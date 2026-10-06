import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ctxmuxArtifacts from './ctxmux-artifact-contract.json' with { type: 'json' }

// Artifact identity only. The adapter verifies the packed manifest and owner receipt
// with this digest; changing an artifact must not change the Runtime's address.
export function supportedCtxmuxArtifactPlatform(
  platform: string = process.platform,
  architecture: string = process.arch
): string | null {
  const artifactPlatform = `${platform}-${architecture}`
  return Object.hasOwn(ctxmuxArtifacts.manifests, artifactPlatform) ? artifactPlatform : null
}

export function ctxmuxManifestSha256(
  platform: string = process.platform,
  architecture: string = process.arch
): string {
  const artifactPlatform = supportedCtxmuxArtifactPlatform(platform, architecture)
  if (artifactPlatform === null) {
    throw new Error(`AgentMux has no qualified ctxmux artifacts for ${platform}-${architecture}.`)
  }
  return ctxmuxArtifacts.manifests[artifactPlatform as keyof typeof ctxmuxArtifacts.manifests]
}

export const CTXMUX_MANIFEST_SHA256 = ctxmuxManifestSha256()

/** Each qualified platform retains the exact source of its own Native and SDK bundle. */
export function ctxmuxArtifactSource(platform: string = process.platform, architecture: string = process.arch): { commit: string; tree: string } {
  const artifactPlatform = supportedCtxmuxArtifactPlatform(platform, architecture)
  if (artifactPlatform === null) throw new Error(`AgentMux has no qualified ctxmux artifacts for ${platform}-${architecture}.`)
  return ctxmuxArtifacts.sources[artifactPlatform as keyof typeof ctxmuxArtifacts.sources]
}

// A stable host namespace, independent of artifact identity. The short endpoint can be
// recreated; persistent state uses the same namespace under the user's durable directory.
const CTXMUX_RUNTIME_ID = '1e19b1caf5c6ddd1aa8b5cac'

export function defaultAgentMuxRuntimeDirectory(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.AGENTMUX_RUNTIME_DIRECTORY?.trim()
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

export function defaultAgentMuxStateDirectory(): string {
  const override = process.env.AGENTMUX_STATE_DIRECTORY?.trim()
  if (override) {
    if (!isAbsolute(override)) throw new Error('AGENTMUX_STATE_DIRECTORY must be an absolute path.')
    return resolve(override)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(homedir(), '.agentmux', 'state', `amx-${uid}-${CTXMUX_RUNTIME_ID}`)
}

export function defaultCtxmuxStateDirectory(): string {
  return join(defaultAgentMuxStateDirectory(), 'ctxmux')
}

export function defaultAgentMuxControlSocketPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(defaultAgentMuxRuntimeDirectory(env), 'control.sock')
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

export function resolveCoreBinPath(binaryName: 'amux' | 'agentmux-hook.js' | 'native-socket-transport.mjs'): string {
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
