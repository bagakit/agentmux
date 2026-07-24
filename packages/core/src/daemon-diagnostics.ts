import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentMuxDaemonDiagnostics } from './daemon-protocol.js'

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function inspectAgentMuxDaemonRuntime(): Promise<AgentMuxDaemonDiagnostics> {
  const require = createRequire(import.meta.url)
  const nodePtyPackagePath = require.resolve('node-pty/package.json')
  const nodePtyPackage = require(nodePtyPackagePath) as { version?: unknown }
  const platformArtifact = `prebuilds/${process.platform}-${process.arch}/pty.node`
  const packageRoot = dirname(nodePtyPackagePath)
  const helperArtifact = process.platform === 'darwin'
    ? `prebuilds/${process.platform}-${process.arch}/spawn-helper`
    : null
  const helperPath = helperArtifact ? join(packageRoot, helperArtifact) : null
  const helperExecutable = helperPath
    ? await stat(helperPath).then((value) => value.isFile() && (value.mode & 0o111) !== 0, () => false)
    : null
  const supportedPlatform = (
    (process.platform === 'darwin' || process.platform === 'linux') &&
    (process.arch === 'arm64' || process.arch === 'x64')
  )
  const artifactPresent = await isFile(join(packageRoot, platformArtifact))
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    supported: nodeMajor() >= 22 && supportedPlatform,
    pty: {
      packageName: 'node-pty',
      version: typeof nodePtyPackage.version === 'string' ? nodePtyPackage.version : 'invalid-package-version',
      artifact: platformArtifact,
      artifactPresent,
      helperArtifact,
      helperExecutable,
      ready: artifactPresent && helperExecutable !== false
    }
  }
}
