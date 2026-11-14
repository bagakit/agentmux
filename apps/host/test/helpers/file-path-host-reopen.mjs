import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const c = JSON.parse(await readFile(process.argv[2], 'utf8'))
for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete process.env[key]
process.env.AGENTMUX_STATE_DIRECTORY = c.stateDirectory
process.env.AGENTMUX_RUNTIME_DIRECTORY = c.runtimeDirectory
process.env.AGENTMUX_WORKSPACE_MOVE_HELPER = c.helper
const { startAgentMuxHost, AgentMuxClient, AgentMuxFileAgentSessionStore, OrdinaryWorkspaceFiles } = await import(pathToFileURL(c.entry).href)
// The actual Core registry/authentication/semantic lease is reopened. Runtime
// bytes are the same deterministic fixture port, never an installed daemon.
AgentMuxClient.prototype.connect = async function () {
  await this.registry.load('local'); this.connected = true
  this.kernel.isConnected = () => true
  this.kernel.identity = () => ({ daemonInstanceId: 'fixture-runtime', protocolVersion: 1, buildIdentity: 'fixture' })
  this.kernel.listPage = async () => ({ runs: [], nextCursor: null })
  this.kernel.status = async runId => ({ runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: c.runtimeDirectory,
    pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 3, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
}
let mkdirCalls = 0
const original = OrdinaryWorkspaceFiles.prototype.mkdirPath
OrdinaryWorkspaceFiles.prototype.mkdirPath = async function (...args) { mkdirCalls++; return original.apply(this, args) }
let host
try {
  host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(c.storePath), configurationPath: c.configurationPath,
    socketPath: c.socketPath, desktopSocketPath: c.desktopSocketPath, mobileBuildDirectory: c.mobileBuildDirectory })
  await host.client.connect()
  process.on('message', async message => {
    if (message?.type === 'stats') process.send?.({ type: 'stats', pid: process.pid, mkdirCalls })
    if (message?.type === 'stop') { await host.dispose(); process.exit(0) }
  })
  process.send?.({ type: 'ready', pid: process.pid, socketPath: c.socketPath })
} catch (cause) {
  process.stderr.write(JSON.stringify({ code: cause.code, message: cause.message }) + '\n')
  if (host) await host.dispose()
  process.exit(1)
}
