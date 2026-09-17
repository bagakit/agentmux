// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
const initial = useAppStore.getState()
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })
it('creates a durable Topic from a different Project before its independent Tab projection exists', async () => {
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' as const }
  useAppStore.setState({ config: { ...initial.config!, version: 9, workspaces: [workspace], hosts: [], executors: {} }, activeWorkspaceId: 'other', layouts: {}, tabs: {} })
  const ensure = vi.spyOn(api.scratch, 'ensureTopic')
  const created = await useAppStore.getState().createScratchTopic()
  expect(ensure).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, created.id)
  expect(created.id).toMatch(/^launcher:/)
  expect(await api.files.readDirectory(SCRATCH_WORKSPACE_ID, created.directoryPath)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'topic.md' }), expect.objectContaining({ name: 'refs' }),
    expect.objectContaining({ name: 'outcome' }), expect.objectContaining({ name: '.agents' })
  ]))
  const state = useAppStore.getState()
  const tabs = Object.values(state.tabs)
  expect(tabs).toHaveLength(1)
  expect(tabs[0]?.topicId).toBe(created.id)
  expect(tabs[0]?.id).not.toBe(created.id)
  expect(state.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(state.workspaceFileRevisions[SCRATCH_WORKSPACE_ID]).toBeGreaterThan(0)
  useAppStore.setState({ tabs: {}, layouts: {} })
  expect(await api.scratch.readTopic(SCRATCH_WORKSPACE_ID, created.id)).toMatchObject({ id: created.id, directoryPath: created.directoryPath })
})
