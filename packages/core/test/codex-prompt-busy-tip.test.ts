import { fixtureDisplayPath, fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { inspectCodexPromptExecution } from '../src/providers/codex-prompt-execution.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'

// Native bottom-pane bytes retain the captured status/tip columns and styles.
// Only the row positions and footer dimensions are reduced for these controls.
const header = '\x1b[13;1H\x1b[1m•\x1b[13;3H\x1b[22m\x1b[2mWorking (4h 15m 48s • \x1b[22m\x1b[1mesc\x1b[22m\x1b[2m to interrupt)'
const tip = '\x1b[14;3H└ \x1b[22m\x1b[1mTip:\x1b[22m You can resume a previous conversation by running codex resume'
const composer = '\x1b[17;1H\x1b[1m›\x1b[17;3H\x1b[22m\x1b[2mAsk Codex to do anything\x1b[22m'
const footer = ("\u001b[19;3HGPT-6.1-Sol xhigh · " + (fixtureDisplayPath("project")) + " · Main [default]")
const shortcut = '\x1b[20;3H\x1b[1m?\x1b[22m\x1b[2m for shortcuts\x1b[22m'
const warning = '\x1b[24;3H\x1b[22m\x1b[1m?\x1b[22m for shortcuts' +
  '\x1b[24;95H⚠\x1b[24;97H4 warnings\x1b[24;108H·\x1b[24;110H\x1b[1mf2\x1b[24;113H\x1b[22mto\x1b[24;116Hview'
const body = header + tip + composer + footer + shortcut
const frame = (output: string, cursorColumn = 3) => `\x1b[?2026h\x1b[2J${output}\x1b[0m\x1b[17;${cursorColumn}H\x1b[?2026l`

async function inspect(output: string) {
  const screen = new AgentTerminalScreen(120, 24)
  try {
    const bytes = Buffer.from(frame(output))
    await screen.write({ startByte: 0, endByte: bytes.length, dataBytes: bytes })
    return inspectCodexPromptExecution(screen.snapshot())
  } finally { screen.dispose() }
}

describe('the native busy header and its subordinate tip', () => {
  it('keeps the captured complete busy/tip group interruptible', async () => {
    expect(await inspect(body)).toBe('interruptible')
  })
  it('keeps that group interruptible with the native warning footer', async () => {
    expect(await inspect(header + tip + composer + footer.replace('[19;', '[23;') + warning)).toBe('interruptible')
  })
  it.each([
    ['unknown subordinate detail', body.replace('Tip:', 'NOTE:')],
    ['wrong indentation', body.replace('[14;3H', '[14;4H')],
    ['a non-dim branch marker', body.replace('[14;3H', '[14;3H\x1b[22m')],
    ['a dim tip instead of the captured native tip', body.replace('1mTip:', '1m\x1b[2mTip:')],
    ['a wrapped tip', body.replace('You can resume', 'KEEP_DETAIL '.repeat(20))],
    ['a wrapped busy header', body.replace(header, '\x1b[12;1H' + 'x'.repeat(120) + header.replace('\x1b[13;1H', ''))],
    ['a nonadjacent header', body.replaceAll('[13;', '[12;')],
    ['a clipped header', body.replaceAll('[13;', '[8;').replace('[14;3H', '[9;3H')],
    ['a nonadjacent composer', body.replaceAll('[14;', '[15;')],
    ['a tip without a busy header', body.replace(header, '\x1b[13;1HWorked for 4s')],
    ['a remapped interrupt key', body.replace('esc', 'f12')],
    ['a native review', body.replace('Working', 'Review')],
    ['a native hook', body.replace('Working', 'Hook')],
    ['a native draft', body + '\x1b[17;3H\x1b[22mKEEP_DRAFT'],
    ['native pending input', body + '\x1b[15;1H\x1b[22m• Messages to be submitted after next tool call\x1b[16;1H  ↳ KEEP_QUEUE'],
    ['a modal row', body + '\x1b[18;1H\x1b[22m1. Approve request'],
    ['an unknown footer', body + '\x1b[21;1HKEEP_UNKNOWN']
  ])('does not treat %s as idle or interruptible', async (_name, output) => {
    expect(await inspect(output)).toBe('unavailable')
  })
})

// Actual public Client/coordinator/store and actual Provider inspector/plan.
// Runtime ACK and native evidence below are controlled, not a genuine CLI proof.
async function controlledClient(output: string, authenticatedTurn = true) {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'busy-tip', providerId: 'tip-control', executorId: 'control',
    hostId: 'local', workspacePath: fixturePath("private/tip-control"), run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'control-binding', hookToken: 'control-token', createdAt: 1, updatedAt: 1 })
  const original = new AgentProviderRegistry().get('codex')
  const { providerFork: _fork, ...capabilities } = original.catalog.capabilities
  const screen = new AgentTerminalScreen(120, 24)
  const draw = async (pane: string, cursorColumn = 3) => {
    const bytes = Buffer.from(frame(pane, cursorColumn))
    await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.length, dataBytes: bytes })
  }
  await draw(output)
  let working = true, cursor = 0
  const writes: Array<{ operationId: string; data: string; expectedByte: number }> = []
  const provider = defineAgentProvider({ catalog: { ...original.catalog, capabilities: { ...capabilities, promptExecution: {immediate: 'interrupt-before-input'} }, id: 'tip-control', hookStrategy: { kind: 'native', installation: 'unmanaged' } },
    buildArgs: (_, args) => [...args], hook: { rules: [] }, terminalPromptRender: original.terminalPromptRender!,
    planPromptInput: (prompt, context) => ({...original.planPromptInput(prompt), ...(context?.execution === 'immediate' ? {prepare: {refresh: '\x1b[I',interrupt: '\x1b',endEvent: 'Interrupt'}} : {})}), inspectPromptExecution: inspectCodexPromptExecution,
    preparePromptExecutionTransport: async () => ({ nativeSourceId: 'original-source', verifyCurrentTransport: async () => true }),
    verifyPromptExecutionTransport: async () => true,
    readPromptExecutionEvidence: async () => ({ sourceId: 'original-source', id: working ? 'original-working' : 'original-end',
      ...(authenticatedTurn ? { nativeTurnId: 'original-turn' } : {}),
      state: working ? 'working' as const : 'ended' as const, ...(!working ? { endReason: 'interrupted' as const } : {}) }) })
  const client = new AgentMuxClient({ store, providers: [provider] })
  const owner = client as unknown as { connected: boolean; registry: { load(host: string): Promise<void> };
    kernel: Record<string, unknown>; screenEvidence: { wait: (...args: unknown[]) => Promise<number>; generation: () => number } }
  await owner.registry.load('local')
  const run = () => ({ nativeService: null, runId: 'original-run', lifecycleOperationId: null,
    program: 'control', args: [], workspacePath: fixturePath("private/tip-control"), pid: 123, state: { type: 'running' as const },
    cols: 120, rows: 24, latestOutputBytes: screen.throughByte, firstAvailableByte: 0, acceptedInputBytes: cursor })
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'tip-control', protocolVersion: 1, buildIdentity: 'control' })
  owner.kernel.status = async () => run()
  owner.kernel.input = async (_run: string, request: { operationId: string; expectedByte: number; data: string }) => {
    expect(request.expectedByte).toBe(cursor)
    const startByte = cursor
    cursor += Buffer.byteLength(request.data)
    writes.push(request)
    if (request.data === '\x1b[I') await draw(output)
    else if (request.data === '\x1b') {
      working = false
      await draw('\x1b[14;1HWorked for 4s' + composer + footer + shortcut)
    } else if (request.data !== '\r') {
      const text = request.data.replace(/\x1b\[20[01]~/gu, '')
      await draw(`\x1b[17;1H› ${text}` + footer + shortcut, text.length + 3)
    }
    return { run: run(), appliedByteRange: { startByte, endByte: cursor } }
  }
  owner.screenEvidence.wait = async (...args: unknown[]) => {
    if (!(args[3] as (screen: AgentTerminalScreen) => boolean)(screen)) throw new AgentMuxError('Controlled screen unavailable', 'AGENT_PROMPT_RENDER_TIMEOUT')
    return screen.throughByte
  }
  owner.screenEvidence.generation = () => 0
  owner.connected = true
  const submit = () => client.submitAgentPrompt({ agentSessionId: 'busy-tip', expectedRun: { runId: 'original-run' },
    operationId: 'original-operation', afterSubmissionId: null, prompt: 'ORIGINAL_BODY', execution: 'immediate', allowUncertainTurn: true })
  return { client, writes, submit, close: async () => { screen.dispose(); await client.dispose() } }
}

