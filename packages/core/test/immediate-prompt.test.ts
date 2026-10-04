import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentMuxError } from '../src/errors.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import type { AgentPromptExecutionEvidence, AgentMuxStoredAgentSession, AgentMuxClientEvent } from '../src/types.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'

async function fixture(interrupt = '\x1b', endEvent = 'Interrupt', refresh?: string, strategy: 'interrupt-before-input' | 'native-steer' = 'interrupt-before-input') {
  let stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-immediate', providerId: 'fixture', executorId: 'fixture',
    hostId: 'local', workspacePath: fixturePath("private/workspace"), run: { runId: 'private-run' }, retiredRuns: [], hookBindingId: 'b', hookToken: 't', createdAt: 1, updatedAt: 1,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 } }
  const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store)
  await registry.put(stored)
  const screen = new AgentTerminalScreen(100, 30)
  const draw = async (text = '', busy = true) => {
    const bytes = Buffer.from(`\x1b[?2026h\x1b[2J\x1b[10;1H${busy ? 'working' : 'idle'}\x1b[15;1H> ${text}\x1b[15;${3+text.length}H\x1b[?2026l`)
    await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.length, dataBytes: bytes })
  }
  await draw()
  let native: AgentPromptExecutionEvidence | null = { sourceId: 'private-native', id: 'started', nativeTurnId: 'turn-1', state: 'working' }
  const template = new AgentProviderRegistry().get('codex')
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'fixture', capabilities: { ...template.catalog.capabilities, promptExecution: { immediate: strategy } }, hookStrategy: { kind: 'native', installation: 'unmanaged' } },
    buildArgs: (_, args) => [...args], hook: { rules: [] }, terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: (prompt, context) => ({ kind: 'render-then-submit', payload: prompt, renderedText: prompt, submit: '\r',
      ...(context?.execution === 'immediate' && strategy === 'interrupt-before-input' ? { prepare: { interrupt, endEvent, ...(refresh ? { refresh } : {}) } } : {}) }),
    verifyPromptExecutionTransport: async () => {
      if (sourceDrift) native = { ...native!, sourceId: 'replaced-native-source' }
      return transport
    },
    readPromptExecutionEvidence: async () => {
      if (resizeDuringRead && screenEvidence.wait.mock.calls.length) { generation++; resizeDuringRead = false }
      return native
    },
    inspectPromptExecution: snapshot => {
      const line = snapshot.lines[snapshot.cursor.row]
      if (line?.text.trimEnd() !== '>') return 'unavailable'
      return snapshot.lines[9]?.text === 'working' ? 'interruptible' : 'idle'
    } })
  const providers = new AgentProviderRegistry([provider]), events: AgentMuxClientEvent[] = [], publisher = new AgentMuxClientEventPublisher()
  publisher.onEvent(event => events.push(event))
  let cursor = 0, transport = true, loseRefreshAck = false, loseInterruptAck = false, wrongEnd = false, race = false, sourceDrift = false
  const receipt = new Map<string, { startByte: number; endByte: number }>(), writes: string[] = []
  const run = () => ({ runId: 'private-run', nativeService: null, lifecycleOperationId: null, program: 'fixture', args: [], workspacePath: fixturePath("private/workspace"), pid: 123,
    state: { type: 'running' as const }, cols: 100, rows: 30, latestOutputBytes: screen.throughByte, firstAvailableByte: 0, acceptedInputBytes: cursor })
  const kernel = { identity: () => ({ daemonInstanceId: 'private-daemon' }), status: async () => run(),
    input: vi.fn(async (_id: string, operation: { expectedByte: number; operationId: string; data: string }) => {
      const old = receipt.get(operation.operationId)
      if (old) return { run: run(), appliedByteRange: old }
      if (race) { race = false; cursor++; }
      if (cursor !== operation.expectedByte) throw new AgentMuxError('private cursor mismatch', 'CTXMUX_input_cursor_mismatch', 'not_applied')
      writes.push(operation.data)
      const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(operation.data) }
      cursor = range.endByte; receipt.set(operation.operationId, range)
      if (operation.data === refresh) {
        await draw(screen.snapshot().lines[14]!.text.slice(2), native?.state === 'working')
        if (loseRefreshAck) { loseRefreshAck = false; throw new AgentMuxError('private lost refresh ACK', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
      } else if (operation.data === interrupt) {
        native = { sourceId: 'private-native', id: 'cancelled', nativeTurnId: wrongEnd ? 'turn-other' : 'turn-1', state: 'ended', endReason: 'interrupted' }
        await draw('', false)
        if (loseInterruptAck) { loseInterruptAck = false; throw new AgentMuxError('private lost interrupt ACK', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
      } else if (operation.data !== '\r') await draw(operation.data, strategy === 'native-steer')
      else if (strategy === 'native-steer') await draw('', true)
      return { run: run(), appliedByteRange: range }
    }) }
  let generation = 0, resizeDuringRead = false
  const screenEvidence = { generation: () => generation, wait: vi.fn(async (...args: Parameters<AgentScreenEvidenceStore['wait']>) => {
    if (!args[3](screen)) throw new AgentMuxError('private screen unconfirmed', 'AGENT_PROMPT_RENDER_TIMEOUT')
    return screen.throughByte
  }) }
  const coordinator = () => new AgentPromptSubmissionCoordinator({ store, registry, providers, publisher, kernel: kernel as never,
    screenEvidence: screenEvidence as never, agentInputCursors: new Map(), requireAgentSession: id => registry.get(id), assertAgentRun: () => {},
    updateExactAgentSession: (id, expectedRun, update) => registry.update(id, expectedRun, update) })
  let owner = coordinator()
  const initialCondition = agentPromptCondition(stored)
  const submit = (execution: 'default' | 'immediate' = 'immediate', operationId = 'owned', condition = initialCondition) => {
    stored = registry.get(stored.agentSessionId)
    return owner.submitInputPlan(stored, run(), operationId, 'ONLY_AUTHORIZED_MESSAGE', provider.planPromptInput('ONLY_AUTHORIZED_MESSAGE', { execution }),
      condition, undefined, undefined, true, undefined, undefined, { userContent: 'ONLY_AUTHORIZED_MESSAGE' }, execution)
  }
  return { registry, store, screen, writes, kernel, submit, run, events, draw, coordinator, screenEvidence, provider,
    restart: () => { owner = coordinator() }, native: (evidence: AgentPromptExecutionEvidence | null) => { native = evidence },
    fault: (kind: string) => { if (kind === 'external-resize') resizeDuringRead = true; if (kind === 'refresh-ack') loseRefreshAck = true; if (kind === 'ack') loseInterruptAck = true; if (kind === 'turn') wrongEnd = true; if (kind === 'race') race = true; if (kind === 'transport') transport = false; if (kind === 'source') sourceDrift = true } }
}

describe('single authorized native immediate preparation', () => {
  it('refuses a source replacement between native transport proof and preparation before any input', async () => {
    const f = await fixture();try {
      f.fault('source');await expect(f.submit()).rejects.toMatchObject({code:'AGENT_PROMPT_PREPARATION_FAILED',controlFailure:{disposition:'not_applied',confirmedInputBytes:0}})
      expect(f.writes).toEqual([]); expect(f.kernel.input).not.toHaveBeenCalled()
      await f.submit('default','healthy-ordinary');expect(f.writes).toEqual(['ONLY_AUTHORIZED_MESSAGE','\r'])
    }finally{f.screen.dispose()}
  })
  it.each([['\x1b', 'Interrupt'], ['\x04', 'native_halted']])('interrupts before payload through generic protocol %s', async (interrupt, event) => {
    const f = await fixture(interrupt, event)
    try {
      await f.submit()
      expect(f.writes).toEqual([interrupt, 'ONLY_AUTHORIZED_MESSAGE', '\r'])
      const stored = normalizeStoredAgentSession(f.registry.get('private-immediate'))
      expect(stored.promptCompletionAdmission?.intent?.execution).toBe('immediate')
      expect(stored.terminalPromptSubmission?.prepare).toMatchObject({ nativeTurnId: 'turn-1', nativeSourceId: 'private-native',
        barrierReceiptId: 'cancelled', interrupt: { acknowledged: true } })
      expect(stored.terminalPromptSubmission?.submit.acknowledged).toBe(true)
      expect(stored.run.runId).toBe('private-run')
      await f.submit()
      expect(f.writes).toEqual([interrupt, 'ONLY_AUTHORIZED_MESSAGE', '\r'])
      await expect(f.submit('default')).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    } finally { f.screen.dispose() }
  })
  it('joins the frozen interrupt receipt after a lost ACK and cold coordinator without replaying its bytes', async () => {
    const f = await fixture();try {
      f.fault('ack');await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      expect(f.writes).toEqual(['\x1b']);expect(f.registry.get('private-immediate').terminalPromptSubmission?.prepare?.interrupt?.acknowledged).toBe(false)
      f.restart();await f.submit();expect(f.writes).toEqual(['\x1b','ONLY_AUTHORIZED_MESSAGE','\r'])
    } finally { f.screen.dispose() }
  })
  it('sends from verified idle without interrupting', async () => {
    const f=await fixture();try {
      await f.draw('',false);f.native({sourceId:'private-native',id:'done',nativeTurnId:'turn-1',state:'ended',endReason:'completed'})
      await f.submit();expect(f.writes).toEqual(['ONLY_AUTHORIZED_MESSAGE','\r'])
      expect(f.registry.get('private-immediate').terminalPromptSubmission?.prepare).toMatchObject({context:'idle'})
    } finally {f.screen.dispose()}
  })
  it.each(['draft','transport','native-unknown'])('keeps %s and ordinary healthy input before any preparation claim', async kind => {
    const f=await fixture();try {
      if(kind==='draft')await f.draw('UNAUTHORIZED_DRAFT',true)
      if(kind==='transport')f.fault('transport')
      if(kind==='native-unknown')f.native(null)
      await expect(f.submit()).rejects.toMatchObject({code:'AGENT_PROMPT_PREPARATION_FAILED',controlFailure:{disposition:'not_applied',confirmedInputBytes:0}})
      expect(f.writes).toEqual([]);expect(f.kernel.input).not.toHaveBeenCalled();expect(f.registry.get('private-immediate').promptCompletionAdmission).toBeUndefined()
      expect(f.registry.get('private-immediate').terminalPromptDelivery?.reason).toBe('immediate-context-unconfirmed')
      await f.submit('default','ordinary');expect(f.writes).toEqual(['ONLY_AUTHORIZED_MESSAGE','\r'])
    } finally {f.screen.dispose()}
  })
  it('rejects an intervening exact input fence without emitting Escape', async()=>{
    const f=await fixture();try {f.fault('race');await expect(f.submit()).rejects.toMatchObject({code:'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED'})
      expect(f.writes).toEqual([]);expect(f.registry.get('private-immediate').terminalPromptSubmission?.prepare?.interrupt?.notApplied).toBe(true)
    }finally{f.screen.dispose()}
  })
  it('never appends owned payload after a different native turn ended',async()=>{
    const f=await fixture();try {f.fault('turn');await expect(f.submit()).rejects.toMatchObject({code:'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED'})
      expect(f.writes).toEqual(['\x1b']);expect(f.registry.get('private-immediate').terminalPromptSubmission?.submit.acknowledged).toBe(false)
    }finally{f.screen.dispose()}
  })
})


describe('explicit Provider-owned non-submitting refresh', () => {
 it.each(['\x1b[I', '\x05'])('freezes and rejoins one refresh %s after lost ACK before interrupting', async refresh => {
  const f = await fixture('\x1b', 'Interrupt', refresh)
  try {
   f.fault('refresh-ack'); await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
   const frozen = normalizeStoredAgentSession(f.registry.get('private-immediate')).promptCompletionAdmission!
   expect(frozen.frameRefresh).toMatchObject({ acknowledged: false, nativeSourceId: 'private-native', resizeRevision: 0, inputByteRange: { startByte: 0, endByte: Buffer.byteLength(refresh) } })
   expect(f.writes).toEqual([refresh]); expect(f.registry.get('private-immediate').terminalPromptSubmission).toBeUndefined()
   f.restart(); await f.submit()
   expect(f.writes).toEqual([refresh, '\x1b', 'ONLY_AUTHORIZED_MESSAGE', '\r'])
   const settled = normalizeStoredAgentSession(f.registry.get('private-immediate'))
   expect(settled.promptCompletionAdmission!.frameRefresh).toMatchObject({ ...frozen.frameRefresh, acknowledged: true })
   expect(settled.terminalPromptSubmission!.prepare!.interrupt!.inputByteRange.startByte).toBe(Buffer.byteLength(refresh))
   const finalWait = f.screenEvidence.wait.mock.calls.find(call => call[4].checkpointFrameFence && call[4].requireCompleteFrame)
   expect(finalWait?.[4]).toMatchObject({ requireCompleteFrame: true, requireFrameAfterBoundary: true })
   await f.submit(); expect(f.writes).toHaveLength(4)
  } finally { f.screen.dispose() }
 })
 it('keeps a draft after refresh and permits ordinary input with its current condition', async () => {
  const f = await fixture('\x1b', 'Interrupt', '\x1b[I')
  try {
   await f.draw('UNAUTHORIZED_DRAFT', true)
   await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
   expect(f.writes).toEqual(['\x1b[I']); expect(f.screen.composerText('>')).toBe('UNAUTHORIZED_DRAFT')
   expect(f.registry.get('private-immediate').promptCompletionAdmission!.frameRefresh!.acknowledged).toBe(true)
   await f.submit('default', 'ordinary', agentPromptCondition(f.registry.get('private-immediate')))
   expect(f.writes).toEqual(['\x1b[I', 'ONLY_AUTHORIZED_MESSAGE', '\r'])
  } finally { f.screen.dispose() }
 })
 it('rejects changed geometry after refresh before emitting interrupt or owned payload', async () => {
  const f = await fixture('\x1b', 'Interrupt', '\x1b[I')
  try {
   const input = f.kernel.input.getMockImplementation()!
   f.kernel.input.mockImplementation(async (...args) => {
    const result = await input(...args)
    if(args[1].data === '\x1b[I' && f.screen.geometryRevision === 0) f.screen.resize(100, 30, f.screen.throughByte, 1)
    return result
   })
   await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
   expect(f.writes).toEqual(['\x1b[I'])
   await f.submit(); expect(f.writes).toEqual(['\x1b[I', '\x1b[I', '\x1b', 'ONLY_AUTHORIZED_MESSAGE', '\r'])
   expect(f.registry.get('private-immediate').promptCompletionAdmission!.frameRefresh!.resizeRevision).toBe(1)
  } finally { f.screen.dispose() }
 })
 it('refuses automatic refresh authorization before any native input', async () => {
  const f = await fixture('\x1b', 'Interrupt', '\x1b[I')
  try {
   const s = f.registry.get('private-immediate')
   await expect(f.coordinator().submitInputPlan(s, f.run(), 'automatic', 'ONLY_AUTHORIZED_MESSAGE', f.provider.planPromptInput('ONLY_AUTHORIZED_MESSAGE', { execution: 'immediate' }), agentPromptCondition(s), 'completed', undefined, true, undefined, 0, undefined, 'immediate')).rejects.toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
   expect(f.writes).toEqual([]); expect(f.kernel.input).not.toHaveBeenCalled()
  } finally { f.screen.dispose() }
 })
})


it('rejects a public Runtime resize between native screen observation and admission', async () => {
 const f=await fixture('\x1b', 'Interrupt', '\x1b[I')
 try {
  f.fault('external-resize'); await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
  expect(f.writes).toEqual(['\x1b[I']); expect(f.registry.get('private-immediate').terminalPromptSubmission).toBeUndefined()
  await f.submit('default','ordinary',agentPromptCondition(f.registry.get('private-immediate')))
  expect(f.writes).toEqual(['\x1b[I', 'ONLY_AUTHORIZED_MESSAGE', '\r'])
 } finally { f.screen.dispose() }
})

it('cold interruption recovery carries its durable geometry fence without a second refresh', async () => {
 const f=await fixture('\x1b', 'Interrupt', '\x1b[I')
 try {
  f.fault('ack'); await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
  const frozen=f.registry.get('private-immediate')
  f.screenEvidence.wait.mockImplementation(async (...args: Parameters<AgentScreenEvidenceStore['wait']>) => {
   if(args[4].timeoutMessage==='Native interruption or empty composer is unconfirmed.') {
    expect(args[4].checkpointFrameFence).toEqual({outputByte:frozen.terminalPromptSubmission!.outputCursorBytes,resizeRevision:frozen.promptCompletionAdmission!.frameRefresh!.resizeRevision})
   }
   if(!args[3](f.screen)) throw new AgentMuxError('private cold frame missing','AGENT_PROMPT_RENDER_TIMEOUT')
   return f.screen.throughByte
  })
  f.restart(); await f.submit(); expect(f.writes).toEqual(['\x1b[I','\x1b','ONLY_AUTHORIZED_MESSAGE','\r'])
 } finally { f.screen.dispose() }
})


it('a different ordinary intent recovers lost harmless refresh ACK and preserves the original unsent intent', async () => {
 const f=await fixture('\x1b', 'Interrupt', '\x1b[I')
 try {
  await f.draw('UNAUTHORIZED_DRAFT',true); f.fault('refresh-ack')
  await expect(f.submit()).rejects.toMatchObject({code:'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED'})
  expect(f.registry.get('private-immediate').promptCompletionAdmission!.frameRefresh!.acknowledged).toBe(false)
  f.restart(); await f.submit('default','ordinary',agentPromptCondition(f.registry.get('private-immediate')))
  expect(f.writes).toEqual(['\x1b[I','ONLY_AUTHORIZED_MESSAGE','\r'])
  expect(f.registry.get('private-immediate').terminalPromptSubmission!.submissionId).toBe('ordinary')
 } finally { f.screen.dispose() }
})


describe('declared native steering', () => {
 it('accepts two consecutive busy messages without redraw, interrupt or a completed turn', async () => {
  const f = await fixture('\x1b', 'Interrupt', undefined, 'native-steer')
  try {
   await expect(f.submit()).resolves.toBeDefined()
   const first = structuredClone(f.registry.get('private-immediate'))
   await expect(f.submit('immediate', 'second-steer', agentPromptCondition(first))).resolves.toBeDefined()
   expect(f.writes).toEqual(['ONLY_AUTHORIZED_MESSAGE', '\r', 'ONLY_AUTHORIZED_MESSAGE', '\r'])
   expect(first.terminalPromptSubmission?.prepare).toBeUndefined()
   expect(first.promptCompletionAdmission?.intent?.execution).toBe('immediate')
   expect(first.semanticStatus?.state).toBe('working')
   expect(f.registry.get('private-immediate').terminalPromptSubmission?.submit.acknowledged).toBe(true)
   expect(f.registry.get('private-immediate').terminalPromptDelivery).toBeUndefined()
   expect(f.registry.get('private-immediate').semanticStatus).toEqual(first.semanticStatus)
   const preflight = f.screenEvidence.wait.mock.calls.filter(call => call[4].timeoutMessage.includes('current native composer'))
   expect(preflight).toHaveLength(2)
   for (const call of preflight) {
    expect(call[2]).toBe(false)
    expect(call[4]).toMatchObject({requireCompleteFrame: true})
    expect(call[4]).not.toHaveProperty('requireFrameAfterBoundary')
    expect(call[4]).not.toHaveProperty('checkpointFrameFence')
   }
  } finally { f.screen.dispose() }
 })
 it.each(['draft', 'transport', 'native-unknown'])('keeps the original native %s before steering', async kind => {
  const f = await fixture('\x1b', 'Interrupt', undefined, 'native-steer')
  try {
   if (kind === 'draft') await f.draw('UNAUTHORIZED_DRAFT')
   if (kind === 'transport') f.fault('transport')
   if (kind === 'native-unknown') f.native(null)
   await expect(f.submit()).rejects.toMatchObject({code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: {disposition: 'not_applied', confirmedInputBytes: 0}})
   expect(f.writes).toEqual([])
   expect(f.registry.get('private-immediate').promptCompletionAdmission).toBeUndefined()
  } finally { f.screen.dispose() }
 })
 it('rejoins an already frozen interrupt plan after capability changes, without replacing its bytes', async () => {
  const f = await fixture()
  try {
   f.fault('ack')
   await expect(f.submit()).rejects.toMatchObject({code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED'})
   const before = structuredClone(f.registry.get('private-immediate').promptCompletionAdmission!.intent!)
   f.provider.catalog.capabilities.promptExecution = {immediate: 'native-steer'}
   // Only the new plan changes; the coordinator must consume the saved one.
   f.provider.planPromptInput = prompt => ({kind: 'render-then-submit',payload: prompt,renderedText: prompt,submit: '\r'})
   f.restart()
   await expect(f.submit()).resolves.toBeDefined()
   expect(f.writes).toEqual(['\x1b', 'ONLY_AUTHORIZED_MESSAGE', '\r'])
   expect(f.registry.get('private-immediate').promptCompletionAdmission!.intent).toEqual(before)
   await expect(f.submit('default')).rejects.toMatchObject({code: 'AGENT_PROMPT_OPERATION_CONFLICT'})
  } finally { f.screen.dispose() }
 })
})
