import { execFileSync } from 'node:child_process'

const PROCESS_QUERY_TIMEOUT_MS = 1_000
const PROCESS_QUERY_MAX_BYTES = 1024 * 1024

export type PosixProcessIdentity = {
  pid: number
  startedAtMs: number
}

export function parsePosixProcessIdentity(output: string, pid: number): PosixProcessIdentity | null {
  const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(output)
  if (!match || Number(match[1]) !== pid || match[2]!.startsWith('Z')) return null
  const startedAtMs = Date.parse(`${match[3]} UTC`)
  return Number.isFinite(startedAtMs) ? { pid, startedAtMs } : null
}

function readIdentity(pid: number): PosixProcessIdentity | null {
  const output = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,stat=,lstart='], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    maxBuffer: PROCESS_QUERY_MAX_BYTES,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' }
  })
  return parsePosixProcessIdentity(output, pid)
}

export function recordPosixProcessIdentity(pid: number): PosixProcessIdentity | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    return readIdentity(pid)
  } catch {
    return null
  }
}

export function posixProcessIdentityIsAlive(identity: PosixProcessIdentity): boolean {
  if (process.platform === 'win32') return false
  try {
    return readIdentity(identity.pid)?.startedAtMs === identity.startedAtMs
  } catch {
    return false
  }
}

/** A Zombie still owns a PID but cannot run or receive a control signal. */
export function posixProcessIsControllable(pid: number): boolean {
  return recordPosixProcessIdentity(pid) !== null
}
