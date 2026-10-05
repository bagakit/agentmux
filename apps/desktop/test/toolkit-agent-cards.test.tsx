const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ToolkitAgentCard, ToolkitAgentCardField, ToolkitResultDocument, ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import { TOOLKIT_AGENT_CARD_FIELDS } from '@agentmux/core/control'
import type { SessionSnapshot } from '../src/shared/contracts'
import { ToolkitAgentCards } from '../src/renderer/src/components/toolkit/ToolkitAgentCards'
import { AgentAvatar, ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const cost = vi.hoisted(() => ({ cardRenders: 0, storeHooks: 0, sessionVisits: 0 }))
// Count actual component executions and Store hooks without replacing either implementation.
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>()
  return { ...original, memo: ((component: (...args: any[]) => any, compare?: any) => {
    if (!/^ToolkitAgentCard\d*$/u.test(component.name)) return original.memo(component, compare)
    return original.memo((...args: any[]) => { cost.cardRenders++; return component(...args) }, compare)
  }) }
})
vi.mock('../src/renderer/src/store', async importOriginal => {
  const original = await importOriginal<typeof import('../src/renderer/src/store')>()
  const observed = Object.assign((...args: Parameters<typeof original.useAppStore>) => { cost.storeHooks++; return original.useAppStore(...args) }, original.useAppStore)
  return { ...original, useAppStore: observed }
})

const dom = composerDOM()
beforeEach(() => { cost.cardRenders = 0; cost.storeHooks = 0; cost.sessionVisits = 0 })
function agent(id: string, hostId = 'local', sid = id, runId = `run-${id}`) {
  const value = composerSession(id)
  return { ...value, hostId, label: `Named ${id}`, status: { ...value.status, state: 'working' as const },
    control: { ...value.control, hostId, agentSessionId: sid, run: { runId } } }
}
const card = (id: string, kind: 'session' | 'run' = 'session', hostId = 'local'): ToolkitAgentCard => ({
  reference: kind === 'session' ? { kind, hostId, sessionId: id } : { kind, hostId, runId: id }, metrics: [{ label: 'Inert work', value: '7 tasks' }]
})
const cards = (items: ToolkitAgentCard[], fields: ToolkitAgentCardField[] = ['avatar', 'name', 'status']): NonNullable<ToolkitResultDocument['agentCards']> => ({ fields, items, omittedItems: 0 })
const documentFor = (value: NonNullable<ToolkitResultDocument['agentCards']>): ToolkitResultDocument => ({ schema: 'agentmux.toolkit.result.v1', summary: 'Ordinary script result', items: [], links: [], notice: '', agentCards: value })
function countingSessions(values: SessionSnapshot[]) {
  return new Proxy(values, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/u.test(key)) cost.sessionVisits++; return Reflect.get(target, key, receiver) } })
}
async function show(value: NonNullable<ToolkitResultDocument['agentCards']>, active = true) {
  await dom.render(<ToolkitAgentCards cards={value} active={active} />)
}
function node() { const result = dom.container.querySelector<HTMLElement>('[data-toolkit-agent-card]'); expect(result).not.toBeNull(); return result! }
function renderedFields() { return [...node().querySelectorAll('[data-card-field]')].map(field => field.getAttribute('data-card-field')) }

it('ordinary Custom result consumes the public document and shared standard face without executing anything', async () => {
  const original = agent('display-id', 'local', 'canonical-sid', 'original-run')
  useAppStore.setState({ sessions: [original], config: { ...composerConfig, executors: { codex: { ...composerConfig.executors.codex!, avatar: { badge: 'spark', tint: '#41bd98' } } } } })
  const definition: ToolkitToolDefinition = { id: 'ordinary-tool', revision: 'r1', name: 'Ordinary tool', icon: 'terminal', enabled: true, statusBar: 'label', workspacePath: _hygiene_fixturePath("repo"), script: 'console.log(JSON.stringify(document))', args: [] }
  const document = documentFor(cards([card('canonical-sid')], [...TOOLKIT_AGENT_CARD_FIELDS]))
  const snapshot: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'succeeded', reason: null, admission: null, consumerCount: 1, sequence: 1,
    latestConfirmed: { executionId: 'captured-result', invocationId: 'original-invocation', definition, expectedLatestExecutionId: null, target: { workspacePath: _hygiene_fixturePath("repo") }, run: { hostId: 'local', runId: 'tool-run' }, startedAt: 1, endedAt: 2, state: 'succeeded', reason: null, exitCode: 0, text: JSON.stringify(document) } }
  const release = vi.fn(), run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop'), action = vi.spyOn(api.toolkit, 'action')
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read) => { read(snapshot); return { dispose: release } })
  await dom.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {} }}><UserToolkitResult definition={definition} active close={() => {}} /></SettingsNavigation.Provider>)
  expect(dom.container.querySelector('.toolkit-result__document h3')?.textContent).toBe('Ordinary script result')
  expect(renderedFields()).toEqual([...TOOLKIT_AGENT_CARD_FIELDS])
  expect(node().textContent).toContain('Named display-id'); expect(node().textContent).toContain('canonical-sid'); expect(node().textContent).toContain('original-run')
  expect(node().querySelector('[data-avatar-badge="spark"]')).not.toBeNull()
  expect(node().querySelector('.agent-avatar__status--working')).not.toBeNull()
  expect(node().querySelector('[data-toolkit-card-metric]')?.textContent).toBe('Inert work7 tasks')
  expect(run).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
  expect(cost.cardRenders).toBeGreaterThan(0)
  await dom.render(<span />); expect(release).toHaveBeenCalledOnce()
})

