// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { observeMoteContextOperation } from '../src/renderer/src/lib/mote-context-observation'
import { useAppStore } from '../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, defaultAgent, customTab, customMoteId, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

let app: MoteAppFixture
const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
async function open() {
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference }))
  await settleMoteApp()
}
function record(action = 'prepare', topic = PMO_TEAMS_TOPIC_ID) {
  return Object.values(useAppStore.getState().moteContextOperations).find(item => item.action === action && item.target.topicId === topic)
}
function trigger() { return app.panel().querySelector<HTMLButtonElement>('.mote-context-status .service-disclosure__trigger') }
async function details() {
  expect(trigger()).not.toBeNull(); await moteClick(trigger()!)
  // Only Chromium's declarative popover host behavior is supplied by happy-dom.
  const panel = app.panel().querySelector<HTMLElement>('.mote-context-status [popover="hint"]')!
  await act(async () => panel.showPopover()); await settleMoteApp(); return panel
}

it('a real ensure failure keeps the original conversation/input and moves the source facts to one header status', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('Original Mote storage read failed'))
  const before = useAppStore.getState()
  await app.mount(); await open()
  expect(trigger()?.textContent).toContain('资料准备待恢复')
  expect(trigger()?.closest('.pane-tabbar__actions')).not.toBeNull()
  expect(app.panel().querySelectorAll('.workbench-restore-notice.mote-context-notice')).toHaveLength(0)
  expect(record()).toMatchObject({ state: 'unconfirmed', failure: { step: 'ensure-mote', cause: 'Original Mote storage read failed', target: { topicId: PMO_TEAMS_TOPIC_ID, tabId: defaultTab.id, reference } } })
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  const input = app.panel().querySelector<HTMLElement>('[contenteditable="true"]')!
  expect(input).not.toBeNull(); await moteType(input, 'Continue in the original conversation')
  expect(input.textContent).toContain('Continue in the original conversation')
  const panel = await details(); expect(panel.textContent).toContain('Original Mote storage read failed')
  expect(useAppStore.getState().sessions.find(session => session.id === defaultAgent.id)?.control).toEqual(defaultAgent.control)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('retry pending and collapse retain the original failure until that same preparation confirms', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('Original preparation failure'))
  await app.mount(); await open(); const original = record()!.failure
  let finish!: (value: typeof moteTopics[0]) => void
  app.ensureMote.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const panel = await details(); await moteClick(panel.querySelector<HTMLButtonElement>('[data-mote-context-retry]')!)
  expect(record()).toMatchObject({ state: 'pending', failure: original })
  expect(trigger()?.textContent).toContain('资料准备待恢复')
  expect(panel.querySelector<HTMLButtonElement>('[data-mote-context-retry]')?.disabled).toBe(true)
  await moteClick(panel.querySelector<HTMLButtonElement>('.service-disclosure__heading button')!)
  expect(record()!.failure).toEqual(original); expect(trigger()).not.toBeNull()
  await act(async () => finish(moteTopics[0]!)); await settleMoteApp()
  expect(record()).toMatchObject({ state: 'confirmed', failure: null }); expect(trigger()).toBeNull()
})

it('a fulfilled ensure receipt with an original preparation error cannot be cleared by a narrower successful Topic read', async () => {
  app.ensureMote.mockResolvedValueOnce({ ...moteTopics[0]!, readError: 'Original AGENTS.md preparation was not confirmed' })
  await app.mount(); await open()
  expect(record()).toMatchObject({ state: 'unconfirmed', failure: { step: 'ensure-mote', cause: 'Original AGENTS.md preparation was not confirmed' } })
  expect(trigger()?.textContent).toContain('资料准备待恢复')
  expect(app.panel().querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeDefined()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('a fulfilled ensure receipt for another Mote is refused without changing the original discussion', async () => {
  app.ensureMote.mockResolvedValueOnce(moteTopics[1]!)
  await app.mount(); await open()
  expect(record()).toMatchObject({ state: 'unconfirmed', failure: { step: 'ensure-mote', target: { topicId: PMO_TEAMS_TOPIC_ID } } })
  expect(record()!.failure!.cause).toContain('different Topic identity')
  expect(app.panel().dataset.moteTargetTopic).toBe(PMO_TEAMS_TOPIC_ID)
  expect(app.panel().querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('another Mote success cannot clear a retained Main Mote failure and reopening pending keeps it visible', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('Main Mote original failure'))
  await app.mount(); await open(); const original = record()!.failure
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${customMoteId}"]`)!)
  expect(record('prepare', customMoteId)).toMatchObject({ state: 'confirmed', failure: null })
  expect(record()!.failure).toEqual(original)
  app.ensureMote.mockImplementationOnce(() => new Promise(() => {}))
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"]`)!)
  expect(app.panel().dataset.moteTargetTopic).toBe(PMO_TEAMS_TOPIC_ID)
  expect(record()).toMatchObject({ state: 'pending', failure: original })
  expect(trigger()?.textContent).toContain('资料准备待恢复')
  expect(useAppStore.getState().tabs[customTab.id]).toBeDefined()
})

it('a late original preparation result cannot clear a later attempt after close and reopen', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('Original retained failure'))
  await app.mount(); await open(); const original = record()!.failure
  let finish!: (value: typeof moteTopics[0]) => void
  app.ensureMote.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await moteClick((await details()).querySelector<HTMLButtonElement>('[data-mote-context-retry]')!)
  await act(async () => requestPmoTeamsTopicFloatingClose()); await settleMoteApp()
  app.ensureMote.mockImplementationOnce(() => new Promise(() => {})); await open()
  const later = record(); await act(async () => finish(moteTopics[0]!)); await settleMoteApp()
  expect(record()).toBe(later); expect(record()).toMatchObject({ state: 'pending', failure: original })
  expect(trigger()).not.toBeNull()
})

it('preparation success does not erase a separate exact Open in Space failure', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('Original preparation failure'))
  await app.mount(); await open()
  vi.spyOn(useAppStore.getState(), 'executeControl').mockRejectedValueOnce(new Error('Original Space selection receipt unavailable'))
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
  expect(record('open-space')).toMatchObject({ state: 'unconfirmed', failure: { step: 'open-space', cause: 'Original Space selection receipt unavailable', target: { reference } } })
  const spaceFailure = record('open-space')!.failure
  const panel = await details(); await moteClick(panel.querySelector<HTMLButtonElement>('[data-mote-context-retry]')!)
  expect(record()).toMatchObject({ state: 'confirmed', failure: null }); expect(record('open-space')!.failure).toEqual(spaceFailure)
  expect(trigger()?.textContent).toContain('Space 打开待重试')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('a pending preparation cannot label or disable an independent Space recovery as already retrying', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('Original preparation failure'))
  await app.mount(); await open()
  vi.spyOn(useAppStore.getState(), 'executeControl').mockRejectedValueOnce(new Error('Original Space receipt unavailable'))
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
  const panel = await details()
  app.ensureMote.mockImplementationOnce(() => new Promise(() => {}))
  await moteClick(panel.querySelector<HTMLButtonElement>('[data-mote-context-retry="ensure-mote"]')!)
  expect(record()).toMatchObject({ state: 'pending' })
  const prepareRetry = panel.querySelector<HTMLButtonElement>('[data-mote-context-retry="ensure-mote"]')!
  const spaceRetry = panel.querySelector<HTMLButtonElement>('[data-mote-context-retry="open-space"]')!
  expect(prepareRetry.disabled).toBe(true); expect(prepareRetry.textContent).toBe('正在重试…')
  expect(spaceRetry.disabled).toBe(false); expect(spaceRetry.textContent).toBe('重试这一步')
  expect(app.panel().querySelector('[contenteditable="true"]')).not.toBeNull()
})

