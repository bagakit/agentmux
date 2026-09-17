import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Artifact identity only. The adapter verifies the packed manifest and owner receipt
// with this digest; changing an artifact must not change the Runtime's address.
export const CTXMUX_MANIFEST_SHA256 = '6227cdb682a36a971f3befd5bd352ec45fc6d68f8d306bc2180af1bda883b5b5'

// The already deployed host namespace is durable, independent of artifact identity.
// Keep the existing address so upgrades reach the same listener, state and healthy Runs.
const CTXMUX_RUNTIME_ID = '1e19b1caf5c6ddd1aa8b5cac'

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

export function defaultAgentMuxControlSocketPath(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'control.sock')
}

export function defaultAgentMuxMessageQueuePath(
  adoptedFileStorePath: string | null = process.env.AGENTMUX_AGENT_SESSION_STORE?.trim() || null,
  queueAuthority = process.env.AGENTMUX_MESSAGE_QUEUE_PATH
): string {
  const override = queueAuthority?.trim()
  if (override) {
    if (!isAbsolute(override)) throw new Error('AGENTMUX_MESSAGE_QUEUE_PATH must be an absolute path.')
    return resolve(override)
  }
  if (adoptedFileStorePath !== null) {
    if (!isAbsolute(adoptedFileStorePath)) throw new Error('Agent Session store context must be an absolute path.')
    return join(dirname(resolve(adoptedFileStorePath)), 'global-messages.ndjson')
  }
  return join(homedir(), '.agentmux', 'state', 'global-messages.ndjson')
}

export function defaultAgentMuxHookPort(): number {
  const digest = createHash('sha256').update(defaultAgentMuxRuntimeDirectory()).digest()
  return 40_000 + (digest.readUInt16BE(0) % 20_000)
}

export function resolveCoreBinPath(binaryName: 'agentmux' | 'agentmux-hook.js'): string {
  const candidates: string[] = [
    fileURLToPath(new URL(`../bin/${binaryName}`, import.meta.url)),
    fileURLToPath(new URL(`./bin/${binaryName}`, import.meta.url)),
    fileURLToPath(new URL(`../../node_modules/@agentmux/core/bin/${binaryName}`, import.meta.url)),
    fileURLToPath(new URL(`../node_modules/@agentmux/core/bin/${binaryName}`, import.meta.url))
  ]
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(
      join(resourcesPath, 'app', 'node_modules', '@agentmux', 'core', 'bin', binaryName),
      join(resourcesPath, 'app', 'out', 'bin', binaryName),
      join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@agentmux', 'core', 'bin', binaryName)
    )
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]!
}