it.each(TOOLKIT_AGENT_CARD_FIELDS)('the public %s field is the only displayed identity field', async field => {
  useAppStore.setState({ sessions: [agent('one')] })
  await show(cards([card('one')], [field]))
  expect(node().dataset.agentCardState).toBe('resolved')
  expect(renderedFields()).toEqual([field])
  if (field !== 'avatar') expect(node().querySelector('.agent-avatar')).toBeNull()
  expect(node().querySelector('[data-toolkit-card-metric]')?.textContent).toBe('Inert work7 tasks')
})

it('empty configured fields support metrics-only cards without indexing Sessions', async () => {
  useAppStore.setState({ sessions: countingSessions(Array.from({ length: 100 }, (_, i) => agent(`a${i}`))) })
  await show(cards([card('a1')], []))
  expect(renderedFields()).toEqual([]); expect(node().textContent).toBe('Inert work7 tasks')
  expect(cost.sessionVisits).toBe(0); expect(cost.cardRenders).toBe(1)
})

it.each(['session', 'run'] as const)('exact Host-qualified %s reference does not choose the same ID from another Host', async kind => {
  useAppStore.setState({ sessions: [agent('wrong', 'other', 'collision', 'collision'), agent('correct', 'local', 'collision', 'collision')] })
  await show(cards([card('collision', kind)]))
  expect(node().textContent).toContain('Named correct'); expect(node().textContent).not.toContain('Named wrong')
  expect(node().dataset.agentCardState).toBe('resolved')
})

it('canonical Session reference survives a new Run, while an old Run reference remains unresolved', async () => {
  useAppStore.setState({ sessions: [agent('display', 'local', 'canonical', 'old-run')] })
  const value = cards([card('old-run', 'run'), card('canonical')], ['name', 'runId'])
  await show(value)
  const old = dom.container.querySelectorAll('[data-toolkit-agent-card]')[0]!
  expect(old.textContent).toContain('Named display')
  await act(async () => useAppStore.setState({ sessions: [agent('display', 'local', 'canonical', 'new-run')] }))
  const rows = dom.container.querySelectorAll<HTMLElement>('[data-toolkit-agent-card]'); expect(rows).toHaveLength(2)
  expect(rows[0]!.dataset.agentCardState).toBe('unavailable'); expect(rows[0]!.textContent).toContain('old-run'); expect(rows[0]!.textContent).not.toContain('new-run')
  expect(rows[1]!.dataset.agentCardState).toBe('resolved'); expect(rows[1]!.textContent).toContain('new-run')
})

it.each(['session', 'run'] as const)('multiple exact %s candidates are ambiguous and keep inert metrics', async kind => {
  useAppStore.setState({ sessions: [agent('first', 'local', 'same', 'same'), agent('second', 'local', 'same', 'same')] })
  await show(cards([card('same', kind)]))
  expect(node().dataset.agentCardState).toBe('ambiguous'); expect(node().textContent).toContain('Agent identity is ambiguous')
  expect(node().textContent).not.toContain('Named first'); expect(node().textContent).not.toContain('Named second')
  expect(node().querySelector('.agent-avatar')).toBeNull(); expect(node().textContent).toContain('7 tasks')
})

