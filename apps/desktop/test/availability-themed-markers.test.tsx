// @vitest-environment happy-dom
import { act } from 'react';
import { it, expect, vi } from 'vitest';
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme';
import { semanticIconHref } from '@agentmux/client-ui/icons';
import { AgentExecutorPicker } from '../src/renderer/src/components/AgentExecutorPicker';
import { MobileIdentity } from '../../mobile/src/navigation/MobileIdentity';
import { composerDOM } from './helpers/composer-dom-fixture';
import type { ExecutorDetectionInput } from '../src/shared/contracts';
import type { ExecutorChoice } from '../src/renderer/src/lib/executors';
const dom = composerDOM(), input: ExecutorDetectionInput = { executorId: 'original', providerId: 'codex', command: 'unused', host: { id: 'local', kind: 'local' as const, label: 'Local' } }, choices: ExecutorChoice[] = [{ id: 'unknown', label: 'Original colleague', providerId: 'codex', command: 'unused', detection: { state: 'error', input, detail: 'Original probe unavailable' } }, { id: 'ready', label: 'Ready colleague', providerId: 'claude', command: 'unused', detection: { state: 'ready', input } }];
it('actual catalog unconfirmed marker follows theme while preserving the unknown original executor available selection', async () => { const cleanup = mountThemeRuntime(window), select = vi.fn(); try {
    await dom.render(<AgentExecutorPicker executors={choices} selected="unknown" onSelect={select}/>);
    const row = dom.container.querySelector<HTMLButtonElement>('[data-executor-id="unknown"]')!, marker = row.querySelector('.agent-pick__unconfirmed')!;
    expect(marker, 'actual nonempty unknown executor observation').not.toBeNull();
    expect(marker.getAttribute('aria-label')).toBe('Check failed');
    expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.unknown'));
    expect(row.disabled).toBe(false);
    const custom = structuredClone(GRAPHITE_THEME);
    custom.id = 'custom.executor-observation';
    custom.name = 'Unknown observation';
    custom.icons = { 'status.unknown': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } };
    await act(async () => { expect(previewTheme(custom).applied).toBe(true); });
    expect(dom.container.querySelector('[data-executor-id="unknown"]')).toBe(row);
    expect(document.getElementById(semanticIconHref('status.unknown').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');
    await act(async () => row.click());
    expect(select).toHaveBeenCalledExactlyOnceWith('unknown');
    expect(dom.container.querySelector('[data-executor-id="ready"] .agent-pick__unconfirmed')).toBeNull();
}
finally {
    await dom.render(null);
    cleanup();
} });
it('actual Mobile identity issue can change only its warning glyph and retains original identity/title/unknown expression', async () => { const cleanup = mountThemeRuntime(window), identity = { name: 'Original Mote', project: 'Original project', mote: { spaceId: 'original-mote', appearance: { spaceId: 'original-mote', glyph: 'bot', issue: 'Original avatar content unconfirmed' } } }; try {
    await dom.render(<MobileIdentity identity={identity} client={null} connected={false} size={32}/>);
    const carrier = dom.container.querySelector('.mobile-object-avatar')!, marker = carrier.querySelector('.mobile-avatar-issue')!;
    expect(marker, 'actual nonempty avatar observation warning').not.toBeNull();
    expect(marker.getAttribute('aria-label')).toBe(identity.mote.appearance.issue);
    expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.warning'));
    expect(carrier.getAttribute('title')).toBe(identity.mote.appearance.issue);
    expect(carrier.getAttribute('data-mote-expression')).toBe('unknown');
    const avatar = carrier.querySelector('.space-object-icon')!;
    const custom = structuredClone(GRAPHITE_THEME);
    custom.id = 'custom.avatar-observation';
    custom.name = 'Avatar observation warning';
    custom.icons = { 'status.warning': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } };
    await act(async () => { expect(previewTheme(custom).applied).toBe(true); });
    expect(carrier.querySelector('.space-object-icon')).toBe(avatar);
    expect(document.getElementById(semanticIconHref('status.warning').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');
    expect(marker.querySelector('svg')?.getAttribute('width')).toBe('10');
    expect(carrier.getAttribute('data-mote-expression')).toBe('unknown');
    expect(carrier.getAttribute('title')).toBe(identity.mote.appearance.issue);
}
finally {
    await dom.render(null);
    cleanup();
} });
