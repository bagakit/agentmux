import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  connectLocalAgentMux,
  connectSshAgentMux,
  diagnoseAgentMux
} from '@agentmux/core'
import * as AgentMuxPackage from '@agentmux/core'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const runtimeDirectory = join(root, 'runtime')
const socketPath = join(runtimeDirectory, 'agentmuxd.sock')
const statePath = join(runtimeDirectory, 'agentmuxd.state.json')
const remoteHome = process.env.AGENTMUX_FAKE_SSH_HOME
const fakeSshPath = join(root, 'fake-system-ssh.mjs')
const fakeAgentPath = join(root, 'fake-agent.mjs')
const coreIndex = fileURLToPath(import.meta.resolve('@agentmux/core'))
const agentmuxdPath = resolve(dirname(coreIndex), '../bin/agentmuxd.js')
let local = null
let remote = null
let remoteRuntime = null

async function waitFor(description, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function shutdownLocal() {
  await execFileAsync(process.execPath, [
    agentmuxdPath,
    'shutdown',
    '--socket',
    socketPath,
    '--host-id',
    'local',
    '--build-id',
    '0.1.0'
  ]).catch(() => {})
}

try {
  if (!remoteHome) throw new Error('Packed Consumer remote home is missing.')
  for (const retiredExport of [
    'AgentMuxDaemonClient',
    'AgentMuxSshRemoteDaemon',
    'SshAgentMuxDaemonConnector',
    'activateAgentMuxLocalDaemon',
    'createAgentMuxRemoteArtifact'
  ]) {
    if (retiredExport in AgentMuxPackage) throw new Error(`Retired public export is still available: ${retiredExport}`)
  }
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory, 0o700)
  await writeFile(fakeAgentPath, [
    "process.stdout.write(`packed-agent:${process.argv.slice(2).join('|')}\\n`)",
    'process.stdin.resume()'
  ].join('\n'))

  local = await connectLocalAgentMux({ endpointPath: socketPath, statePath })
  const localEvents = []
  local.onEvent((event) => localEvents.push(event))
  const terminal = await local.createTerminal({
    runId: 'packed-terminal',
    createOperationId: 'packed-terminal-create',
    workspacePath: root
  })
  await local.writeTerminal(terminal, "printf 'packed-terminal-ready\\n'\n")
  await waitFor('packed Terminal output', () => localEvents.some((event) => (
    event.type === 'terminal-output' && event.data.includes('packed-terminal-ready')
  )))
  const agent = await local.createAgent({
    agentSessionId: 'packed-agent',
    runId: 'packed-agent-run',
    createOperationId: 'packed-agent-create',
    agentId: 'codex',
    workspacePath: root,
    commandOverride: process.execPath,
    args: [fakeAgentPath],
    prompt: 'clean-consumer'
  })
  await waitFor('packed Agent output', () => localEvents.some((event) => (
    event.type === 'terminal-output' && event.data.includes('packed-agent:clean-consumer')
  )))
  const commandOverrides = Object.fromEntries(local.catalog().map((entry) => [entry.id, process.execPath]))
  const localDoctor = await diagnoseAgentMux({
    client: local,
    hostKind: 'local',
    commandOverrides
  })
  if (!localDoctor.ok) throw new Error('Packed Local doctor did not pass.')
  if (localDoctor.runtime?.pty.version !== '1.2.0-beta.15') throw new Error('Packed PTY version is wrong.')

  const remoteSocketPath = join(remoteHome, 'agentmuxd.sock')
  const remoteStatePath = join(remoteHome, 'agentmuxd.state.json')
  let remoteOutput = ''
  remoteRuntime = spawn(process.execPath, [
    agentmuxdPath,
    'serve',
    '--socket',
    remoteSocketPath,
    '--state',
    remoteStatePath,
    '--host-id',
    'packed-remote',
    '--build-id',
    '0.1.0'
  ], {
    env: { ...process.env, HOME: remoteHome },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  remoteRuntime.stdout.setEncoding('utf8')
  remoteRuntime.stdout.on('data', (chunk) => { remoteOutput += chunk })
  await waitFor('packed Remote Runtime readiness', () => remoteOutput.includes('"type":"ready"'))
  remote = await connectSshAgentMux({
    target: { hostId: 'packed-remote', hostname: 'fixture.example' },
    runtime: {
      buildIdentity: '0.1.0',
      remoteNodePath: process.execPath,
      remoteEntrypointPath: agentmuxdPath,
      remoteEndpointPath: remoteSocketPath
    },
    sshCommand: fakeSshPath
  })
  const remoteTerminal = await remote.createTerminal({
    runId: 'packed-remote-terminal',
    createOperationId: 'packed-remote-create',
    workspacePath: root
  })
  const remoteDoctor = await diagnoseAgentMux({
    client: remote,
    hostKind: 'ssh',
    commandOverrides
  })
  if (!remoteDoctor.ok || remoteDoctor.host.hostId !== 'packed-remote') {
    throw new Error('Packed SSH doctor did not pass.')
  }

  await remote.stopTerminal(remoteTerminal)
  await local.stopAgent(agent.agentSessionId)
  await local.stopTerminal(terminal)
  const packageRoot = resolve(dirname(coreIndex), '..')
  process.stdout.write(`${JSON.stringify({
    local: localDoctor.host,
    remote: remoteDoctor.host,
    pty: localDoctor.runtime.pty,
    packageRoot
  })}\n`)
} finally {
  await remote?.dispose().catch(() => {})
  if (remoteRuntime && remoteRuntime.exitCode === null && remoteRuntime.signalCode === null) {
    remoteRuntime.kill('SIGTERM')
    await once(remoteRuntime, 'exit').catch(() => {})
  }
  await local?.dispose().catch(() => {})
  await shutdownLocal()
}
