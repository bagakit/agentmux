import { fileURLToPath } from 'node:url'
import {
  AGENTMUX_DAEMON_BUILD_IDENTITY,
  AGENTMUX_LOCAL_HOST_ID,
  type AgentMuxDaemonHello
} from './daemon-protocol.js'
import { agentMuxDaemonStatePath, defaultAgentMuxDaemonSocketPath } from './daemon-endpoint.js'
import { AgentMuxError, CommandExecutionError } from './errors.js'
import { runProcess, type ProcessRunner } from './process-runner.js'

export type AgentMuxLocalDaemonOptions = {
  socketPath?: string
  statePath?: string
  hostId?: string
  buildIdentity?: string
  runner?: ProcessRunner
}

function parseHello(output: string, expected: { hostId: string; buildIdentity: string }): AgentMuxDaemonHello {
  let value: unknown
  try {
    value = JSON.parse(output.trim())
  } catch {
    throw new AgentMuxError('Local daemon activation returned invalid JSON.', 'INVALID_DAEMON_RESPONSE')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Local daemon activation returned invalid data.', 'INVALID_DAEMON_RESPONSE')
  }
  const hello = value as Record<string, unknown>
  if (
    hello.hostId !== expected.hostId ||
    hello.buildIdentity !== expected.buildIdentity ||
    typeof hello.protocolVersion !== 'number' ||
    typeof hello.daemonPid !== 'number' ||
    typeof hello.daemonInstanceId !== 'string'
  ) {
    throw new AgentMuxError('Local daemon identity does not match the requested runtime.', 'DAEMON_IDENTITY_MISMATCH')
  }
  return hello as unknown as AgentMuxDaemonHello
}

export async function activateAgentMuxLocalDaemon(
  options: AgentMuxLocalDaemonOptions = {}
): Promise<AgentMuxDaemonHello> {
  const socketPath = options.socketPath ?? defaultAgentMuxDaemonSocketPath()
  const statePath = options.statePath ?? agentMuxDaemonStatePath(socketPath)
  const hostId = options.hostId ?? AGENTMUX_LOCAL_HOST_ID
  const buildIdentity = options.buildIdentity ?? AGENTMUX_DAEMON_BUILD_IDENTITY
  const entry = fileURLToPath(new URL('./agentmuxd.js', import.meta.url))
  const runner = options.runner ?? runProcess
  const result = await runner(process.execPath, [
    entry,
    'activate',
    '--socket',
    socketPath,
    '--state',
    statePath,
    '--host-id',
    hostId,
    '--build-id',
    buildIdentity
  ], {
    timeoutMs: 12_000,
    maxOutputBytes: 64 * 1024,
    ...(typeof process.versions.electron === 'string'
      ? { env: { ELECTRON_RUN_AS_NODE: '1' } }
      : {})
  })
  if (result.exitCode !== 0) {
    throw new CommandExecutionError(
      'Could not activate the local AgentMux daemon.',
      process.execPath,
      [entry, 'activate'],
      result.exitCode,
      result.stderr
    )
  }
  return parseHello(result.stdout, { hostId, buildIdentity })
}
