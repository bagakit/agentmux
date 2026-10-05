import { fixtureDisplayPath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { inspectCodexPromptExecution } from '../src/providers/codex-prompt-execution.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

// The natural failure's complete bottom group, reduced to 80x24. Names and
// workspace are neutral; native columns, attributes and empty composer remain.
function pane(name = 'link_review', extra = '', draft = '') {
  const warning = '⚠ 5 warnings · f2 to view'
  return '\x1b[?2026h\x1b[2J\x1b[18;1H\x1b[2m•\x1b[22m Completed `' + name + '`' +
    '\x1b[21;1H› ' + (draft || '\x1b[2mAsk Codex to do anything\x1b[22m') +
    '\x1b[23;3HGPT-6.1-Sol high · ' + fixtureDisplayPath('project') + ' · Main [default]' +
    '\x1b[24;3H? for shortcuts' + `\x1b[24;${80 - warning.length}H` + warning +
    extra + '\x1b[21;3H\x1b[?2026l'
}

async function inspect(output: string) {
  const screen = new AgentTerminalScreen(80, 24)
  try {
    const dataBytes = Buffer.from(output)
    await screen.write({ startByte: 0, endByte: dataBytes.length, dataBytes })
    return inspectCodexPromptExecution(screen.snapshot(), 'native-steer')
  } finally { screen.dispose() }
}

it.each(['link_review', 'hook_check', 'question_audit', 'approval_notes', 'pending_compacting'])
('does not turn the completed name %s into a current control state', async name => {
  expect(await inspect(pane(name))).toBe('idle')
})

it.each([
  ['draft after cursor', pane('link_review', '\x1b[21;3HKEEP_DRAFT')],
  ['modal at composer', pane('link_review', '\x1b[21;1H\x1b[2K1. Choose an answer')],
  ['unknown footer', pane('link_review', '\x1b[24;1H\x1b[2KUNKNOWN_FOOTER')],
  ['current review', pane().replace('Completed `link_review`', 'Review (4s • esc to interrupt)')],
  ['current hooks', pane().replace('Completed `link_review`', 'Running hooks (4s)')],
  ['current compaction', pane().replace('Completed `link_review`', 'Compacting context (4s • esc to interrupt)')],
  ['native preview without its header', pane('link_review', '\x1b[19;1H\x1b[2m  ↳ KEEP_QUEUE\x1b[22m')]
])('preserves the %s refusal after a completed notification', async (_name, output) => {
  expect(await inspect(output)).toBe('unavailable')
})

// Real Core Coordinator, screen evidence, Provider inspector/plan and public
// socket/CLI. Only Runtime bytes/ACKs and native identity evidence are controlled.
async function clientFixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-completed-pane-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const record = { kind: 'agent' as const, agentSessionId: 'completed-pane', providerId: 'completed-control', executorId: 'completed-control',
    hostId: 'local', workspacePath: root, run: { runId: 'same-run' }, retiredRuns: [],
    hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 }
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, record)
  const original = new AgentProviderRegistry().get('codex')
  const { providerFork: _fork, ...capabilities } = original.catalog.capabilities
  const provider = defineAgentProvider({ catalog: { ...original.catalog, id: record.providerId,
    capabilities, hookStrategy: { kind: 'none' } }, hook: { rules: [] }, buildArgs: (_, args) => [...args],
    terminalPromptRender: original.terminalPromptRender!, planPromptInput: original.planPromptInput,
    inspectPromptExecution: original.inspectPromptExecution,
    readPromptExecutionEvidence: async () => ({ sourceId: 'same-source', id: 'idle', state: 'idle' }),
    verifyPromptExecutionTransport: async () => true })
  const client = new AgentMuxClient({ store, providers: [provider] }), owner = client as any
  await owner.registry.load('local'); owner.connected = true
  let inputByte = 0, outputByte = 0
  const writes: Array<{ operationId: string; data: string; expectedByte: number }> = []
  const listeners: Array<(event: unknown) => void> = []
  const history: Array<{ startByte: number; endByte: number; dataBytes: Buffer }> = []
  const draw = (draft = '') => {
    const dataBytes = Buffer.from(pane('link_review', '', draft)), startByte = outputByte
    outputByte += dataBytes.length
    const chunk = { startByte, endByte: outputByte, dataBytes }; history.push(chunk)
    for (const listener of listeners) listener({ type: 'data', ...chunk })
  }
  draw()
  const run = () => ({ nativeService: null, lifecycleOperationId: null, runId: record.run.runId,
    program: 'controlled', args: [], workspacePath: root, pid: 123, state: { type: 'running' },
    cols: 80, rows: 24, firstAvailableByte: 0, latestOutputBytes: outputByte, acceptedInputBytes: inputByte })
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'controlled', protocolVersion: 18, buildIdentity: 'controlled' })
  owner.kernel.status = async () => run()
  owner.kernel.disconnect = () => {}
  owner.kernel.stop = vi.fn()
  owner.kernel.observeOutput = async (_run: string, _byte: number, listener: (event: unknown) => void) => {
    listeners.push(listener)
    return { run: run(), resizeRevision: 0, gap: null, terminal: { type: 'not-requested' }, replay: [...history], close: async () => {} }
  }
  owner.kernel.replay = async () => ({ run: run(), gap: null, replay: [...history] })
  owner.kernel.input = async (_run: string, input: typeof writes[number]) => {
    expect(_run).toBe(record.run.runId); expect(input.expectedByte).toBe(inputByte)
    writes.push(input)
    const appliedByteRange = { startByte: inputByte, endByte: inputByte + Buffer.byteLength(input.data) }
    inputByte = appliedByteRange.endByte
    if (input.data !== '\r') draw(input.data.replace(/^\x1b\[200~/u, '').replace(/\x1b\[201~$/u, ''))
    return { run: run(), appliedByteRange }
  }
  return { client, owner, root, record, writes,
    close: async () => { await client.dispose(); await rm(root, { recursive: true, force: true }) } }
}

it('submits the same original SDK intent once through the real current-pane gate', async () => {
  const f = await clientFixture()
  try {
    await f.client.submitAgentPrompt({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run,
      afterSubmissionId: null, operationId: 'original-input', prompt: 'ORIGINAL_BODY', execution: 'immediate', authorHuman: true })
    expect(f.writes.map(write => write.data)).toEqual(['ORIGINAL_BODY', '\r'])
    expect(f.client.agentSession(f.record.agentSessionId).terminalPromptSubmission).toMatchObject({ submissionId: 'original-input',
      payload: { acknowledged: true }, submit: { acknowledged: true } })
    expect(f.owner.kernel.stop).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('delivers through the existing compiled CLI and actual public service without another sender', async () => {
  const f = await clientFixture()
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  try {
    await server.start()
    const cli = await runCompiledObjectCli(['agent', 'send', '--to-session', f.record.agentSessionId, '--text', 'CLI_BODY',
      '--execution', 'immediate', '--operation-id', 'original-cli-input'], objectCliEnvironment(f.root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result).toMatchObject({ sourceChannel: 'cli', delivery: { state: 'delivered' } })
    expect(f.writes).toHaveLength(2)
    expect(f.writes[0]!.data).toContain('CLI_BODY'); expect(f.writes[1]!.data).toBe('\r')
    expect(f.owner.kernel.stop).not.toHaveBeenCalled()
  } finally { await server.stop(); await f.close() }
})
