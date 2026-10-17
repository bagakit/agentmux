// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
function reviewer(id: string) {
  const session = composerSession(id), observedAt = Date.now()
  return { ...session, label: 'Reviewer', status: { state: 'waiting' as const, source: 'native-hook' as const, observedAt },
    pendingInteraction: { kind: 'question' as const, id: `question-${id}`, agentSessionId: id,
      questions: [{ id: 'choice', prompt: 'Which branch should I review?', options: [] }], evidence: { source: 'native-hook' as const, observedAt } } }
}
async function hoverAgents() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('.project-activity')
  expect(trigger).not.toBeNull()
  await act(async () => trigger!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  const unplaced = document.querySelector<HTMLElement>('.project-activity-menu [data-unplaced]')
  expect(unplaced).not.toBeNull()
  await act(async () => unplaced!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.project-activity-submenu .focus-context[data-session-id]')]
  expect(rows.length).toBeGreaterThan(0)
  return rows
}

it('hover explains the original question, explicit selection opens that Agent, and resolution clears its attention marker', async () => {
  const session = reviewer('reviewer'), selectSession = vi.fn()
  useAppStore.setState({ sessions: [session], tabs: {}, layouts: {}, selectSession })
  await dom.render(<ProjectActivity sessions={[session]} />)
  expect(dom.container.querySelector('.project-activity')?.getAttribute('aria-label')).toContain('Needs you')
  const [card] = await hoverAgents()
  expect(card!.dataset.sessionId).toBe(session.id)
  expect(card!.textContent).toContain('Which branch should I review?')
  expect(selectSession).not.toHaveBeenCalled()
  await act(async () => card!.click())
  expect(selectSession).toHaveBeenCalledExactlyOnceWith(session.id)
  const { pendingInteraction: _resolved, ...original } = session
  const completed = { ...original, status: { ...session.status, state: 'done' as const } }
  await act(async () => useAppStore.setState({ sessions: [completed] }))
  await dom.render(<ProjectActivity sessions={[completed]} />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('.project-activity')!
  expect(trigger.getAttribute('aria-label')).toContain('1 Completed')
  expect(trigger.getAttribute('aria-label')).not.toContain('Needs you')
  expect(trigger.dataset.category).toBe('active')
})

it('hover keeps the full Agent collection and lets the user explicitly choose its urgent original subject', async () => {
  const urgent = reviewer('urgent')
  const working = { ...composerSession('working'), label: 'Builder',
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  const selectSession = vi.fn()
  useAppStore.setState({ sessions: [working, urgent], tabs: {}, layouts: {}, selectSession })
  await dom.render(<ProjectActivity sessions={[working, urgent]} />)
  const rows = await hoverAgents()
  expect(rows.map(row => row.dataset.sessionId)).toEqual([working.id, urgent.id])
  expect(rows[0]!.textContent).toContain('Builder')
  expect(rows[1]!.textContent).toContain('Which branch should I review?')
  expect(rows[1]!.getAttribute('data-bucket')).toBe('attention')
  expect(selectSession).not.toHaveBeenCalled()
  await act(async () => rows[1]!.click())
  expect(selectSession).toHaveBeenCalledExactlyOnceWith(urgent.id)
})
