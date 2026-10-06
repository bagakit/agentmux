import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react';
import { it, expect, vi } from 'vitest';
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme';
import { semanticIconHref } from '@agentmux/client-ui/icons';
import { parseToolkitSnapshot } from '@agentmux/core/control';
import type { ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control';
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult';
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation';
import { api } from '../src/renderer/src/lib/api';
import { composerDOM } from './helpers/composer-dom-fixture';
import { fixturePath } from '../scripts/lib/fixture-values.mjs';
const dom = composerDOM(), definition: ToolkitToolDefinition = { id: 'original-tool', revision: 'original-revision', name: 'Original tool', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: fixturePath('work'), script: 'Original captured source', args: [] };
const base: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'idle', reason: null, admission: null, latestConfirmed: null, sequence: 1, consumerCount: 1 };
it('actual result states and reading consume nonempty 5px semantic glyphs without changing original tool actions or qualifications', async () => {
    const cleanup = mountThemeRuntime(window);
    let publish!: (s: ToolkitScriptSnapshot) => void, fail!: (s: string) => void, current = base;
    const close = vi.fn(), configure = vi.fn(), run = vi.spyOn(api.toolkit, 'run').mockImplementation(async () => current);
    vi.spyOn(api.toolkit, 'get').mockImplementation(async () => current);
    vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read, error) => { publish = read; fail = error!; return { dispose: vi.fn() }; });
    try {
        await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openHost: vi.fn(), openToolkit: configure }}><UserToolkitResult definition={definition} active close={close}/></SettingsNavigation.Provider>);
        const marker = () => dom.container.querySelector('.performance-status')!, role = (id: string) => { expect(marker(), 'actual nonempty toolkit observation').not.toBeNull(); expect(marker().querySelector('i')).toBeNull(); const icon = marker().querySelector('svg')!; expect(icon?.getAttribute('width')).toBe('5'); expect(icon.querySelector('use')?.getAttribute('href')).toBe('#agentmux-icon-' + id); expect(document.getElementById('agentmux-icon-' + id)?.children.length).toBeGreaterThan(0); };
        role('status.toolkit-reading');
        expect(marker().textContent).toBe('Reading result…');
        const states = ['idle', 'disabled', 'pending', 'running', 'stopping', 'unknown', 'succeeded', 'failed', 'stopped'] as const;
        for (const [index, state] of states.entries()) {
            const execution = { executionId: 'original-state-' + state, invocationId: 'original-invocation-' + state, definition, expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath }, run: state === 'pending' ? null : { hostId: 'local', runId: 'original-state-run' }, startedAt: _reshape_fixtureEpoch(0, 0, 1), text: 'Original typed state output', reason: state === 'unknown' ? 'Original reply unconfirmed' : null };
            current = { ...base, sequence: index + 2, state, definition: { ...definition, enabled: state !== 'disabled' }, reason: execution.reason, admission: state === 'pending' || state === 'running' || state === 'stopping' || state === 'unknown' ? { ...execution, state } : null, latestConfirmed: state === 'succeeded' || state === 'failed' || state === 'stopped' ? { ...execution, state, endedAt: _reshape_fixtureEpoch(0, 0, 2), exitCode: state === 'succeeded' ? 0 : state === 'failed' ? 7 : null } : null };
            expect(parseToolkitSnapshot(current).kind).toBe('script');
            await act(async () => publish(current));
            role('status.toolkit-' + state);
            expect(marker().getAttribute('data-state')).toBe(state);
        }
        current = { ...base, sequence: 20, state: 'succeeded', latestConfirmed: { executionId: 'original-result', invocationId: 'original-invocation', definition, expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'original-run' }, startedAt: _reshape_fixtureEpoch(0, 0, 1), endedAt: _reshape_fixtureEpoch(0, 0, 2), state: 'succeeded', exitCode: 0, reason: null, text: 'Original output' } };
        await act(async () => publish(current));
        const runButton = dom.container.querySelector<HTMLButtonElement>('.toolkit-result__actions button')!;
        expect(runButton.disabled).toBe(false);
        const custom = structuredClone(GRAPHITE_THEME);
        custom.id = 'custom.toolkit-states';
        custom.name = 'Tool result states';
        custom.icons = { 'status.toolkit-succeeded': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }, 'status.toolkit-unknown': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z' }] } };
        await act(async () => { expect(previewTheme(custom).applied).toBe(true); });
        expect(document.getElementById(semanticIconHref('status.toolkit-succeeded').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');
        expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe('Original output');
        await act(async () => runButton.click());
        expect(run).toHaveBeenCalledExactlyOnceWith(definition.id, { invocationId: expect.any(String), expectedRevision: definition.revision, expectedLatestExecutionId: 'original-result' });
        await act(async () => fail('Original reader unavailable'));
        role('status.toolkit-unknown');
        expect(marker().getAttribute('data-state')).toBe('unknown');
        expect(marker().textContent).toBe('Result unconfirmed');
        expect(runButton.disabled).toBe(true);
        expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe('Original output');
        expect(document.getElementById(semanticIconHref('status.toolkit-unknown').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z');
        const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent?.trim() === 'Configure')!;
        await act(async () => button.click());
        expect(configure).toHaveBeenCalledExactlyOnceWith(definition.id);
        expect(close).toHaveBeenCalledOnce();
    }
    finally {
        await dom.render(null);
        cleanup();
        vi.restoreAllMocks();
    }
});
it('actual inactive not-yet-loaded result does not pretend that a tool has run', async () => { const cleanup = mountThemeRuntime(window); try {
    await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openHost: vi.fn(), openToolkit: vi.fn() }}><UserToolkitResult definition={definition} active={false} close={vi.fn()}/></SettingsNavigation.Provider>);
    const marker = dom.container.querySelector('.performance-status')!;
    expect(marker, 'nonempty retained inactive result').not.toBeNull();
    expect(marker.textContent).toBe('Result not loaded');
    expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.toolkit-unloaded'));
    expect(marker.getAttribute('data-state')).toBe('idle');
}
finally {
    await dom.render(null);
    cleanup();
} });

