import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { connectAgentMuxRpc } from '../../../packages/core/dist/index.js'
import { connectHostedAgentMux } from '../../../packages/core/dist/hosted.js'
import { runRemoteDesktopProof } from './remote-runtime-native-proof.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/remote-runtime-restart', ("run-" + (globalThis.crypto.randomUUID()) + "")))
const privateRoot = await fs.mkdtemp(_hygiene_fixturePath("tmp/amx-rr-"))
const remoteDirectory = path.join(privateRoot, 'remote'), remoteState = path.join(privateRoot, 'remote-state')
const receipt = { schema: 'agentmux.remote-runtime-restart.v1', passed: false, transport: 'unix', userAppRunTouched: false,
  limitations: ['Actual private Headless CLI owner, public Runtime RPC, original Provider Session and official ctxmux Run across owner and two ordinary Electron process restarts.',
    'Only Desktop SSH transport selection is replaced by private Unix. This does not qualify SSH/Farm or a real Agent Provider.',
    'The repository Codex CLI fixture provides a real process/native identity. No remote Session, lifecycle fact or byte channel is simulated.'] }
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
  AGENTMUX_RUNTIME_DIRECTORY: remoteDirectory, AGENTMUX_STATE_DIRECTORY: remoteState,
  AGENTMUX_AGENT_SESSION_STORE: path.join(remoteState, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(remoteState, 'messages.ndjson') }
let server, client, currentOwner
const wait = async (read, accept, timeout = 20000) => {
  const deadline = Date.now() + timeout
  for (;;) { const value = await read(); if (accept(value)) return value
    if (Date.now() > deadline) throw Error('Private remote Runtime observation timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
const stopOwner = async () => {
  if (server && server.exitCode === null && server.signalCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit }
}
const startOwner = async () => {
  server = spawn(process.execPath, [path.join(root, 'packages/core/dist/headless-runtime-cli.js'), 'serve'], { cwd: privateRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  currentOwner = await new Promise((resolve, reject) => {
    let output = '', errors = ''
    const timer = setTimeout(() => reject(Error('Private Headless readiness timed out: ' + errors)), 30000)
    server.stderr.on('data', data => { errors += String(data) })
    server.stdout.on('data', data => { output += String(data); if (!output.includes('\n')) return
      clearTimeout(timer); try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))) } catch (error) { reject(error) } })
    server.once('error', error => { clearTimeout(timer); reject(error) })
    server.once('exit', code => { clearTimeout(timer); reject(Error(`Private owner exited ${code}: ${errors}`)) })
  })
  return currentOwner
}
await fs.mkdir(evidence, { recursive: true })
try {
  await fs.mkdir(remoteDirectory, { mode: 0o700 }); await fs.mkdir(remoteState, { mode: 0o700 })
  await fs.mkdir(path.join(privateRoot, 'workspace')); await fs.mkdir(path.join(privateRoot, 'codex'))
  const command = path.join(privateRoot, 'fake-codex-cli.mjs')
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), command); await fs.chmod(command, 0o755)
  await startOwner()
  const originalOwner = currentOwner.owner
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: currentOwner.socketPath } })
  try {
    client = await connectHostedAgentMux({ rpc, expectedRuntimeId: currentOwner.owner.runtimeId })
    const dispose = client.dispose.bind(client)
    client.dispose = async () => { try { await dispose() } finally { await rpc.dispose() } }
  } catch (error) { await rpc.dispose(); throw error }
  const session = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: path.join(privateRoot, 'workspace'),
    commandOverride: command, createOperationId: 'private-native-recovery-create', injectAgentMuxGuide: false,
    env: { CODEX_HOME: path.join(privateRoot, 'codex'), AGENTMUX_FAKE_READY_MODE: 'before' } })
  const original = await client.reattachAgent(session.agentSessionId, 0, 'terminal')
  const native = await wait(() => client.agentSession(session.agentSessionId), value => Boolean(value.nativeHandle) && value.semanticStatus?.state === 'done')
  const splitRun = await client.createTerminal({ createOperationId: 'private-native-split-terminal', workspacePath: path.join(privateRoot, 'workspace'),
    command: process.execPath, args: ['-e', "process.stdout.write('ORIGINAL_SPLIT_TERMINAL\\r\\n');process.stdin.resume();"], cols: 100, rows: 20 })
  const remoteHost = { id: 'private-remote', kind: 'ssh', label: 'Private remote Runtime', hostname: 'private-owner.fixture',
    remoteCommand: 'agentmux-runtime', remoteSocketPath: currentOwner.socketPath, runtimeId: originalOwner.runtimeId }
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local Runtime' }, remoteHost],
    executors: { codex: { label: 'Private native CLI fixture', providerId: 'codex', command, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'original-remote-workspace', name: 'Original remote workbench', hostId: remoteHost.id, path: path.join(privateRoot, 'workspace'), kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const input = { schema: 'agentmux.remote-runtime-native-input.v1', remoteEndpoint: { transport: 'unix', path: currentOwner.socketPath }, config,
    inputProbe: { kind: 'fixture-marker', text: 'z', marker: 'codex-composer-rendered:' },
    splitTerminal: { sessionId: splitRun.runId, runId: splitRun.runId, pid: splitRun.pid, tabId: 'original-terminal-tab',
      regionId: 'original-terminal-region', workspaceId: config.workspaces[0].id },
    identity: { runtimeId: originalOwner.runtimeId, hostId: remoteHost.id, workspaceId: config.workspaces[0].id,
      tabId: 'original-remote-tab', regionId: 'original-remote-agent', sessionId: session.agentSessionId,
      run: session.run, pid: original.attachment.run.pid, nativeHandle: native.nativeHandle } }
  receipt.originalIdentity = input.identity
  receipt.native = await runRemoteDesktopProof({ privateRoot, evidence, input, ownerCommand: async operation => {
    if (operation === 'stop') { await stopOwner(); return { stopped: true } }
    await startOwner(); assert.equal(currentOwner.owner.runtimeId, originalOwner.runtimeId)
    return currentOwner.owner
  } })
  const status = await client.statusAgent(session.agentSessionId)
  assert.deepEqual([status.session.agentSessionId, status.run.runId, status.run.pid, status.session.nativeHandle],
    [input.identity.sessionId, input.identity.run.runId, input.identity.pid, input.identity.nativeHandle])
  receipt.survivingIdentity = { sessionId: status.session.agentSessionId, run: status.run, nativeHandle: status.session.nativeHandle }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try { if (client) for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId }) }
  catch (error) { errors.push(error.message) }
  try { await client?.dispose() } catch (error) { errors.push(error.message) }
  try { await stopOwner(); await stopProbeProcesses(process.pid + 1000000000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: await listProbeProcesses(-1, privateRoot), temporaryRootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.temporaryRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.deepEqual(receipt.cleanup.errors, []); assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: path.join(evidence, 'receipt.json'), sessionId: receipt.originalIdentity.sessionId }))
