// @vitest-environment happy-dom
import { act, useState } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openDemandStore } from '@agentmux/demand'
import { GoalAlignment, EMPTY_GOAL_ACKNOWLEDGEMENT } from '../src/renderer/src/components/GoalAlignment'
import { projectDemands } from '../src/renderer/src/lib/global-demand-board'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), goalId = 'shared-goal'
const proposal = { summary: 'Agree on the original work', criteria: [{ id: 'criterion', text: 'Keep the original work readable' }], openQuestions: [] }
let directory: string, owner: ReturnType<typeof openDemandStore>, reduced = false
function Panel({ id = goalId, active = true }: { id?: string; active?: boolean }) {
  const records = useAppStore(state => state.demands)
  const [feedback, setFeedback] = useState(EMPTY_GOAL_ACKNOWLEDGEMENT)
  const demand = projectDemands(composerConfig, [], records).find(row => row.id === id)!
  return <WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><GoalAlignment demand={demand} feedback={feedback}
    onFeedbackChange={patch => setFeedback(value => ({ ...value, ...patch }))} onGrill={() => {}} onGrounding={() => {}} onOpenMote={() => {}} /></WorkbenchPresentationContext.Provider>
}
const icon = () => dom.container.querySelector('[data-semantic-icon="object.goal"]')
const cue = () => dom.container.querySelector('[data-icon-animation="feedback"]')
async function confirm() { await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-goal-confirm]')!.click()) }
async function create(id = goalId) {
  await useAppStore.getState().createDemand({ id, title: 'Shared direction', source: 'session', status: 'in_progress', sessionIds: [] })
  await useAppStore.getState().updateDemand(id, { alignment: proposal })
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentmux-goal-icon-')); owner = openDemandStore({ root: directory })
  useAppStore.setState({ demands: {}, selectedDemandId: null, config: composerConfig })
  vi.spyOn(api.demands, 'create').mockImplementation(input => owner.create(input))
  vi.spyOn(api.demands, 'update').mockImplementation((id, patch) => owner.update(id, patch))
  vi.spyOn(api.demands, 'confirmAlignment').mockImplementation((id, revision) => owner.confirmAlignment(id, revision))
  vi.spyOn(api.demands, 'acceptGrounding').mockImplementation((id, revision, submission, gaps) => owner.acceptGrounding(id, revision, submission, gaps))
  vi.spyOn(api.demands, 'list').mockImplementation(() => owner.list())
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 16, right: 16, width: 16, height: 16, toJSON() {} })
  reduced = false
  const original = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => query === '(prefers-reduced-motion: reduce)' ? { ...original(query), matches: reduced, addEventListener() {}, removeEventListener() {} } as MediaQueryList : original(query))
  await create()
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
it('the real confirmation owner returns the exact revision before the mounted Goal icon gives one local feedback', async () => {
  await dom.render(<Panel/>); expect(icon()).not.toBeNull(); expect(cue()).toBeNull()
  const control = useAppStore.getState().sessions[0]!.control
  let release!: () => void
  vi.mocked(api.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => { await new Promise<void>(resolve => { release = resolve }); return owner.confirmAlignment(id, revision) })
  await confirm(); expect(cue()).toBeNull(); expect((await owner.get(goalId))!.alignment!.confirmedAt).toBeNull()
  await act(async () => { release(); await vi.waitFor(() => expect(useAppStore.getState().demands[goalId]!.alignment!.confirmedAt).not.toBeNull()) })
  expect(cue()).not.toBeNull(); expect(dom.container.querySelectorAll('[data-semantic-icon="object.goal"]')).toHaveLength(1)
  expect(api.demands.confirmAlignment).toHaveBeenCalledExactlyOnceWith(goalId, 1)
  expect((await owner.get(goalId))!).toMatchObject({ status: 'in_progress', alignment: { revision: 1, confirmedAt: expect.any(Number) } })
  expect((await owner.get(goalId))!.grounding).toBeUndefined(); expect(useAppStore.getState().sessions[0]!.control).toBe(control)
  await act(async () => icon()!.dispatchEvent(new Event('animationend', { bubbles: true }))); expect(cue()).toBeNull()
  await dom.render(<div/>); await dom.render(<Panel/>); expect(icon()).not.toBeNull(); expect(cue()).toBeNull()
})
it('loading old agreement, refreshing it and accepting a result do not replay goal-confirmation feedback', async () => {
  await useAppStore.getState().confirmDemandGoal(goalId, 1)
  await useAppStore.getState().updateDemand(goalId, { grounding: { alignmentRevision: 1, summary: 'Original work remains readable', checks: [{ criterionId: 'criterion', outcome: 'met', evidence: ['proof.txt'], note: 'Observed the original work' }] } })
  await dom.render(<Panel/>); expect(icon()).not.toBeNull(); expect(cue()).toBeNull()
  await act(async () => useAppStore.getState().refreshDemand(goalId)); expect(cue()).toBeNull()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-goal-accept]')!.click())
  await vi.waitFor(async () => expect((await owner.get(goalId))!.grounding!.acceptedAt).not.toBeNull())
  expect(cue()).toBeNull(); expect(api.demands.acceptGrounding).toHaveBeenCalledOnce()
})
it('a stale confirmation keeps its original failure and does not animate the newer proposal', async () => {
  let release!: () => void
  vi.mocked(api.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => { await new Promise<void>(resolve => { release = resolve }); return owner.confirmAlignment(id, revision) })
  await dom.render(<Panel/>); await confirm()
  await act(async () => useAppStore.getState().updateDemand(goalId, { alignment: { ...proposal, summary: 'Newer agreement' } }))
  await act(async () => { release() })
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); expect(dom.container.querySelector('[data-goal-acknowledgement-failure]')).not.toBeNull() })
  expect(cue()).toBeNull(); expect(dom.container.textContent).toContain('Newer agreement')
  expect((await owner.get(goalId))!.alignment!.confirmedAt).toBeNull()
})
it('a late receipt stays on its original Goal and cannot animate a different visible Goal', async () => {
  await create('other-goal'); let release!: () => void
  vi.mocked(api.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => { await new Promise<void>(resolve => { release = resolve }); return owner.confirmAlignment(id, revision) })
  await dom.render(<Panel/>); await confirm(); await dom.render(<Panel id="other-goal"/>)
  await act(async () => { release(); await vi.waitFor(() => expect(useAppStore.getState().demands[goalId]!.alignment!.confirmedAt).not.toBeNull()) })
  expect(cue()).toBeNull(); expect((await owner.get('other-goal'))!.alignment!.confirmedAt).toBeNull()
})
it.each(['parked', 'hidden', 'reduced'] as const)('keeps a real confirmation usable but still when %s', async mode => {
  if (mode === 'reduced') reduced = true
  await dom.render(<Panel active={mode !== 'parked'}/> )
  if (mode === 'hidden') dom.container.hidden = true
  await confirm(); await vi.waitFor(() => expect(useAppStore.getState().demands[goalId]!.alignment!.confirmedAt).not.toBeNull())
  expect(cue()).toBeNull(); expect(icon()).not.toBeNull()
  dom.container.hidden = false; reduced = false; await dom.render(<Panel/>); expect(cue()).toBeNull()
})
