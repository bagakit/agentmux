// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { WorkspaceFilesFrame } from '../src/renderer/src/components/WorkspaceFilesFrame'
import { api } from '../src/renderer/src/lib/api'
import { contentSlotPresentation } from '../src/renderer/src/lib/surface-tool-dock'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { controlledNativeImage } from './fixtures/mote-identity-image'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))

const dom = composerDOM()
let temporaryRoot: string | undefined
afterEach(async () => { if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }) })

it('opens same-name documents in their original Motes while Scratch retains a separate folder request', async () => {
  installFileTreeGeometry()
  temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'topic-file-routing-')))
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', kind: 'folder' as const, name: 'Scratch', path: join(temporaryRoot, 'scratch') }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(controlledNativeImage)
  const files = new WorkspaceFiles(() => composerConfig.hosts[0]!)
  const owners = await Promise.all(['view:first', 'view:second'].map(async id => {
    const topic = await topics.ensureMote(workspace, id)
    const root = scratchTopicDirectoryName(id)
    await mkdir(join(topic.physicalDirectoryPath!, 'examples'))
    await writeFile(join(topic.physicalDirectoryPath!, 'examples', 'same.md'), id)
    return { topic, root, path: root + '/examples/same.md' }
  }))
  const target = { hostId: workspace.hostId, expectedRuntimeId: 'original-runtime' }
  const witness = await stat(workspace.path, { bigint: true })
  const registration = { runtimeId: target.expectedRuntimeId, directory: { hostId: 'local' as const, workspacePath: workspace.path,
    projectRootPath: workspace.path, witness: { realPath: workspace.path, device: String(witness.dev), inode: String(witness.ino) } } }
  const input = { target, workspace, registration, registrationStatus: 'unknown' as const, selection: { kind: 'directory' as const, path: workspace.path },
    issue: 'Public Scratch folder requires attention' }
  const selections = { [workspace.id]: input }
  const read = vi.spyOn(api.files, 'read').mockImplementation((_id, path) => files.read(workspace, path))
  let listing: ReturnType<typeof files.readDirectory> | undefined
  vi.spyOn(api.files, 'readDirectory').mockImplementation((_id, path) => listing = files.readDirectory(workspace, path))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  const foreign = vi.spyOn(api.sourceFiles, 'call').mockRejectedValue(new Error('Foreign Source consumed a file'))
  const resolve = vi.fn(async () => ({ status: 'unconfirmed' as const, issue: { code: 'UNKNOWN', message: input.issue } }))
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, activeWorkspaceId: workspace.id,
    layouts: { [workspace.id]: createWorkspaceLayout('files', []) }, tabs: {}, documents: {}, explorerCollapsed: { [workspace.id]: false },
    resolveFilesSource: resolve, observeFilesSource: async () => () => {},
    sourceFilesInputs: { selections, pending: {}, creations: {}, folderRequests: {} } })
  async function show(rootPath: string, fileIssue?: string) {
    await dom.render(<WorkspaceFilesFrame workspace={workspace} title={rootPath || workspace.name} fileIssue={fileIssue} visible
      presentation={contentSlotPresentation(false)} explorerKey={rootPath} explorer={{ rootPath }}><div /></WorkspaceFilesFrame>)
  }
  for (const { root, path, topic } of owners) {
    await show(root)
    await act(async () => { await listing })
    expect(dom.container.textContent).not.toContain('Folder registration needs checking')
    const directory = await vi.waitFor(() => {
      const row = dom.container.querySelector<HTMLElement>(`[data-tree-path="${root}/examples"] .tree-row__label`)
      expect(row, dom.container.textContent ?? '').toBeTruthy()
      return row!
    })
    await act(async () => directory.click())
    await act(async () => { await listing })
    await vi.waitFor(() => expect(dom.container.querySelector(`[data-tree-path="${path}"]`)).toBeTruthy())
    // Even a confirmed locator for the surrounding Workspace cannot own this new object document.
    const locator = { mount: { hostId: workspace.hostId, reference: { runtimeId: target.expectedRuntimeId, spaceId: 'other-space' },
      workspaceId: workspace.id, zoneId: 'other-zone' }, resource: { hostId: workspace.hostId, workspaceId: workspace.id,
      workspacePath: workspace.path, zoneId: 'other-zone', zonePath: workspace.path, path: '.' } }
    await act(async () => {
      useAppStore.setState(state => ({ sourceFilesInputs: { ...state.sourceFilesInputs, selections: { [workspace.id]: { ...input, locator } } } }))
      await useAppStore.getState().openFile(path, 'files', undefined, workspace.id)
    })
    expect(useAppStore.getState().documents[documentKey(workspace.id, path)]?.content).toBe(topic.id)
    await act(async () => useAppStore.setState(state => ({ sourceFilesInputs: { ...state.sourceFilesInputs, selections } })))
  }
  expect(read.mock.calls.map(([, path]) => path)).toEqual(owners.map(owner => owner.path))
  expect(resolve).not.toHaveBeenCalled()
  expect(foreign).not.toHaveBeenCalled()
  await show('', 'The selected object is still being located.')
  expect(dom.container.textContent).toContain('The selected object is still being located.')
  expect(resolve).not.toHaveBeenCalled()
  await show('')
  expect(resolve).toHaveBeenCalledWith(workspace.id)
  expect(dom.container.textContent).toContain('Folder registration needs checking')
  expect(useAppStore.getState().sourceFilesInputs.selections).toBe(selections)
})
