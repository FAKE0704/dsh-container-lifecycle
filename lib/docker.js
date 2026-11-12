// Docker CLI wrapper. Every invocation captures output, enforces a timeout,
// and never inherits stdio: this code runs inside the dsh host process.
import { spawn } from 'node:child_process'

/** @typedef {{code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string|null}} DockerResult */

/**
 * Run `docker <args>` and capture the outcome without throwing.
 * @param {string} bin docker binary name or path
 * @param {string[]} args
 * @param {{timeoutMs?: number, env?: Record<string,string>}} [opts]
 * @returns {Promise<DockerResult>}
 */
export function runDocker(bin, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (/** @type {Partial<DockerResult>} */ extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut: false, spawnError: null, ...extra })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { finish({ spawnError: String(error) }) })
    child.on('close', (code) => { finish({ code }) })
  })
}

/**
 * Run `docker <args>` expecting exit 0; a nonzero exit becomes an Error with
 * the captured diagnostic so callers fail loud with actionable text.
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?: number, env?: Record<string,string>, what?: string}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function docker(bin, args, opts = {}) {
  const result = await runDocker(bin, args, opts)
  if (result.spawnError !== null) {
    throw new Error(`docker ${args.join(' ')}: cannot start docker (${result.spawnError}). Is Docker installed and on PATH?`)
  }
  if (result.timedOut) throw new Error(`docker ${args.join(' ')}: timed out after ${opts.timeoutMs ?? 120_000}ms`)
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`docker ${args.join(' ')}${opts.what ? ` (${opts.what})` : ''}: ${detail}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

/** True when the docker daemon answers `docker version` within the timeout. */
export async function daemonReady(bin) {
  const result = await runDocker(bin, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 })
  return result.code === 0 && result.stdout.trim() !== ''
}
