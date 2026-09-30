// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentMuxClient } from '../../../packages/core/src/client.js';
import { AgentProviderRegistry, defineAgentProvider } from '../../../packages/core/src/agent-provider.js';
import { AgentMuxMemoryAgentSessionStore } from '../../../packages/core/src/agent-session-store.js';
import { agentPromptCondition } from '../../../packages/core/src/agent-prompt-condition.js';
import type { AgentMuxStoredAgentSession } from '../../../packages/core/src/types.js';
import type { CtxmuxAdapterRun } from '../../../packages/core/src/ctxmux-run-adapter.js';
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control.js';
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline';
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context';
import { useAppStore } from '../src/renderer/src/store';
import { api } from '../src/renderer/src/lib/api';
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts';
import type { ContinuousProgressLoop } from '../../../packages/core/src/continuous-progress-scheduler.js';
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery';
import { RuntimeController } from '../src/main/runtime-controller';
const baseline = useAppStore.getState();
const roots: Array<ReturnType<typeof createRoot>> = [];
const elements: HTMLElement[] = [];
const clients: AgentMuxClient[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    for (const element of elements.splice(0)) element.remove();
    for (const client of clients.splice(0)) await client.dispose();
    useAppStore.setState(baseline, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
function previewOf(marker: HTMLElement) {
    const id = marker.getAttribute('aria-describedby');
    expect(id).not.toBeNull();
    const preview = document.getElementById(id!);
    expect(preview).not.toBeNull();
    expect(preview!.getAttribute('role')).toBe('dialog');
    expect(preview!.dataset.previewMessageId).toBe(marker.dataset.messageId);
    expect(document.getElementById('agentmux-window-overlay-host')?.contains(preview)).toBe(true);
    return preview!;
}
async function fixture() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const template = new AgentProviderRegistry().get('codex');
    expect(template.planManagedHooks).toEqual(expect.any(Function));
    const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic' }, hook: template.hook, planManagedHooks: template.planManagedHooks!, buildArgs: (_prompt, args) => [...args] });
    const store = new AgentMuxMemoryAgentSessionStore();
    const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-recipient', providerId: 'generic', executorId: 'generic', hostId: 'local', workspacePath: '/private-project', run: { runId: 'private-recipient-run' }, retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1, semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1, stateEnteredAt: 1 } };
    await store.compareAndSwap(null, session);
    const client = new AgentMuxClient({ store, providers: [provider] });
    clients.push(client);
    // Keep the public Store/Core/event/UI path real; replace only private adapter I/O.
    // This does not start a daemon, native CLI, or actual PTY.
    const inner = client as unknown as {
        connected: boolean;
        registry: {
            load(host: string): Promise<void>;
        };
        kernel: {
            isConnected(): boolean;
            identity(): object;
            status(runId: string): Promise<CtxmuxAdapterRun>;
            input(runId: string, operation: {
                operationId: string;
                expectedByte: number;
                data: string;
            }): Promise<{
                run: CtxmuxAdapterRun;
                appliedByteRange: {
                    startByte: number;
                    endByte: number;
                };
            }>;
        };
    };
    await inner.registry.load('local');
    inner.connected = true;
    inner.kernel.isConnected = () => true;
    inner.kernel.identity = () => ({ daemonInstanceId: 'private-no-daemon' });
    let cursor = 0;
    const writes: Array<{
        runId: string;
        data: string;
    }> = [];
    const run = (): CtxmuxAdapterRun => ({ runId: session.run.runId, lifecycleOperationId: null, program: 'generic', args: [], workspacePath: session.workspacePath, pid: 123, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor });
    inner.kernel.status = async () => run();
    inner.kernel.input = async (runId, op) => { expect(runId).toBe(session.run.runId); expect(op.expectedByte).toBe(cursor); writes.push({ runId, data: op.data }); const startByte = cursor; cursor += Buffer.byteLength(op.data); return { run: run(), appliedByteRange: { startByte, endByte: cursor } }; };
    const recipient = { id: session.agentSessionId, kind: 'agent', providerId: 'generic', executorId: 'generic', hostId: 'local', workspacePath: session.workspacePath, label: 'Private recipient', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, processState: 'running', latestOutputBytes: 0, status: { state: 'running', source: 'run-process', observedAt: 1 }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' }, control: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run } } as Extract<SessionSnapshot, {
        kind: 'agent';
    }>;
    const config: AppConfig = {
        version: 9,
        hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }],
        executors: { generic: { label: 'Generic', providerId: 'generic', command: 'generic', args: [], env: {}, injectAgentMuxGuide: true } },
        workspaces: [{ id: 'private-project', name: 'Private project', kind: 'folder', hostId: 'local', path: session.workspacePath }],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
    };
    useAppStore.setState({ config, sessions: [recipient], timelines: { [session.agentSessionId]: { agentSessionId: session.agentSessionId, revision: 0, items: [] } }, error: null });
    client.onEvent(event => { if (event.type === 'agent-timeline')
        useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event }); });
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, prompt, operationId, condition, authorAgentSessionId) => { await client.submitAgentPrompt({ agentSessionId: control.agentSessionId, prompt, operationId, ...condition, ...(authorAgentSessionId === undefined ? {} : { authorAgentSessionId }), allowUncertainTurn: true }); });
    const element = document.createElement('div');
    document.body.append(element);
    elements.push(element);
    const root = createRoot(element);
    roots.push(root);
    const onSelect = vi.fn();
    const render = async () => { const state = useAppStore.getState(); const contexts = createFocusProjectionSelector()(state).contexts; expect(contexts.map(c => c.id)).toEqual([session.agentSessionId]); await act(async () => root.render(createElement(RecentFocusTimeline, { entries: [], contexts, currentSessionId: session.agentSessionId, onSelect }))); };
    return { client, store, session, recipient, element, render, writes, submit, onSelect };
}
it('actual Store Control send and Core recording show a nonempty known Agent marker without claiming Human', async () => {
    const h = await fixture();
    const prompt = 'The same body from a known Agent';
    await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'private-control-send', operation: 'send', target: { kind: 'agent-session', agentSessionId: h.session.agentSessionId }, text: prompt, promptCondition: agentPromptCondition(h.client.agentSession(h.session.agentSessionId)), caller: { agentSessionId: 'private-author' } });
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.submit.mock.calls[0]![4]).toBe('private-author');
    const captured = await h.client.sessionTimeline(h.session.agentSessionId);
    expect(captured.items).toEqual([expect.objectContaining({ id: 'prompt:private-control-send', kind: 'user_message', source: 'user', authorAgentSessionId: 'private-author', content: prompt })]);
    expect(h.writes).toEqual([{ runId: h.session.run.runId, data: prompt + '\r' }]);
    await h.render();
    const markers = [...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__message')];
    expect(markers.map(marker => marker.dataset.messageId)).toEqual(['captured:prompt:private-control-send']);
    expect(markers[0]!.dataset.messageAuthor).toBe('agent');
    expect(markers[0]!.getAttribute('aria-label')).toMatch(/^Agent message in .+, sender private-author$/);
    expect(markers[0]!.title).toContain('Agent message · Sender private-author');
    expect(markers[0]!.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId).toBe(h.session.agentSessionId);
    await act(async () => markers[0]!.click());
    const preview = previewOf(markers[0]!);
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('Agent message');
    expect(preview.textContent).toContain('private-author');
    expect(preview.textContent).toContain('Sender Run not recorded');
    expect(preview.textContent).not.toContain('Human');
    expect(useAppStore.getState().timelines[h.session.agentSessionId]!.items).toEqual(captured.items);
});
it('actual public Core plain send retains two identical prompts without claiming a Human sender', async () => {
    const h = await fixture();
    const prompt = 'Same real Core submitted body';
    for (const operationId of ['human-one', 'human-two'])
        await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(h.session.agentSessionId)), agentSessionId: h.session.agentSessionId, prompt, operationId, allowUncertainTurn: true });
    const captured = await h.client.sessionTimeline(h.session.agentSessionId);
    expect(captured.items.map(item => [item.id, item.content, item.authorAgentSessionId])).toEqual([['prompt:human-one', prompt, undefined], ['prompt:human-two', prompt, undefined]]);
    await h.render();
    const markers = [...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__message')];
    expect(markers.map(item => item.dataset.messageId)).toEqual(['captured:prompt:human-one', 'captured:prompt:human-two']);
    expect(markers.map(item => Number(item.dataset.messageAt))).toEqual(captured.items.map(item => item.createdAt));
    expect(markers.map(item => item.getAttribute('aria-label'))).toEqual([
        expect.stringMatching(/^Prompt in .+, sender not recorded$/),
        expect.stringMatching(/^Prompt in .+, sender not recorded$/)
    ]);
    expect(markers.map(item => item.title)).toEqual([
        expect.stringContaining('Prompt · Sender not recorded'),
        expect.stringContaining('Prompt · Sender not recorded')
    ]);
    await act(async () => markers[0]!.click());
    const preview = previewOf(markers[0]!);
    expect(preview.getAttribute('aria-label')).toBe('Message');
    expect(preview.textContent).toContain(prompt);
    expect(preview.textContent).toContain('Prompt · Sender not recorded');
    expect(h.onSelect).not.toHaveBeenCalled();
    await act(async () => preview.querySelector<HTMLButtonElement>(':scope > button')!.click());
    expect(h.onSelect).toHaveBeenCalledExactlyOnceWith(h.session.agentSessionId);
    expect((await h.client.sessionTimeline(h.session.agentSessionId)).items).toEqual(captured.items);
});
it('actual continuous-progress caller through Runtime/Core/Store presents an automated prompt with sender not recorded', async () => {
    const h = await fixture();
    // Install only this private, already-connected Core client in the host transport slot.
    // Observation, completion admission, input delivery and captured recording remain real.
    const runtime = new RuntimeController(h.store);
    (runtime as unknown as { hosts: Map<string, { client: AgentMuxClient }> }).hosts.set('local', { client: h.client });
    runtime.setContinuousProgressInputObserver(async () => false);
    const completionId = JSON.stringify([h.session.run.runId, 1]);
    const condition = agentPromptCondition(h.client.agentSession(h.session.agentSessionId));
    const loop: ContinuousProgressLoop = {
        loopId: 'private-progress-loop', hostId: 'local', agentSessionId: h.session.agentSessionId,
        providerId: 'generic', workspacePath: h.session.workspacePath, intervalMs: 10,
        prompt: 'Continue automatically', nextCheckAt: 0, status: 'active',
        pendingCompletion: { inputByte: 0, id: completionId, operationId: 'private-automation', condition }
    };
    expect(await deliverContinuousProgress(runtime, loop, 'private-automation', () => true, new AbortController().signal)).toBe('sent');
    const captured = await h.client.sessionTimeline(h.session.agentSessionId);
    expect(captured.items).toEqual([expect.objectContaining({
        id: 'prompt:private-automation', kind: 'user_message', source: 'user', content: loop.prompt
    })]);
    expect(captured.items[0]!.authorAgentSessionId).toBeUndefined();
    expect(h.writes).toEqual([{ runId: h.session.run.runId, data: loop.prompt + '\r' }]);
    await h.render();
    const markers = [...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__message')];
    expect(markers.map(marker => marker.dataset.messageId)).toEqual(['captured:prompt:private-automation']);
    expect(Number(markers[0]!.dataset.messageAt)).toBe(captured.items[0]!.createdAt);
    expect(markers[0]!.getAttribute('aria-label')).toMatch(/^Prompt in .+, sender not recorded$/);
    expect(markers[0]!.title).toContain('Prompt · Sender not recorded');
    await act(async () => markers[0]!.click());
    const preview = previewOf(markers[0]!);
    expect(preview.getAttribute('aria-label')).toBe('Message');
    expect(preview.textContent).toContain('Prompt · Sender not recorded');
    expect(preview.textContent).toContain(loop.prompt);
    expect(h.onSelect).not.toHaveBeenCalled();
    await act(async () => preview.querySelector<HTMLButtonElement>(':scope > button')!.click());
    expect(h.onSelect).toHaveBeenCalledExactlyOnceWith(h.session.agentSessionId);
    expect(useAppStore.getState().timelines[h.session.agentSessionId]!.items).toEqual(captured.items);
});
it('does not infer Human authorship from a non-user source even when its kind says user_message', async () => {
    const h = await fixture();
    const at = Date.now();
    const item = { id: 'non-user-source-record', agentSessionId: h.session.agentSessionId, kind: 'user_message' as const, source: 'native-hook' as const, status: 'complete' as const, createdAt: at, updatedAt: at, title: 'Untested external authorship', content: 'A semantic input record without verified human source' };
    await h.store.applyTimelineMutation({ type: 'append', agentSessionId: h.session.agentSessionId, item });
    const captured = await h.client.sessionTimeline(h.session.agentSessionId);
    expect(captured.items).toEqual([item]);
    useAppStore.setState({ timelines: { [h.session.agentSessionId]: captured } });
    await h.render();
    const markers = [...h.element.querySelectorAll<HTMLElement>('.recent-focus__message')];
    expect(markers.map(marker => [marker.dataset.messageId, marker.dataset.messageAuthor])).toEqual([['captured:non-user-source-record', 'unknown']]);
    expect(markers[0]!.getAttribute('aria-label')).toContain('sender not recorded');
    expect(useAppStore.getState().timelines[h.session.agentSessionId]!.items).toEqual([item]);
});
