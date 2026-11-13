// Stage A lifecycle: image pin → create/adopt → helper → host key → ssh block.
// Design §4.2 responsibilities 1–7 as executable code. The behavioral spec is
// the A0-proven a0/stagea-up.sh, now idempotent, adopt-aware, and drift-refusing.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daemonReady, docker, runDocker } from './docker.js'
import { ensureStateDir, helperCachePath, keyPaths, knownHostsPath, readState, writeState } from './state.js'
import { knownHostsEntry, upsertManagedBlock } from './sshconfig.js'

/** Path of the helper entry inside the container, relative to helperDir. */
export const HELPER_REL = 'node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'

/** The helper closure, exactly the A0-proven manifest (versions resolved from this plugin's own dependencies). */
const FAMILY = [
  '@deepseek-ai/dsh-ssh', '@deepseek-ai/cordis', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-http-proxy',
]

/** Native packages whose install scripts npm 11 gates (A0 finding F4). */
const NATIVE_PKGS = ['node-pty', 'koffi', '@deepseek-ai/dsh-subprocess-local']

/**
 * Resolve and validate plugin config. Unknown or malformed fields fall back to
 * documented defaults; the trust anchors (StrictHostKeyChecking, BatchMode,
 * known_hosts spelling) are not configurable.
 */
export function resolveConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  const str = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const port = Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536 ? cfg.port : 2223
  return {
    alias: str(cfg.alias, 'dsh-container'),
    image: str(cfg.image, 'dsh-container-sshd:a1'),
    port,
    sshUser: str(cfg.sshUser, 'agent'),
    helperDir: str(cfg.helperDir, '/opt/dsh'),
    containerNode: str(cfg.containerNode, '/usr/local/bin/node'),
    dockerBin: str(cfg.dockerBin, 'docker'),
    registry: str(cfg.registry, 'https://registry.npmmirror.com'),
    fallbackRegistry: 'https://registry.npmjs.org',
    workspace: str(cfg.workspace, process.cwd()),
    imageRebind: cfg.imageRebind === true,
    aptMirror: str(cfg.aptMirror, ''),
  }
}

/** Versions of the helper closure as installed beside this plugin. */
export function familyVersions() {
  const requireFromPlugin = createRequire(import.meta.url)
  const versions = {}
  for (const name of FAMILY) versions[name] = requireFromPlugin(`${name}/package.json`).version
  return versions
}

