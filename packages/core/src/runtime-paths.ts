import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const CTXMUX_RUNTIME_ID = 'ac53b1e43e67a73841d4f6cf'

export function defaultAgentMuxRuntimeDirectory(): string {
  const override = process.env.AGENTMUX_RUNTIME_DIRECTORY?.trim()
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error('AGENTMUX_RUNTIME_DIRECTORY must be an absolute path.')
    }
    return resolve(override)
  }
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

export function defaultAgentMuxCompositionSocketPath(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'composition.sock')
}

export function defaultAgentMuxHookPort(): number {
  const digest = createHash('sha256').update(defaultAgentMuxRuntimeDirectory()).digest()
  return 40_000 + (digest.readUInt16BE(0) % 20_000)
}
