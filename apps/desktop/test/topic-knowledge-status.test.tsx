import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import type { ExecutionHost, TopicKnowledge, TopicUnavailable } from '@agentmux/core'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { TopicKnowledgePanel } from '../src/renderer/src/components/TopicKnowledgePanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { createClientUiRoot } from './helpers/client-ui-render'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('No image decoding in knowledge discovery') } } }))
vi.mock('../src/renderer/src/monaco', () => ({}))

const initial = useAppStore.getState()
const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _historyFixturePath("fixture/topics"), name: 'Topics', kind: 'folder' }
const topic: ScratchTopicSnapshot = { id: 'view:status', title: 'Disk maintenance', summary: '', collaborators: [],
  directoryPath: 'topic--status', topicPath: 'topic--status/topic.md' }
const saved: TopicKnowledge = { topicId: topic.id, entryId: 'entry', title: 'Keep original files', content: 'A confirmed useful result',
  form: 'derived', certainty: 'fact', sources: [], revision: 'original', updatedAt: _historyFixtureEpoch(0, 0, 0) }
const bounded: TopicUnavailable = { code: 'TOPIC_KNOWLEDGE_PARTIAL', message: 'Discovery is bounded.', source: topic.id, recovery: 'Narrow the query or open the exact original file.' }
const failed: TopicUnavailable = { code: 'SOURCE_READ_UNKNOWN', message: 'The original source could not be confirmed.', source: topic.id + ':refs/source.md', recovery: 'Retry this original source.' }
const roots: string[] = []
let root: Root, host: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  host = document.createElement('div'); document.body.append(host)
  root = createClientUiRoot(host)
  vi.spyOn(api.topics, 'call').mockImplementation(async method => {
    if (method === 'topic.inspect') return { topic: null, unavailable: [] } as never
    return { entries: [saved], documents: [], unavailable: [] } as never
  })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function settle(predicate: () => boolean) {
  for (let attempt = 0; attempt < 150 && !predicate(); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(predicate(), host.textContent ?? '').toBe(true)
}
async function mount(issues: TopicUnavailable[], entries: TopicKnowledge[] = [saved]) {
  vi.mocked(api.topics.call).mockImplementation(async method => method === 'topic.inspect'
    ? { topic: null, unavailable: [] } as never : { entries, documents: [], unavailable: issues } as never)
  await act(async () => root.render(createElement(TopicKnowledgePanel, { workspace, topic })))
  await settle(() => host.querySelector('.topic-knowledge-results__label')?.textContent !== 'Reading knowledge…')
}
async function search(value: string, submit = true) {
  const field = host.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (submit) await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search"]')!.click())
}

describe('Knowledge observation presentation keeps authoritative status and original capabilities', () => {
  it.each(['TOPIC_KNOWLEDGE_PARTIAL', 'TOPIC_DOCUMENT_DISCOVERY_LIMIT', 'TOPIC_DOCUMENT_DISCOVERY_BUDGET', 'TOPIC_DOCUMENTS_GIT_IGNORED'])('presents %s as bounded discovery, independent of its display message', async code => {
    await mount([{ ...bounded, code, message: 'Display text changed without changing its protocol code.' }])
    expect(host.querySelector('.topic-knowledge-notice--error')).toBeNull()
    expect(host.querySelector('[aria-label="Knowledge discovery incomplete"] summary')?.textContent).toBe('Results may be incomplete')
    expect(host.querySelector('.topic-knowledge-results__label')?.textContent).toBe('1 item shown')
    expect(host.querySelector('.topic-knowledge-notice code')?.textContent).toBe(code)
    expect(host.querySelector('.topic-knowledge-notice')?.textContent).toContain(bounded.recovery)
    expect(host.querySelector('.topic-knowledge-notice')?.textContent).toContain(topic.id)
    expect(host.querySelectorAll('.topic-knowledge-row')).toHaveLength(1)
  })
  it.each(['SOURCE_READ_UNKNOWN', 'TOPIC_DOCUMENT_DISCOVERY_UNREADABLE', 'WORKSPACE_FILE_BYTE_LIMIT'])('does not soften %s even when its message sounds like a result limit', async code => {
    await mount([{ ...failed, code, message: 'Knowledge discovery reached its result-limit.' }])
    expect(host.querySelector('[aria-label="Knowledge sources unavailable"] summary')?.textContent).toBe('Some sources are unavailable')
    expect(host.querySelector('[aria-label="Knowledge discovery incomplete"]')).toBeNull()
    expect(host.querySelector('.topic-knowledge-notice--error')?.textContent).toContain(failed.recovery)
    expect(host.querySelector('.topic-knowledge-notice--error')?.textContent).toContain(failed.source!)
    expect(host.querySelectorAll('.topic-knowledge-row')).toHaveLength(1)
  })
  it('keeps mixed errors separate and opens a useful result without changing the original workface or draft', async () => {
    const original = useAppStore.getState()
    await mount([bounded, failed])
    expect(host.querySelectorAll('.topic-knowledge-notice')).toHaveLength(2)
    expect(host.querySelectorAll('.topic-knowledge-notice--error')).toHaveLength(1)
    await act(async () => host.querySelector<HTMLButtonElement>('.topic-knowledge-row')!.click())
    expect(host.querySelector('[aria-label="Knowledge detail"]')?.textContent).toContain(saved.content)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
    expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().layouts).toBe(original.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(original.sessions)
  })
  it('does not turn an empty partial observation into complete no matches', async () => {
    await mount([bounded], [])
    expect(host.querySelector('.topic-knowledge-results__label')?.textContent).toBe('Search incomplete')
    expect(host.textContent).not.toContain('No matches')
    expect(host.textContent).not.toContain('No saved knowledge or text documents match')
    expect(host.querySelector('[aria-label="Knowledge discovery incomplete"]')).not.toBeNull()
  })
  it('returns focus to the original result only after closing the reader has committed', async () => {
    await mount([bounded])
    const row = host.querySelector<HTMLButtonElement>('.topic-knowledge-row')!
    await act(async () => row.click())
    expect(host.querySelector('[aria-label="Knowledge detail"]')).not.toBeNull()
    const originalFocus = row.focus.bind(row)
    const focus = vi.spyOn(row, 'focus').mockImplementation(() => {
      expect(host.querySelector('[aria-label="Knowledge detail"]')).toBeNull()
      originalFocus()
    })
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close knowledge detail"]')
    expect(close).not.toBeNull()
    await act(async () => close!.click())
    expect(focus).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(row)
    expect(host.querySelector('[aria-label="Knowledge discovery incomplete"]')).not.toBeNull()
  })
  it('leaves complete observations quiet and does not infer truncation from count alone', async () => {
    await mount([], Array.from({ length: 100 }, (_, index) => ({ ...saved, entryId: 'entry-' + index })))
    expect(host.querySelectorAll('.topic-knowledge-notice')).toHaveLength(0)
    expect(host.querySelector('.topic-knowledge-results__label')?.textContent).toBe('100 items')
  })
  it('keeps successful query ownership when a later query fails, including its readable original detail', async () => {
    await mount([])
    vi.mocked(api.topics.call).mockImplementation(async (method, params) => {
      if (method === 'topic.inspect') return { topic: null, unavailable: [] } as never
      if (method === 'topic.knowledge.search' && 'query' in params && params.query === 'beta') throw new Error('The beta request could not be confirmed.')
      return { entries: [{ ...saved, title: 'Confirmed alpha' }], documents: [], unavailable: [], observation: { unavailable: [] } } as never
    })
    await search('alpha')
    await settle(() => host.querySelector('.topic-knowledge-row strong')?.textContent === 'Confirmed alpha')
    await act(async () => host.querySelector<HTMLButtonElement>('.topic-knowledge-row')!.click())
    await search('beta')
    await settle(() => !!host.querySelector('.surface-inline-error')?.textContent?.includes('The beta request could not be confirmed.'))
    expect(host.querySelector('.topic-knowledge-results__label')?.textContent).toBe('Last confirmed: 1 result · Disk maintenance · “alpha”')
    expect(host.querySelector('[aria-label="Original document detail"]')).toBeNull()
    expect(host.querySelector('[aria-label="Knowledge detail"]')?.textContent).toContain(saved.content)
    expect(host.querySelector('.topic-knowledge-row strong')?.textContent).toBe('Confirmed alpha')
  })
  it('does not reattribute confirmed results to an unsubmitted draft query', async () => {
    await mount([])
    const calls = vi.mocked(api.topics.call).mock.calls.length
    await search('unsubmitted text', false)
    expect(api.topics.call).toHaveBeenCalledTimes(calls)
    expect(host.querySelector('.topic-knowledge-results__label')?.textContent).toBe('1 item')
    expect(host.querySelector('.topic-knowledge-row strong')?.textContent).toBe(saved.title)
  })
  it('preserves structured search-history failure separately from available results and discovery status', async () => {
    await mount([])
    const history: TopicUnavailable = { code: 'TOPIC_SEARCH_HISTORY_UNAVAILABLE', message: 'Search history could not be saved.',
      source: 'original-search-observation', recovery: 'Repair the original history file before retrying history storage.' }
    vi.mocked(api.topics.call).mockImplementation(async method => method === 'topic.inspect' ? { topic: null, unavailable: [] } as never
      : { entries: [saved], documents: [], unavailable: [], observation: { unavailable: [history] } } as never)
    await search('confirmed result')
    await settle(() => !!host.querySelector('[aria-label="Search history unavailable"]'))
    const notice = host.querySelector('[aria-label="Search history unavailable"]')!
    for (const value of [history.code, history.message, history.source!, history.recovery]) expect(notice.textContent).toContain(value)
    expect(host.querySelector('[aria-label="Knowledge sources unavailable"]')).toBeNull()
    expect(host.querySelector('[aria-label="Knowledge discovery incomplete"]')).toBeNull()
    expect(host.querySelector('.topic-knowledge-results__label')?.textContent).toBe('1 result')
    expect(host.querySelectorAll('.topic-knowledge-row')).toHaveLength(1)
  })
  it('does not fetch hidden panels or react to unrelated Session output', async () => {
    await act(async () => root.render(createElement(TopicKnowledgePanel, { workspace, topic, active: false })))
    expect(api.topics.call).not.toHaveBeenCalled()
    await mount([bounded])
    const calls = vi.mocked(api.topics.call).mock.calls.length
    await act(async () => useAppStore.setState({ sessions: [{ id: 'unrelated', kind: 'agent', providerId: 'fixture', executorId: 'fixture',
      hostId: 'local', workspacePath: _historyFixturePath("fixture/unrelated"), label: 'Unrelated', createdAt: _historyFixtureEpoch(0, 0, 0), updatedAt: _historyFixtureEpoch(0, 0, 0), agentSessionUpdatedAt: _historyFixtureEpoch(0, 0, 0),
      processState: 'running', latestOutputBytes: 1024, status: { state: 'working', source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 0) },
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
      control: { kind: 'agent', hostId: 'local', agentSessionId: 'unrelated', run: { runId: 'unrelated-run' } } }] }))
    expect(api.topics.call).toHaveBeenCalledTimes(calls)
  })
  it('shows bounded original Host discovery through the real Files, spatial and Knowledge owners and still reads an exact document', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-status-'))); roots.push(directory)
    const path = join(directory, 'scratch'); await mkdir(path)
    const resource: WorkspaceRecord = { ...workspace, path }
    const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
    const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
    const owner = new TopicKnowledgeOwner(scratch, files, () => resource)
    owner.setSpatialPort(new TopicSpatialOwner({ state: spatial, workspace: () => resource,
      topics: () => owner.listTopicSnapshots(), categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
    const publicFiles = new FileReadOwner({ files, workspace: id => id === resource.id ? resource : undefined,
      topicForDirectory: (original, originalDirectory) => scratch.readForDirectory(original, originalDirectory),
      catalog: async () => { const state = await spatial.read(); return state ? spatialCatalog(state.graph) : null } })
    owner.setFileReadPort(publicFiles)
    const created = (await owner.call('topic.create', { topicId: 'view:bounded', title: 'Original bounded documents' })).topic
    for (let index = 0; index < 520; index++) await writeFile(join(created.directoryPath, 'refs', `source-${String(index).padStart(3, '0')}.md`), 'Original readable document ' + index)
    const originalTopic = (await scratch.list(resource)).find(item => item.id === created.topicId)!
    vi.mocked(api.topics.call).mockImplementation(owner.call.bind(owner))
    vi.spyOn(api.files, 'readPublic').mockImplementation(publicFiles.read.bind(publicFiles))
    await act(async () => root.render(createElement(TopicKnowledgePanel, { workspace: resource, topic: originalTopic })))
    await settle(() => host.querySelectorAll('[data-document-path]').length === 100)
    expect(host.querySelector('.topic-knowledge-results__label')?.textContent).toBe('100 items shown')
    expect(host.querySelectorAll('[aria-label="Knowledge discovery incomplete"]')).toHaveLength(1)
    expect(host.querySelector('.topic-knowledge-notice--error')).toBeNull()
    expect(host.querySelector('.topic-knowledge-notice')?.textContent).toContain('TOPIC_DOCUMENT_DISCOVERY_LIMIT')
    const document = host.querySelector<HTMLButtonElement>('[data-document-path^="refs/source-"]')!
    await act(async () => document.click())
    await settle(() => !!host.querySelector('[aria-label="Original document detail"]')?.textContent?.includes('Original readable document'))
    const openOriginal = host.querySelector<HTMLButtonElement>('[aria-label="Open original file"]')
    expect(openOriginal).not.toBeNull()
    expect(openOriginal!.disabled).toBe(false)
    expect(vi.mocked(api.topics.call).mock.calls.filter(([method]) => method === 'topic.knowledge.ls')).toHaveLength(1)
  })
})
