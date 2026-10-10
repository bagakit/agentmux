// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), base = composerSession('image-display')
const agent = { ...base, control: { ...base.control, agentSessionId: 'canonical-image-reader' } }
const neighbor = { ...composerSession('neighbor-image-display'), hostId: 'neighbor-host', control: { ...agent.control, hostId: 'neighbor-host' } }
const pasted = fixturePath('reader/.agentmux/pasted/original.png')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const page: AgentSessionHistoryPage = { agentSessionId: agent.control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'original-images' }, nextCursor: null,
  items: [{ id: 'original-record', turnId: 'original-turn', kind: 'user-message', startedAt: _historyFixtureEpoch(0, 0, 1), contentParts: [
    { kind: 'text', text: 'Original image request' }, { kind: 'resource', resourceType: 'image', reference: 'original-native-image', label: 'Original image' }
  ] }] }
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'image-reply', agentSessionId: agent.id, kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Reply', content: `Inspect @${pasted}\n\n[Reference](https://example.invalid/reference)`, createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] }
const context = () => agentContextForSession(agent, timeline, 'Original images', composerConfig.workspaces[0]!, null)
const panel = () => document.querySelector<HTMLElement>('.agent-information-reader')!
const observers = new Set<{ targets: Set<Element>; callback: IntersectionObserverCallback }>()
async function intersect() { await act(async () => { for (const observer of observers) observer.callback([...observer.targets].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver); for (let n = 0; n < 10; n++) await Promise.resolve() }) }
async function open(surface: 'workspace' | 'focus' = 'workspace') {
  await dom.render(surface === 'focus' ? <FocusContextRow context={context()} selected={false} onSelect={() => {}} /> : <WorkspaceAgentRow context={context()} percent={null} onOpen={() => {}} />)
  expect(api.ui.readPastedImage).not.toHaveBeenCalled(); expect(api.sessions.historyResource).not.toHaveBeenCalled()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.workspace-agent-row, .focus-context')!.focus())
  await act(async () => { for (let n = 0; n < 10; n++) await Promise.resolve() })
  expect(panel()).not.toBeNull()
}
beforeEach(() => {
  observers.clear()
  vi.stubGlobal('IntersectionObserver', class {
    targets = new Set<Element>()
    constructor(public callback: IntersectionObserverCallback) { observers.add(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { observers.delete(this) }
  })
  useAppStore.setState({ sessions: [agent, neighbor], timelines: { [agent.id]: timeline }, demands: {}, agentNames: {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: page.source, dispose() {} }))
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue({ dataUrl: 'data:image/png;base64,' + png })
  vi.spyOn(api.sessions, 'historyResource').mockImplementation(async (_subject, request) => ({ agentSessionId: agent.control.agentSessionId, ...request, reference: request.expectedReference, result: { status: 'read', mimeType: 'image/png', dataBase64: png, byteLength: 68 } }))
})

afterEach(() => vi.unstubAllGlobals())

it.each(['workspace', 'focus'] as const)('loads visible original pasted and native images in %s through exact readers while links stay inert', async surface => {
  await open(surface)
  expect(api.ui.readPastedImage).not.toHaveBeenCalled(); expect(api.sessions.historyResource).not.toHaveBeenCalled()
  await intersect()
  expect(api.ui.readPastedImage).toHaveBeenCalledWith(pasted)
  expect(api.sessions.historyResource).toHaveBeenCalledExactlyOnceWith({ hostId: agent.control.hostId, agentSessionId: agent.control.agentSessionId }, {
    source: page.source, recordId: 'original-record', turnId: 'original-turn', partIndex: 1, expectedReference: 'original-native-image'
  })
  expect(panel().querySelectorAll('img.md-conversation-image__thumb')).toHaveLength(2)
  expect(panel().querySelectorAll('.focus-context-hover__prose button')).toHaveLength(0)
  expect(panel().querySelector('[role="dialog"]')).toBeNull()
  expect(panel().querySelector('.md-link--readonly')?.getAttribute('title')).toBe('https://example.invalid/reference')
})

it('keeps structured original images when the full input uses the literal long-text path', async () => {
  const long = 'Original long input '.repeat(600) + 'COMPLETE IMAGE INPUT TAIL'
  vi.mocked(api.sessions.historyPage).mockResolvedValue({ ...page, items: [{ ...page.items[0]!, contentParts: [{ kind: 'text', text: long }, page.items[0]!.contentParts[1]!] }] })
  await open()
  const entry = panel().querySelector<HTMLElement>('.agent-input-recall__entry')!
  await act(async () => { entry.focus(); entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await intersect()
  expect(panel().querySelector('[data-reading-format="plain"]')?.textContent).toContain('COMPLETE IMAGE INPUT TAIL')
  expect(panel().querySelector('.agent-input-recall__original img')).not.toBeNull()
  expect(api.sessions.historyResource).toHaveBeenCalledTimes(1)
})

it('rejects another original resource receipt and preserves its text and honest failure', async () => {
  vi.mocked(api.sessions.historyResource).mockImplementation(async (_subject, request) => ({ agentSessionId: agent.control.agentSessionId, ...request, recordId: 'neighbor-record', reference: request.expectedReference, result: { status: 'read', mimeType: 'image/png', dataBase64: png, byteLength: 68 } }))
  await open(); await intersect()
  const input = panel().querySelector('[data-hover-input-id]')!
  expect(input.querySelector('img')).toBeNull(); expect(input.textContent).toContain('Original image request')
  expect(input.textContent).toContain('another recorded resource')
})

it('does not attach a late image or issue more reads after the original pinned Run changes', async () => {
  let resolve!: (image: { dataUrl: string }) => void
  vi.mocked(api.ui.readPastedImage).mockImplementation(() => new Promise(done => { resolve = done }))
  await open(); await intersect()
  expect(api.ui.readPastedImage).toHaveBeenCalledWith(pasted)
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
  const before = vi.mocked(api.ui.readPastedImage).mock.calls.length
  await act(async () => useAppStore.setState({ sessions: [{ ...agent, control: { ...agent.control, run: { runId: 'replacement-image-run' } } }, neighbor] }))
  await act(async () => resolve({ dataUrl: 'data:image/png;base64,' + png }))
  expect(panel().querySelector('.focus-context-hover__recap img')).toBeNull()
  expect(panel().textContent).toContain('Original Run or source is no longer confirmed')
  await intersect(); expect(api.ui.readPastedImage).toHaveBeenCalledTimes(before)
})