function run(bin, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    // The timer makes a hung child (e.g. ssh-keygen on a wedged fs) fail
    // loudly instead of hanging apply() forever.
    const timer = setTimeout(() => {
      if (settled) return
      stderr += `\n${bin} timed out after ${timeoutMs}ms and was killed`
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: String(error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Generate the plugin-owned ssh client keypair once per alias. */
async function ensureKeyPair(keys) {
  if (existsSync(keys.private) && existsSync(keys.public)) return
  await mkdir(join(keys.private, '..'), { recursive: true })
  const result = await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'dsh-container-lifecycle', '-f', keys.private])
  if (result.code !== 0) throw new Error(`ssh-keygen failed: ${result.stderr.trim()}`)
}

/**
 * Build the image from the bundled Dockerfile when it is absent — first use
 * on a fresh machine must not require manual docker commands. The pin flow
 * then records the local image ID (imageFacts prefers a repo digest, but a
 * locally built image has none).
 * @returns {Promise<boolean>} true when a build happened
 */
async function ensureImage(cfg, log) {
  const probe = await runDocker(cfg.dockerBin, ['image', 'inspect', cfg.image, '--format', '{{.Id}}'], { timeoutMs: 30_000 })
  if (probe.code === 0) return false
  const dockerDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker')
  if (!existsSync(join(dockerDir, 'Dockerfile'))) {
    throw new Error(`image '${cfg.image}' is absent and the bundled Dockerfile was not found at ${dockerDir} — the plugin install is incomplete; reinstall it.`)
  }
  const args = ['build', '-t', cfg.image]
  if (cfg.aptMirror !== '') args.push('--build-arg', `APT_MIRROR=${cfg.aptMirror}`)
  args.push(dockerDir)
  log(`image '${cfg.image}' absent — building from the bundled Dockerfile (first use; apt mirror: ${cfg.aptMirror === '' ? 'upstream default' : cfg.aptMirror})`)
  const built = await runDocker(cfg.dockerBin, args, { timeoutMs: 900_000 })
  if (built.code !== 0) {
    throw new Error(`docker build for '${cfg.image}' failed (base image must be pullable; behind a throttled route set the plugin config aptMirror):\n${built.stderr.trim().slice(-2000)}`)
  }
  return true
}

/** Image pin facts: prefer a repo digest (registry-pulled), else the config digest (locally built). */
async function imageFacts(cfg) {
  const { stdout } = await docker(cfg.dockerBin, ['image', 'inspect', cfg.image, '--format', '{{.Id}}\t{{join .RepoDigests " "}}'], { what: 'image inspect' })
  const [id, digests] = stdout.trim().split('\t')
  const digest = (digests ?? '').split(' ').find((entry) => entry.includes('@sha256:')) ?? null
  return { id: id.trim(), ref: digest ?? id.trim() }
}

/** Container facts by name: null when absent; throws when the name is held by a foreign container. */
export async function containerFacts(cfg) {
  const result = await runDocker(cfg.dockerBin, ['inspect', cfg.alias, '--format', '{{.Id}}\t{{.State.Running}}\t{{index .Config.Labels "dsh.plugin"}}'])
  if (result.code !== 0) return null
  const [id, running, label] = result.stdout.trim().split('\t')
  if (label !== 'dsh-container-lifecycle') {
    throw new Error(`container '${cfg.alias}' exists but is not owned by this plugin (dsh.plugin label missing). Remove it or choose another alias.`)
  }
  return { id, running: running === 'true' }
}

/** Wait until sshd answers inside the container (A0-proven probe loop). */
async function waitSshd(cfg) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const probe = await runDocker(cfg.dockerBin, ['exec', cfg.alias, 'pgrep', '-x', 'sshd'], { timeoutMs: 10_000 })
    if (probe.code === 0) return
    await new Promise((resolve) => { setTimeout(resolve, 1000) })
  }
  const { stdout } = await docker(cfg.dockerBin, ['logs', '--tail', '10', cfg.alias], { what: 'container logs' })
  throw new Error(`sshd never came up in '${cfg.alias}'. Last logs:\n${stdout}`)
}

/** SHA-256 of the helper entry inside the container; null when absent. */
async function helperHashIn(cfg) {
  const probe = await runDocker(cfg.dockerBin, ['exec', cfg.alias, 'sha256sum', join(cfg.helperDir, HELPER_REL)], { timeoutMs: 15_000 })
  if (probe.code !== 0) return null
  return probe.stdout.trim().split(/\s+/)[0]
}

/** Native modules must load (A0 finding F4: npm 11 gates their install scripts). */
async function nativesLoad(cfg) {
  const script = `require(${JSON.stringify(join(cfg.helperDir, 'node_modules/node-pty'))});require(${JSON.stringify(join(cfg.helperDir, 'node_modules/koffi'))});require(${JSON.stringify(join(cfg.helperDir, 'node_modules/@deepseek-ai/dsh-subprocess-local'))})`
  const probe = await runDocker(cfg.dockerBin, ['exec', cfg.alias, cfg.containerNode, '-e', script], { timeoutMs: 30_000 })
  return probe.code === 0
}

