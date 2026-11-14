// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, documentKey, fileViewPointerKey } from '../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { EditorPane } from '../src/renderer/src/components/EditorPane'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { revealInFileManagerLabel } from '../src/renderer/src/lib/host-platform'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
vi.mock('../src/renderer/src/monaco', () => ({}))
const dom = composerDOM()
const workspace = { id: '__scratch__', hostId: 'local', kind: 'folder' as const, name: 'Scratch', path: fixturePath('reserved-root') }
const topicId = 'launcher:original', directory = scratchTopicDirectoryName(topicId)
const view = { kind: 'file' as const, workspaceId: workspace.id, regionId: 'file-region', path: directory + '/work.md' }
const tab = createWorkbenchTab('file-tab', view)
async function select(label: string) {
  const opener = dom.container.querySelector<HTMLElement>('button[data-workbench-tab-id="file-tab"]')
  expect(opener).not.toBeNull()
  await act(async () => { opener!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 35, clientY: 40 })) })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === label)
  expect(item, label).toBeDefined()
  await act(async () => { item!.click() })
}

it('copies the physical Mote directory and reveals the exact cold Source View through the Tab and editor actions', async () => {
  const physical = fixturePath('mote-storage/original')
  const topic = { id: topicId, title: 'Original', directoryPath: directory, physicalDirectoryPath: physical, topicPath: directory + '/topic.md', summary: '', collaborators: [] }
  const base = { hostId: 'local', workspaceId: 'source-owner', workspacePath: fixturePath('source-workspace') }
  const source = { target: { hostId: 'local', expectedRuntimeId: 'source-runtime' },
    resource: { ...base, zonePath: fixturePath('source-workspace/subfolder'), zoneId: 'source-zone', path: 'subfolder/entry.md' },
    query: { zoneId: 'source-zone', path: 'entry.md', expectedResource: base } }
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const reveal = vi.spyOn(api.files, 'reveal').mockResolvedValue(undefined)
  const report = vi.fn()
  useAppStore.setState({ reportError: report, activeWorkspaceId: workspace.id, mainSurface: 'workbench', sessions: [], config: { ...composerConfig, workspaces: [workspace] },
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('files-group', [tab.id]) },
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), topics: [topic], revision: 1, error: null, reading: false } },
    documentIssues: { [documentKey(workspace.id, view.path)]: { kind: 'deleted' } } })
  await dom.render(<WorkspaceWorkbench workspaceId={workspace.id} viewOwnership="projection" />)
  await select('Copy Path')
  expect(copy).toHaveBeenLastCalledWith(physical + '/work.md')
  await select('Copy Relative Path')
  expect(copy).toHaveBeenLastCalledWith(view.path)
  await act(async () => { useAppStore.setState({ scratchTopicSnapshots: {} }) })
  copy.mockClear()
  await select('Copy Path')
  expect(copy).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledWith(expect.any(Error))
  await select('Copy Relative Path')
  expect(copy).toHaveBeenCalledExactlyOnceWith(view.path)
  await act(async () => { useAppStore.setState(state => ({ sourceFilesInputs: { ...state.sourceFilesInputs,
    readSources: { [fileViewPointerKey(tab.id, view.regionId)]: { workspaceId: view.workspaceId, path: view.path, source } } } })) })
  await select('Copy Path')
  expect(copy).toHaveBeenLastCalledWith(source.resource.zonePath + '/entry.md')
  await select('Copy Relative Path')
  expect(copy).toHaveBeenLastCalledWith('entry.md')
  await select(revealInFileManagerLabel())
  expect(reveal).toHaveBeenCalledExactlyOnceWith(workspace.id, view.path, source)
  reveal.mockClear()
  await dom.render(<EditorPane tabId={tab.id} surface={view} />)
  const button = [...dom.container.querySelectorAll('button')].find(item => item.textContent?.trim() === revealInFileManagerLabel())
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
  expect(reveal).toHaveBeenCalledExactlyOnceWith(workspace.id, view.path, source)
  await act(async () => { useAppStore.setState(state => ({ sourceFilesInputs: { ...state.sourceFilesInputs,
    readSources: { [fileViewPointerKey(tab.id, view.regionId)]: { workspaceId: view.workspaceId, path: view.path,
      source: { ...source, target: { ...source.target, hostId: 'remote' } } } } } })) })
  expect([...dom.container.querySelectorAll('button')].some(item => item.textContent?.trim() === revealInFileManagerLabel())).toBe(false)
})
