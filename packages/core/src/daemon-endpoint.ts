import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

export function defaultAgentMuxDaemonSocketPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\agentmux-${userInfo().username}`
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().username
  return join(tmpdir(), `agentmux-${uid}`, 'agentmuxd.sock')
}

export function agentMuxDaemonStatePath(socketPath: string): string {
  if (process.platform !== 'win32') return `${socketPath}.sessions.json`
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().username
  return join(tmpdir(), `agentmux-${uid}`, 'agentmuxd.sessions.json')
}