/** Write the helper manifest into the container and npm-install the closure. */
async function npmInstallHelper(cfg, versions) {
  const manifest = { name: 'dsh-helper-dist', private: true, dependencies: { ...versions } }
  const manifestHost = join((await ensureStateDir()), `${cfg.alias}.helper-package.json`)
  await writeFile(manifestHost, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await docker(cfg.dockerBin, ['exec', cfg.alias, 'rm', '-rf', `${cfg.helperDir}/node_modules`, `${cfg.helperDir}/package.json`], { what: 'clear helper dir' })
  await docker(cfg.dockerBin, ['cp', manifestHost, `${cfg.alias}:${cfg.helperDir}/package.json`], { what: 'copy manifest' })
  const npmEnv = { npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }
  let install = await runDocker(cfg.dockerBin, ['exec', '-w', cfg.helperDir, '-e', `npm_config_allow_scripts=${NATIVE_PKGS.join(',')}`, ...Object.entries(npmEnv).map(([k, v]) => ['-e', `${k}=${v}`]).flat(), cfg.alias, 'npm', 'install', '--omit=dev', '--registry', cfg.registry], { timeoutMs: 600_000 })
  if (install.code !== 0) {
    install = await runDocker(cfg.dockerBin, ['exec', '-w', cfg.helperDir, ...Object.entries(npmEnv).map(([k, v]) => ['-e', `${k}=${v}`]).flat(), cfg.alias, 'npm', 'install', '--omit=dev', '--registry', cfg.fallbackRegistry], { timeoutMs: 600_000 })
  }
  if (install.code !== 0) throw new Error(`npm install in container failed:\n${install.stderr.trim().slice(-2000)}`)
  if (!(await nativesLoad(cfg))) await rebuildNatives(cfg)
  if (!(await nativesLoad(cfg))) {
    throw new Error(`native helper modules still fail to load after rebuild. Manual recipe (A0 F4): docker exec -w ${cfg.helperDir}/node_modules/<pkg> ${cfg.alias} npm run install|postinstall for: ${NATIVE_PKGS.join(', ')}`)
  }
}

/** F4 fallback: run each native package's install/postinstall scripts explicitly. */
async function rebuildNatives(cfg) {
  for (const pkg of NATIVE_PKGS) {
    const dir = join(cfg.helperDir, 'node_modules', pkg)
    const scripts = await runDocker(cfg.dockerBin, ['exec', cfg.alias, cfg.containerNode, '-e', `const p=require(${JSON.stringify(join(dir, 'package.json'))});console.log(JSON.stringify(p.scripts??{}))`], { timeoutMs: 15_000 })
    if (scripts.code !== 0) continue
    let declared = {}
    try { declared = JSON.parse(scripts.stdout.trim()) } catch { continue }
    for (const script of ['install', 'postinstall']) {
      if (typeof declared[script] !== 'string') continue
      await runDocker(cfg.dockerBin, ['exec', '-w', dir, cfg.alias, 'sh', '-c', declared[script]], { timeoutMs: 300_000 })
    }
  }
}

/** Save the container's helper closure as a host-side tarball (binary-safe via docker cp). */
async function saveHelperCache(cfg, cachePath) {
  await mkdir(join(cachePath, '..'), { recursive: true })
  await docker(cfg.dockerBin, ['exec', cfg.alias, 'tar', 'czf', '/tmp/dsh-helper-cache.tgz', '-C', cfg.helperDir, '.'], { what: 'pack helper cache' })
  await docker(cfg.dockerBin, ['cp', `${cfg.alias}:/tmp/dsh-helper-cache.tgz`, cachePath], { what: 'export helper cache' })
  await runDocker(cfg.dockerBin, ['exec', cfg.alias, 'rm', '-f', '/tmp/dsh-helper-cache.tgz'])
}

/** Restore the helper closure from cache; false when no cache exists. */
async function restoreHelperCache(cfg, cachePath) {
  if (!existsSync(cachePath)) return false
  await docker(cfg.dockerBin, ['exec', cfg.alias, 'rm', '-rf', `${cfg.helperDir}/node_modules`], { what: 'clear helper dir' })
  await docker(cfg.dockerBin, ['cp', cachePath, `${cfg.alias}:/tmp/dsh-helper-cache.tgz`], { what: 'import helper cache' })
  await docker(cfg.dockerBin, ['exec', cfg.alias, 'tar', 'xzf', '/tmp/dsh-helper-cache.tgz', '-C', cfg.helperDir], { what: 'extract helper cache' })
  await runDocker(cfg.dockerBin, ['exec', cfg.alias, 'rm', '-f', '/tmp/dsh-helper-cache.tgz'])
  return true
}

/** Re-pin known_hosts from the container's live ephemeral host key. */
async function pinHostKey(cfg, knownHosts) {
  const { stdout } = await docker(cfg.dockerBin, ['exec', cfg.alias, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { what: 'read host key' })
  const [keyType, keyBody] = stdout.trim().split(/\s+/)
  const entry = knownHostsEntry(cfg.port, keyType, keyBody)
  const current = existsSync(knownHosts) ? await readFile(knownHosts, 'utf8') : ''
  if (current.trim() !== entry) await writeFile(knownHosts, `${entry}\n`, 'utf8')
  return current.trim() === entry ? 'fresh' : 'pinned'
}

/**
 * Cross-process prepare lock for one alias: concurrent loads of the same
 * alias otherwise race a double `docker run` (the loser dies on "name already
 * in use") and interleave `docker cp`/npm installs into the same helper dir.
 * O_EXCL create; stale-breakable only when the holding pid is dead or the
 * lock is far older than any legitimate prepare (image build + helper
 * install can legitimately take ~20 min on a cold first use).
 */
async function withPrepareLock(cfg, fn) {
  const dir = await ensureStateDir()
  const lockPath = join(dir, `${cfg.alias}.prepare.lock`)
  const STALE_MS = 45 * 60_000
  const tryAcquire = () => {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      return false
    }
  }
  if (!tryAcquire()) {
    let stale = false
    let holder = 'unknown'
    try {
      holder = readFileSync(lockPath, 'utf8').trim()
      const { mtimeMs } = statSync(lockPath)
      const pid = Number.parseInt(holder, 10)
      if (Number.isInteger(pid)) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          if (error.code === 'ESRCH') stale = true
        }
      }
      if (!stale && Date.now() - mtimeMs > STALE_MS) stale = true
    } catch {
      stale = true
    }
    if (!stale) {
      throw new Error(`another dsh-container-lifecycle process (pid ${holder}) is already preparing '${cfg.alias}'. Retry once it finishes; delete ${lockPath} only if you know it is stale.`)
    }
    try { unlinkSync(lockPath) } catch { /* racing another stale-breaker is fine */ }
    if (!tryAcquire()) {
      throw new Error(`could not acquire the prepare lock for '${cfg.alias}' (${lockPath}); another process broke the same stale lock first.`)
    }
  }
  try {
    return await fn()
  } finally {
    try { unlinkSync(lockPath) } catch { /* already gone */ }
  }
}

