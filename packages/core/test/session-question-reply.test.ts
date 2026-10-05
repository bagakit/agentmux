import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, type AgentMuxSessionQuestionReplyInput } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { codexQuestionAnswers, codexQuestionRequest, encodeCodexQuestionReply } from '../src/providers/codex-question.js'
import { normalizeSessionHistoryPage } from '../src/session-history.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { buildPromptInputPayload } from '../src/bracketed-paste.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const source = { providerId: 'codex', nativeSessionId: 'question-native-source' }
const trustedQuestionHookContext = { processNativeHandle: { kind: 'provider' as const, providerId: source.providerId, sessionId: source.nativeSessionId } }
const nativeQuestion = { type: 'agentMessage', id: 'native-async-call', phase: 'final_answer', delivery: 'async', text: 'Exact original question summary',
  questions: [{ title: 'Choose a direction\n保留正文', options: ['Keep original', 'Revise'] }, { title: 'Free text answer' }] }
const request = codexQuestionRequest(nativeQuestion)!
const answers = [{ questionId: request.questions[0]!.id, answer: 'Keep original' }]
const recordedAnswers = answers.map(answer => ({ ...answer, prompt: 'Choose a direction 保留正文' }))
const raw = encodeCodexQuestionReply(request, answers)
const closes: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(closes.splice(0).map(close => close())) })

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise } catch (error) {
    if (error instanceof AgentMuxError) return error.code
    throw error
  }
  return undefined
}