it('terminal-only and missing references remain explicit without guessed Agent artwork', async () => {
  const base = agent('terminal')
  const terminal: SessionSnapshot = { ...base, kind: 'terminal', providerId: null, control: { kind: 'terminal', hostId: 'local', runId: 'shell-run', run: { runId: 'shell-run' } } }
  useAppStore.setState({ sessions: [terminal] })
  await show(cards([card('shell-run', 'run'), card('absent')]))
  const rows = dom.container.querySelectorAll<HTMLElement>('[data-toolkit-agent-card]'); expect(rows).toHaveLength(2)
  expect(rows[0]!.textContent).toContain('not an Agent Session'); expect(rows[1]!.textContent).toContain('Agent identity unavailable')
  expect(dom.container.querySelectorAll('.agent-avatar')).toHaveLength(0)
})

it('same-reference refresh keeps card nodes, Range, focus and scroll, and does not rerender unchanged cards', async () => {
  useAppStore.setState({ sessions: [agent('one')] })
  const value = cards([card('one')], ['avatar', 'name'])
  await show(value)
  const original = node(), label = original.querySelector('[data-card-field="name"]')!, text = label.firstChild!
  const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 5); document.getSelection()!.addRange(range)
  original.tabIndex = 0; original.focus(); dom.container.scrollTop = 37
  const before = cost.cardRenders
  await show(structuredClone(value))
  expect(node()).toBe(original); expect(document.activeElement).toBe(original); expect(dom.container.scrollTop).toBe(37)
  expect(range.startContainer).toBe(text); expect(range.toString()).toBe('amed'); expect(cost.cardRenders).toBe(before)
  const changed = structuredClone(value); changed.items[0]!.metrics[0]!.value = '8 tasks'
  await show(changed); expect(node()).toBe(original); expect(node().textContent).toContain('8 tasks'); expect(cost.cardRenders).toBe(before + 1)
})

it('repeated references with different metrics have unique collection identities and both remain visible', async () => {
  useAppStore.setState({ sessions: [agent('one')] })
  const warning = vi.spyOn(console, 'error'), second = card('one'); second.metrics = [{ label: 'Other', value: 'Second fact' }]
  await show(cards([card('one'), second]))
  expect(dom.container.querySelectorAll('[data-toolkit-agent-card]')).toHaveLength(2)
  expect(dom.container.textContent).toContain('Second fact'); expect(dom.container.textContent).toContain('7 tasks')
  expect(warning.mock.calls.filter(call => call.some(value => /same key|unique.*key/iu.test(String(value))))).toHaveLength(0)
})

it.each([1, 32, 100])('%i visible cards share one Store reader and one Session index; unrelated updates do not rerender cards', async count => {
  const sessions = Array.from({ length: 128 }, (_, i) => agent(`a${i}`)), value = cards(sessions.slice(0, count).map(session => card(session.control.agentSessionId)), ['avatar', 'name'])
  useAppStore.setState({ sessions: countingSessions(sessions) })
  await show(value)
  expect(dom.container.querySelectorAll('[data-toolkit-agent-card]')).toHaveLength(count)
  expect(cost.cardRenders).toBe(count); expect(cost.storeHooks).toBe(1); expect(cost.sessionVisits).toBe(128)
  cost.cardRenders = 0; cost.storeHooks = 0; cost.sessionVisits = 0
  await act(async () => useAppStore.setState(state => ({ agentComposerDrafts: { ...state.agentComposerDrafts, a127: 'Unrelated unsent input' }, timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 42, items: [{ id: 'output-42', agentSessionId: 'unrelated', kind: 'assistant_message', title: 'Reply', status: 'streaming', source: 'native-hook', content: 'Actual unrelated output', createdAt: 42, updatedAt: 42 }] } } })))
  expect(cost.cardRenders).toBe(0); expect(cost.storeHooks).toBe(0); expect(cost.sessionVisits).toBe(0)
  const updated = sessions.map((session, index) => index === 127 ? { ...session, label: 'Unrelated metadata changed', latestOutputBytes: 800 } : session)
  await act(async () => useAppStore.setState({ sessions: countingSessions(updated) }))
  expect(cost.cardRenders).toBe(0); expect(cost.storeHooks).toBe(0); expect(cost.sessionVisits).toBe(128)
  cost.sessionVisits = 0
  await act(async () => useAppStore.setState({ sessions: countingSessions(updated.map((session, index) => index ? session : { ...session, label: 'Actual relevant update' })) }))
  expect(cost.cardRenders).toBe(1); expect(node().textContent).toContain('Actual relevant update'); expect(cost.sessionVisits).toBe(128)
})