/**
 * Materialize the connection world for one alias. Returns the facts the
 * connection row needs (helperHash) plus what happened (created/adopted/started).
 * Serialized per alias across processes by the prepare lock.
 * @param {{cfg: ReturnType<resolveConfig>, log: (message: string) => void}} input
 */
export async function ensureWorld({ cfg, log }) {
  return withPrepareLock(cfg, () => ensureWorldLocked({ cfg, log }))
}

async function ensureWorldLocked({ cfg, log }) {
  if (!(await daemonReady(cfg.dockerBin))) {
    throw new Error('docker daemon is not answering. Start Docker Desktop (or set DOCKER_HOST) and reload this profile.')
  }
  const versions = familyVersions()
  const state = await readState(cfg.alias)
  await ensureImage(cfg, log)
  const image = await imageFacts(cfg)
  if (state !== null && state.imagePin !== image.ref && !cfg.imageRebind) {
    throw new Error([
      `image '${cfg.image}' drifted since first use.`,
      `  pinned:  ${state.imagePin}`,
      `  current: ${image.ref}`,
      `Refusing to run an unpinned image (trust chain). To rebind deliberately: set this plugin's config imageRebind: true once, or delete ${join((await ensureStateDir()), `${cfg.alias}.state.json`)}.`,
    ].join('\n'))
  }
  await ensureStateDir()
  const keys = keyPaths(cfg.alias)
  await ensureKeyPair(keys)
  const knownHosts = knownHostsPath(cfg.alias)

  const existing = await containerFacts(cfg)
  // A deliberate rebind (imageRebind) re-pins the image; a surviving container
  // from the previous pin would silently keep running old bytes, so it is
  // recreated from the newly pinned ref.
  if (state !== null && state.imagePin !== image.ref && existing !== null) {
    log(`image pin changed since the container was created — recreating '${cfg.alias}' from ${image.ref}`)
    await docker(cfg.dockerBin, ['rm', '-f', cfg.alias], { what: 'recreate after rebind' })
  }
  let outcome
  if ((await containerFacts(cfg)) === null) {
    log(`creating container '${cfg.alias}' from ${image.ref} (bind ${cfg.workspace})`)
    const publicKey = (await readFile(keys.public, 'utf8')).trim()
    try {
      await docker(cfg.dockerBin, ['run', '-d', '--name', cfg.alias,
        '--label', `dsh.container=${cfg.alias}`, '--label', 'dsh.plugin=dsh-container-lifecycle',
        '-p', `127.0.0.1:${cfg.port}:22`,
        '-v', `${cfg.workspace}:${cfg.workspace}`, '-w', cfg.workspace,
        '-e', `AUTHORIZED_KEY=${publicKey}`,
        '-e', `HOST_UID=${process.getuid()}`, '-e', `HOST_GID=${process.getgid()}`,
        image.ref], { what: 'create container' })
    } catch (error) {
      if (String(error).includes('port is already allocated')) {
        throw new Error(`loopback port ${cfg.port} is already allocated (another container or process holds 127.0.0.1:${cfg.port}). Set this plugin's config port: <free-port> in the profile patch and reload. Original: ${String(error).split('\n')[0]}`)
      }
      throw error
    }
    await waitSshd(cfg)
    await ensureHelper(cfg, versions, state)
    outcome = 'created'
  } else if (existing.running) {
    log(`adopting running container '${cfg.alias}'`)
    await ensureHelper(cfg, versions, state)
    outcome = 'adopted'
  } else {
    log(`starting stopped container '${cfg.alias}' (host keys regenerate; known_hosts will re-pin)`)
    await docker(cfg.dockerBin, ['start', cfg.alias], { what: 'start container' })
    await waitSshd(cfg)
    await ensureHelper(cfg, versions, state)
    outcome = 'started'
  }
  const keyState = await pinHostKey(cfg, knownHosts)
  const helperHash = await helperHashIn(cfg)
  if (helperHash === null) throw new Error('helper entry missing after ensure; this is a bug in ensureHelper')
  const cachePath = helperCachePath(versions['@deepseek-ai/dsh-ssh'], process.platform, process.arch)
  if (!existsSync(cachePath)) await saveHelperCache(cfg, cachePath)
  const facts = await containerFacts(cfg)
  const next = {
    version: 1, alias: cfg.alias, imageRef: cfg.image, imagePin: image.ref,
    familyVersions: versions, helperHash, containerId: facts.id,
    port: cfg.port, workspace: cfg.workspace, updatedAt: new Date().toISOString(),
    ...(state === null ? { createdAt: next0() } : { createdAt: state.createdAt }),
  }
  await writeState(cfg.alias, next)
  await upsertManagedBlock(cfg.alias, { port: cfg.port, user: cfg.sshUser, knownHostsFile: knownHosts, identityFile: keys.private })
  return { outcome, helperHash, keyState, cacheSeeded: true, state: next }
}

