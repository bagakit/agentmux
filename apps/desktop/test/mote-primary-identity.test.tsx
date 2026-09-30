// @vitest-environment happy-dom
import { act } from 'react'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, moteConfig, savedMoteKey } from './fixtures/mote-workface'
let root: string, service: ScratchTopics, workspace: typeof moteConfig.workspaces[number], dispose: (() => void) | undefined, app: MoteAppFixture | undefined
const original = useAppStore.getInitialState()
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); useAppStore.setState(original, true)
  root = await mkdtemp(join(tmpdir(), 'mote-primary-initialize-')); await mkdir(join(root, 'topics'))
  workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(root, 'topics'), name: 'Topics', kind: 'folder' }
  service = new ScratchTopics()
  vi.spyOn(api.config, 'get').mockResolvedValue({ ...moteConfig, workspaces: [workspace] })
  vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation((_id, topic) => service.ensureMote(workspace, topic))
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(() => service.list(workspace))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})
afterEach(async () => { if (app) await app.dispose(); app = undefined; dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })
function disposeInitialization() { dispose?.(); dispose = undefined }
async function initialized() {
  dispose = await useAppStore.getState().initialize()
  for (let attempt = 0; attempt < 50 && !useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  await Promise.all(vi.mocked(api.scratch.ensureMote).mock.results.map(result => Promise.resolve(result.value).catch(() => {})))
  expect(useAppStore.getState().loading).toBe(false)
}
it('ordinary real initialize ensures the cold primary once using real ScratchTopics, not a presented default or list-time seed', async () => {
  expect(await service.read(workspace, PMO_TEAMS_TOPIC_ID)).toBeNull()
  const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
  await initialized()
  const actual = await service.read(workspace, PMO_TEAMS_TOPIC_ID)
  expect(actual).not.toBeNull(); expect(actual!.soul?.content.length).toBeGreaterThan(0)
  expect(api.scratch.ensureMote).toHaveBeenCalledTimes(1)
  expect(api.scratch.ensureMote).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  expect(api.scratch.ensureMote).toHaveBeenCalledTimes(1)
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toEqual([])
})
it('ordinary initialization retains existing authored bytes and does not overwrite unknown symlink contents', async () => {
  const first = await service.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  const soul = join(workspace.path, first.directoryPath, 'SOUL.md'); await writeFile(soul, 'Original saved personality')
  await initialized(); expect(await readFile(soul, 'utf8')).toBe('Original saved personality')
  disposeInitialization()
  await initialized(); expect(await readFile(soul, 'utf8')).toBe('Original saved personality')
  expect(api.scratch.ensureMote).toHaveBeenCalledTimes(2)
  disposeInitialization()
  const unknown = join(root, 'unknown-user-SOUL.md'); await writeFile(unknown, 'Unknown nonempty user personality')
  await rm(soul); await symlink(unknown, soul)
  await initialized()
  expect(await readFile(unknown, 'utf8')).toBe('Unknown nonempty user personality')
  expect(useAppStore.getState().error).toContain('primary Mote directory could not be confirmed')
  expect(api.scratch.ensureMote).toHaveBeenCalledTimes(3)
})
it('failed primary ensure is an explicit advisory while the original durable Tab and healthy Session remain usable', async () => {
  vi.mocked(api.scratch.ensureMote).mockRejectedValue(new Error('directory unavailable'))
  vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [defaultAgent], timelines: {}, recoveryCandidates: [] })
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: { restoredWorkbench: { tabs: { [defaultTab.id]: defaultTab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-group', [defaultTab.id]) } } } }))
  await useAppStore.persist.rehydrate(); await initialized()
  expect(useAppStore.getState().error).toContain('directory unavailable')
  expect(useAppStore.getState().error).toContain('open Mote to retry')
  expect(useAppStore.getState().tabs[defaultTab.id]).toEqual(defaultTab)
  expect(useAppStore.getState().sessions).toEqual([defaultAgent]); expect(useAppStore.getState().loading).toBe(false)
})
it('real Renderer deletePath calls the final service guard and leaves custom/internal operations reachable', async () => {
  await initialized(); const directory = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
  const files = new WorkspaceFiles(() => ({ kind: 'local' }) as never, { primaryMoteWorkspace: async () => workspace })
  vi.spyOn(api.files, 'delete').mockImplementation(async (_workspaceId, path) => files.delete(workspace, path))
  const before = useAppStore.getState()
  await expect(useAppStore.getState().deletePath(directory)).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  expect(api.files.delete).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, directory)
  expect(useAppStore.getState().error).toContain('primary Mote')
  expect(await service.read(workspace, PMO_TEAMS_TOPIC_ID)).not.toBeNull()
  const custom = await service.ensureMote(workspace, 'view:custom')
  await useAppStore.getState().deletePath(custom.directoryPath)
  expect(await service.read(workspace, custom.id)).toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
it('the primary actual Tab close remains legal and retains its directory identity and healthy Session', async () => {
  await initialized(); await prepareRendererUpdate(); app = createMoteApp()
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await app.mount(); const before = useAppStore.getState()
  const close = app.panel().querySelector<HTMLElement>(`button[data-workbench-tab-id="${defaultTab.id}"] .workbench-tab__close`)
  expect(close).not.toBeNull(); await moteClick(close!)
  const keep = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Keep Session & Close')
  expect(keep).toBeDefined(); await moteClick(keep!)
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(await service.read(workspace, PMO_TEAMS_TOPIC_ID)).not.toBeNull()
  expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})
