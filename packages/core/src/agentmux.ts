#!/usr/bin/env node
import process from 'node:process'
import { AgentMuxClient } from './client.js'
import { diagnoseAgentMux, type AgentMuxDoctorReport } from './doctor.js'
import { defaultAgentMuxDaemonSocketPath } from './daemon-endpoint.js'
import {
  AGENTMUX_DAEMON_BUILD_IDENTITY,
  AGENTMUX_LOCAL_HOST_ID
} from './daemon-protocol.js'
import { AgentMuxError } from './errors.js'
import { activateAgentMuxLocalDaemon } from './local-daemon.js'
import { createAgentMuxRemoteArtifact } from './remote-artifact-builder.js'
import {
  SshAgentMuxDaemonConnector,
  type AgentMuxSshTarget
} from './ssh-daemon-connector.js'
import type { AgentMuxRemotePlatform } from './ssh-remote-daemon.js'

const USAGE = [
  'Usage:',
  '  agentmux doctor [--activate] [--socket <path>] [--json]',
  '  agentmux doctor --ssh-host <hostname> --host-id <id> --build-id <id>',
  '    --remote-agentmuxd <absolute-path> --remote-socket <absolute-path>',
  '    [--remote-node <path>] [--ssh-user <user>] [--ssh-port <port>]',
  '    [--identity-file <path>] [--ssh-command <path>] [--json]',
  '  agentmux artifact create --output <archive.tgz> --build-id <id>',
  '    [--platform <darwin-arm64|darwin-x64|linux-arm64|linux-x64>] [--json]'
].join('\n')

type ParsedFlags = {
  values: Map<string, string>
  booleans: Set<string>
}

function parseFlags(args: readonly string[], booleanFlags: ReadonlySet<string>): ParsedFlags {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag?.startsWith('--')) throw new AgentMuxError(USAGE, 'INVALID_CLI_ARGUMENT')
    if (values.has(flag) || booleans.has(flag)) {
      throw new AgentMuxError(`Duplicate option: ${flag}`, 'INVALID_CLI_ARGUMENT')
    }
    if (booleanFlags.has(flag)) {
      booleans.add(flag)
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new AgentMuxError(`Missing value for ${flag}.`, 'INVALID_CLI_ARGUMENT')
    values.set(flag, value)
    index += 1
  }
  return { values, booleans }
}

function requireFlag(flags: ParsedFlags, name: string): string {
  const value = flags.values.get(name)
  if (!value) throw new AgentMuxError(`Missing required option: ${name}`, 'INVALID_CLI_ARGUMENT')
  return value
}

function assertAllowed(flags: ParsedFlags, allowed: ReadonlySet<string>): void {
  for (const flag of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowed.has(flag)) throw new AgentMuxError(`Unsupported option: ${flag}`, 'INVALID_CLI_ARGUMENT')
  }
}

function hasAny(flags: ParsedFlags, names: readonly string[]): boolean {
  return names.some((name) => flags.values.has(name) || flags.booleans.has(name))
}

function port(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new AgentMuxError('SSH port must be an integer from 1 to 65535.', 'INVALID_SSH_PORT')
  }
  return parsed
}

function printDoctor(report: AgentMuxDoctorReport): void {
  process.stdout.write(`AgentMux doctor: ${report.ok ? 'PASS' : 'FAIL'}\n`)
  if (report.host.reachable) {
    process.stdout.write(
      `Host (${report.host.kind}): ${report.host.hostId} · build ${report.host.buildIdentity} · protocol ${report.host.protocolVersion}\n`
    )
  } else {
    process.stdout.write(`Host (${report.host.kind}): unavailable · ${report.host.error}\n`)
  }
  if (report.runtime) {
    process.stdout.write(
      `Runtime: Node ${report.runtime.nodeVersion} · ${report.runtime.platform}-${report.runtime.arch} · ${report.runtime.supported ? 'supported' : 'unsupported'}\n`
    )
    process.stdout.write(
      `PTY: ${report.runtime.pty.packageName}@${report.runtime.pty.version} · ${report.runtime.pty.artifact} · ${report.runtime.pty.ready ? 'ready' : 'invalid'}\n`
    )
  } else {
    process.stdout.write('Runtime: not inspected because the Host is unavailable\n')
  }
  if (report.runtimeAction) process.stdout.write(`Action: ${report.runtimeAction}\n`)
  process.stdout.write('Agents:\n')
  for (const agent of report.agents) {
    process.stdout.write(
      `  ${agent.probe === 'found' ? 'OK' : agent.probe === 'missing' ? 'WARN' : 'BLOCKED'} ${agent.label} (${agent.executable}) · Hook ${agent.hook.kind} · Permission ${agent.permission} · ACP ${agent.acp.kind}\n`
    )
    if (agent.action) process.stdout.write(`    Action: ${agent.action}\n`)
  }
  process.stdout.write(
    `Integration: Hook ${report.integration.hookInstallation}; permission default ${report.integration.permissionDefault}; semantic evidence ${report.integration.semanticEvidence}\n`
  )
  if (report.host.action) process.stdout.write(`Action: ${report.host.action}\n`)
}

