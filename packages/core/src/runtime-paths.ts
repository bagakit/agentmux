import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// SSOT for the pinned CtxMux artifact's manifest digest. `ctxmux-run-adapter.ts`
// imports it to verify the packed manifest bytes and the owner receipt; the
// endpoint id below derives from it so each artifact version claims its own
// socket/state root.
export const CTXMUX_MANIFEST_SHA256 = 'ccf0a9bbc9e3db468459b81d011e40e90599ba43873bc795a1c6fc9dd668ce45'

// Derive the endpoint identity from the pinned manifest so an artifact upgrade
// lands on a fresh socket/state root instead of colliding with a stale detached
// daemon from the previous version. A collision would let the old daemon pass the
// build/protocol handshake but fail owner-receipt verification, throwing
// CTXMUX_OWNER_IDENTITY_UNPROVEN with no reap and taking the whole app down via
// app.exit(1). In-flight sessions do not transfer across an artifact version.
// Historical Runtime namespace remains the original release identity.
// Normalized manifest bytes change the verification checksum, not this address.
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
