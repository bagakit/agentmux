// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { agentContextForSession, type FocusContext } from '../src/renderer/src/lib/focus-context'
import type { FocusContextIdentity } from '../src/renderer/src/lib/focus-context-identity'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), name = 'Original Agent', reply = 'Original reply with **evidence** and an unchanged reading source.'
const session = composerSession('density-subject')
const base = () => agentContextForSession(session, undefined, name, composerConfig.workspaces[0], null)
const identity: FocusContextIdentity = { occurrenceCount: 2, tabs: ['first', 'second'].map(group => ({
  tabId: 'original-tab', occurrenceKey: group, groupId: group, title: name, active: false,
  locationLabel: `Project · ${group}`, highlightedRegionIds: ['subject'], regions: [
    { regionId: 'neighbor', bounds: { x: 0, y: 0, width: .4, height: 1 }, surfaceKind: 'browser', executorLabel: 'Browser', activity: 'No recent activity' },
    { regionId: 'subject', bounds: { x: .4, y: 0, width: .6, height: 1 }, surfaceKind: 'agent', agentSessionId: session.id, executorLabel: 'Agent', activity: 'Original activity' }
  ]
})) }
const recap = { text: reply, source: 'Last assistant message' as const, origin: 'timeline' as const,
  reading: { text: reply, truncated: false } }
const preview = () => document.querySelector<HTMLElement>('.focus-context-hover')!
async function open(context: FocusContext, positions = identity) {
  await act(async () => { (document.activeElement as HTMLElement | null)?.blur() })
  await dom.render(<FocusContextRow context={context} identity={positions} selected={false} onSelect={() => { throw Error('Reading cannot navigate') }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.focus-context')!.focus())
  expect(preview()).not.toBeNull()
}
beforeEach(() => { useAppStore.setState({ sessions: [session], timelines: {}, mainSurface: 'agents' }) })

it('keeps every exact occurrence in compact shared glyphs without repeating its Agent title or large map', async () => {
  await open({ ...base(), recap, detailIsRecap: true })
  const positions = preview().querySelector('.focus-context-hover__workbench')!
  expect(positions.getAttribute('aria-label')).toBe('2 confirmed positions')
  expect(positions.querySelectorAll('[data-focus-occurrence-key]')).toHaveLength(2)
  expect([...positions.querySelectorAll('[data-subject-region=true]')].map(node => node.getAttribute('data-region-id'))).toEqual(['subject', 'subject'])
  expect([...positions.querySelectorAll('.focus-context-hover__position-label')].map(node => node.textContent)).toEqual(['Project · first · 2 Regions', 'Project · second · 2 Regions'])
  expect(preview().querySelector('.workbench-topology__inspector-regions')).toBeNull()
  expect(positions.querySelector('strong')).toBeNull()
  expect(positions.querySelector('.focus-context-hover__position-copy')?.getAttribute('title')).toContain(name)
  expect(preview().querySelector('header strong')?.textContent).toBe(name)
  expect(preview().querySelector('.focus-context-hover__prose .md')?.textContent).toContain('Original reply with evidence')
})

it('retains a distinct Tab title and original proportional geometry rather than guessing a new position', async () => {
  await open(base(), { occurrenceCount: 1, tabs: [{ ...identity.tabs[0]!, title: 'Distinct original Tab' }] })
  const position = preview().querySelector('.focus-context-hover__position-copy')!
  expect(position.querySelector('strong')?.textContent).toBe('Distinct original Tab')
  const region = preview().querySelector<HTMLElement>('[data-region-id=subject]')!
  expect(region.style.left).toBe('40%'); expect(region.style.width).toBe('60%')
})

it.each(['Activity not confirmed · original input readiness unknown', 'Permission required · original edit request'])('keeps necessary service text directly readable once: %s', async detail => {
  await open({ ...base(), stateLabel: detail.split(' · ')[0]!, detail, detailKind: 'service', recap, detailIsRecap: false })
  expect(preview().querySelector('.focus-context-hover__activity')?.textContent).toBe(detail)
  expect(preview().querySelector('header')?.textContent).not.toContain(detail.split(' · ')[0])
  expect(preview().querySelector('.focus-context-hover__state')?.getAttribute('aria-label')).toContain(detail.split(' · ')[0])
  expect(preview().querySelector('.focus-context-hover__activity-details')).toBeNull()
})

it('discloses ordinary held activity only when the original reply already owns the reading space', async () => {
  const detail = 'Read original-source.ts'
  const reads = vi.spyOn(api.sessions, 'historyPage'), control = vi.spyOn(api.sessions, 'stop')
  const context = { ...base(), detail, detailKind: 'activity' as const, detailIsRecap: false, recap }
  await open(context)
  const supplementary = preview().querySelector<HTMLDetailsElement>('.focus-context-hover__activity-details')!
  expect(supplementary).not.toBeNull(); expect(supplementary.open).toBe(false)
  const originalBody = preview().querySelector('.focus-context-hover__prose')!
  const range = document.createRange(); range.selectNodeContents(originalBody); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const readCount = reads.mock.calls.length
  await act(async () => { supplementary.open = true })
  expect(supplementary.querySelector('p')?.textContent).toBe(detail)
  expect(preview().querySelector('.focus-context-hover__prose')).toBe(originalBody)
  expect(window.getSelection()!.toString()).toContain('Original reply')
  expect(reads).toHaveBeenCalledTimes(readCount); expect(control).not.toHaveBeenCalled()
  await open({ ...context, recap: null })
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.focus-context')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
  expect(preview().querySelector('.focus-context-hover__activity')?.textContent).toBe(detail)
})

it('keeps keyboard reading inside the disclosure, returns Escape to the original card and respects a later outside focus', async () => {
  const context = { ...base(), detail: 'Read original-source.ts', detailKind: 'activity' as const, detailIsRecap: false, recap }
  await open(context)
  const original = preview(), card = dom.container.querySelector<HTMLButtonElement>('.focus-context')!
  const summary = original.querySelector<HTMLElement>('.focus-context-hover__activity-details summary')!
  expect(summary).not.toBeNull()
  await act(async () => summary.focus())
  await act(async () => new Promise(resolve => setTimeout(resolve, 220)))
  expect(preview()).toBe(original); expect(document.activeElement).toBe(summary)
  await act(async () => original.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 220)))
  expect(preview()).toBe(original); expect(document.activeElement).toBe(summary)
  await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.focus-context-hover')).toBeNull(); expect(document.activeElement).toBe(card)
  const outside = document.createElement('input'); document.body.append(outside)
  try {
    await open(context)
    await act(async () => preview().querySelector<HTMLElement>('summary')!.focus())
    await act(async () => outside.focus())
    await act(async () => new Promise(resolve => setTimeout(resolve, 220)))
    expect(document.querySelector('.focus-context-hover')).toBeNull(); expect(document.activeElement).toBe(outside)
  } finally { outside.remove() }
})
