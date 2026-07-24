import { spawn as nodeSpawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AgentMuxClient } from './daemon-client.js'
import { AgentMuxError, CommandExecutionError } from './errors.js'
import { runProcess, type ProcessRunner } from './process-runner.js'
import {
  buildAgentMuxSshCommandArgs,
  SshAgentMuxDaemonConnector,
  type AgentMuxSshSpawn,
  type AgentMuxSshTarget
} from './ssh-daemon-connector.js'
import type { AgentMuxDaemonHello } from './daemon-protocol.js'

const MAX_INSTALL_COMMAND_OUTPUT_BYTES = 1024 * 1024
const REMOTE_ARTIFACT_MANIFEST = 'agentmux-artifact.json'
const REMOTE_AGENTMUX_ENTRY = 'package/dist/agentmuxd.js'
const REMOTE_LAYOUT_DIRECTORY = '.agentmux'

const PROBE_SCRIPT = [
  "const os=require('node:os')",
  "process.stdout.write(JSON.stringify({home:os.homedir(),platform:process.platform,arch:process.arch}))"
].join(';')

const VERIFY_ARTIFACT_SCRIPT = [
  "const fs=require('node:fs')",
  'const [path,buildIdentity,platform]=process.argv.slice(1)',
  "const value=JSON.parse(fs.readFileSync(path,'utf8'))",
  "if(value.schema==='agentmux.remote-artifact.v1'&&value.buildIdentity===buildIdentity&&value.platform===platform&&value.entrypoint==='package/dist/agentmuxd.js')process.exit(0)",
  'process.exit(42)'
].join(';')

const INSTALL_SCRIPT = `
set -eu
umask 077
base=$1
build=$2
node=$3
platform=$4
verify=$5
versions="$base/versions"
destination="$versions/$build"
stage="$base/.install-$build-$$"
mkdir -p "$versions"
chmod 700 "$base" "$versions"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir "$stage"
tar -xzf - -C "$stage"
test -f "$stage/${REMOTE_AGENTMUX_ENTRY}"
"$node" -e "$verify" "$stage/${REMOTE_ARTIFACT_MANIFEST}" "$build" "$platform"
if [ -e "$destination" ]; then
  test -f "$destination/${REMOTE_AGENTMUX_ENTRY}"
  "$node" -e "$verify" "$destination/${REMOTE_ARTIFACT_MANIFEST}" "$build" "$platform"
else
  mv "$stage" "$destination"
fi
`

const UNINSTALL_SCRIPT = `
set -eu
base=$1
build=$2
socket=$3
if [ -S "$socket" ]; then
  echo 'agentmuxd socket is still live or stale; refusing uninstall' >&2
  exit 73
fi
rm -rf "$base/versions/$build"
rm -f "$socket" "$socket.sessions.json"
`

export type AgentMuxRemotePlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'

export type AgentMuxRemoteArtifact = {
  archivePath: string
  buildIdentity: string
  platform: AgentMuxRemotePlatform
}

export type AgentMuxRemoteInstallation = {
  hostId: string
  buildIdentity: string
  platform: AgentMuxRemotePlatform
  remoteBaseDirectory: string
  remoteAgentMuxdPath: string
  remoteSocketPath: string
  remoteStatePath: string
}

export type AgentMuxSshRemoteDaemonOptions = {
  target: AgentMuxSshTarget
  remoteNodePath?: string
  sshCommand?: string
  localRunner?: ProcessRunner
  sshRunner?: ProcessRunner
  spawnProcess?: AgentMuxSshSpawn
}

type RemoteProbe = {
  home: string
  platform: 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
}

function safeBuildIdentity(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AgentMuxError('Remote build identity contains unsupported characters.', 'INVALID_REMOTE_BUILD')
  }
  return value
}

function parseProbe(output: string): RemoteProbe {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new AgentMuxError('Remote Node probe returned invalid JSON.', 'INVALID_REMOTE_PLATFORM')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Remote Node probe returned invalid data.', 'INVALID_REMOTE_PLATFORM')
  }
  const probe = value as Record<string, unknown>
  if (
    typeof probe.home !== 'string' || !probe.home.startsWith('/') || probe.home.includes('\0') ||
    (probe.platform !== 'linux' && probe.platform !== 'darwin') ||
    (probe.arch !== 'x64' && probe.arch !== 'arm64')
  ) {
    throw new AgentMuxError(
      `Remote platform is unsupported: ${String(probe.platform)}-${String(probe.arch)}.`,
      'UNSUPPORTED_REMOTE_PLATFORM'
    )
  }
  return probe as RemoteProbe
}

function parseJsonLine(output: string, context: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(output.trim())
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // The stable error below keeps raw remote output out of higher-level state.
  }
  throw new AgentMuxError(`${context} returned invalid JSON.`, 'INVALID_REMOTE_DAEMON_RESPONSE')
}

