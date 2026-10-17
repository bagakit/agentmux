// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), agent = composerSession('recall-agent'), neighbor = composerSession('other-recall-agent')
const originalText = 'Keep the original task and its complete details.\n\n'.repeat(250) + 'COMPLETE ORIGINAL INPUT TAIL'
const page: AgentSessionHistoryPage = { agentSessionId: agent.id, source: { providerId: 'codex', nativeSessionId: 'recall-source' }, nextCursor: 'older-records',
  items: Array.from({ length: 8 }, (_, index) => ({ id: 'input-' + index, kind: 'user-message', startedAt: index + 1,
    contentParts: [{ kind: 'text', text: index === 7 ? originalText : 'Original task request ' + index }] })) }
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'recall-reply', agentSessionId: agent.id, kind: 'assistant_message' as const,
  source: 'native-hook' as const, status: 'complete' as const, title: 'Reply', content: 'Original reply remains selected and readable.', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] }
const context = () => agentContextForSession(agent, timeline, 'Input recall', composerConfig.workspaces[0]!, null)
const panel = () => document.querySelector<HTMLElement>('.agent-information-reader')!
const entries = () => [...panel().querySelectorAll<HTMLElement>('.agent-input-recall__entry')]
const detail = () => panel()?.querySelector<HTMLElement>('.agent-input-recall__original') ?? null
async function open(surface: 'focus' | 'workspace' = 'workspace') {
  await dom.render(surface === 'focus' ? <FocusContextRow context={context()} selected={false} onSelect={() => {}} /> : <WorkspaceAgentRow context={context()} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => {}} />)
  await act(async () => dom.container.querySelector<HTMLElement>('.focus-context')!.focus())
  await waitForAgentCardReading(() => expect(entries()).toHaveLength(6))
}
async function inspect() { const entry = entries().at(-1)!; await act(async () => { entry.focus(); entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }); return entry }
async function key(target: Element, value: string) { await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))) }
async function pointer(target: Element, type: 'pointerover' | 'pointerout', relatedTarget: Element | null = null) {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', relatedTarget })))
}
const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 200)))

it('the original input return control follows the shared semantic draft and retains its reading target', async () => {
  const release = mountThemeRuntime(window, { appAppearance: 'dark' })
  try {
    await open()
    const originalPanel = panel(), entry = await inspect(), original = detail()!
    const back = original.querySelector<HTMLButtonElement>('[aria-label="Back to recent inputs"]')!
    expect(back).not.toBeNull()
    const drawing = back.querySelector('svg')!
    expect(drawing.getAttribute('data-semantic-icon')).toBe('navigation.back')
    const theme = structuredClone(GRAPHITE_THEME)
    theme.id = 'custom.input-return'; theme.icons = { 'navigation.back': { kind: 'paths', paths: [{ d: 'M3 4H21L12 20Z' }] } }
    await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
    expect(original.querySelector('[aria-label="Back to recent inputs"]')).toBe(back)
    expect(back.querySelector('svg')).toBe(drawing)
    expect(drawing.querySelector('use')?.getAttribute('href')).toBe('#agentmux-icon-navigation.back')
    expect(document.getElementById('agentmux-icon-navigation.back')?.querySelector('path')?.getAttribute('d')).toBe('M3 4H21L12 20Z')
    expect(original.textContent).toContain('COMPLETE ORIGINAL INPUT TAIL')
    await act(async () => back.click())
    expect(detail()).toBeNull(); expect(panel()).toBe(originalPanel); expect(document.activeElement).toBe(entry)
  } finally { release() }
})

