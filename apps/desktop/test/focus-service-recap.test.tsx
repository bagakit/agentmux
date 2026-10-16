// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { conversationRevision, projectConversationSummary } from '@agentmux/core/conversation'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

vi.mock('@agentmux/core/conversation', async original => {
  const actual = await original<typeof import('@agentmux/core/conversation')>()
  return { ...actual, projectConversationSummary: vi.fn(actual.projectConversationSummary) }
})
// Keep Global, projection, viewport slots, body, original Row, content and Core.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => <span /> }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const baseline = useAppStore.getState(), project = vi.mocked(projectConversationSummary)
let root: Root, container: HTMLDivElement
const at = _tailFixtureEpoch(1)
const io: { callback: IntersectionObserverCallback; targets: Set<Element> }[] = []
function data() {
  const running = Array.from({ length: 25 }, (_, index) => composerSession(`running-${index}`))
  const retained = Array.from({ length: 254 }, (_, index) => ({ ...composerSession(`retained-${index}`), processState: 'interrupted' as const }))
  const sessions = [...running, ...retained]
  const timelines: Record<string, AgentTimelineSnapshot> = Object.fromEntries(sessions.map(session => [session.id, {
    agentSessionId: session.id, sourceHostId: 'local', revision: 1,
    items: Array.from({ length: 40 }, (_, index) => ({ id: `${session.id}-${index}`, agentSessionId: session.id,
      kind: index % 2 ? 'assistant_message' as const : 'user_message' as const,
      source: 'native-hook' as const, status: 'complete' as const, title: index % 2 ? 'Reply' : 'Prompt',
      content: index === 39 ? `Original complete response needle-${session.id}` : `Original ${session.id} record ${index}`,
      createdAt: at + index, updatedAt: at + index }))
  }]))
  return { sessions, timelines, agentNames: {}, config: composerConfig, scratchTopicSnapshots: {} }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); project.mockClear(); io.length = 0
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof io[number]
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, targets: new Set() }; io.push(this.record) }
    observe(target: Element) { this.record.targets.add(target) }
    unobserve(target: Element) { this.record.targets.delete(target) }
    disconnect() { this.record.targets.clear() }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(704)
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const grid = this.closest('.focus-context-group__cards')
    const columns = Number.parseInt(this.closest<HTMLElement>('.focus-context-group')?.style.getPropertyValue('--focus-card-columns') || '3')
    if (this.dataset.focusCardBody) {
      const index = [...this.parentElement!.children].indexOf(this)
      return new DOMRect(index % columns * 200, Math.floor(index / columns) * 54, 200, 52)
    }
    if (this.classList.contains('focus-context-group__cards')) return new DOMRect(0, 0, 600, Math.ceil(this.children.length / columns) * 54)
    return new DOMRect(0, 0, 600, grid ? 52 : 704)
  })
  useAppStore.setState({ ...data(), mainSurface: 'agents', tabs: {}, layouts: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    focusTimelineNameWidth: 112, agentComposerDrafts: { original: 'Keep the original draft' } })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); project.mockClear()
})
const slots = () => [...container.querySelectorAll<HTMLElement>('.focus-context-group__cards > [data-focus-card-body]')]
const bodies = () => slots().filter(slot => slot.dataset.focusCardBody === 'mounted')
const idFor = (slot: HTMLElement) => JSON.parse(slot.dataset.focusCardKey!)[1] as string
const card = (id: string) => container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${id}"]`)!
async function query(text: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('retains all original metadata, result/unknown/attention truth and group order while only exact service recaps defer', () => {
  const input = data(), original = input.sessions[0]!, observed = Date.now() - 10
  const controls = [
    { ...original, id: 'done', control: { ...original.control, agentSessionId: 'done' }, status: { ...original.status, state: 'done' as const, source: 'native-hook' as const, observedAt: observed + 5 },
      semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: observed + 5, stateEnteredAt: observed + 1 } },
    { ...original, id: 'unknown', control: { ...original.control, agentSessionId: 'unknown' } },
    { ...original, id: 'attention', processState: 'interrupted' as const, control: { ...original.control, agentSessionId: 'attention' }, status: { ...original.status, state: 'waiting' as const } },
    { ...original, id: 'error', processState: 'interrupted' as const, control: { ...original.control, agentSessionId: 'error' }, status: { ...original.status, state: 'error' as const } },
    { ...original, id: 'pending', processState: 'interrupted' as const, control: { ...original.control, agentSessionId: 'pending' },
      pendingInteraction: { kind: 'permission' as const, id: 'original-request', agentSessionId: 'pending', title: 'Allow original edit?',
        options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' as const }], evidence: { source: 'native-hook' as const, observedAt: _tailFixtureEpoch(0, 0, 1), run: original.control.run } } },
    { ...original, id: 'unobserved', runUnobserved: true as const, control: { ...original.control, agentSessionId: 'unobserved' } }
  ]
  for (const control of controls) input.timelines[control.id] = { ...input.timelines[original.id]!, agentSessionId: control.id,
    items: input.timelines[original.id]!.items.map(item => ({ ...item, agentSessionId: control.id })) }
  input.sessions.push(...controls)
  const select = createFocusProjectionSelector(), full = select(input), metadata = select(input, true, 'metadata')
  expect(metadata.contexts).toHaveLength(285)
  expect(metadata.contexts.map(row => row.id)).toEqual(full.contexts.map(row => row.id))
  for (const row of metadata.contexts) {
    const complete = full.contexts.find(value => value.id === row.id)!
    expect({ ...row, recap: undefined }).toEqual({ ...complete, recap: undefined })
    if (row.id.startsWith('retained-') || row.id === 'unobserved') expect(row.recap).toBeUndefined()
    else expect(row.recap).toBe(complete.recap)
  }
  expect(metadata.contexts.find(row => row.id === 'done')!.bucket).toBe('results')
  expect(metadata.contexts.find(row => row.id === 'unknown')!.activitySemantic).toBe('unknown')
  expect(metadata.contexts.find(row => row.id === 'attention')!.bucket).toBe('attention')
  expect(metadata.contexts.find(row => row.id === 'error')!.bucket).toBe('attention')
  expect(metadata.contexts.find(row => row.id === 'pending')!.bucket).toBe('attention')
  expect(select(input, true, 'full').contexts.map(row => row.id)).toEqual(full.contexts.map(row => row.id))
  expect(select(input, true, 'metadata').contexts.map(row => row.id)).toEqual(full.contexts.map(row => row.id))
  const changed = { ...input, sessions: input.sessions.map(session => session.id === 'running-0'
    ? { ...session, status: { ...session.status, state: 'waiting' as const, source: 'native-hook' as const, observedAt: observed + 6 },
      semanticStatus: { state: 'waiting' as const, source: 'native-hook' as const, observedAt: observed + 6, stateEnteredAt: observed } } : session) }
  const transitioned = select(changed, true, 'metadata').contexts.map(row => row.id)
  expect(transitioned[0], 'A later real group transition precedes the older done entry').toBe('running-0')
  expect(select(changed, true, 'full').contexts.map(row => row.id)).toEqual(transitioned)
  expect(select(changed, true, 'metadata').contexts.map(row => row.id)).toEqual(transitioned)
})

it('the actual Global mounts 279 slots, reads only running or visible bodies, and fully searches pending original content', async () => {
  const before = useAppStore.getState(), select = vi.fn()
  await act(async () => root.render(<GlobalFocusSurface onSelectContext={select} />))
  expect(slots()).toHaveLength(279)
  expect(bodies().length).toBeGreaterThan(25); expect(bodies().length).toBeLessThan(80)
  expect(container.querySelectorAll('.focus-context__identity')).toHaveLength(bodies().length)
  const expected = new Set([...before.sessions.filter(session => session.processState === 'running').map(session => session.id), ...bodies().map(idFor)])
  expect(new Set(project.mock.calls.map(([input]) => input.agentSessionId))).toEqual(expected)
  expect(project).toHaveBeenCalledTimes(expected.size)
  const beforeUnrelated = project.mock.calls.length
  await act(async () => useAppStore.setState({ focusTimelineHeight: before.focusTimelineHeight + 1 }))
  expect(project).toHaveBeenCalledTimes(beforeUnrelated)
  const originalOrder = slots().map(idFor), pending = slots().find(slot => idFor(slot) === 'retained-200')!
  expect(pending.dataset.focusCardBody).toBe('pending')
  expect(card('retained-200').getAttribute('aria-label')).toContain('Run interrupted')
  expect(card('retained-200').getAttribute('aria-label')).not.toContain('needle-retained-200')
  const visibleRetained = bodies().find(slot => idFor(slot).startsWith('retained-'))!
  expect(card(idFor(visibleRetained)).getAttribute('aria-label')).toContain(`needle-${idFor(visibleRetained)}`)
  const focusedId = idFor(slots().find(slot => slot.dataset.focusCardBody === 'pending' && idFor(slot) !== 'retained-200')!)
  await act(async () => card(focusedId).focus())
  expect(card(focusedId).getAttribute('aria-label')).toContain(`needle-${focusedId}`)
  expect(slots().find(slot => idFor(slot) === focusedId)!.dataset.focusCardBody).toBe('mounted')
  await query('needle-retained-200')
  expect(slots().map(idFor)).toEqual(['retained-200'])
  expect(card('retained-200').getAttribute('aria-label')).toContain('needle-retained-200')
  expect(new Set(project.mock.calls.map(([input]) => input.agentSessionId)).size).toBe(279)
  await query('')
  expect(slots().map(idFor)).toEqual(originalOrder)
  expect(select).not.toHaveBeenCalled()
  for (const key of ['sessions', 'timelines', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('crosses the outer cache and updates a real retained body for same-wrapper version/source/items/stream changes', async () => {
  await act(async () => root.render(<GlobalFocusSurface />))
  const id = idFor(bodies().find(slot => idFor(slot).startsWith('retained-'))!)
  const original = card(id), state = useAppStore.getState(), timeline = state.timelines[id]!
  const selector = createFocusProjectionSelector(), held = selector(state, true, 'metadata')
  const change = async (text: string, mutate: () => void) => {
    project.mockClear(); mutate()
    await act(async () => useAppStore.setState({ timelines: state.timelines }))
    expect(card(id)).toBe(original)
    expect(card(id).getAttribute('aria-label')).toContain(text)
    expect(project.mock.calls.map(([input]) => input.agentSessionId)).toEqual([id])
  }
  await change('Revision response', () => { timeline.items[39] = { ...timeline.items[39]!, content: 'Revision response' }; timeline.revision++ })
  project.mockClear(); timeline.items[0] = { ...timeline.items[0]!, content: 'New original first prompt' }; timeline.revision++
  const renamed = selector(state, true, 'metadata')
  expect(renamed.contexts.find(row => row.id === id)!.name).toBe('New original first prompt')
  expect(renamed.contexts.find(row => row.id === id)).not.toBe(held.contexts.find(row => row.id === id))
  await act(async () => useAppStore.setState({ timelines: state.timelines }))
  expect(card(id).querySelector('strong')!.textContent).toBe('New original first prompt')
  await change('Revision response', () => { timeline.sourceHostId = 'changed-original-source' })
  await change('Replacement items response', () => { timeline.items = timeline.items.map((item, index) => index === 39 ? { ...item, content: 'Replacement items response' } : item) })
  const stream = (epoch: string): NonNullable<AgentTimelineSnapshot['stream']> => ({ epoch, sequence: 40, revision: timeline.revision, origin: 'beginning', gaps: [],
    positions: timeline.items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) })
  await change('Replacement items response', () => { timeline.stream = stream('original-epoch') })
  await change('Epoch response', () => {
    timeline.items[39] = { ...timeline.items[39]!, content: 'Epoch response' }
    timeline.stream!.epoch = 'changed-epoch'; timeline.stream!.positions = stream('changed-epoch').positions
  })
  await change('Epoch response', () => { timeline.stream = { ...timeline.stream! } })
  project.mockClear(); timeline.agentSessionId = 'different-original-subject'
  await act(async () => useAppStore.setState({ timelines: state.timelines }))
  expect(card(id).getAttribute('aria-label')).not.toContain('Epoch response')
  expect(project.mock.calls.map(([input]) => input.agentSessionId)).toEqual(['different-original-subject'])
})