it('hidden collection keeps metrics without indexing or creating per-card Store readers', async () => {
  const values = Array.from({ length: 100 }, (_, i) => agent(`hidden${i}`))
  useAppStore.setState({ sessions: countingSessions(values) })
  await show(cards(values.map(session => card(session.control.agentSessionId))), false)
  expect(dom.container.querySelectorAll('[data-toolkit-agent-card]')).toHaveLength(100)
  expect(cost.sessionVisits).toBe(0); expect(cost.storeHooks).toBe(1)
  cost.cardRenders = 0; cost.storeHooks = 0
  await act(async () => useAppStore.setState({ sessions: countingSessions([...values]) }))
  expect(cost.sessionVisits).toBe(0); expect(cost.cardRenders).toBe(0); expect(cost.storeHooks).toBe(0)
  await show(cards(values.map(session => card(session.control.agentSessionId))), true)
  expect(cost.sessionVisits).toBe(100); expect(node().dataset.agentCardState).toBe('resolved')
})

it('related status and appearance update the selected card while unrelated Executor edits keep its face', async () => {
  const session = agent('one')
  useAppStore.setState({ sessions: [session] })
  await show(cards([card('one')]))
  cost.cardRenders = 0; cost.storeHooks = 0
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, executors: { ...state.config!.executors, unrelated: { ...state.config!.executors.codex!, label: 'Unrelated executor' } } } })))
  expect(cost.cardRenders).toBe(0); expect(cost.storeHooks).toBe(0)
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, executors: { ...state.config!.executors, codex: { ...state.config!.executors.codex!, avatar: { badge: 'spark', tint: '#41bd98' } } } } })))
  expect(cost.cardRenders).toBe(1); expect(node().querySelector('[data-avatar-badge="spark"]')).not.toBeNull()
  await act(async () => useAppStore.setState({ sessions: [{ ...session, status: { state: 'exited', source: 'run-process', observedAt: 2 } }] }))
  expect(cost.cardRenders).toBe(2); expect(node().querySelector('.agent-avatar__status--working')).toBeNull()
  expect(node().querySelector('[data-card-field="status"]')?.textContent).toBeTruthy()
})

it('legacy and resolved identities use the same artwork, enamel, badge and working mark', async () => {
  const original = agent('one'), config = { ...composerConfig, executors: { codex: { ...composerConfig.executors.codex!, avatar: { badge: 'spark' as const, tint: '#41bd98' } } } }
  useAppStore.setState({ sessions: [original], config })
  await dom.render(<ExecutorIdentityContext.Provider value={{ config }}><AgentAvatar sessionId="one" /><ToolkitAgentCards cards={cards([card('one')])} active /></ExecutorIdentityContext.Provider>)
  const faces = dom.container.querySelectorAll('.agent-avatar'); expect(faces).toHaveLength(2)
  for (const face of faces) { expect(face.querySelector('[data-avatar-badge="spark"]')).not.toBeNull(); expect(face.querySelector('.agent-avatar__status--working')).not.toBeNull(); expect(face.querySelector('.agent-avatar__filters')).not.toBeNull() }
  expect(faces[0]!.querySelector('.agent-avatar__mark')?.textContent).toBe(faces[1]!.querySelector('.agent-avatar__mark')?.textContent)
  expect(faces[1]!.getAttribute('tabindex')).toBeNull()
})

it('malformed optional document preserves exact confirmed raw output and the healthy Session', async () => {
  const original = agent('one'); useAppStore.setState({ sessions: [original] })
  const definition: ToolkitToolDefinition = { id: 'ordinary-invalid', revision: 'r1', name: 'Ordinary', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: _hygiene_fixturePath("repo"), script: 'console.log("raw")', args: [] }
  const malformed = JSON.stringify({ ...documentFor(cards([card('one')])), agentCards: { fields: ['avatar'], omittedItems: 0, items: [{ ...card('one'), reference: { kind: 'session', hostId: 'local', sessionId: 'one', provider: 'made-up' } }] } })
  const snapshot: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'succeeded', reason: null, admission: null, latestConfirmed: { executionId: 'original', invocationId: 'invocation', definition, expectedLatestExecutionId: null, target: { workspacePath: _hygiene_fixturePath("repo") }, run: { hostId: 'local', runId: 'original-tool-run' }, startedAt: 1, endedAt: 2, exitCode: 0, state: 'succeeded', reason: null, text: malformed }, consumerCount: 1, sequence: 1 }
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read) => { read(snapshot); return { dispose() {} } })
  await dom.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {} }}><UserToolkitResult definition={definition} active close={() => {}} /></SettingsNavigation.Provider>)
  expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe(malformed)
  expect(dom.container.querySelector('[data-toolkit-agent-card]')).toBeNull(); expect(useAppStore.getState().sessions[0]).toBe(original)
})