beforeEach(async () => {
  useAppStore.setState({ sessions: [agent, neighbor], timelines: { [agent.id]: timeline }, demands: {}, agentNames: {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: page.source, dispose() {} }))
  await agentCardConversationFixture(() => page.source)
})
it.each(['focus', 'workspace'] as const)('recalls six loaded original inputs and reads the complete selected input with layered Escape in %s', async surface => {
  await open(surface)
  expect(entries().map(node => node.querySelector('p')!.textContent)).toEqual([2, 3, 4, 5, 6, 7].map(index => index === 7 ? originalText.trim() : 'Original task request ' + index))
  expect(new Set(entries().map(node => node.closest('li')!.dataset.hoverInputId)).size).toBe(6)
  expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(agent.control, expect.objectContaining({ limit: 100 }))
  const originalPanel = panel(), entry = await inspect(), body = detail()!.querySelector<HTMLElement>('.agent-input-recall__original-body')!
  expect(body.textContent).toContain('COMPLETE ORIGINAL INPUT TAIL'); expect(document.activeElement).toBe(body)
  const range = document.createRange(); range.selectNodeContents(body.querySelector('p')!); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  expect(document.getSelection()!.toString()).toBe(originalText.trim())
  await key(body, 'Escape'); expect(detail()).toBeNull(); expect(panel()).toBe(originalPanel); expect(document.activeElement).toBe(entry)
  await key(entry, 'Escape'); expect(panel()).toBeNull()
})
it.each(['focus', 'workspace'] as const)('requires explicit input reading and keeps it through pointer transfer in %s', async surface => {
  await open(surface); const originalPanel = panel(), entry = entries().at(-1)!, outside = document.createElement('input'); document.body.append(outside); outside.focus()
  try {
    await pointer(entry, 'pointerover'); await settle()
    expect(detail()).toBeNull(); expect(panel()).toBe(originalPanel); expect(document.activeElement).toBe(outside)
    expect(panel().querySelector('.agent-input-recall h4')!.textContent).toContain('Click or Enter to read')
    await inspect()
    const original = detail()!, body = original.querySelector<HTMLElement>('[data-agent-input-reading]')!
    await pointer(entry, 'pointerout', body); await pointer(original, 'pointerover', entry); await settle()
    expect(detail()).toBe(original); expect(body.textContent).toContain('COMPLETE ORIGINAL INPUT TAIL')
    const footer = panel().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!
    await pointer(original, 'pointerout', footer); await act(async () => footer.focus()); await settle()
    expect(detail()).toBe(original); expect(document.activeElement).toBe(footer)
    await act(async () => outside.focus()); await settle()
    expect(panel()).toBeNull(); expect(document.activeElement).toBe(outside)
  } finally { outside.remove() }
})
it('keeps inspected original DOM and selection across pin and metadata, then holds the earlier reading when its Run changes', async () => {
  await open(); await inspect()
  const original = detail()!, prose = original.querySelector('p')!, range = document.createRange(); range.selectNodeContents(prose); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const selection = document.getSelection()!.toString()
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!.click())
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Back to original content"]')!.click())
  expect(detail()).toBe(original); expect(original.querySelector('p')).toBe(prose); expect(document.getSelection()!.toString()).toBe(selection)
  expect(document.activeElement).toBe(original.querySelector('[data-agent-input-reading]'))
  const outside = document.createElement('input'); document.body.append(outside)
  try {
    await act(async () => outside.focus()); await pointer(original, 'pointerout', outside); await settle()
    expect(detail()).toBe(original); expect(document.activeElement).toBe(outside)
  } finally { outside.remove() }
  await act(async () => useAppStore.setState({ sessions: [{ ...agent, control: { ...agent.control, run: { runId: 'replacement-recall-run' } } }, neighbor] }))
  expect(detail()).toBe(original); expect(original.querySelector('p')).toBe(prose); expect(panel().textContent).toContain('Reading an earlier Run or source')
  await act(async () => useAppStore.setState({ sessions: [agent, neighbor] }))
  expect(detail()).toBe(original); expect(api.sessions.historyPage).toHaveBeenLastCalledWith(agent.control, expect.objectContaining({ limit: 100 }))
})
