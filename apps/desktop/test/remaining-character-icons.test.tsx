// @vitest-environment happy-dom
import { act } from 'react';
import { createWorkspaceLayout } from '@agentmux/layout';
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs';
import { it, expect, vi } from 'vitest';
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme';
import { semanticIconHref } from '@agentmux/client-ui/icons';
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown';
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher';
import { MoteFirstCooperation } from '../src/renderer/src/components/MoteFirstCooperation';
import { useAppStore } from '../src/renderer/src/store';
import { useLauncherState } from '../src/renderer/src/lib/launcher-state';
import { api } from '../src/renderer/src/lib/api';
import { composerDOM } from './helpers/composer-dom-fixture';
import { scratchWorkspace, moteTopics } from './fixtures/mote-workface';
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics';
const dom = composerDOM();
it('actual QuickSwitcher key hints consume themed key meanings while original ArrowDown and Enter choose the same tab', async () => { const cleanup = mountThemeRuntime(window), initial = useAppStore.getState(), activate = vi.fn(), close = vi.fn(); try {
    useAppStore.setState({ config: await api.config.get(), scratchTopicSnapshots: {}, sessions: [], tabs: { one: createWorkbenchTab('one', { regionId: 'one-region', workspaceId: 'workspace', kind: 'file', path: 'original.txt' }, 'Original file'), two: createWorkbenchTab('two', { regionId: 'two-region', workspaceId: 'workspace', kind: 'file', path: 'second.txt' }, 'Second file') }, layouts: { workspace: createWorkspaceLayout('original-group', ['one', 'two']) }, activateTab: activate });
    await dom.render(<QuickSwitcher open onClose={close}/>);
    const footer = document.querySelector('.quick-switch__footer')!;
    expect(footer, 'actual nonempty QuickSwitcher footer').not.toBeNull();
    for (const role of ['control.key-up', 'control.key-down', 'control.key-enter'] as const)
        expect(footer.querySelector(`use[href="${semanticIconHref(role)}"]`)).not.toBeNull();
    const custom = structuredClone(GRAPHITE_THEME);
    custom.id = 'custom.keys';
    custom.name = 'Key hints';
    custom.icons = { 'control.key-up': { kind: 'glyph', glyph: 'circle-arrow-up' }, 'control.key-down': { kind: 'paths', paths: [{ d: 'M3 4H21L12 21Z' }] }, 'control.key-enter': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } };
    await act(async () => { expect(previewTheme(custom).applied).toBe(true); });
    expect(document.getElementById(semanticIconHref('control.key-enter').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');
    const input = document.querySelector<HTMLInputElement>('.quick-switch input')!;
    expect(document.querySelectorAll('.quick-switch [role="option"]')).toHaveLength(2);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.querySelector('.quick-switch [data-active="true"]')?.textContent).toContain('second.txt');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(activate).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
}
finally {
    await dom.render(null);
    cleanup();
    useAppStore.setState(initial, true);
} });
it('actual Mote question keeps its input and shortcut meaning during a Root glyph change without preparing a discussion', async () => { const cleanup = mountThemeRuntime(window), scope = { workspace: scratchWorkspace, topic: moteTopics[0]!, rootPath: scratchTopicDirectoryName(moteTopics[0]!.id) }, key = 'mote-cooperation:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath]), before = useLauncherState.getState(); try {
    useLauncherState.getState().setDraft(key, 'prompt', 'Original unprepared question');
    await dom.render(<MoteFirstCooperation scope={scope}/>);
    const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')!;
    expect(input).not.toBeNull();
    expect(dom.container.querySelector('.mote-cooperation-entry__shortcut use')?.getAttribute('href')).toBe(semanticIconHref('control.key-enter'));
    const custom = structuredClone(GRAPHITE_THEME);
    custom.id = 'custom.mote-enter';
    custom.name = 'Mote shortcut';
    custom.icons = { 'control.key-enter': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } };
    await act(async () => { expect(previewTheme(custom).applied).toBe(true); });
    expect(dom.container.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('Original unprepared question');
    expect(document.getElementById(semanticIconHref('control.key-enter').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');
}
finally {
    await dom.render(null);
    cleanup();
    useLauncherState.setState(before, true);
} });
it('actual Markdown footnote backlink uses its own theme role and retains original within-document focus for the exact reference', async () => { const cleanup = mountThemeRuntime(window); try {
    await dom.render(<><AgentMarkdown documentMode content={'Original first[^note].\n\nSecond[^note].\n\n[^note]: Original source note.'}/><AgentMarkdown documentMode content={'Other document[^note].\n\n[^note]: Other note.'}/></>);
    const docs = dom.container.querySelectorAll('[data-markdown-root]'), back = docs[0]!.querySelector<HTMLButtonElement>('[aria-label="Return to footnote 1 reference 2"]')!;
    expect(back, 'actual nonempty footnote backlink').not.toBeNull();
    expect(back.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('navigation.footnote-reference'));
    expect(back.textContent).toBe('2');
    const custom = structuredClone(GRAPHITE_THEME);
    custom.id = 'custom.footnote';
    custom.name = 'Footnote navigation';
    custom.icons = { 'navigation.footnote-reference': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z' }] } };
    await act(async () => { expect(previewTheme(custom).applied).toBe(true); });
    expect(docs[0]!.querySelector('[aria-label="Return to footnote 1 reference 2"]')).toBe(back);
    expect(document.getElementById(semanticIconHref('navigation.footnote-reference').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z');
    await act(async () => back.click());
    expect(document.activeElement).toBe(docs[0]!.querySelector('[data-md-footnote-reference="1:2"]'));
    expect(docs[1]!.textContent).toContain('Other note');
}
finally {
    await dom.render(null);
    cleanup();
} });
