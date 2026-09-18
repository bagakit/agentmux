// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { MOTE_SOUL_PATH, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { SpaceCreateMenu } from '../src/renderer/src/components/SpaceCreateMenu'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const initial = useAppStore.getState()
const roots: string[] = []
let mountedRoot: Root | undefined
afterEach(async () => { if (mountedRoot) { await act(async () => mountedRoot!.unmount()); mountedRoot = undefined }; vi.restoreAllMocks(); useAppStore.setState(initial, true); document.body.replaceChildren(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
it('creates Mote through the actual menu, preserves its editable SOUL and opens that same file', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const path = await mkdtemp(join(tmpdir(), 'agentmux-mote-')); roots.push(path)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path, kind: 'folder' as const }
  const service = new ScratchTopics()
  useAppStore.setState({ config: { ...initial.config!, version: 9, workspaces: [workspace], hosts: [], executors: {} }, activeWorkspaceId: 'other', tabs: {}, layouts: {}, workspaceFileRevisions: {} })
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_id, topicId) => service.ensureMote(workspace, topicId))
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => service.list(workspace))
  const realCreate = useAppStore.getState().createScratchTopic
  let pending: ReturnType<typeof realCreate> | undefined
  useAppStore.setState({ createScratchTopic: (preset) => (pending = realCreate(preset)) })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); mountedRoot = root
  await act(async () => root.render(createElement(SpaceCreateMenu, { onOpenFolder: async () => {} })))
  await act(async () => container.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const create = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === 'Create Mote')
  expect(create).toBeDefined()
  await act(async () => { create!.click(); await pending })
  const snapshots = await service.list(workspace)
  expect(snapshots).toHaveLength(1)
  const mote = snapshots[0]!
  expect(mote.soul?.content).toContain('Default role: PMO')
  expect(mote.soul?.content).toContain('Choose how to organize your knowledge')
  expect(await readdir(join(path, mote.directoryPath))).toEqual(expect.arrayContaining(['SOUL.md', 'topic.md', '.agents', 'refs', 'outcome']))
  await writeFile(join(path, mote.directoryPath, MOTE_SOUL_PATH), '# SOUL\n\nUser personality.\n')
  const again = await service.ensureMote(workspace, mote.id)
  expect(again.soul?.content).toBe('# SOUL\n\nUser personality.\n')
  const ordinary = await service.ensure(workspace, 'view:ordinary')
  expect(ordinary.soul).toBeUndefined()
  expect(await readFile(join(path, mote.directoryPath, 'topic.md'), 'utf8')).toContain('Untitled Mote')
  vi.mocked(api.scratch.listTopics).mockResolvedValue(await service.list(workspace))
  const openTopic = vi.fn(async () => {}); const openFile = vi.fn(async () => {})
  useAppStore.setState({ openScratchTopic: openTopic, openFile })
  await act(async () => { root.render(createElement(SpaceTopicsTree, { workspace })); })
  const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Untitled Mote SOUL.md"]')
  expect(edit).not.toBeNull()
  await act(async () => { edit!.click(); await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`${mote.directoryPath}/SOUL.md`, undefined, undefined, SCRATCH_WORKSPACE_ID)) })
  expect(openTopic).toHaveBeenCalledWith(mote.id, SCRATCH_WORKSPACE_ID)
  expect(openFile).toHaveBeenCalledWith(`${mote.directoryPath}/SOUL.md`, undefined, undefined, SCRATCH_WORKSPACE_ID)
  await act(async () => root.unmount()); mountedRoot = undefined
})
