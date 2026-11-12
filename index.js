// dsh-container-lifecycle — Stage A container provider lifecycle plugin.
//
// One plugin owns the connection's prerequisites end-to-end (design §4.2):
// image digest pin → labeled container (sshd, identical-path bind mount,
// loopback-only port, host uid mapping) → helper closure injected and hashed →
// ephemeral host key pinned into plugin-owned known_hosts → managed
// ~/.ssh/config block → the stock dsh-ssh connection row inserted at runtime
// with the computed helperHash. No seam is touched; nothing is proxied.
//
// Load-order note: SshConnection connects eagerly in its constructor, so the
// static patch never carries the ssh row — this plugin inserts it only after
// ensureWorld() has materialized everything the connection will verify.
import SshConnection from '@deepseek-ai/dsh-ssh'
import { resolveConfig, ensureWorld, disposeWorld, HELPER_REL, containerFacts } from './lib/lifecycle.js'
import { daemonReady, runDocker } from './lib/docker.js'
import { readState, knownHostsPath, keyPaths } from './lib/state.js'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export const name = 'dsh-container-lifecycle'
export const inject = ['tools']

const OUTPUT = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {unknown} config */
export async function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const log = (message) => {
    const logger = ctx.logger ? ctx.logger('dsh-container-lifecycle') : console
    logger.info?.(message)
  }

  const world = await ensureWorld({ cfg, log })
  log(`world ${world.outcome}: helper ${world.helperHash.slice(0, 12)}…, key ${world.keyState}, alias ${cfg.alias}:${cfg.port}`)

  ctx.plugin(SshConnection, {
    host: cfg.alias,
    launch: { kind: 'node-script', node: cfg.containerNode },
    helper: `${cfg.helperDir}/${HELPER_REL}`,
    helperHash: world.helperHash,
    workspace: cfg.workspace,
  })
  // Settle barrier: the runtime-inserted ssh service wakes the ssh-family
  // consumers, whose own services wake the tool layer — a two-step cascade.
  // Profile boot awaits this apply, so holding it open until the cascade lands
  // keeps the first session's toolset complete; without the barrier the
  // session can snapshot its tools mid-cascade and lose the shell/fs tools.
  const cascade = ['subprocess', 'sandbox', 'fs', 'shell', 'workingDirectory']
  const settleStart = Date.now()
  while (Date.now() - settleStart < 8000) {
    const present = cascade.filter((name) => typeof ctx.get === 'function' && ctx.get(name) !== undefined)
    if (present.length === cascade.length) break
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  log(`service cascade settled in ${Date.now() - settleStart}ms`)
  setTimeout(async () => {
    const service = typeof ctx.get === 'function' ? ctx.get('ssh') : undefined
    if (service?.ready) {
      try { await service.ready } catch (error) { log(`ssh connection failed after settle: ${String(error)}`) }
    }
  }, 1500)

  ctx.tools.register({
    name: 'container-status',
    description: '查看容器执行世界的生命周期状态：容器是否在跑（由谁收养）、镜像 digest 钉定、helper 哈希是否与钉定一致、端口与工作区投影、known_hosts/ssh 托管块是否就位。只读免审。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute() {
      const state = await readState(cfg.alias)
      if (state === null) return { ok: false, message: `no pin record for alias '${cfg.alias}' — the world was never created in this DSH_HOME` }
      const dockerUp = await daemonReady(cfg.dockerBin)
      let container = 'docker-down'
      if (dockerUp) {
        const facts = await containerFacts(cfg)
        container = facts === null ? 'absent' : facts.running ? `running (${facts.id.slice(0, 12)})` : 'stopped'
      }
      const hashNow = dockerUp && container.startsWith('running')
        ? (await runDocker(cfg.dockerBin, ['exec', cfg.alias, 'sha256sum', `${cfg.helperDir}/${HELPER_REL}`], { timeoutMs: 15_000 })).stdout.trim().split(/\s+/)[0]
        : null
      const known = existsSync(knownHostsPath(cfg.alias)) ? 'present' : 'missing'
      const key = existsSync(keyPaths(cfg.alias).private) ? 'present' : 'missing'
      const lines = [
        `alias ${cfg.alias} (port ${cfg.port}, workspace ${cfg.workspace})`,
        `container: ${container}${world.outcome === 'created' ? ' — created this load' : ''}`,
        `image pin: ${state.imagePin}`,
        `helperHash: ${state.helperHash.slice(0, 16)}…${hashNow === null ? ' (container not running — not rechecked)' : hashNow === state.helperHash ? ' ✓ matches pin' : ' ✗ DRIFT'}`,
        `known_hosts ${known}, client key ${key}`,
        `family: dsh-ssh ${state.familyVersions['@deepseek-ai/dsh-ssh']}`,
      ]
      return { ok: true, message: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'container-dispose',
    description: '拆除本别名的容器执行世界：docker rm -f 容器、移除 ~/.ssh/config 托管块与 known_hosts。钉定记录/客户端密钥/helper 缓存保留（下次加载自动收养重建）。写面过审批门。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute() {
      try {
        const result = await disposeWorld({ cfg, log })
        return { ok: true, message: `disposed ${result.alias}: container ${result.containerRemoved ? 'removed' : 'already absent'}, ssh block + known_hosts cleared` }
      } catch (error) {
        return { ok: false, message: `dispose failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name === 'container-dispose') {
      return {
        kind: 'ask',
        reason: 'dsh-container-lifecycle: 拆除容器执行世界（docker rm -f + 清理 ~/.ssh/config 托管块与 known_hosts）',
        displayReason: { en: 'Tear down the container execution world (docker rm -f + remove the managed ssh block and known_hosts).' },
      }
    }
    return next()
  })
}
