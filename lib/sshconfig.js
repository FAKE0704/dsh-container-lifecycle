// ~/.ssh/config managed block + plugin-owned known_hosts.
// A0 finding F6: Include lines were read but their Host blocks did not apply on
// this macOS host; the proven form is a directly managed BEGIN/END block in
// ~/.ssh/config, replaced idempotently and never touching other content.
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MARK = 'dsh-container-lifecycle'

/** Path of the user's OpenSSH client config. */
export function userSshConfigPath() {
  return join(homedir(), '.ssh', 'config')
}

/**
 * The managed block for one alias. Trust anchors: StrictHostKeyChecking yes,
 * the plugin-owned known_hosts written from the container's live host key, and
 * the plugin-owned keypair (no agent, no interactive fallback).
 */
export function managedBlock(alias, { port, user, knownHostsFile, identityFile }) {
  return [
    `# BEGIN ${MARK} ${alias}`,
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    `  User ${user}`,
    `  UserKnownHostsFile ${knownHostsFile}`,
    '  StrictHostKeyChecking yes',
    '  IdentitiesOnly yes',
    `  IdentityFile ${identityFile}`,
    `# END ${MARK} ${alias}`,
  ].join('\n')
}

/**
 * Insert or replace this alias's managed block in ~/.ssh/config, preserving
 * every other byte. Creates the file (and nothing else) when absent.
 * @param {string} alias
 * @param {{port: number, user: string, knownHostsFile: string, identityFile: string}} fields
 */
export async function upsertManagedBlock(alias, fields) {
  const file = userSshConfigPath()
  const begin = `# BEGIN ${MARK} ${alias}`
  const end = `# END ${MARK} ${alias}`
  const block = managedBlock(alias, fields)
  const current = existsSync(file) ? await readFile(file, 'utf8') : ''
  const beginAt = current.indexOf(begin)
  const endAt = current.indexOf(end)
  let next
  if (beginAt !== -1 && endAt !== -1 && endAt > beginAt) {
    next = current.slice(0, beginAt) + block + current.slice(endAt + end.length)
  } else if (beginAt !== -1 || endAt !== -1) {
    // A half-written marker pair is corruption we refuse to guess around.
    throw new Error(`${file}: found a '${MARK} ${alias}' marker without its pair; fix the file manually (expected '${begin}' … '${end}')`)
  } else {
    next = current === '' ? block : `${current.replace(/\n*$/, '\n')}${block}\n`
  }
  if (next !== current) {
    const tmp = `${file}.tmp-dsh-container-lifecycle`
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, file)
  }
}

/**
 * Remove this alias's managed block from ~/.ssh/config (dispose). Other
 * content is preserved byte-for-byte.
 */
export async function removeManagedBlock(alias) {
  const file = userSshConfigPath()
  if (!existsSync(file)) return
  const begin = `# BEGIN ${MARK} ${alias}`
  const end = `# END ${MARK} ${alias}`
  const current = await readFile(file, 'utf8')
  const beginAt = current.indexOf(begin)
  const endAt = current.indexOf(end)
  if (beginAt === -1 && endAt === -1) return
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error(`${file}: found a '${MARK} ${alias}' marker without its pair; fix the file manually`)
  }
  const next = (current.slice(0, beginAt) + current.slice(endAt + end.length)).replace(/\n{3,}/g, '\n\n')
  const tmp = `${file}.tmp-dsh-container-lifecycle`
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, file)
}

/**
 * Render one known_hosts entry for the loopback endpoint. The `[host]:port`
 * spelling is what OpenSSH consults for non-22 ports.
 */
export function knownHostsEntry(port, keyType, keyBody) {
  return `[127.0.0.1]:${port} ${keyType} ${keyBody}`
}
