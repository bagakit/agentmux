import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CTXMUX_RUNTIME_ID = '5e67346cf1fedd60eba15e2b'

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

