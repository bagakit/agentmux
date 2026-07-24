import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { cp, chmod, link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentMuxError, CommandExecutionError } from './errors.js'
import { runProcess, type ProcessRunner } from './process-runner.js'
import type { AgentMuxRemoteArtifact, AgentMuxRemotePlatform } from './ssh-remote-daemon.js'

const SUPPORTED_PLATFORMS = new Set<AgentMuxRemotePlatform>([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64'
])

export type CreateAgentMuxRemoteArtifactOptions = {
  outputPath: string
  buildIdentity: string
  platform?: AgentMuxRemotePlatform
  runner?: ProcessRunner
}

function currentPlatform(): AgentMuxRemotePlatform {
  const value = `${process.platform}-${process.arch}` as AgentMuxRemotePlatform
  if (!SUPPORTED_PLATFORMS.has(value)) {
    throw new AgentMuxError(`Remote artifact platform is unsupported: ${value}.`, 'UNSUPPORTED_REMOTE_PLATFORM')
  }
  return value
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  throw new AgentMuxError(`${label} is missing; build @agentmux/core before creating an artifact.`, 'MISSING_PACKAGE_ARTIFACT')
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new AgentMuxError('Remote artifact output already exists.', 'REMOTE_ARTIFACT_EXISTS')
}

async function publish(outputPath: string, temporaryOutputPath: string): Promise<void> {
  try {
    await link(temporaryOutputPath, outputPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AgentMuxError('Remote artifact output already exists.', 'REMOTE_ARTIFACT_EXISTS')
    }
    throw error
  }
}

export async function createAgentMuxRemoteArtifact(
  options: CreateAgentMuxRemoteArtifactOptions
): Promise<AgentMuxRemoteArtifact> {
  const platform = options.platform ?? currentPlatform()
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new AgentMuxError(`Remote artifact platform is unsupported: ${platform}.`, 'UNSUPPORTED_REMOTE_PLATFORM')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.buildIdentity)) {
    throw new AgentMuxError('Remote build identity contains unsupported characters.', 'INVALID_REMOTE_BUILD')
  }
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  const require = createRequire(import.meta.url)
  const nodePtyRoot = dirname(require.resolve('node-pty/package.json'))
  const nodePtyPrebuild = join(nodePtyRoot, 'prebuilds', platform)
  await Promise.all([
    requireFile(join(packageRoot, 'dist', 'agentmuxd.js'), 'Built agentmuxd entrypoint'),
    requireFile(join(packageRoot, 'bin', 'agentmuxd.js'), 'agentmuxd executable'),
    requireFile(join(nodePtyRoot, 'LICENSE'), 'node-pty license'),
    requireFile(join(nodePtyPrebuild, 'pty.node'), `node-pty ${platform} prebuild`)
  ])

  const outputPath = resolve(options.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await requireAbsent(outputPath)
  const temporaryOutputPath = join(
    dirname(outputPath),
    `.agentmux-artifact-${process.pid}-${randomUUID()}.tmp`
  )
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentmux-remote-artifact-'))
  const staging = join(temporaryRoot, 'staging')
  const deployedPackage = join(staging, 'package')
  const deployedNodePty = join(deployedPackage, 'node_modules', 'node-pty')
  try {
    await mkdir(deployedNodePty, { recursive: true })
    await Promise.all([
      cp(join(packageRoot, 'dist'), join(deployedPackage, 'dist'), { recursive: true }),
      cp(join(packageRoot, 'bin'), join(deployedPackage, 'bin'), { recursive: true }),
      cp(join(packageRoot, 'package.json'), join(deployedPackage, 'package.json')),
      cp(join(nodePtyRoot, 'package.json'), join(deployedNodePty, 'package.json')),
      cp(join(nodePtyRoot, 'LICENSE'), join(deployedNodePty, 'LICENSE')),
      cp(join(nodePtyRoot, 'lib'), join(deployedNodePty, 'lib'), { recursive: true }),
      cp(nodePtyPrebuild, join(deployedNodePty, 'prebuilds', platform), { recursive: true })
    ])
    if (platform.startsWith('darwin-')) {
      await chmod(join(deployedNodePty, 'prebuilds', platform, 'spawn-helper'), 0o755)
    }
    await writeFile(join(staging, 'agentmux-artifact.json'), `${JSON.stringify({
      schema: 'agentmux.remote-artifact.v1',
      buildIdentity: options.buildIdentity,
      platform,
      entrypoint: 'package/dist/agentmuxd.js'
    }, null, 2)}\n`, { mode: 0o600 })
    const result = await (options.runner ?? runProcess)('tar', [
      '-czf',
      temporaryOutputPath,
      '-C',
      staging,
      '.'
    ], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 })
    if (result.exitCode !== 0) {
      throw new CommandExecutionError(
        'Could not create the AgentMux remote artifact.',
        'tar',
        ['-czf', outputPath],
        result.exitCode,
        result.stderr
      )
    }
    await publish(outputPath, temporaryOutputPath)
    return { archivePath: outputPath, buildIdentity: options.buildIdentity, platform }
  } finally {
    await Promise.all([
      rm(temporaryRoot, { recursive: true, force: true }),
      rm(temporaryOutputPath, { force: true })
    ])
  }
}
