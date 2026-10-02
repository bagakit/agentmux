// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, defaultTab } from './fixtures/mote-workface'
import { documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'

// Monaco transport is outside the actual Mote -> File owner address boundary.
vi.mock('../src/renderer/src/components/EditorPane', () => ({
  EditorPane: () => createElement('div', { 'data-editor-boundary': true })
}))

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

async function editPersona() {
  useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: customMoteId, targetTabId: customTab.id }))
  await settleMoteApp()
  const choice = app.panel().querySelector<HTMLElement>('[data-mote-topic-id="' + customMoteId + '"]')!
  expect(choice).not.toBeNull()
  await act(async () => choice.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await settleMoteApp()
  const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Edit persona')
  expect(edit).toBeDefined()
  const before = useAppStore.getState()
  await moteClick(edit!)
  return before
}

describe('live Main Mote module integrity', () => {
  it('opens the explicit Mote persona through the original File owner over another Project', async () => {
    const path = scratchTopicDirectoryName(customMoteId) + '/SOUL.md'
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path, content: '# Original persona', revision: 'persona-v1' } })
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const before = await editPersona()
    await settleMoteApp()
    expect(read.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, path]])
    const state = useAppStore.getState(), id = fileTabId(SCRATCH_WORKSPACE_ID, path)
    expect(state.tabs[id]?.topicId).toBe(customMoteId)
    expect(state.documents[documentKey(SCRATCH_WORKSPACE_ID, path)]?.content).toBe('# Original persona')
    expect(app.panel().dataset.moteTargetTab).toBe(id)
    expect(state.activeWorkspaceId).toBe('project')
    expect(state.mainSurface).toBe('board')
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(state.sessions).toBe(before.sessions)
    expect(app.launch).not.toHaveBeenCalled()
    expect(app.send).not.toHaveBeenCalled()
    expect(app.stop).not.toHaveBeenCalled()
  })

  it('retains a later Mote choice when the original persona read completes late', async () => {
    const path = scratchTopicDirectoryName(customMoteId) + '/SOUL.md'
    let complete!: (result: { status: 'read'; document: { path: string; content: string; revision: string } }) => void
    const read = vi.spyOn(api.files, 'read').mockImplementation(async () => new Promise(resolve => { complete = resolve }))
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    await editPersona()
    expect(read.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, path]])
    await moteClick(app.panel().querySelector<HTMLElement>('[data-mote-topic-id="' + defaultTab.topicId + '"]')!)
    const afterChoice = app.panel().dataset.moteTargetTab
    expect(afterChoice).toBe(defaultTab.id)
    await act(async () => complete({ status: 'read', document: { path, content: '# Late persona', revision: 'persona-v2' } }))
    await settleMoteApp()
    expect(app.panel().dataset.moteTargetTab).toBe(afterChoice)
    expect(useAppStore.getState().activeWorkspaceId).toBe('project')
    expect(app.launch).not.toHaveBeenCalled()
    expect(app.send).not.toHaveBeenCalled()
    expect(app.stop).not.toHaveBeenCalled()
  })
})
