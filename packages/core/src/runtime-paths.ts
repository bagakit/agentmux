import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CTXMUX_RUNTIME_ID = '88e8377ecc4341b655d47306'

export function defaultAgentMuxRuntimeDirectory(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  const root = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  return join(root, `amx-${uid}-${CTXMUX_RUNTIME_ID}`)
}

export function defaultCtxmuxSocketPath(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'ctxmux.sock')
}

export function defaultCtxmuxStateDirectory(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'state')
}

export function defaultAgentMuxDesktopFocusSocketPath(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'desktop-focus.sock')
}

export function defaultAgentMuxHookPort(): number {
  const digest = createHash('sha256').update(defaultAgentMuxRuntimeDirectory()).digest()
  return 40_000 + (digest.readUInt16BE(0) % 20_000)
}
