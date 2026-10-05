// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage } from '@agentmux/core';
import { codexQuestionRequest, encodeCodexQuestionReply } from '../../../packages/core/src/providers/codex-question.js';
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform';
import { ConversationView } from '@agentmux/client-ui/components/ConversationView';
import { ActivityView } from '../src/renderer/src/components/ActivityView';
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages';
import { api } from '../src/renderer/src/lib/api';
import { useAppStore } from '../src/renderer/src/store';
import type { AgentSessionControl } from '../src/shared/contracts';
const sid = 'question-window-session', source = { providerId: 'codex', nativeSessionId: 'question-window-native' };
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-run' } };
const originalStore = useAppStore.getState(), copy = vi.fn(async () => true);
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => { }, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null };
let root: Root, container: HTMLDivElement, directory: string, client: AgentMuxClient, store: AgentMuxFileAgentSessionStore, oldPage: AgentSessionHistoryPage, fullPage: AgentSessionHistoryPage, latestPage: AgentSessionHistoryPage, calls: MockInstance<typeof api.sessions.historyPage>, stored: Buffer;
let contextSnapshot: ReturnType<typeof useSessionUserMessages> | undefined;
const question = { type: 'agentMessage', id: 'native-question', phase: 'final_answer', delivery: 'async', text: 'Original request', questions: [{ title: 'Continue the original goal?', options: ['Keep the original goal', 'Revise'] }] };
const request = codexQuestionRequest(question)!, reply = encodeCodexQuestionReply(request, [{ questionId: request.questions[0]!.id, answer: 'Keep the original goal' }]);
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)); }
function card() { const c = container.querySelector<HTMLElement>('[aria-label="Native asynchronous question"]'); expect(c).not.toBeNull(); return c!; }
function view(context: AgentSessionHistoryPage | null = fullPage, page = oldPage) { return <ConversationView page={page} sessionId={sid} questionAnswerContext={context}/>; }
function Reading({ visible = true }: {
    visible?: boolean;
}) { const facts = useSessionUserMessages(control, { enabled: visible }); contextSnapshot = facts; return <ActivityView sessionId={sid} items={[]} userMessages={[]} nativeHistoryPage={oldPage} nativeContextItems={facts.nativeContextItems} capability="complete-events" conversationReading={{ reference: control, identity: control.run.runId, enabled: visible }}/>; }
beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class {
        observe() { }
        unobserve() { }
        disconnect() { }
    });
    vi.stubGlobal('IntersectionObserver', class {
        observe() { }
        unobserve() { }
        disconnect() { }
    });
    Element.prototype.scrollIntoView = vi.fn();
    copy.mockClear();
    useAppStore.setState({ config: null, sessions: [], timelines: {}, agentNames: {}, agentComposerDrafts: { [sid]: 'ORIGINAL DRAFT' } });
    directory = await mkdtemp(join(tmpdir(), 'amux-question-window-'));
    const records = join(directory, 'records.json'), script = join(directory, 'reader.mjs');
    const originalEntries = [{ turnId: 'original-turn', item: { type: 'userMessage', id: 'original-prose', content: [{ type: 'text', text: 'Keep this original prose and selection' }] } }, { turnId: 'original-turn', item: question }];
    await writeFile(records, JSON.stringify(originalEntries));
    await writeFile(script, `import {readFileSync} from 'node:fs';import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={userAgent:'controlled-read-only-protocol'};else if(q.method==='thread/read')result={thread:{id:${JSON.stringify(source.nativeSessionId)},historyMode:'paginated'}};else if(q.method==='thread/items/list'){const rows=JSON.parse(readFileSync(${JSON.stringify(records)},'utf8')).reverse(),offset=Number(q.params.cursor??0),limit=q.params.limit??30;result={data:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?String(offset+limit):null}}process.stdout.write(JSON.stringify({id:q.id,result})+'\\n')})`);
    store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'));
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: sid, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: directory, run: control.run, retiredRuns: [], hookBindingId: 'fixture-hook', hookToken: 'fixture-token', createdAt: 1, updatedAt: 1, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId } });
    client = new AgentMuxClient({ store });
    stored = await readFile(store.path);
    const read = (options = {}) => client.sessionHistoryPage(sid, { commandOverride: process.execPath, args: [script], ...options });
    oldPage = await read();
    expect(oldPage.items.map(i => i.id)).toEqual(['original-prose', question.id]);
    await writeFile(records, JSON.stringify([...originalEntries, { turnId: 'original-turn', item: { type: 'userMessage', id: 'native-answer', content: [{ type: 'text', text: reply }] } }, ...Array.from({ length: 35 }, (_, n) => ({ turnId: 'original-turn', item: { type: 'reasoning', id: 'process-' + n, summary: [{ type: 'summary_text', text: 'Recorded process ' + n }] } }))]));
    fullPage = await read({ limit: 100 });
    latestPage = await read({ limit: 30 });
    expect(latestPage.items.some(i => i.questionAnswers?.length)).toBe(false);
    expect(fullPage.items.find(i => i.id === 'native-answer')?.questionAnswers?.[0]?.questionId).toBe(request.questions[0]!.id);
    calls = vi.spyOn(api.sessions, 'historyPage').mockImplementation((_control, options) => options?.limit === 100 ? Promise.resolve(oldPage) : read(options));
    vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source, dispose: () => { } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); expect(await readFile(store.path)).toEqual(stored); useAppStore.setState(originalStore, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); await client.dispose(); await rm(directory, { recursive: true, force: true }); });
