// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const roots: string[] = []
const originalBridge = Object.getOwnPropertyDescriptor(window, 'agentmux')
afterEach(async () => {
  if (originalBridge) Object.defineProperty(window, 'agentmux', originalBridge)
  else Reflect.deleteProperty(window, 'agentmux')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['scratch-empty', 'scratch-dot', 'ordinary-workspace'] as const)(
  'renders real directory results without losing original addresses: %s', async mode => {
    const fixture = await mkdtemp(join(tmpdir(), 'agentmux-mote-directory-'))
    roots.push(fixture)
    const root = join(fixture, 'topics')
    await mkdir(root)
    const entityName = scratchTopicDirectoryName('view:retained')
    await mkdir(join(root, 'notes'))
    await mkdir(join(root, entityName))
    await writeFile(join(root, 'README.md'), 'Retained root material\n')
    await writeFile(join(root, 'notes', 'saved.md'), 'Retained note\n')
    await symlink('notes', join(root, 'notes-link'))
    const workspace = { id: mode === 'ordinary-workspace' ? 'project' : SCRATCH_WORKSPACE_ID,
      hostId: 'local', name: 'Retained materials', kind: 'folder' as const, path: root }
    const host: ExecutionHost = { id: 'local', kind: 'local', label: 'Local', run: vi.fn(),
      exposeLoopbackPort: async port => port, dispose: async () => {} }
    const files = new WorkspaceFiles(() => host)
    const requestedRoot = mode === 'scratch-dot' ? '.' : ''
    const entries = await files.readDirectory(workspace, requestedRoot)
    expect(entries.map(entry => entry.path)).toEqual(entries.map(entry => entry.name))
    expect(new Set(entries.map(entry => entry.path))).toEqual(new Set(['notes', 'notes-link', entityName, 'README.md']))
    expect(entries.find(entry => entry.name === 'notes-link')).toMatchObject({
      path: 'notes-link', isDirectory: true, isSymlink: true, linkTarget: 'notes'
    })
    expect(entries.find(entry => entry.name === entityName)).toMatchObject({ path: entityName, isDirectory: true })

    const read = vi.spyOn(api.files, 'readDirectory').mockImplementation(async (id, path) => {
      expect(id).toBe(workspace.id)
      return path === '' ? entries : await files.readDirectory(workspace, path)
    })
    Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: {
      status: vi.fn(async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: root }))
    } } })
    const report = vi.fn()
    useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace], copyPathsAsAbsolute: true },
      activeWorkspaceId: workspace.id, sessions: [], layouts: {}, tabs: {}, dirtyDocuments: {}, pinnedItems: {},
      fileExplorerStates: {}, workspaceFileRevisions: {}, lastActiveFileByWorkspace: {}, reportError: report,
      scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1,
        topics: [{ id: 'view:retained', title: 'Retained', summary: '', directoryPath: entityName,
          topicPath: `${entityName}/topic.md`, collaborators: [] }], reading: false, error: null } },
      refreshScratchTopics: vi.fn(async () => {}) })
    await dom.render(<FileExplorer workspaceId={workspace.id} />)
    const row = (path: string) => dom.container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)
    expect([...dom.container.querySelectorAll<HTMLElement>('[data-tree-path]')].map(node => node.dataset.treePath))
      .toEqual(entries.map(entry => entry.path))
    expect(row('README.md')?.title).toBe(join(root, 'README.md'))
    expect(row('notes')?.title).toBe(join(root, 'notes'))
    expect(row(entityName)?.title).toBe(join(root, entityName))
    expect(report).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => row('notes')!.querySelector<HTMLButtonElement>('.tree-row__disclosure')!.click())
    await vi.waitFor(async () => {
      await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
      expect(row('notes/saved.md')).not.toBeNull()
    })
    expect(row('notes/saved.md')?.title).toBe(join(root, 'notes', 'saved.md'))
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('Retained root material\n')
    expect(await readFile(join(root, 'notes', 'saved.md'), 'utf8')).toBe('Retained note\n')
    await files.dispose()
  }
)
