import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentProviderPreparedPromptTransport, AgentProviderPromptExecutionContext } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

/** Public Client and real coordinator/store; Runtime bytes are explicitly synthetic here. */
async function fixture() {
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored = (id: string): AgentMuxStoredAgentSession => ({ kind: 'agent', agentSessionId: id, providerId: 'fixture',
    executorId: 'fixture', hostId: 'local', workspacePath: upstreamFixturePath("private/preparation"), run: { runId: `${id}-run` },
    retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 })
  await store.compareAndSwap(null, stored('prepare'))
  await store.compareAndSwap(null, stored('healthy'))
  const template = new AgentProviderRegistry().get('codex')
  let source = 'source-1', pid = 123, cursor = 0, recheck = true, lostAck = false
  let verifyCount = 0, statusesAfterVerify = 0, finalStatusFault: string | undefined
  let rawDuringFinalStatus: Promise<unknown> | undefined
  const screen = new AgentTerminalScreen(80, 24)
  const draw = async (text = '') => {
    const bytes = Buffer.from(`\x1b[?2026h\x1b[2J\x1b[10;1H> ${text}\x1b[10;${3 + text.length}H\x1b[?2026l`)
    await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.length, dataBytes: bytes })
  }
  await draw()
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  const preparation = vi.fn(async (context: AgentProviderPromptExecutionContext & { signal: AbortSignal }): Promise<AgentProviderPreparedPromptTransport> => {
    started(); await ready
    context.signal.throwIfAborted()
    return { nativeSourceId: 'source-1', verifyCurrentTransport: async () => { verifyCount++; statusesAfterVerify = 0; return recheck } }
  })
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'fixture', hookStrategy: { kind: 'native', installation: 'unmanaged' } },
    buildArgs: (_, args) => [...args], hook: { rules: [] }, terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: (text, context) => ({ kind: 'render-then-submit', payload: text, renderedText: text, submit: '\r',
      ...(context?.execution === 'immediate' ? { prepare: { refresh: '\x1b[I', interrupt: '\x1b', endEvent: 'Interrupt' } } : {}) }),
    readPromptExecutionEvidence: async () => ({ sourceId: source, id: 'initial', state: 'idle' }),
    verifyPromptExecutionTransport: async () => recheck,
    preparePromptExecutionTransport: preparation,
    inspectPromptExecution: snapshot => snapshot.lines[snapshot.cursor.row]?.text.trimEnd() === '>' ? 'idle' : 'unavailable' })
  const client = new AgentMuxClient({ store, providers: [provider] })
  const owner = client as unknown as { connected: boolean; registry: { load(host: string): Promise<void> };
    kernel: Record<string, unknown>; screenEvidence: { wait: (...args: unknown[]) => Promise<number>; generation: () => number } }
  await owner.registry.load('local')
  const writes: Array<{ run: string; data: string }> = [], receipts = new Map<string, { startByte: number; endByte: number }>()
  const run = (id = 'prepare-run') => ({ nativeService: null, runId: id, lifecycleOperationId: null,
    program: 'fixture', args: [], workspacePath: upstreamFixturePath("private/preparation"), pid, state: { type: 'running' as const },
    cols: 80, rows: 24, latestOutputBytes: screen.throughByte, firstAvailableByte: 0, acceptedInputBytes: id === 'prepare-run' ? cursor : 0 })
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'prepare-daemon', protocolVersion: 1, buildIdentity: 'test' })
  owner.kernel.status = async (id: string) => {
    if (verifyCount === 2 && ++statusesAfterVerify === 2) {
      if (finalStatusFault === 'cursor') cursor++
      if (finalStatusFault === 'pid') pid++
      if (finalStatusFault === 'raw-cancel') rawDuringFinalStatus = client.writeAgent({ agentSessionId: 'prepare',
        expectedRun: { runId: 'prepare-run' }, data: 'RAW_AT_FINAL_BOUNDARY', source: 'user' })
    }
    return run(id)
  }
  owner.kernel.input = async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
    const old = receipts.get(op.operationId)
    if (old) return { run: run(id), appliedByteRange: old }
    if (id === 'prepare-run' && cursor !== op.expectedByte) throw new AgentMuxError('cursor changed', 'CTXMUX_input_cursor_mismatch', 'not_applied')
    const range = { startByte: op.expectedByte, endByte: op.expectedByte + Buffer.byteLength(op.data) }
    if (id === 'prepare-run') cursor = range.endByte
    receipts.set(op.operationId, range); writes.push({ run: id, data: op.data })
    if (id === 'prepare-run' && op.data !== '\r') await draw(op.data === '\x1b[I' ? '' : op.data)
    if (lostAck && op.data === '\x1b[I') { lostAck = false; throw new AgentMuxError('lost original refresh ACK', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
    return { run: run(id), appliedByteRange: range }
  }
  owner.screenEvidence.wait = async (...args: unknown[]) => {
    const inspect = args[3] as (screen: AgentTerminalScreen) => boolean
    if (!inspect(screen)) throw new AgentMuxError('screen unavailable', 'AGENT_PROMPT_RENDER_TIMEOUT')
    return screen.throughByte
  }
  owner.screenEvidence.generation = () => 0
  owner.connected = true
  const submit = (signal?: AbortSignal) => client.submitAgentPrompt({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' },
    afterSubmissionId: null, operationId: 'original-send', prompt: 'ORIGINAL_BODY', execution: 'immediate', ...(signal ? { signal } : {}) })
  return { client, provider, preparation, entered, release, writes, submit,
    finalStatusFault: (kind: string) => { finalStatusFault = kind }, rawDuringFinalStatus: () => rawDuringFinalStatus,
    change: (kind: string) => { if (kind === 'source') source = 'source-other'; if (kind === 'pid') pid++; if (kind === 'cursor') cursor++;
      if (kind === 'final') recheck = false; if (kind === 'lost-ack') lostAck = true },
    close: async () => { release(); screen.dispose(); await client.dispose() } }
}