function assertRemoteIdentity(
  value: Record<string, unknown>,
  installation: AgentMuxRemoteInstallation
): AgentMuxDaemonHello {
  if (
    value.hostId !== installation.hostId ||
    value.buildIdentity !== installation.buildIdentity ||
    typeof value.protocolVersion !== 'number' ||
    typeof value.daemonPid !== 'number' ||
    typeof value.daemonInstanceId !== 'string'
  ) {
    throw new AgentMuxError('Remote daemon identity does not match the requested installation.', 'REMOTE_IDENTITY_MISMATCH')
  }
  return value as unknown as AgentMuxDaemonHello
}

export class AgentMuxSshRemoteDaemon {
  private readonly remoteNodePath: string
  private readonly sshCommand: string
  private readonly localRunner: ProcessRunner
  private readonly sshRunner: ProcessRunner
  private readonly spawnProcess: AgentMuxSshSpawn

  constructor(private readonly options: AgentMuxSshRemoteDaemonOptions) {
    this.remoteNodePath = options.remoteNodePath ?? 'node'
    this.sshCommand = options.sshCommand ?? 'ssh'
    this.localRunner = options.localRunner ?? runProcess
    this.sshRunner = options.sshRunner ?? runProcess
    this.spawnProcess = options.spawnProcess ?? nodeSpawn
  }

  async install(artifact: AgentMuxRemoteArtifact): Promise<AgentMuxRemoteInstallation> {
    safeBuildIdentity(artifact.buildIdentity)
    const archive = await stat(artifact.archivePath)
    if (!archive.isFile()) throw new AgentMuxError('Remote artifact must be a regular file.', 'INVALID_REMOTE_ARTIFACT')
    await this.validateArchiveEntries(artifact.archivePath)
    const probe = await this.probe()
    const platform = `${probe.platform}-${probe.arch}` as AgentMuxRemotePlatform
    if (platform !== artifact.platform) {
      throw new AgentMuxError(
        `Remote artifact platform mismatch: expected ${platform}, received ${artifact.platform}.`,
        'REMOTE_ARTIFACT_PLATFORM_MISMATCH'
      )
    }
    const installation = this.layout(probe, artifact.buildIdentity)
    const remoteArgs = buildAgentMuxSshCommandArgs(this.options.target, [
      'sh',
      '-c',
      INSTALL_SCRIPT,
      'agentmux-install',
      installation.remoteBaseDirectory,
      installation.buildIdentity,
      this.remoteNodePath,
      installation.platform,
      VERIFY_ARTIFACT_SCRIPT
    ])
    await this.streamArchive(artifact.archivePath, remoteArgs)
    return installation
  }

  async activate(installation: AgentMuxRemoteInstallation): Promise<AgentMuxDaemonHello> {
    this.assertInstallation(installation)
    const result = await this.runRemote([
      this.remoteNodePath,
      installation.remoteAgentMuxdPath,
      'activate',
      '--socket',
      installation.remoteSocketPath,
      '--state',
      installation.remoteStatePath,
      '--host-id',
      installation.hostId,
      '--build-id',
      installation.buildIdentity
    ])
    return assertRemoteIdentity(parseJsonLine(result.stdout, 'Remote daemon activation'), installation)
  }

  async audit(installation: AgentMuxRemoteInstallation): Promise<AgentMuxDaemonHello> {
    this.assertInstallation(installation)
    const result = await this.runRemote([
      this.remoteNodePath,
      installation.remoteAgentMuxdPath,
      'status',
      '--socket',
      installation.remoteSocketPath,
      '--host-id',
      installation.hostId,
      '--build-id',
      installation.buildIdentity
    ])
    return assertRemoteIdentity(parseJsonLine(result.stdout, 'Remote daemon status'), installation)
  }

  createClient(installation: AgentMuxRemoteInstallation): AgentMuxClient {
    this.assertInstallation(installation)
    return new AgentMuxClient({
      connector: new SshAgentMuxDaemonConnector({
        target: this.options.target,
        remoteNodePath: this.remoteNodePath,
        remoteAgentMuxdPath: installation.remoteAgentMuxdPath,
        remoteSocketPath: installation.remoteSocketPath,
        expectedBuildIdentity: installation.buildIdentity,
        sshCommand: this.sshCommand,
        spawnProcess: this.spawnProcess
      }),
      expectedHostId: installation.hostId,
      expectedBuildIdentity: installation.buildIdentity
    })
  }

  async shutdown(installation: AgentMuxRemoteInstallation): Promise<void> {
    this.assertInstallation(installation)
    await this.runRemote([
      this.remoteNodePath,
      installation.remoteAgentMuxdPath,
      'shutdown',
      '--socket',
      installation.remoteSocketPath,
      '--host-id',
      installation.hostId,
      '--build-id',
      installation.buildIdentity
    ])
  }

  async upgrade(
    artifact: AgentMuxRemoteArtifact,
    previous: AgentMuxRemoteInstallation
  ): Promise<AgentMuxRemoteInstallation> {
    this.assertInstallation(previous)
    const next = await this.install(artifact)
    await this.shutdown(previous)
    await this.activate(next)
    return next
  }

