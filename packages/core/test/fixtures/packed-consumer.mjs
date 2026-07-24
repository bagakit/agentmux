import { execFile } from 'node:child_process'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  AgentMuxClient,
  AgentMuxSshRemoteDaemon,
  activateAgentMuxLocalDaemon,
  createAgentMuxRemoteArtifact,
  diagnoseAgentMux
} from '@agentmux/core'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const runtimeDirectory = join(root, 'runtime')
const socketPath = join(runtimeDirectory, 'agentmuxd.sock')
const statePath = join(runtimeDirectory, 'agentmuxd.state.json')
const remoteHome = process.env.AGENTMUX_FAKE_SSH_HOME
const fakeSshPath = join(root, 'fake-system-ssh.mjs')
const fakeAgentPath = join(root, 'fake-agent.mjs')
const artifactPath = join(root, 'agentmux-remote.tgz')
const coreIndex = fileURLToPath(import.meta.resolve('@agentmux/core'))
const agentmuxdPath = resolve(dirname(coreIndex), '../bin/agentmuxd.js')
const local = new AgentMuxClient({ socketPath })
let remoteManager = null
let remoteInstallation = null
let remote = null

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
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory, 0o700)
  await writeFile(fakeAgentPath, [
    "process.stdout.write(`packed-agent:${process.argv.slice(2).join('|')}\\n`)",
    'process.stdin.resume()'
  ].join('\n'))

  await activateAgentMuxLocalDaemon({ socketPath, statePath })
  await local.connect()
  const localEvents = []
  local.onEvent((event) => localEvents.push(event))
  const terminal = await local.createTerminal({
    sessionId: 'packed-terminal',
    createOperationId: 'packed-terminal-create',
    cwd: root
  })
  await local.writeTerminal(terminal, "printf 'packed-terminal-ready\\n'\n")
  await waitFor('packed Terminal output', () => localEvents.some((event) => (
    event.type === 'terminal-output' && event.data.includes('packed-terminal-ready')
  )))
  const agent = await local.createAgent({
    semanticSessionId: 'packed-agent',
    daemonSessionId: 'packed-agent-run',
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

  const artifact = await createAgentMuxRemoteArtifact({
    outputPath: artifactPath,
    buildIdentity: 'packed-consumer'
  })
  remoteManager = new AgentMuxSshRemoteDaemon({
    target: { hostId: 'packed-remote', hostname: 'fixture.example' },
    sshCommand: fakeSshPath
  })
  remoteInstallation = await remoteManager.install(artifact)
  await remoteManager.activate(remoteInstallation)
  remote = remoteManager.createClient(remoteInstallation)
  await remote.connect()
  const remoteTerminal = await remote.createTerminal({
    sessionId: 'packed-remote-terminal',
    createOperationId: 'packed-remote-create',
    cwd: root
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
  await local.stopAgent(agent.semanticSessionId)
  await local.stopTerminal(terminal)
  const packageRoot = resolve(dirname(coreIndex), '..')
  process.stdout.write(`${JSON.stringify({
    local: localDoctor.host,
    remote: remoteDoctor.host,
    pty: localDoctor.runtime.pty,
    packageRoot,
    artifactBytes: (await stat(artifactPath)).size
  })}\n`)
} finally {
  await remote?.dispose().catch(() => {})
  if (remoteManager && remoteInstallation) await remoteManager.uninstall(remoteInstallation).catch(() => {})
  await local.dispose().catch(() => {})
  await shutdownLocal()
}