it('confirmed Space navigation is not relabelled unconfirmed by the ensuing floating cleanup', async () => {
  await app.mount(); await open()
  const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
  const index = owner.mock.calls.findIndex(([request]) => request.operation === 'focus')
  expect(index).toBeGreaterThanOrEqual(0)
  await act(async () => { await owner.mock.results[index]!.value }); await settleMoteApp()
  expect(record('open-space')).toMatchObject({ state: 'confirmed', failure: null, target: { reference } })
  expect(app.panel().dataset.motePresentation).toBe('closed')
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeDefined()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('a rejected discussion read has one persistent context owner and does not add a duplicate global notice', async () => {
  const error = new Error('Original Topic read rejected')
  vi.spyOn(api.scratch, 'readTopic').mockRejectedValueOnce(error)
  const globalReport = vi.spyOn(useAppStore.getState(), 'reportError')
  await app.mount(); await open()
  expect(record()).toMatchObject({ state: 'unconfirmed', failure: { step: 'read-discussion', cause: error.message } })
  expect(trigger()).not.toBeNull(); expect(globalReport).not.toHaveBeenCalled()
  expect(app.panel().querySelector('[contenteditable="true"]')).not.toBeNull()
})

it('the default background caller still reports its rejected read through its existing global owner', async () => {
  const error = new Error('Original caller metadata failure')
  vi.spyOn(api.scratch, 'readTopic').mockRejectedValueOnce(error)
  const globalReport = vi.spyOn(useAppStore.getState(), 'reportError')
  await expect(useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: defaultTab.id })).rejects.toBe(error)
  expect(globalReport).toHaveBeenCalledWith(error, expect.objectContaining({ kind: 'indeterminate' }))
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeDefined()
})

it('another card Space failure remains visible and its resolved original reference is inspectable', async () => {
  const globalReport = vi.spyOn(useAppStore.getState(), 'reportError')
  await app.mount(); await open()
  const error = new Error('Other Mote original Space receipt unavailable')
  vi.spyOn(useAppStore.getState(), 'executeControl').mockRejectedValueOnce(error)
  const row = app.panel().querySelector<HTMLElement>(`[data-mote-topic-id="${customMoteId}"]`)!
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 50 })))
  await settleMoteApp()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent?.includes('Open in Space'))
  expect(item).toBeDefined(); await moteClick(item!)
  const opening = record('open-space', customMoteId)!
  expect(opening.state).toBe('unconfirmed'); expect(opening.target.reference).not.toBeNull()
  expect(opening.failure!.target).toEqual(opening.target)
  expect(globalReport).toHaveBeenCalledWith(error, expect.objectContaining({ kind: 'indeterminate', summary: expect.stringContaining('Space') }))
  const query = { domain: 'mote.context.client' as const, hostId: 'local', action: 'open-space' as const,
    scope: { hostId: scratchWorkspace.hostId, directoryPath: scratchWorkspace.path, topicId: customMoteId, tabId: customTab.id }, reference: opening.target.reference }
  const inspected = observeMoteContextOperation(useAppStore.getState().moteContextOperations,
    { schemaVersion: 5, requestId: 'other-card-source-inspection', operation: 'inspect.mote-context', target: query, includeRaw: false, maxBytes: 8000 })
  expect(inspected.data?.operation.target.reference).toEqual(opening.target.reference)
  expect(inspected.data?.operation.failure?.target.reference).toEqual(opening.target.reference)
  expect(inspected.raw.returned).toBe('withheld')
  expect(app.panel().dataset.moteTargetTopic).toBe(PMO_TEAMS_TOPIC_ID)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