type NativeRequest = { method: string; params: Record<string, unknown> }
async function fixture(mode = 'normal') {
  const directory = await mkdtemp(fixturePath("tmp/amux-question-test-"))
  const workspace = join(directory, 'workspace'); await mkdir(workspace)
  const callsPath = join(directory, 'calls.jsonl'), script = join(directory, 'native.mjs')
  const entries = [
    { turnId: 'question-turn', item: { type: 'userMessage', id: 'before-question', content: [{ type: 'text', text: 'before' }] } },
    { turnId: 'question-turn', item: mode === 'malformed-options' ? { ...nativeQuestion, questions: [{ title: 'Original invalid options', options: ['Keep', 4] }] }
      : mode === 'malformed-title' ? { ...nativeQuestion, questions: [{ title: '', options: ['Keep'] }] }
      : mode === 'malformed-questions' ? { ...nativeQuestion, questions: 'not-a-question-array' } : nativeQuestion },
    { turnId: 'answer-turn', item: { type: 'userMessage', id: 'exact-answer-record', content: [{ type: 'text', text: raw }] } }
  ]
  await writeFile(script, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const entries=${JSON.stringify(entries)}, mode=${JSON.stringify(mode)}
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(request)+'\\n')
 if(request.id===undefined)return
 let result
 if(request.method==='initialize')result={userAgent:'controlled-question-owner'}
 else if(request.method==='thread/read')result={thread:{id:${JSON.stringify(source.nativeSessionId)},historyMode:'paginated'}}
 else if(request.method==='thread/items/list'){
  if(request.params.turnId){
   if(request.params.sortDirection==='desc')result={data:[entries[0]],nextCursor:null}
   else result={data:[mode==='wrong-record'?{...entries[1],item:{...entries[1].item,id:'another-real-question'}}:entries[1]],nextCursor:null}
  }else result={data:entries.slice().reverse(),nextCursor:null}
 }
 if(mode==='delayed'&&request.method==='thread/items/list'&&request.params.sortDirection==='asc'){
  writeFileSync(${JSON.stringify(join(directory,'ready'))},'ready')
  const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(directory,'release'))})){clearInterval(timer);process.stdout.write(JSON.stringify({id:request.id,result})+'\\n')}},5)
 }else process.stdout.write(JSON.stringify({id:request.id,result})+'\\n')
})`)
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'question-session', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: workspace,
    run: { runId: 'question-run' }, retiredRuns: [], hookBindingId: 'question-binding', hookToken: 'question-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1, stateEnteredAt: 1 } })
  const client = new AgentMuxClient({ store })
  type Internals = { connected: boolean; registry: AgentMuxAgentSessionRegistry; screenEvidence: AgentScreenEvidenceStore;
    serializeAgentInput<T>(session: AgentMuxAgentSession, operation: (session: AgentMuxAgentSession, run: CtxmuxAdapterRun) => Promise<T>, observation?: AbortController): Promise<T>;
    kernel: { isConnected(): boolean; identity(): { daemonInstanceId: string }; status(runId: string): Promise<CtxmuxAdapterRun>;
      input(runId: string, input: { operationId: string; expectedByte: number; data: string | Uint8Array }): Promise<{ run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }> } }
  const inner = client as unknown as Internals
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'question-private-daemon' })
  let cursor = 0
  const run = (runId: string): CtxmuxAdapterRun => ({ nativeService: null, runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: workspace, pid: 42,
    state: { type: 'running' }, cols: 120, rows: 40, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  inner.kernel.status = async id => run(id)
  const writes: Array<{ runId: string; data: string | Uint8Array }> = []
  const accepted = new Map<string, { run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }>()
  inner.kernel.input = async (runId, input) => {
    const prior = accepted.get(input.operationId); if (prior) return prior
    writes.push({ runId, data: input.data }); cursor = input.expectedByte + Buffer.byteLength(input.data)
    const receipt = { run: run(runId), appliedByteRange: { startByte: input.expectedByte, endByte: cursor } }; accepted.set(input.operationId, receipt); return receipt
  }
  const screen = new AgentTerminalScreen(120, 40)
  if (mode === 'expanded' || mode === 'expanded-second') {
    const dataBytes = Buffer.from(mode === 'expanded-second' ? '\u001b[32;1H2 of 2\u001b[40;1Henter submit   ctrl+] skip   shift+→ prev question' : '\u001b[40;1Henter submit   ctrl+] skip   shift+→ main prompt')
    await screen.write({ startByte: 0, endByte: dataBytes.byteLength, dataBytes })
  }
  vi.spyOn(inner.screenEvidence, 'wait').mockImplementation(async (_session, _byte, _after, predicate) => { predicate(screen); return 1 })
  closes.push(async () => { screen.dispose() })
  closes.push(async () => { await client.dispose(); await rm(directory, { recursive: true, force: true }) })
  const invocation = { commandOverride: process.execPath, args: [script] }
  const input: AgentMuxSessionQuestionReplyInput = { ...agentPromptCondition(client.agentSession('question-session')), ...invocation,
    agentSessionId: 'question-session', source, turnId: 'question-turn', recordId: nativeQuestion.id, answers,
    operationId: 'question-reply-operation', authorHuman: true, sourceDevice: { hostId: 'local', deviceId: 'device-private', name: 'Private device' } }
  return { client, store, inner, writes, input, directory, invocation,
    waitNative: async () => { await vi.waitFor(async () => expect(await readFile(join(directory,'ready'),'utf8')).toBe('ready'), { timeout: 5_000, interval: 5 }) },
    releaseNative: async () => { await writeFile(join(directory,'release'),'release') },
    calls: async (): Promise<NativeRequest[]> => (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    replace: async (newSource = 'new-native', newRun = 'question-run') => {
      const previous = (await loadAgentSessions(store))[0]!
      await store.compareAndSwap(previous, { ...previous, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: newSource }, run: { runId: newRun }, updatedAt: previous.updatedAt + 1 })
      await inner.registry.load('local')
    } }
}

async function activeFixture(state: 'working' | 'unknown' = 'working') {
  const h = await fixture()
  await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('question-session')),
    agentSessionId: 'question-session', operationId: 'original-active-turn', prompt: 'Original active request' })
  const previous = (await loadAgentSessions(h.store))[0]!
  const current = { ...previous, updatedAt: previous.updatedAt + 1 }
  if (state === 'unknown') delete current.semanticStatus
  else current.semanticStatus = { state: 'working', source: 'native-hook', observedAt: current.updatedAt, stateEnteredAt: current.updatedAt }
  await h.store.compareAndSwap(previous, current)
  await h.inner.registry.load('local')
  expect(h.client.agentSession('question-session').semanticStatus?.state).toBe(state === 'unknown' ? undefined : state)
  return { ...h, input: { ...h.input, ...agentPromptCondition(h.client.agentSession('question-session')) } }
}

describe('native asynchronous question facts and normal user replies', () => {
  it.each(['working', 'unknown'] as const)('admits an explicit exact question reply during an uncertain %s turn without widening ordinary prompts', async state => {
    const h = await activeFixture(state)
    expect(h.input.afterSubmissionId).toBe('original-active-turn')
    expect(h.writes).toHaveLength(2)
    await expect(h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('question-session')),
      agentSessionId: 'question-session', operationId: 'ordinary-not-authorized', prompt: 'Unrelated ordinary request' }))
      .rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    expect(h.writes).toHaveLength(2)
    const receipt = await h.client.replySessionQuestion(h.input).catch(error => ({ code: error.code, message: error.message }))
    expect(receipt).toMatchObject({ outcome: 'submitted', operationId: h.input.operationId })
    expect(h.writes.slice(2).map(write => write.data)).toEqual([buildPromptInputPayload(raw), '\r'])
    const stored = (await loadAgentSessions(h.store))[0]!
    expect(stored.run).toEqual({ runId: 'question-run' })
    expect(stored.pendingInteraction).toBeUndefined()
    expect(stored.semanticStatus?.state).not.toBe('done')
    expect(stored.promptCompletionAdmission).toMatchObject({ submissionId: h.input.operationId, acknowledged: true, uncertainTurn: true })
    expect(stored.terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
    await h.client.replySessionQuestion(h.input)
    expect(h.writes).toHaveLength(4)
  })
  it('respects an explicit refusal to continue an uncertain question turn', async () => {
    const h = await activeFixture()
    expect(await errorCode(h.client.replySessionQuestion({ ...h.input, allowUncertainTurn: false }))).toBe('AGENT_TURN_END_UNCONFIRMED')
    expect(h.writes).toHaveLength(2)
    expect(h.client.agentSession('question-session').run).toEqual({ runId: 'question-run' })
  })
  it('keeps the authoritative synchronous interaction fence for an explicit async reply', async () => {
    const h = await activeFixture(), previous = (await loadAgentSessions(h.store))[0]!
    const observed = h.client.providers.get('codex').normalizeHook({ agentSessionId: 'question-session', runId: 'question-run',
      providerId: 'codex', eventName: 'PreToolUse', receiptId: 'original-sync-question', payload: {
        session_id: source.nativeSessionId, tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Current synchronous question', options: [{ label: 'Keep' }, { label: 'Revise' }] }] }
      } }, trustedQuestionHookContext)
    expect(observed.interaction?.kind).toBe('question')
    await h.store.compareAndSwap(previous, { ...previous, pendingInteraction: { request: observed.interaction! }, updatedAt: Math.max(previous.updatedAt + 1, observed.interaction!.evidence.observedAt) })
    await h.inner.registry.load('local')
    await expect(h.client.replySessionQuestion(h.input)).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    expect(h.writes).toHaveLength(2)
    expect(h.client.agentSession('question-session').pendingInteraction?.request.id).toBe('original-sync-question')
  })
  it('keeps the exact predecessor fence for an explicit active question reply', async () => {
    const h = await activeFixture()
    await expect(h.client.replySessionQuestion({ ...h.input, afterSubmissionId: null })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(h.writes).toHaveLength(2)
  })
  it('reconciles an explicit retry with the same applied question payload instead of sending it twice', async () => {
    const h = await activeFixture(), original = h.inner.kernel.input.bind(h.inner.kernel)
    let loseReceipt = true
    vi.spyOn(h.inner.kernel, 'input').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (loseReceipt) { loseReceipt = false; throw new AgentMuxError('Private applied payload receipt was lost.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
      return result
    })
    await expect(h.client.replySessionQuestion(h.input)).rejects.toBeDefined()
    expect(h.writes.slice(2).map(write => write.data)).toEqual([buildPromptInputPayload(raw)])
    await h.client.replySessionQuestion(h.input)
    expect(h.writes.slice(2).map(write => write.data)).toEqual([buildPromptInputPayload(raw), '\r'])
    await h.client.replySessionQuestion(h.input)
    expect(h.writes).toHaveLength(4)
  })
  it('public reply consumes the current same-Run editor snapshot in its actual Provider input plan', async () => {
    const h = await fixture('expanded')
    await h.client.replySessionQuestion(h.input)
    expect(h.writes.map(write => write.data)).toEqual(['\u001b[1;2C' + buildPromptInputPayload(raw), '\r'])
    expect((await loadAgentSessions(h.store))[0]!.run).toEqual({ runId: 'question-run' })
  })
  it('public reply leaves the actual second native question editor before submitting the exact partial answer', async () => {
    const h = await fixture('expanded-second')
    h.input.answers = [{ questionId: request.questions[1]!.id, answer: 'Keep this original free text' }]
    const exact = encodeCodexQuestionReply(request, h.input.answers)
    await h.client.replySessionQuestion(h.input)
    expect(h.writes.map(write => write.data)).toEqual(['\u001b[1;2C\u001b[1;2C' + buildPromptInputPayload(exact), '\r'])
    expect((await loadAgentSessions(h.store))[0]!.run).toEqual({ runId: 'question-run' })
  })
  it('native multi-question navigation follows current progress and rejects only ambiguous visible editors', () => {
    const provider = new AgentProviderRegistry().get('codex')
    const line = (text: string) => ({ text, wrapped: false, cells: [] })
    const screen = (progress: string, footer: string) => ({ cols: 120, rows: 8, cursor: { row: 7, column: 0 }, lines: [line(progress), line('Original title'), line('1. Original option'), line('2. Other'), line(''), line(''), line(footer), line('')] })
    for (const [progress, footer, steps] of [
      ['1 of 3', 'enter submit   ctrl+] skip   shift+→ main prompt   shift+← next question', 1],
      ['2 of 3', 'enter submit   ctrl+] skip   shift+→ prev question   shift+← next question', 2],
      ['3 of 3', 'enter submit   ctrl+] skip   shift+→ prev question   shift+← queued messages', 3]
    ] as const) {
      const plan = provider.planPromptInput(raw, { intent: 'question-reply', terminalScreen: screen(progress, footer) })
      if (plan.kind !== 'render-then-submit') throw new Error('Expected actual Codex plan')
      expect(plan.payload).toBe('\u001b[1;2C'.repeat(steps) + buildPromptInputPayload(raw))
    }
    for (const progress of ['', '1 of 2', '3 of 2', '2 of unknown']) {
      const terminalScreen = screen(progress, 'enter submit   ctrl+] skip   shift+→ prev question')
      expect(() => provider.planPromptInput(raw, { intent: 'question-reply', terminalScreen })).toThrowError(expect.objectContaining({ code: 'AGENT_QUESTION_REPLY_UNSUPPORTED' }))
      const ordinary = provider.planPromptInput('Healthy manual prompt', { terminalScreen })
      if (ordinary.kind !== 'render-then-submit') throw new Error('Expected actual Codex plan')
      expect(ordinary.payload).toBe(buildPromptInputPayload('Healthy manual prompt'))
    }
  })
  it('uses native question navigation only for an exact reply on the current expanded editor', () => {
    const provider = new AgentProviderRegistry().get('codex')
    const terminalScreen = { cols: 120, rows: 1, cursor: { row: 0, column: 0 }, lines: [{ text: 'enter submit   ctrl+] skip   shift+→ main prompt', wrapped: false, cells: [] }] }
    const expanded = provider.planPromptInput(raw, { intent: 'question-reply', terminalScreen })
    expect(expanded.kind).toBe('render-then-submit')
    if (expanded.kind !== 'render-then-submit') throw new Error('Expected the actual Codex render plan')
    expect(expanded.payload).toBe('\u001b[1;2C' + buildPromptInputPayload(raw))
    expect(expanded.renderedText).toBe(raw)
    for (const [prompt, context] of [
      ['Ordinary user prompt', { terminalScreen }], [raw, { terminalScreen }],
      ['Ordinary user prompt', { intent: 'question-reply' as const, terminalScreen }],
      [raw, { intent: 'question-reply' as const }],
      [raw, { intent: 'question-reply' as const, terminalScreen: { ...terminalScreen, lines: [] } }],
      [raw, { intent: 'question-reply' as const, terminalScreen: { ...terminalScreen, lines: [...terminalScreen.lines, ...Array.from({ length: 5 }, () => ({ text: '', wrapped: false, cells: [] }))] } }]
    ] satisfies Array<[string, Parameters<AgentProvider['planPromptInput']>[1]]>) {
      const plan = provider.planPromptInput(prompt, context)
      if (plan.kind !== 'render-then-submit') throw new Error('Expected the actual Codex render plan')
      expect(plan.payload).toBe(buildPromptInputPayload(prompt))
    }
  })

  it('retains multiple questions, ordered labels, opaque IDs and text-only questions', () => {
    expect(request.questions.map(question => question.prompt)).toEqual(['Choose a direction\n保留正文', 'Free text answer'])
    expect(request.questions[0]!.id).toBe('["request_user_input_async","native-async-call",0]')
    expect(request.questions[0]!.options.map(option => option.label)).toEqual(['Keep original', 'Revise'])
    expect(request.questions[1]).toMatchObject({ options: [], acceptsText: true })
    expect(codexQuestionRequest({ ...nativeQuestion, delivery: undefined })).toBeUndefined()
  })
  it('preserves exact answer text and UTF-8 framing without manufacturing an answered status', () => {
    const text = '  Original answer\n中  '
    const wire = encodeCodexQuestionReply(request, [{ questionId: request.questions[0]!.id, answer: text }])
    expect(codexQuestionAnswers([{ type: 'text', text: wire }])).toEqual([{ questionId: request.questions[0]!.id, answer: text, prompt: 'Choose a direction 保留正文' }])
    expect(JSON.parse(wire.slice(wire.indexOf('\n') + 1, wire.lastIndexOf('\n')))[0].question).toBe('Choose a direction 保留正文')
    const long = codexQuestionRequest({ ...nativeQuestion, questions: [{ title: '中'.repeat(200) }] })!
    expect(Buffer.byteLength(JSON.parse(encodeCodexQuestionReply(long, [{ questionId: long.questions[0]!.id, answer: 'answer' }]).split('\n')[1]!)[0].question)).toBe(510)
  })
  it.each(['quoted', 'incomplete', 'image', 'second-text'])('does not correlate %s content as a native answer', mode => {
    const content = mode === 'quoted' ? [{ type: 'text', text: 'Here is a quoted example:\n' + raw }]
      : mode === 'incomplete' ? [{ type: 'text', text: raw.slice(0, -1) }]
      : mode === 'image' ? [{ type: 'text', text: raw }, { type: 'image', url: 'native:image' }]
      : [{ type: 'text', text: raw }, { type: 'text', text: 'trailing' }]
    expect(codexQuestionAnswers(content)).toBeUndefined()
  })
  it('recognizes the native single-object and standard IDE context wrappers without upgrading authorship', () => {
    const reply = { questionItemId: 'opaque', question: 'Question', answer: 'Answer' }
    const wire = '<send_user_message_question_reply>' + JSON.stringify(reply) + '</send_user_message_question_reply>'
    expect(codexQuestionAnswers([{ type: 'text', text: '# Context from my IDE setup:\ncontext\n## My request for Codex:\n' + wire }])).toEqual([{ questionId: 'opaque', answer: 'Answer', prompt: 'Question' }])
  })
  it('rejects a duplicate, foreign or oversized reference while leaving ordinary input independent', () => {
    expect(() => encodeCodexQuestionReply(request, [...answers, ...answers])).toThrow()
    expect(() => encodeCodexQuestionReply(request, [{ questionId: 'foreign', answer: 'same text' }])).toThrow()
    const oversized = { ...request, questions: [{ ...request.questions[0]!, id: 'x'.repeat(513) }] }
    expect(() => encodeCodexQuestionReply(oversized, [{ questionId: oversized.questions[0]!.id, answer: 'answer' }])).toThrow(/cannot be represented/)
  })
  it('public Core/FileStore history retains original raw and exact reply references', async () => {
    const h = await fixture(), page = await h.client.sessionHistoryPage('question-session', { ...h.invocation, limit: 3 })
    expect(page.items[1]).toMatchObject({ id: nativeQuestion.id, questionRequest: request, contentParts: [{ kind: 'text', text: nativeQuestion.text }] })
    expect(page.items[2]).toMatchObject({ questionAnswers: answers, contentParts: [{ kind: 'text', text: raw }] })
    expect(h.writes).toEqual([])
    const known = page.items[2]!.questionAnswers![0]!.questionId
    expect(page.items[1]!.questionRequest!.questions.filter(question => question.id === known)).toHaveLength(1)
    expect(page.items[1]!.questionRequest!.questions[1]).not.toHaveProperty('status')
  })
  it.each(['malformed-options', 'malformed-title', 'malformed-questions'])('isolates %s native question data without losing its original body or adjacent messages', async mode => {
    const h = await fixture(mode), read = h.client.sessionHistoryPage('question-session', { ...h.invocation, limit: 3 })
    await expect(read).resolves.toMatchObject({ agentSessionId: 'question-session', items: [{ id: 'before-question' }, { id: nativeQuestion.id }, { id: 'exact-answer-record' }] })
    const page = await read
    expect(page.items.map(item => item.id)).toEqual(['before-question', nativeQuestion.id, 'exact-answer-record'])
    expect(page.items.map(item => item.contentParts)).toEqual([[{ kind: 'text', text: 'before' }], [{ kind: 'text', text: nativeQuestion.text }], [{ kind: 'text', text: raw }]])
    expect(page.items[1]).toMatchObject({ kind: 'assistant-message', questionDiagnostic: { code: 'INVALID_AGENT_SESSION_HISTORY_PAGE', message: 'Native asynchronous question data is invalid.' } })
    expect(page.items[1]).not.toHaveProperty('questionRequest')
    expect(page.items[1]).not.toHaveProperty('status')
    const publicInput = { hostId: 'local', agentSessionId: 'question-session', source: 'native' as const, limit: 3 }
    const publicPage = { hostId: publicInput.hostId, agentSessionId: publicInput.agentSessionId, source: publicInput.source,
      revision: 'a'.repeat(64), availability: 'available', order: 'chronological-page',
      items: page.items.map(item => ({ kind: 'item', item })), nextCursor: null, budgetBytes: 64 * 1024, nativeSource: source }
    expect(parseRpcNativeResult('agent.history', publicPage, publicInput).items).toEqual(publicPage.items)
    expect(await errorCode(h.client.replySessionQuestion(h.input))).toBe('INVALID_AGENT_SESSION_HISTORY_PAGE')
    expect(h.writes).toEqual([])
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('question-session')), agentSessionId: 'question-session', prompt: 'Ordinary input is still available', operationId: 'healthy-input-after-malformed-question' })
    expect(h.writes.map(write => write.data)).toEqual([buildPromptInputPayload('Ordinary input is still available'), '\r'])
    expect(page.items[2]!.questionAnswers).toEqual(recordedAnswers)
  })
  it('normalizer retains a question diagnostic on the original assistant record without manufacturing a request', () => {
    const diagnostic = { code: 'INVALID_AGENT_SESSION_HISTORY_PAGE', message: 'Native asynchronous question data is invalid.' }
    const page = normalizeSessionHistoryPage(source, { source, items: [{ id: 'invalid-question-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original body' }], questionDiagnostic: diagnostic }], nextCursor: null }, 1)
    expect(page.items[0]).toEqual({ id: 'invalid-question-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original body' }], questionDiagnostic: diagnostic })
  })
  it('normalizer preserves questions and rejects a question field on another native kind', () => {
    expect(normalizeSessionHistoryPage(source, { source, items: [{ id: 'q', kind: 'assistant-message', contentParts: [], questionRequest: request }], nextCursor: null }, 1).items[0]!.questionRequest).toEqual(request)
    expect(() => normalizeSessionHistoryPage(source, { source, items: [{ id: 'q', kind: 'user-message', contentParts: [], questionRequest: request }], nextCursor: null }, 1)).toThrow()
  })
  it('uses exact bounded Provider lookup then the original durable prompt delivery, without an Agent envelope or Hook', async () => {
    const h = await fixture(), receipt = await h.client.replySessionQuestion(h.input)
    expect(receipt).toEqual({ agentSessionId: 'question-session', source, recordId: nativeQuestion.id, questionIds: answers.map(answer => answer.questionId), operationId: h.input.operationId, outcome: 'submitted' })
    expect(h.writes.map(write => write.data)).toEqual([buildPromptInputPayload(raw), '\r'])
    const lists = (await h.calls()).filter(call => call.method === 'thread/items/list')
    expect(lists.map(call => call.params)).toEqual([
      { threadId: source.nativeSessionId, turnId: 'question-turn', limit: 1, sortDirection: 'desc', cursor: { type: 'item', itemId: nativeQuestion.id } },
      { threadId: source.nativeSessionId, turnId: 'question-turn', limit: 1, sortDirection: 'asc', cursor: { type: 'item', itemId: 'before-question' } }
    ])
    const stored = (await loadAgentSessions(h.store))[0]!
    expect(stored.pendingInteraction).toBeUndefined()
    expect(stored.promptCompletionAdmission?.intent?.message).toMatchObject({ authorHuman: true, sourceDevice: h.input.sourceDevice, userContent: raw })
    expect((await h.store.loadTimeline('question-session')).items[0]).toMatchObject({ kind: 'user_message', content: raw })
    await h.client.replySessionQuestion(h.input)
    expect(h.writes).toHaveLength(2)
  })
  it.each(['source', 'run', 'record', 'question'])('rejects wrong %s only for this input and keeps manual prompt available', async mode => {
    const h = await fixture(mode === 'record' ? 'wrong-record' : 'normal')
    const input = { ...h.input, ...(mode === 'source' ? { source: { ...source, nativeSessionId: 'wrong-native' } }
      : mode === 'run' ? { expectedRun: { runId: 'wrong-run' } }
      : mode === 'record' ? { answers: [{ questionId: JSON.stringify(['request_user_input_async', 'another-real-question', 0]), answer: 'Keep original' }] }
      : mode === 'question' ? { answers: [{ questionId: 'wrong-question', answer: 'Keep original' }] } : {}) }
    expect(await errorCode(h.client.replySessionQuestion(input))).toBe(mode === 'source' ? 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      : mode === 'run' ? 'STALE_AGENT_SESSION' : mode === 'record' ? 'UNKNOWN_AGENT_QUESTION' : 'INVALID_AGENT_QUESTION_REPLY')
    expect(h.writes).toEqual([])
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('question-session')), agentSessionId: 'question-session', operationId: 'ordinary-still-usable', prompt: 'Manual remains available' })
    expect(h.writes.map(write => write.data)).toEqual(['Manual remains available', '\r'])
  })
  it('rejects source replacement after Provider lookup before any input', async () => {
    const h = await fixture(), provider = h.client.providers.get('codex'), original = provider.prepareSessionQuestionReply!.bind(provider)
    vi.spyOn(provider as Required<Pick<AgentProvider, 'prepareSessionQuestionReply'>>, 'prepareSessionQuestionReply').mockImplementation(async context => { const prompt = await original(context); await h.replace(); return prompt })
    expect(await errorCode(h.client.replySessionQuestion(h.input))).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    expect(h.writes).toEqual([])
  })
  it('rechecks the native source after joining the original input serializer', async () => {
    const h = await fixture(), original = h.inner.serializeAgentInput.bind(h.inner)
    vi.spyOn(h.inner, 'serializeAgentInput').mockImplementation(async (...args) => {
      await h.replace()
      return await original(...args)
    })
    expect(await errorCode(h.client.replySessionQuestion(h.input))).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    expect(h.writes).toEqual([])
  })
  it('rejects a same-Run source replacement at the durable admission CAS and keeps manual input usable', async () => {
    const h = await fixture(), original = h.store.compareAndSwapMetadata.bind(h.store)
    let replaced = false
    vi.spyOn(h.store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
      if (!replaced && args[1]?.terminalPromptSubmission) {
        replaced = true
        const previous = (await loadAgentSessions(h.store))[0]!
        await original(previous, { ...previous, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'new-native' }, updatedAt: previous.updatedAt + 1 })
      }
      return await original(...args)
    })
    expect(await errorCode(h.client.replySessionQuestion(h.input))).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    expect(replaced).toBe(true)
    expect(h.writes).toEqual([])
    vi.restoreAllMocks()
    vi.spyOn(h.inner.screenEvidence, 'wait').mockResolvedValue(1)
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('question-session')), agentSessionId: 'question-session', operationId: 'after-source-change', prompt: 'Manual input remains available' })
    expect(h.writes.map(write => write.data)).toEqual(['Manual input remains available', '\r'])
  })
  it('freezes exact caller identity and answer text before the delayed public native reader', async () => {
    const h = await fixture('delayed')
    const input = { ...h.input, source: { ...h.input.source }, answers: h.input.answers.map(answer => ({ ...answer })) }
    const replying = h.client.replySessionQuestion(input)
    await h.waitNative()
    input.source.nativeSessionId = 'later-caller-source'
    input.turnId = 'later-caller-turn'; input.recordId = 'later-caller-record'; input.operationId = 'later-caller-operation'
    input.answers[0]!.answer = 'Later caller text'
    await h.releaseNative()
    const receipt = await replying
    expect(h.writes.map(write => write.data)).toEqual([buildPromptInputPayload(raw), '\r'])
    expect(receipt).toEqual({ agentSessionId: h.input.agentSessionId, source, recordId: nativeQuestion.id,
      questionIds: answers.map(answer => answer.questionId), operationId: h.input.operationId, outcome: 'submitted' })
    expect((await loadAgentSessions(h.store))[0]!.promptCompletionAdmission?.intent?.message?.userContent).toBe(raw)
  })
  it('CLI discovers a typed reply; public RPC admits trusted manual origin and result codec binds every reference', async () => {
    const h = await activeFixture(), file = join(h.directory, 'reply.json')
    const { commandOverride: _command, args: _args, authorHuman: _human, sourceDevice: _device, ...input } = h.input
    await writeFile(file, JSON.stringify(input))
    const cli = await parseAgentMuxCliInvocation(['agent', 'question', 'reply', '--input', file])
    expect(cli.command.method).toBe('agent.question.reply'); expect(cli.params).toEqual({ ...input, sourceChannel: 'cli' })
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }], operationSource: () => h.input.sourceDevice })
    await expect(service.call('agent.question.reply', input)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    const submit = vi.spyOn(h.client, 'replySessionQuestion').mockImplementation(async actual => {
      expect(actual.authorHuman).toBe(true); expect(actual.sourceDevice).toEqual(h.input.sourceDevice); expect(actual.sourceChannel).toBe('cli')
      return await AgentMuxClient.prototype.replySessionQuestion.call(h.client, { ...actual, ...h.invocation })
    })
    const receipt = await service.call('agent.question.reply', cli.params as typeof input, { principal: { kind: 'user', id: 'local-private-user' }, transport: 'unix' })
    expect(submit).toHaveBeenCalledOnce()
    expect((await loadAgentSessions(h.store))[0]!.promptCompletionAdmission?.intent?.message?.sourceChannel).toBe('cli')
    expect((await h.store.loadTimeline('question-session')).items.at(-1)!.sourceChannel).toBe('cli')
    expect(h.writes.slice(2).map(write => write.data)).toEqual([buildPromptInputPayload(raw), '\r'])
    expect(parseRpcNativeResult('agent.question.reply', receipt, input)).toEqual(receipt)
    expect(() => parseRpcNativeResult('agent.question.reply', { ...receipt, source: { ...source, nativeSessionId: 'foreign' } }, input)).toThrow()
  })
  it('public API reply defaults to API origin while rejecting forged Host authority fields', async () => {
    const h = await fixture()
    const { commandOverride: _command, args: _args, authorHuman: _human, sourceDevice: _device, ...input } = h.input
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }], operationSource: () => h.input.sourceDevice })
    const context = { principal: { kind: 'user' as const, id: 'private-api-user' }, transport: 'unix' as const }
    vi.spyOn(h.client, 'replySessionQuestion').mockImplementation(async actual => {
      expect(actual.authorHuman).toBe(true); expect(actual.sourceDevice).toEqual(h.input.sourceDevice)
      expect(actual.sourceChannel).toBe('api')
      return await AgentMuxClient.prototype.replySessionQuestion.call(h.client, { ...actual, ...h.invocation })
    })
    await expect(service.call('agent.question.reply', { ...input, sourceDevice: h.input.sourceDevice } as typeof input, context)).rejects.toHaveProperty('code')
    const receipt = await service.call('agent.question.reply', input, context)
    expect(receipt.outcome).toBe('submitted')
    expect((await loadAgentSessions(h.store))[0]!.promptCompletionAdmission?.intent?.message?.sourceChannel).toBe('api')
    expect((await h.store.loadTimeline('question-session')).items[0]!.sourceChannel).toBe('api')
  })
  it('does not add asynchronous questions to the synchronous Hook interaction protocol', () => {
    const provider = new AgentProviderRegistry().get('codex')
    const base = { agentSessionId: 'question-session', runId: 'question-run', providerId: 'codex', eventName: 'PreToolUse' }
    const asynchronous = provider.normalizeHook({ ...base, receiptId: 'async', payload: {
      session_id: source.nativeSessionId, tool_name: 'request_user_input_async', tool_input: { questions: nativeQuestion.questions }
    } }, trustedQuestionHookContext)
    expect(asynchronous.status.state).toBe('working')
    expect(asynchronous.interaction).toBeUndefined()
    const synchronous = provider.normalizeHook({ ...base, receiptId: 'sync', payload: {
      session_id: source.nativeSessionId, tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Original synchronous question', options: [{ label: 'Keep' }, { label: 'Revise' }] }] }
    } }, trustedQuestionHookContext)
    expect(synchronous.status.state).toBe('waiting')
    expect(synchronous.interaction).toMatchObject({ kind: 'question', id: 'sync' })
  })
})