it('actual display lane selects its own machine state independently of ordinary request outcome while preserving eligible original actions and retained display output', async () => {
  const cleanup = mountThemeRuntime(window), close = vi.fn(), configure = vi.fn(), ordinary = { ...definition, display: { script: 'Original display source', args: [] } };
  const result = { executionId: 'display-success', invocationId: 'display-invocation', definition: ordinary, expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'display-run' }, startedAt: _reshape_fixtureEpoch(0, 0, 1), endedAt: _reshape_fixtureEpoch(0, 0, 2), state: 'succeeded' as const, reason: null, exitCode: 0, text: 'Original successful display output' };
  let current: ToolkitScriptSnapshot = { ...base, definition: ordinary, state: 'idle', sequence: 20, display: { state: 'failed', reason: 'Original display failure', admission: null, latestConfirmed: { ...result, state: 'failed', exitCode: 7, reason: 'Original display failure', text: 'Failed display output' }, lastSucceeded: result, sequence: 1 } }, publish!: (value: ToolkitScriptSnapshot) => void;
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read) => { publish = read; read(current); return { dispose: vi.fn() } });
  vi.spyOn(api.toolkit, 'get').mockImplementation(async () => current);
  const run = vi.spyOn(api.toolkit, 'run').mockImplementation(async () => current), evaluate = vi.spyOn(api.toolkit, 'evaluate').mockImplementation(async () => current);
  try {
    expect(parseToolkitSnapshot(current).kind).toBe('script');
    await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openHost: vi.fn(), openToolkit: configure }}><UserToolkitResult definition={ordinary} active close={close}/></SettingsNavigation.Provider>);
    const marker = dom.container.querySelector('.performance-status')!;
    expect(marker, 'actual nonempty independent display lane').not.toBeNull();
    expect(marker.getAttribute('data-state')).toBe('failed');
    expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.toolkit-failed'));
    expect(marker.textContent).toBe('Failed');
    expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe(result.text);
    const find = (label: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-result__actions button')].find(button => button.textContent?.trim() === label)!;
    const originalRun = find('Run saved tool');
    expect(originalRun.disabled).toBe(false);
    await act(async () => find('Refresh display').click());
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(definition.id);
    expect(run).not.toHaveBeenCalled();
    current = { ...current, sequence: 21, display: { ...current.display!, state: 'unknown', reason: 'Display receipt unconfirmed', sequence: 2 } };
    await act(async () => publish(current));
    expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.toolkit-unknown'));
    expect(originalRun.disabled).toBe(false);
    const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.display-marker'; custom.name = 'Display observation'; custom.icons = { 'status.toolkit-unknown': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z' }] } };
    await act(async () => { expect(previewTheme(custom).applied).toBe(true) });
    expect(document.getElementById(semanticIconHref('status.toolkit-unknown').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z');
    expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe(result.text);
    await act(async () => originalRun.click());
    expect(run).toHaveBeenCalledExactlyOnceWith(definition.id, { invocationId: expect.any(String), expectedRevision: definition.revision, expectedLatestExecutionId: null });
    const { display: previousDisplay, ...withoutDisplay } = current;
    current = { ...withoutDisplay, sequence: 22 };
    await act(async () => publish(current));
    expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.toolkit-preparing-display'));
    expect(marker.textContent).toBe('Preparing display…');
    current = { ...current, sequence: 23, state: 'unknown', reason: 'Original ordinary request unconfirmed', display: { state: 'succeeded', reason: null, admission: null, latestConfirmed: result, lastSucceeded: result, sequence: 3 } };
    expect(parseToolkitSnapshot(current).kind).toBe('script');
    await act(async () => publish(current));
    expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.toolkit-succeeded'));
    expect(marker.textContent).toBe('Display checked');
    expect(dom.container.querySelector('[data-toolkit-previous-request]')?.textContent).toContain('Previous request is unconfirmed');
    expect(originalRun.disabled).toBe(true);

  } finally { await dom.render(null); cleanup(); vi.restoreAllMocks() }
})