  async uninstall(installation: AgentMuxRemoteInstallation): Promise<void> {
    this.assertInstallation(installation)
    await this.shutdown(installation).catch(() => {})
    await this.runRemote([
      'sh',
      '-c',
      UNINSTALL_SCRIPT,
      'agentmux-uninstall',
      installation.remoteBaseDirectory,
      installation.buildIdentity,
      installation.remoteSocketPath
    ])
  }

  private async probe(): Promise<RemoteProbe> {
    const result = await this.runRemote([this.remoteNodePath, '-e', PROBE_SCRIPT])
    return parseProbe(result.stdout)
  }

  private layout(probe: RemoteProbe, buildIdentity: string): AgentMuxRemoteInstallation {
    const remoteBaseDirectory = posix.join(probe.home, REMOTE_LAYOUT_DIRECTORY)
    const remoteSocketPath = posix.join(remoteBaseDirectory, 'agentmuxd.sock')
    return {
      hostId: this.options.target.hostId,
      buildIdentity,
      platform: `${probe.platform}-${probe.arch}` as AgentMuxRemotePlatform,
      remoteBaseDirectory,
      remoteAgentMuxdPath: posix.join(remoteBaseDirectory, 'versions', buildIdentity, REMOTE_AGENTMUX_ENTRY),
      remoteSocketPath,
      remoteStatePath: `${remoteSocketPath}.sessions.json`
    }
  }

  private assertInstallation(installation: AgentMuxRemoteInstallation): void {
    const buildIdentity = safeBuildIdentity(installation.buildIdentity)
    const base = installation.remoteBaseDirectory
    if (
      installation.hostId !== this.options.target.hostId ||
      !base.startsWith('/') ||
      posix.basename(base) !== REMOTE_LAYOUT_DIRECTORY ||
      base.split('/').includes('..') ||
      installation.remoteAgentMuxdPath !== posix.join(base, 'versions', buildIdentity, REMOTE_AGENTMUX_ENTRY) ||
      installation.remoteSocketPath !== posix.join(base, 'agentmuxd.sock') ||
      installation.remoteStatePath !== `${installation.remoteSocketPath}.sessions.json`
    ) {
      throw new AgentMuxError('Remote installation is outside the managed AgentMux layout.', 'INVALID_REMOTE_INSTALLATION')
    }
  }

  private async validateArchiveEntries(path: string): Promise<void> {
    const result = await this.localRunner('tar', ['-tzf', path], {
      timeoutMs: 10_000,
      maxOutputBytes: MAX_INSTALL_COMMAND_OUTPUT_BYTES
    })
    if (result.exitCode !== 0) {
      throw new CommandExecutionError('Could not inspect remote artifact.', 'tar', ['-tzf', path], result.exitCode, result.stderr)
    }
    const entries = result.stdout.split(/\r?\n/).filter(Boolean)
    if (entries.length === 0 || entries.length > 10_000) {
      throw new AgentMuxError('Remote artifact has an invalid entry count.', 'INVALID_REMOTE_ARTIFACT')
    }
    for (const entry of entries) {
      const normalized = entry.replace(/^\.\//, '')
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new AgentMuxError('Remote artifact contains an unsafe path.', 'INVALID_REMOTE_ARTIFACT')
      }
    }
  }

  private async runRemote(remoteArgv: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const args = buildAgentMuxSshCommandArgs(this.options.target, remoteArgv)
    const result = await this.sshRunner(this.sshCommand, args, {
      timeoutMs: 20_000,
      maxOutputBytes: MAX_INSTALL_COMMAND_OUTPUT_BYTES
    })
    if (result.exitCode !== 0) {
      throw new CommandExecutionError('Remote AgentMux command failed.', this.sshCommand, args, result.exitCode, result.stderr)
    }
    return result
  }

  private async streamArchive(path: string, sshArgs: readonly string[]): Promise<void> {
    const child = this.spawnProcess(this.sshCommand, sshArgs, { stdio: 'pipe', windowsHide: true })
    let stdout = ''
    let stderr = ''
    let outputExceeded = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const append = (current: string, chunk: string): string => {
      if (outputExceeded) return current
      const next = current + chunk
      if (Buffer.byteLength(next) > MAX_INSTALL_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill()
        return current
      }
      return next
    }
    child.stdout.on('data', (chunk: string) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: string) => { stderr = append(stderr, chunk) })
    const exit = new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
    const upload = pipeline(createReadStream(path), child.stdin)
    const [uploadResult, exitResult] = await Promise.allSettled([upload, exit])
    if (outputExceeded) {
      throw new AgentMuxError('Remote install output exceeded its limit.', 'REMOTE_INSTALL_OUTPUT_LIMIT')
    }
    if (exitResult.status === 'rejected') throw exitResult.reason
    if (exitResult.value !== 0) {
      throw new CommandExecutionError('Remote artifact install failed.', this.sshCommand, sshArgs, exitResult.value, stderr)
    }
    if (uploadResult.status === 'rejected') throw uploadResult.reason
  }
}
