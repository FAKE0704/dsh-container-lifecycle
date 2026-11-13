// Plugin-owned durable state: pin record + known_hosts + ssh keypair + helper cache.
// Everything lives under <DSH_HOME|.dsh>/container-lifecycle/ so a DSH_HOME
// override (tests, throwaway profiles) never touches the real home.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root directory holding this plugin's durable files. */
export function stateDir() {
  const root = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(root, 'container-lifecycle')
}

/** Ensure the state directory exists and return it. */
export async function ensureStateDir() {
  const dir = stateDir()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Read the pin record for one alias. Null only when absent: an unparsable
 * record throws, because a drift-refusing design must not silently re-pin
 * from scratch behind a corrupt file.
 * @param {string} alias
 */
export async function readState(alias) {
  const file = join(stateDir(), `${alias}.state.json`)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file}: pin record is not parsable JSON — refusing to re-pin from scratch. Fix or delete the file manually, then reload. (${String(error.message)})`)
  }
}

/** Write the pin record atomically (temp file + rename in one directory). */
export async function writeState(alias, state) {
  const dir = await ensureStateDir()
  const file = join(dir, `${alias}.state.json`)
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return file
}

/** known_hosts file path for one alias (content owned by ensureWorld). */
export function knownHostsPath(alias) {
  return join(stateDir(), `${alias}.known_hosts`)
}

/** Plugin-owned ssh client keypair paths for one alias. */
export function keyPaths(alias) {
  const dir = stateDir()
  return { private: join(dir, `${alias}_id`), public: join(dir, `${alias}_id.pub`) }
}

/** Helper cache tarball path for one (family version, container platform) pair. */
export function helperCachePath(familyVersion, platform, arch) {
  return join(stateDir(), 'cache', `helper-${familyVersion}-linux-${platform}-${arch}.tar.gz`)
}
