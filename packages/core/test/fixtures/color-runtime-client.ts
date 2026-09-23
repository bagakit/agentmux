import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentProviderRegistry, defineAgentProvider } from '../../src/agent-provider.js'

const [root, phase] = process.argv.slice(2) as [string, string]
const template = new AgentProviderRegistry().get('codex')
const { usage: _usage, ...capabilities } = template.catalog.capabilities
const provider = defineAgentProvider({
  catalog: { ...template.catalog, id: 'color-fixture', label: 'Color fixture', executable: process.execPath,
    expectedProcess: 'node', hookStrategy: { kind: 'none' },
    readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    capabilities },
  hook: { rules: [{ events: ['SessionStart'], state: 'working' }], nativeHandle: { sessionIdKeys: ['session_id'] },
    eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
  terminalHandshake: { query: '\x1b[?u', response: '\x1b[?0u' },
  buildArgs: (_prompt, args) => [...args],
  buildResumeArgs: (id, _path, prompt, args) => [...args, '--resume-id', id, '--prompt', prompt ?? '']
})
const client = new AgentMuxClient({ providers: [provider], store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
const id = 'private-color-agent', trace = join(root, 'agent.ndjson')
const args = [join(root, 'cli.mjs'), 'literal ; $(never) `never` * "$VALUE"', '-u', '--']
const environment = { AMX_COLOR_TRACE: trace, AMX_COLOR_NATIVE_ID: 'private-native-color' }
const facts = async (): Promise<any[]> => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000
  do { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < deadline)
  throw new Error(`Private color client did not observe ${phase} fact`)
}
try {
  await client.connect()
  const restored = client.agentSessions().map(session => ({ id: session.agentSessionId, run: session.run, nativeHandle: session.nativeHandle }))
  let session = phase === 'create'
    ? await client.createAgent({ agentSessionId: id, createOperationId: 'private-color-create', providerId: provider.id,
      executorId: 'color-fixture', workspacePath: root, commandOverride: process.execPath,
      args, env: environment, injectAgentMuxGuide: false })
    : client.agentSession(id)
  const originalRun = session.run
  if (phase === 'resume') session = await client.resumeAgent({ agentSessionId: id, operationId: 'private-color-resume', prompt: 'resume-color-private',
    commandOverride: process.execPath, args, env: environment })
  else if (phase === 'reattach') await client.reattachAgent(id, 0, 'terminal')
  const status = await waitFor(() => client.statusAgent(id), value => value.session.nativeHandle?.kind === 'provider')
  const observed = await waitFor(facts, entries => entries.some(entry => entry.type === 'ready' && entry.pid === status.run.pid))
  const raw = await client.readRunReplay(session.run, 0, 'raw')
  const terminal = await client.readRunReplay(session.run, 0, 'terminal')
  const rawText = raw.replay.map(chunk => Buffer.from(chunk.dataBytes).toString('utf8')).join('')
  let input: unknown = null, finalState: unknown = null
  if (phase === 'reattach') {
    input = await client.writeAgent({ agentSessionId: id, expectedRun: session.run,
      source: 'user', data: 'literal-input\r' })
    await waitFor(facts, entries => entries.some(entry => entry.type === 'input' && entry.input === 'literal-input'))
    await client.writeAgent({ agentSessionId: id, expectedRun: session.run,
      source: 'user', data: 'EXIT:23\r' })
    finalState = (await waitFor(() => client.statusAgent(id), value => value.run.state === 'exited')).run
  }
  process.stdout.write(JSON.stringify({ phase, processPid: process.pid, restored, originalRun,
    session: { id: status.session.agentSessionId, run: status.session.run, nativeHandle: status.session.nativeHandle,
      retiredRuns: status.session.retiredRuns }, run: status.run, input, finalState,
    observation: observed.find(entry => entry.type === 'start' && entry.pid === status.run.pid),
    hook: observed.find(entry => entry.type === 'hook' && entry.pid === status.run.pid),
    rawText, terminal: terminal.terminal.type === 'basic-vt' ? { ...terminal.terminal,
      restoreBytes: Buffer.from(terminal.terminal.restoreBytes).toString('base64') } : terminal.terminal }) + '\n')
} finally { await client.dispose() }
