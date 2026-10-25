// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

vi.mock('../src/renderer/src/components/AgentAvatar', async original => ({ ...await original<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), select = vi.fn()
const reply = '已核对原会话的长回复。保留这段完整历史摘录，不将它当作正在执行或新的结果。'
const reason = 'Runtime interrupted the original Run; the original Session and its retained records remain available.'
function facts(id: string, interrupted = false) {
  const session = composerSession(id), now = Date.now()
  session.processState = interrupted ? 'interrupted' : 'running'
  session.status = { state: 'running', source: 'run-process', observedAt: now, ...(interrupted ? { detail: reason } : {}) }
  const timeline: AgentTimelineSnapshot = { agentSessionId: id, sourceHostId: 'local', revision: 1, items: [{
    id: 'reply-' + id, agentSessionId: id, kind: 'assistant_message', source: 'native-hook', status: 'complete',
    title: 'Reply', content: reply + ' ' + id, createdAt: now - 1000, updatedAt: now - 1000
  }] }
  return { session, timeline, context: agentContextForSession(session, timeline, '同名任务', composerConfig.workspaces[0], null) }
}
const card = (id: string) => dom.container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${id}"]`)!
beforeEach(() => { select.mockClear() })

it('keeps the original historical excerpt beside a known interrupted Run and its direct service cause', async () => {
  const f = facts('interrupted-summary', true), reads = vi.spyOn(api.sessions, 'historyPage')
  useAppStore.setState({ sessions: [f.session], timelines: { [f.session.id]: f.timeline } })
  const before = useAppStore.getState()
  await dom.render(<FocusContextRow context={f.context} selected={false} onSelect={select} />)
  const node = card(f.session.id)
  expect(node.querySelector('.focus-context__recap')?.textContent).toBe(reply + ' ' + f.session.id)
  expect(node.querySelector('.focus-context__recap')?.getAttribute('title')).toContain('Last reply observation')
  expect(node.querySelector('.focus-context__activity')?.textContent).toContain(reason)
  expect(node.querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe('interrupted')
  expect(node.getAttribute('aria-label')).toContain(reason)
  expect(reads).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled()
  for (const key of ['sessions', 'timelines', 'agentComposerDrafts', 'agentFocus'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('keeps the actual unconfirmed activity explanation readable beside an old excerpt', async () => {
  const f = facts('unknown-summary')
  expect(f.context.detailKind).toBe('observation')
  useAppStore.setState({ sessions: [f.session], timelines: { [f.session.id]: f.timeline } })
  await dom.render(<FocusContextRow context={f.context} selected={false} onSelect={select} />)
  expect(card(f.session.id).querySelector('.focus-context__recap')?.textContent).toContain(reply)
  expect(card(f.session.id).querySelector('.focus-context__activity')?.textContent).toBe(f.context.detail)
  expect(card(f.session.id).querySelector('.focus-context__state small')?.textContent).toBe(f.context.stateLabel)
  expect(card(f.session.id).querySelector('[data-focus-state-icon="unknown"]')).not.toBeNull()
  expect(card(f.session.id).querySelector('[data-icon-animation="work"]')).toBeNull()
})

it('keeps an unknown Run honest without replacing the necessary cause by a repeated short status', async () => {
  const f = facts('unobserved-summary', true)
  f.session.runUnobserved = true
  const context = agentContextForSession(f.session, f.timeline, '原任务', composerConfig.workspaces[0], null)
  await dom.render(<FocusContextRow context={context} selected={false} onSelect={select} />)
  expect(card(f.session.id).querySelector('.focus-context__recap')).toBeNull()
  expect(card(f.session.id).querySelector('.focus-context__detail')?.textContent).toBe(context.detail)
  expect(card(f.session.id).querySelector('[data-focus-state-icon="unknown"]')).not.toBeNull()
})

it('selects the exact same-name Agent while retaining separate excerpts and original Runs', async () => {
  const first = facts('summary-first', true), second = facts('summary-second', true)
  useAppStore.setState({ sessions: [first.session, second.session], timelines: { [first.session.id]: first.timeline, [second.session.id]: second.timeline } })
  const before = useAppStore.getState()
  await dom.render(<><FocusContextRow context={first.context} selected={false} onSelect={select} /><FocusContextRow context={second.context} selected={false} onSelect={select} /></>)
  expect(dom.container.querySelectorAll('.focus-context')).toHaveLength(2)
  expect(card(first.session.id).querySelector('.focus-context__recap')?.textContent).toContain(first.session.id)
  expect(card(second.session.id).querySelector('.focus-context__recap')?.textContent).toContain(second.session.id)
  expect(dom.container.querySelectorAll('button button')).toHaveLength(0)
  await act(async () => card(second.session.id).click())
  expect(select).toHaveBeenCalledExactlyOnceWith(second.session.id)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('uses the original keyboard reader for the complete cause without choosing or recovering an Agent', async () => {
  const f = facts('keyboard-summary', true)
  useAppStore.setState({ sessions: [f.session], timelines: { [f.session.id]: f.timeline } })
  const before = useAppStore.getState()
  await dom.render(<FocusContextRow context={f.context} selected={false} onSelect={select} />)
  const node = card(f.session.id)
  expect(node.getAttribute('aria-keyshortcuts')).toBe('ArrowDown')
  await act(async () => { node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  const preview = document.querySelector<HTMLElement>('.focus-context-hover')
  expect(preview).not.toBeNull()
  expect(preview!.querySelector('.agent-information-reader__service')?.textContent).toContain(reason)
  expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
})