describe('public immediate input consumes the native busy/tip inspector', () => {
  it('interrupts the original authenticated busy turn before one original payload and submit', async () => {
    const control = await controlledClient(body)
    try {
      await control.submit()
      expect(control.writes.map(write => write.data)).toEqual(['\x1b[I', '\x1b', 'ORIGINAL_BODY', '\r'])
      const observed = await control.client.refreshAgentSession('busy-tip', { runId: 'original-run' })
      expect(observed.promptCompletionAdmission?.submissionId).toBe('original-operation')
      expect(observed.terminalPromptSubmission?.prepare?.context).toBe('interruptible')
      await control.submit()
      expect(control.writes).toHaveLength(4)
    } finally { await control.close() }
  })
  it('does not authorize interruption without the authenticated original turn', async () => {
    const control = await controlledClient(body, false)
    try {
      await expect(control.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      expect(control.writes.map(write => write.data)).toEqual(['\x1b[I'])
    } finally { await control.close() }
  })
  it('does not send an original payload through an ambiguous subordinate detail', async () => {
    const control = await controlledClient(body.replace('Tip:', 'NOTE:'))
    try {
      await expect(control.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      expect(control.writes.map(write => write.data)).toEqual(['\x1b[I'])
    } finally { await control.close() }
  })
})