async function doctor(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, new Set(['--activate', '--json']))
  assertAllowed(flags, new Set([
    '--activate',
    '--json',
    '--socket',
    '--state',
    '--host-id',
    '--build-id',
    '--ssh-host',
    '--ssh-user',
    '--ssh-port',
    '--identity-file',
    '--ssh-command',
    '--remote-node',
    '--remote-agentmuxd',
    '--remote-socket'
  ]))
  let client: AgentMuxClient
  let hostKind: 'local' | 'ssh'
  if (flags.values.has('--ssh-host')) {
    if (hasAny(flags, ['--activate', '--socket', '--state'])) {
      throw new AgentMuxError('Local daemon options cannot be combined with --ssh-host.', 'INVALID_CLI_ARGUMENT')
    }
    const sshUser = flags.values.get('--ssh-user')
    const sshPort = port(flags.values.get('--ssh-port'))
    const identityFile = flags.values.get('--identity-file')
    const sshCommand = flags.values.get('--ssh-command')
    const target: AgentMuxSshTarget = {
      hostId: requireFlag(flags, '--host-id'),
      hostname: requireFlag(flags, '--ssh-host'),
      ...(sshUser === undefined ? {} : { user: sshUser }),
      ...(sshPort === undefined ? {} : { port: sshPort }),
      ...(identityFile === undefined ? {} : { identityFile })
    }
    client = new AgentMuxClient({
      connector: new SshAgentMuxDaemonConnector({
        target,
        remoteNodePath: flags.values.get('--remote-node') ?? 'node',
        remoteAgentMuxdPath: requireFlag(flags, '--remote-agentmuxd'),
        remoteSocketPath: requireFlag(flags, '--remote-socket'),
        expectedBuildIdentity: requireFlag(flags, '--build-id'),
        ...(sshCommand === undefined ? {} : { sshCommand })
      })
    })
    hostKind = 'ssh'
  } else {
    if (hasAny(flags, [
      '--ssh-user',
      '--ssh-port',
      '--identity-file',
      '--ssh-command',
      '--remote-node',
      '--remote-agentmuxd',
      '--remote-socket'
    ])) {
      throw new AgentMuxError('SSH options require --ssh-host.', 'INVALID_CLI_ARGUMENT')
    }
    const socketPath = flags.values.get('--socket') ?? defaultAgentMuxDaemonSocketPath()
    const hostId = flags.values.get('--host-id') ?? AGENTMUX_LOCAL_HOST_ID
    const buildIdentity = flags.values.get('--build-id') ?? AGENTMUX_DAEMON_BUILD_IDENTITY
    if (flags.booleans.has('--activate')) {
      const statePath = flags.values.get('--state')
      await activateAgentMuxLocalDaemon({
        socketPath,
        ...(statePath === undefined ? {} : { statePath }),
        hostId,
        buildIdentity
      })
    }
    client = new AgentMuxClient({ socketPath, expectedHostId: hostId, expectedBuildIdentity: buildIdentity })
    hostKind = 'local'
  }
  try {
    const report = await diagnoseAgentMux({ client, hostKind })
    if (flags.booleans.has('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else printDoctor(report)
    return report.ok ? 0 : 1
  } finally {
    await client.dispose()
  }
}

async function artifact(args: readonly string[]): Promise<number> {
  if (args[0] !== 'create') throw new AgentMuxError(USAGE, 'INVALID_CLI_ARGUMENT')
  const flags = parseFlags(args.slice(1), new Set(['--json']))
  assertAllowed(flags, new Set(['--output', '--build-id', '--platform', '--json']))
  const created = await createAgentMuxRemoteArtifact({
    outputPath: requireFlag(flags, '--output'),
    buildIdentity: requireFlag(flags, '--build-id'),
    ...(flags.values.get('--platform')
      ? { platform: flags.values.get('--platform') as AgentMuxRemotePlatform }
      : {})
  })
  if (flags.booleans.has('--json')) process.stdout.write(`${JSON.stringify(created, null, 2)}\n`)
  else process.stdout.write(`Created ${created.archivePath} for ${created.platform} (${created.buildIdentity})\n`)
  return 0
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args[0] === 'doctor') return await doctor(args.slice(1))
  if (args[0] === 'artifact') return await artifact(args.slice(1))
  throw new AgentMuxError(USAGE, 'INVALID_CLI_ARGUMENT')
}

void main().then((exitCode) => {
  process.exitCode = exitCode
}, (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