function next0() { return new Date().toISOString() }

/**
 * Helper present-and-pinned: hash present → keep (refuse nothing, it must equal
 * the recorded pin); absent → cache → fresh npm install; any path ends with the
 * natives loadable and the entry hash returned.
 */
async function ensureHelper(cfg, versions, state) {
  let hash = await helperHashIn(cfg)
  if (hash !== null && state !== null && state.helperHash === hash) {
    if (!(await nativesLoad(cfg))) await rebuildNatives(cfg)
    return hash
  }
  const cachePath = helperCachePath(versions['@deepseek-ai/dsh-ssh'], process.platform, process.arch)
  if (hash === null && (await restoreHelperCache(cfg, cachePath))) {
    hash = await helperHashIn(cfg)
    if (hash !== null && state !== null && state.helperHash === hash && (await nativesLoad(cfg))) return hash
  }
  await npmInstallHelper(cfg, versions)
  hash = await helperHashIn(cfg)
  if (hash === null) throw new Error('helper entry missing after npm install')
  return hash
}

/**
 * Dispose one alias: remove container, managed ssh block, and known_hosts.
 * The pin record, keypair, and helper cache survive for the next start.
 */
export async function disposeWorld({ cfg, log }) {
  if (!(await daemonReady(cfg.dockerBin))) {
    throw new Error('docker daemon is not answering; dispose needs it to remove the container.')
  }
  const removed = await runDocker(cfg.dockerBin, ['rm', '-f', cfg.alias])
  if (removed.code !== 0 && !/No such container/.test(removed.stderr)) {
    throw new Error(`docker rm ${cfg.alias}: ${removed.stderr.trim()}`)
  }
  const { removeManagedBlock } = await import('./sshconfig.js')
  await removeManagedBlock(cfg.alias)
  const knownHosts = knownHostsPath(cfg.alias)
  if (existsSync(knownHosts)) await rm(knownHosts)
  const state = await readState(cfg.alias)
  if (state !== null) await writeState(cfg.alias, { ...state, containerId: null, disposedAt: new Date().toISOString() })
  log(`disposed '${cfg.alias}' (container removed, ssh block and known_hosts cleared; pin record kept)`)
  return { alias: cfg.alias, containerRemoved: removed.code === 0 }
}
