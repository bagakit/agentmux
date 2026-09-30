// @vitest-environment happy-dom
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import type { SessionSnapshot, SessionRecoveryResult } from '../src/shared/contracts';
import { api } from '../src/renderer/src/lib/api';
import { useAppStore } from '../src/renderer/src/store';
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs';
import { createWorkspaceLayout } from '@agentmux/layout';
// Keep the real Space Workbench/Region/SessionPane restart caller and Store; paint transport alone is isolated.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: {
        session: SessionSnapshot;
    }) => createElement('div', { 'data-test-terminal-paint': session.id }) }));
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }));
// Node export does not register browser panels before the production layout effect. Geometry is a separate native qualification.
vi.mock('react-resizable-panels', () => ({ PanelGroup: forwardRef(({ children }: {
        children: ReactNode;
    }, ref) => { useImperativeHandle(ref, () => ({ getLayout: () => [50, 50], setLayout: () => { } })); return createElement('div', null, children); }), Panel: ({ children }: {
        children: ReactNode;
    }) => createElement('div', null, children), PanelResizeHandle: () => createElement('div') }));
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice';
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench';
const initial = useAppStore.getState();
let root: Root, container: HTMLDivElement, resolveRecovery: (result: SessionRecoveryResult) => void, recover: MockInstance<typeof api.sessions.recover>, originalTab: ReturnType<typeof createWorkbenchTab>, recovered: SessionSnapshot;
function terminal(id: string): SessionSnapshot { return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo', label: 'Terminal', createdAt: 1, updatedAt: 1, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0, control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }; }
function Notices() { const state = useAppStore(); return createElement(TransientErrorNotice, { error: state.error, dismissed: state.errorDismissed, lastError: state.lastError, onDismiss: state.dismissError, onReopen: state.reopenError, kind: state.errorNoticeContext?.kind ?? 'indeterminate' }); }
function Fixture() { return createElement('section', null, createElement(Notices), createElement(WorkspaceWorkbench, { workspaceId: 'repo', visible: true })); }
const row = (id: string) => { const r = container.querySelector<HTMLElement>(`[data-test-terminal-paint="${id}"]`); expect(r).not.toBeNull(); return r!; };
const selectedTab = () => useAppStore.getState().layouts.repo!.groups[0]!.activeTabId;
const point = (id: string) => row(id).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const config = await api.config.get(), old = { ...terminal('old'), processState: 'exited' as const, status: { state: 'error' as const, source: 'run-process' as const, observedAt: 2, exitCode: 1, exitReason: 'crashed' as const, detail: 'Exited with code 1' } }, sibling = terminal('sibling'), neighbor = terminal('neighbor');
    recovered = terminal('new');
    originalTab = addWorkbenchRegion(createWorkbenchTab('original-tab', { regionId: 'old-region', kind: 'terminal', phase: 'attached', workspaceId: 'repo', sessionId: 'old' }), 'old-region', 'right', { regionId: 'sibling-region', kind: 'terminal', phase: 'attached', workspaceId: 'repo', sessionId: 'sibling' });
    originalTab = { ...originalTab, name: 'Original work' };
    const neighborTab = { ...createWorkbenchTab('neighbor-tab', { regionId: 'neighbor-region', kind: 'terminal', phase: 'attached', workspaceId: 'repo', sessionId: 'neighbor' }), name: 'Other work' };
    useAppStore.setState({ config: { ...config, workspaces: [{ id: 'repo', kind: 'folder', hostId: 'local', path: '/repo', name: 'Repo' }] }, sessions: [old, sibling, neighbor], timelines: {}, providerCatalog: [], agentNames: {}, tabs: { [originalTab.id]: originalTab, [neighborTab.id]: neighborTab }, layouts: { repo: createWorkspaceLayout('original-group', [originalTab.id, neighborTab.id]) }, activeWorkspaceId: 'repo', mainSurface: 'workbench', agentComposerDrafts: { sibling: 'Preserve this draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } });
    recover = vi.spyOn(api.sessions, 'recover').mockImplementation(() => new Promise<SessionRecoveryResult>(resolve => { resolveRecovery = resolve; }));
    await act(async () => { root.render(createElement(Fixture)); await settle(); });
    await act(async () => { point('old'); await settle(); });
    expect(selectedTab()).toBe('original-tab');
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function clickRestart() { const button = container.querySelector<HTMLButtonElement>('[data-workbench-region-id="old-region"] .terminal-recovery__actions button'); expect(button).not.toBeNull(); expect(button!.textContent).toContain('Restart terminal'); await act(async () => button!.click()); expect(recover).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledWith(useAppStore.getState().sessions.find(s => s.id === 'old')!.control, '/repo', undefined); }
it('keeps the restarted Terminal and execution focus in its original Space split and working surface', async () => {
    await clickRestart();
    const before = useAppStore.getState(), layout = before.layouts.repo!, sibling = before.sessions.find(s => s.id === 'sibling')!, neighbor = before.sessions.find(s => s.id === 'neighbor')!, drafts = before.agentComposerDrafts;
    await act(async () => { resolveRecovery({ kind: 'terminal-restarted', session: recovered }); await settle(); });
    const after = useAppStore.getState();
    expect(after.sessions.map(s => s.id).sort()).toEqual(['neighbor', 'new', 'sibling']);
    expect(after.sessions.find(s => s.id === 'sibling')).toBe(sibling);
    expect(after.sessions.find(s => s.id === 'neighbor')).toBe(neighbor);
    expect(after.agentComposerDrafts).toBe(drafts);
    expect(after.layouts.repo).toEqual(layout);
    expect.soft(after.tabs['original-tab']!.layout).toEqual(before.tabs['original-tab']!.layout);
    expect(Object.keys(after.tabs['original-tab']!.regions)).toEqual(['old-region', 'sibling-region']);
    expect(after.tabs['original-tab']!.regions['old-region']).toEqual({ ...originalTab.regions['old-region'], sessionId: 'new' });
    expect(after.tabs['neighbor-tab']).toBe(before.tabs['neighbor-tab']);
    expect.soft(after.agentFocus.execution.sessionId).toBe('new');
    expect.soft(String(useAppStore.getState().agentFocus.execution.sessionId === 'new')).toBe('true');
    expect.soft(selectedTab()).toBe('original-tab');
    expect.soft(container.querySelector('[data-test-terminal-paint="new"]')).not.toBeNull();
});
it('does not steal a newer user selection while the original restart is pending', async () => {
    await clickRestart();
    await act(async () => { point('neighbor'); await settle(); });
    const choice = useAppStore.getState().agentFocus;
    await act(async () => { resolveRecovery({ kind: 'terminal-restarted', session: recovered }); await settle(); });
    const after = useAppStore.getState();
    expect(after.agentFocus).toBe(choice);
    expect(after.agentFocus.execution.sessionId).toBe('neighbor');
    expect(String(useAppStore.getState().agentFocus.execution.sessionId === 'neighbor')).toBe('true');
    expect(selectedTab()).toBe('neighbor-tab');
    expect(after.tabs['original-tab']!.regions['old-region']).toEqual({ ...originalTab.regions['old-region'], sessionId: 'new' });
});
it('preserves a later Region selection inside the same original split', async () => {
    await clickRestart();
    const region = container.querySelector<HTMLElement>('[data-workbench-region-id="sibling-region"]');
    expect(region).not.toBeNull();
    await act(async () => { region!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); await settle(); });
    const choice = useAppStore.getState();
    expect(choice.agentFocus.execution.sessionId).toBe('sibling');
    expect(choice.tabs['original-tab']!.layout.activeRegionId).toBe('sibling-region');
    await act(async () => { resolveRecovery({ kind: 'terminal-restarted', session: recovered }); await settle(); });
    const after = useAppStore.getState();
    expect(after.agentFocus).toBe(choice.agentFocus);
    expect(after.tabs['original-tab']!.layout).toBe(choice.tabs['original-tab']!.layout);
    expect(selectedTab()).toBe('original-tab');
    expect(String(useAppStore.getState().agentFocus.execution.sessionId === 'sibling')).toBe('true');
});
it('keeps execution focus cleared during a pending Space Terminal restart', async () => {
    await clickRestart();
    // Execution focus is a semantic reference even when ordinary Terminals stay in Space.
    // The actual Focus close control has its own App caller positive; no Terminal card is invented.
    await act(async () => { useAppStore.getState().focusExecutionSession(null); await settle(); });
    const choice = useAppStore.getState().agentFocus;
    expect(choice.execution.sessionId).toBeNull();
    await act(async () => { resolveRecovery({ kind: 'terminal-restarted', session: recovered }); await settle(); });
    const after = useAppStore.getState();
    expect(after.agentFocus).toBe(choice);
    expect(container.querySelector('.global-focus-surface')).toBeNull();
    expect(container.querySelector('[data-workbench-region-id="old-region"]')).not.toBeNull();
    expect(after.tabs['original-tab']!.regions['old-region']).toEqual({ ...originalTab.regions['old-region'], sessionId: 'new' });
});

it('shows the cleanup failure beside the recovered Terminal without losing healthy neighbors', async () => {
    const before = useAppStore.getState(), old = before.sessions.find(session => session.id === 'old')!, sibling = before.sessions.find(session => session.id === 'sibling')!, neighbor = before.sessions.find(session => session.id === 'neighbor')!, neighborTab = before.tabs['neighbor-tab']!, drafts = before.agentComposerDrafts;
    const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async control => {
        expect(control).toEqual(recovered.control);
        throw new Error('Recovered terminal cleanup failed');
    });
    await clickRestart();
    await act(async () => { await useAppStore.getState().closeRegion('repo', 'original-tab', 'old-region');
        expect(useAppStore.getState().tabs['original-tab']!.regions['old-region']).toBeUndefined();
        expect(stop).not.toHaveBeenCalled(); await settle(); });
    await act(async () => { resolveRecovery({ kind: 'terminal-restarted', session: recovered }); await settle(); });
    const after = useAppStore.getState();
    expect(stop.mock.calls.map(([control]) => control)).toEqual([recovered.control]);
    expect(after.sessions.find(session => session.id === 'new')).toBe(recovered);
    expect(after.sessions.find(session => session.id === 'sibling')).toBe(sibling);
    expect(after.sessions.find(session => session.id === 'neighbor')).toBe(neighbor);
    expect(after.tabs['neighbor-tab']).toBe(neighborTab);
    expect(after.tabs['original-tab']!.regions['sibling-region']).toEqual(originalTab.regions['sibling-region']);
    expect(after.agentComposerDrafts).toBe(drafts);
    expect(after.closingWorkbenchViews).toEqual({});
    expect(String(useAppStore.getState().agentFocus.execution.sessionId === 'new')).toBe('true');
    expect(container.querySelector('[data-test-terminal-paint="new"]')).not.toBeNull();
    const notices = container.querySelectorAll('.error-notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.getAttribute('role')).toBe('status');
    expect(notices[0]!.textContent).toContain('Recovered Session owner disappeared and cleanup failed');
    expect(notices[0]!.querySelector('[aria-label="Dismiss error"]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click(); await settle(); });
    expect(container.querySelectorAll('.error-notice')).toHaveLength(0);
    const reopen = container.querySelector<HTMLButtonElement>('.error-notice__reopen');
    expect(reopen).not.toBeNull();
    await act(async () => { reopen!.click(); await settle(); });
    expect(container.querySelectorAll('.error-notice')).toHaveLength(1);
    expect(container.querySelector('.error-notice')!.textContent).toContain('cleanup failed');
    expect(container.querySelector('[data-test-terminal-paint="new"]')).not.toBeNull();
    expect(useAppStore.getState().sessions.find(session => session.id === 'sibling')).toBe(sibling);

});