describe('original immediate transport preparation', () => {
  it('waits before any input, then sends the original body once and rejoins its ACK without preparing again', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit(); await f.entered
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      f.release(); await submitted
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', 'ORIGINAL_BODY', '\r'])
      await f.submit()
      expect(f.preparation).toHaveBeenCalledTimes(1)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })

  it.each(['source', 'pid', 'cursor', 'final'])('rejects changed %s before the first possible input', async kind => {
    const f = await fixture()
    try {
      const submitted = f.submit(); const result = expect(submitted).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      await f.entered; f.change(kind); f.release(); await result
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it.each(['cursor', 'pid', 'raw-cancel'])('does not adopt a new %s authorization at the final refresh claim boundary', async kind => {
    const f = await fixture()
    try {
      f.finalStatusFault(kind); f.release()
      await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      await f.rawDuringFinalStatus()
      expect(f.writes.map(write => write.data)).toEqual(kind === 'raw-cancel' ? ['RAW_AT_FINAL_BOUNDARY'] : [])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('allows another healthy Run while this preparation remains pending', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit(); await f.entered
      await f.client.writeAgent({ agentSessionId: 'healthy', expectedRun: { runId: 'healthy-run' }, data: 'HEALTHY_RAW', source: 'user' })
      expect(f.writes).toEqual([{ run: 'healthy-run', data: 'HEALTHY_RAW' }])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      f.release(); await submitted
      expect(f.writes.map(write => write.data)).toEqual(['HEALTHY_RAW', '\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })

  it('allows same-Run raw input during unknown preparation and cancels the original body without waiting', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit().then(() => 'sent', () => 'cancelled'); await f.entered
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'RAW_WHILE_WAITING', source: 'user' })
      expect(await submitted).toBe('cancelled')
      expect(f.writes.map(write => write.data)).toEqual(['RAW_WHILE_WAITING'])
      f.release(); await Promise.resolve()
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('public cancellation abandons an uncooperative Provider observation without taking the byte lane', async () => {
    const f = await fixture(), cancel = new AbortController()
    try {
      const submitted = f.submit(cancel.signal).then(() => 'sent', () => 'cancelled'); await f.entered
      cancel.abort(); expect(await submitted).toBe('cancelled')
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'AFTER_CANCEL', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['AFTER_CANCEL'])
    } finally { await f.close() }
  })

  it('bounds an uncooperative read-only preparation and keeps ordinary input usable after timeout', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const submitted = f.submit().then(() => 'sent', () => 'timed-out'); await f.entered
      await vi.advanceTimersByTimeAsync(40_001)
      expect(await submitted).toBe('timed-out')
      expect(f.writes).toEqual([])
      vi.useRealTimers()
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'AFTER_TIMEOUT', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['AFTER_TIMEOUT'])
    } finally { vi.useRealTimers(); await f.close() }
  })

  it('cancels an uncooperative final verifier before any Input claim', async () => {
    const f = await fixture(), cancel = new AbortController()
    let entered!: () => void
    const verifying = new Promise<void>(resolve => { entered = resolve })
    f.preparation.mockImplementation(async () => ({ nativeSourceId: 'source-1', verifyCurrentTransport: async () => {
      entered(); return await new Promise<boolean>(() => {})
    } }))
    try {
      const submitted = f.submit(cancel.signal).then(() => 'sent', () => 'cancelled')
      await verifying; cancel.abort()
      expect(await submitted).toBe('cancelled')
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'AFTER_FINAL_CANCEL', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['AFTER_FINAL_CANCEL'])
    } finally { await f.close() }
  })

  it('rejoins an original unknown refresh receipt without starting another preparation or repeating its bytes', async () => {
    const f = await fixture()
    try {
      f.change('lost-ack'); f.release()
      await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I'])
      await f.submit()
      expect(f.preparation).toHaveBeenCalledTimes(1)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })
})