it('confirms an already recorded same-source answer outside a preserved page without replacing prose, Range or raw Copy', async () => {
    await render(view(null));
    expect(card().dataset.questionState).toBe('unknown');
    const body = container.querySelector('[data-native-record-id="original-prose"] .log-turn__body')!, node = body.querySelector('.md-paragraph')?.firstChild ?? body.querySelector('.log-turn__text')!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const originalCard = card();
    await render(view());
    expect(card()).toBe(originalCard);
    expect(card().dataset.questionState).toBe('answered');
    expect(card().querySelector('.agent-question__answer')?.textContent).toBe('Keep the original goal');
    expect(container.querySelector('[data-native-record-id="original-prose"] .log-turn__body')).toBe(body);
    expect(selection.anchorNode).toBe(node);
    expect(selection.focusNode).toBe(node);
    expect(selection.toString()).toBe('Keep');
    await act(async () => body.closest('[data-native-record-id]')!.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());
    expect(copy).toHaveBeenCalledWith('Keep this original prose and selection', expect.any(Function));
    expect(calls).not.toHaveBeenCalled();
});
it.each(['session', 'provider', 'native'] as const)('rejects %s context even when the opaque question ID matches', async (kind) => { const foreign = { ...fullPage, ...(kind === 'session' ? { agentSessionId: 'other-session' } : {}), source: { ...fullPage.source, ...(kind === 'provider' ? { providerId: 'claude' } : kind === 'native' ? { nativeSessionId: 'other-native' } : {}) } }; await render(view(foreign)); expect(card().dataset.questionState).toBe('unknown'); expect(card().querySelector('.agent-question__answer')).toBeNull(); expect(calls).not.toHaveBeenCalled(); });
it('does not infer confirmation from literal reply text or non-user-message facts', async () => { const literal = { ...fullPage, items: fullPage.items.map(i => i.id === 'native-answer' ? (({ questionAnswers: _answers, ...record }) => record)(i) : i) }; await render(view(literal)); expect(card().dataset.questionState).toBe('unknown'); const wrongKind = { ...fullPage, items: fullPage.items.map(i => i.id === 'native-answer' ? { ...i, kind: 'assistant-message' as const } : i) }; await render(view(wrongKind)); expect(card().dataset.questionState).toBe('unknown'); });
it('keeps recorded page answers authoritative and does not retain a confirmation after its same-source facts leave', async () => { const conflicting = { ...fullPage, items: fullPage.items.map(i => i.questionAnswers ? { ...i, questionAnswers: i.questionAnswers.map(a => ({ ...a, answer: 'Different context text' })) } : i) }; await render(view(conflicting, fullPage)); expect(card().querySelector('.agent-question__answer')?.textContent).toBe('Keep the original goal'); await render(view(fullPage)); expect(card().dataset.questionState).toBe('answered'); await render(view(null)); expect(card().dataset.questionState).toBe('unknown'); });
it('an input receipt alone cannot confirm a submitted reply and no automatic retry is issued', async () => {
  const answers = [{ questionId: request.questions[0]!.id, answer: 'Keep the original goal' }]
  let submitted = false
  const send = vi.fn(async () => { submitted = true; return { agentSessionId: sid, source, recordId: question.id,
    questionIds: [request.questions[0]!.id], operationId: 'original-operation', outcome: 'submitted' as const } })
  const node = (context: AgentSessionHistoryPage | null) => <ConversationView page={oldPage} sessionId={sid}
    questionAnswerContext={context} onReplyQuestion={send} questionReplyState={() => submitted ? { phase: 'submitted', answers } : undefined}/>
  await render(node(null))
  await act(async () => { [...card().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Keep the original goal'))!.click() })
  await act(async () => card().querySelector<HTMLButtonElement>('.agent-question__footer button')!.click())
  await render(node(null))
  expect(send).toHaveBeenCalledTimes(1); expect(card().dataset.questionState).toBe('submitted')
  await render(node(fullPage)); expect(card().dataset.questionState).toBe('answered')
  expect(send).toHaveBeenCalledTimes(1); expect(calls).not.toHaveBeenCalled()
})
it('actual shared reader→Activity consumes accepted context beyond latest30 and makes no read demand while hidden', async () => { await render(<Reading />); await vi.waitFor(() => expect(contextSnapshot?.nativeContextItems.some(i => i.questionAnswers?.length)).toBe(true)); await act(async () => { }); expect(card().dataset.questionState).toBe('answered'); expect(card().querySelector('.agent-question__answer')?.textContent).toBe('Keep the original goal'); expect(container.querySelectorAll('[data-native-record-id="native-answer"]')).toHaveLength(0); expect(calls).toHaveBeenCalledTimes(3); const reads = calls.mock.calls.length, body = container.querySelector('[data-native-record-id="original-prose"] .log-turn__body'); await render(<Reading visible={false}/>); await new Promise(resolve => setTimeout(resolve, 90)); expect(calls).toHaveBeenCalledTimes(reads); expect(container.querySelector('[data-native-record-id="original-prose"] .log-turn__body')).toBe(body); expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL DRAFT'); });
