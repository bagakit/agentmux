import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
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

async function fixture(interrupt = '\x1b', endEvent = 'Interrupt') {
  let stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-immediate', providerId: 'fixture', executorId: 'fixture',
    hostId: 'local', workspacePath: upstreamFixturePath("private/workspace"), run: { runId: 'private-run' }, retiredRuns: [], hookBindingId: 'b', hookToken: 't', createdAt: 1, updatedAt: 1,
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
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'fixture', hookStrategy: { kind: 'native', installation: 'unmanaged' } },
    buildArgs: (_, args) => [...args], hook: { rules: [] }, terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: (prompt, context) => ({ kind: 'render-then-submit', payload: prompt, renderedText: prompt, submit: '\r',
      ...(context?.execution === 'immediate' ? { prepare: { interrupt, endEvent } } : {}) }),
    verifyPromptExecutionTransport: async () => transport,
    readPromptExecutionEvidence: async () => native,
    inspectPromptExecution: snapshot => {
      const line = snapshot.lines[snapshot.cursor.row]
      if (line?.text.trimEnd() !== '>') return 'unavailable'
      return snapshot.lines[9]?.text === 'working' ? 'interruptible' : 'idle'
    } })
  const providers = new AgentProviderRegistry([provider]), events: AgentMuxClientEvent[] = [], publisher = new AgentMuxClientEventPublisher()
  publisher.onEvent(event => events.push(event))
  let cursor = 0, transport = true, loseInterruptAck = false, wrongEnd = false, race = false
  const receipt = new Map<string, { startByte: number; endByte: number }>(), writes: string[] = []
  const run = () => ({ runId: 'private-run', nativeService: null, lifecycleOperationId: null, program: 'fixture', args: [], workspacePath: upstreamFixturePath("private/workspace"), pid: 123,
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
      if (operation.data === interrupt) {
        native = { sourceId: 'private-native', id: 'cancelled', nativeTurnId: wrongEnd ? 'turn-other' : 'turn-1', state: 'ended', endReason: 'interrupted' }
        await draw('', false)
        if (loseInterruptAck) { loseInterruptAck = false; throw new AgentMuxError('private lost interrupt ACK', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
      } else if (operation.data !== '\r') await draw(operation.data, false)
      return { run: run(), appliedByteRange: range }
    }) }
  const screenEvidence = { wait: vi.fn(async (...args: Parameters<AgentScreenEvidenceStore['wait']>) => {
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
  return { registry, store, screen, writes, kernel, submit, run, events, draw, coordinator,
    restart: () => { owner = coordinator() }, native: (evidence: AgentPromptExecutionEvidence | null) => { native = evidence },
    fault: (kind: string) => { if (kind === 'ack') loseInterruptAck = true; if (kind === 'turn') wrongEnd = true; if (kind === 'race') race = true; if (kind === 'transport') transport = false } }
}

describe('single authorized native immediate preparation', () => {
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
      await expect(f.submit()).rejects.toMatchObject({code:'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED'})
      expect(f.writes).toEqual([]);expect(f.registry.get('private-immediate').promptCompletionAdmission).toBeUndefined()
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
