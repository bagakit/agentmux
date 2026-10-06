import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { mintObjectId } from '@agentmux/core/object-id'
import { ScratchTopics } from '../../desktop/src/main/scratch-topics'
import { TopicKnowledgeOwner } from '../../desktop/src/main/topic-knowledge'
import { TopicSpatialOwner } from '../../desktop/src/main/topic-spatial-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { SCRATCH_WORKSPACE_ID } from '../../desktop/src/shared/scratch-topics'
import { MobileTopicsSurface } from '../src/topics/MobileTopicsSurface'
import type { TopicsRpc } from '../src/topics/MobileTopicKnowledge'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('Avatar decoding is not consumed by this Topics tree proof.') } } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounts: Array<{ root: Root; element: HTMLDivElement }> = []
async function mount(rpc: TopicsRpc, onOpenTopic = vi.fn(), onBackChange = vi.fn()) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  const render = async (visible = true) => act(async () => root.render(<MobileTopicsSurface rpc={rpc} visible={visible} onOpenTopic={onOpenTopic} renderWorkface={value => <div data-original-topic={value.topicId}>{value.title}</div>} openSource={vi.fn()} onBackChange={onBackChange} />))
  await render(); return { element, render, onOpenTopic, onBackChange }
}
afterEach(async () => { for (const { root, element } of mounts.splice(0)) { await act(async () => root.unmount()); element.remove() } })
async function click(button: HTMLButtonElement) { expect(button).not.toBeNull(); await act(async () => button.click()) }
const category = { categoryId: 'category-a', title: '同名分类', hostId: 'host', spaceId: 'space-a', directoryPath: fixturePath('category/a'), revision: 'a-revision' }
const otherCategory = { ...category, categoryId: 'category-b', spaceId: 'space-b', directoryPath: fixturePath('category/b') }
const topic = { topicId: 'view:a', title: '准确 Topic', summary: '原说明', hostId: 'host', zoneId: 'original-zone-a', directoryPath: fixturePath('topic/a'), categorySpaceIds: [category.spaceId], chatIds: ['original-chat'], spatialRevision: 2 }
const otherTopic = { ...topic, topicId: 'view:b', zoneId: 'original-zone-b', categorySpaceIds: [otherCategory.spaceId] }
const categoryButton = (element: HTMLElement, id: string) => element.querySelector<HTMLButtonElement>(`[data-topic-category="${id}"] > button`)!
const rpcMock = (run: (method: string, input: any) => Promise<any>) => vi.fn(run) as unknown as TopicsRpc

it('opens exact category children in the same tree, keeps sibling category and Topics title, and collapses without reading another category', async () => {
  const rpc = rpcMock(async (method, input) => method === 'topic.category.ls' ? { categories: [category, otherCategory], unavailable: [] } : { topics: [input.categoryId === otherCategory.categoryId ? otherTopic : topic], unavailable: [] })
  const view = await mount(rpc)
  expect(rpc).toHaveBeenCalledExactlyOnceWith('topic.category.ls', {})
  await click(categoryButton(view.element, otherCategory.categoryId))
  expect(view.element.querySelectorAll('.mobile-topics-tree > li')).toHaveLength(2)
  expect(categoryButton(view.element, category.categoryId).getAttribute('aria-expanded')).toBe('false')
  expect(categoryButton(view.element, otherCategory.categoryId).getAttribute('aria-expanded')).toBe('true')
  expect(view.element.querySelector('header h1')?.textContent).toBe('Topics')
  expect(rpc).toHaveBeenLastCalledWith('topic.ls', { categoryId: otherCategory.categoryId })
  await click(view.element.querySelector<HTMLButtonElement>(`[data-topic-branch="${otherCategory.categoryId}"] .mobile-topics-topic`)!)
  expect(view.onOpenTopic).toHaveBeenCalledExactlyOnceWith(otherTopic)
  await act(async () => view.onBackChange.mock.calls.at(-1)![0]())
  expect(view.element.querySelector(`[data-topic-branch="${otherCategory.categoryId}"]`)).not.toBeNull()
  await act(async () => view.onBackChange.mock.calls.at(-1)![0]())
  expect(view.element.querySelector('[data-topic-branch]')).toBeNull()
  expect(view.onBackChange).toHaveBeenLastCalledWith(null)
  expect(vi.mocked(rpc).mock.calls.filter(([method]) => method === 'topic.ls')).toHaveLength(1)
  expect(view.element.querySelector('summary[aria-label="Topics 更多操作"] svg')).not.toBeNull()
  expect(view.element.querySelector('summary[aria-label="Topics 更多操作"]')?.textContent).toBe('')
})

it('cannot apply a late collapsed category response to the later selected same-name category, including after hiding', async () => {
  let resolve!: (value: any) => void
  const rpc = rpcMock(async (method, input) => method === 'topic.category.ls' ? { categories: [category, otherCategory], unavailable: [] }
    : input.categoryId === category.categoryId ? new Promise(done => { resolve = done }) : { topics: [otherTopic], unavailable: [] })
  const view = await mount(rpc)
  await click(categoryButton(view.element, category.categoryId))
  await click(categoryButton(view.element, otherCategory.categoryId))
  await act(async () => resolve({ topics: [topic], unavailable: [] }))
  const branch = view.element.querySelector(`[data-topic-branch="${otherCategory.categoryId}"]`)!
  expect(branch.textContent).toContain(otherTopic.title)
  await click(branch.querySelector<HTMLButtonElement>('.mobile-topics-topic')!)
  expect(view.onOpenTopic).toHaveBeenCalledExactlyOnceWith(otherTopic)
  const calls = vi.mocked(rpc).mock.calls.length
  await view.render(false); await view.render(false)
  expect(vi.mocked(rpc).mock.calls).toHaveLength(calls)
})

it('keeps confirmed children and their callback through a failed branch refresh; an unrelated category remains navigable', async () => {
  let fail = false
  const rpc = rpcMock(async (method, input) => {
    if (method === 'topic.category.ls') return { categories: [category, otherCategory], unavailable: [] }
    if (fail && input.categoryId === category.categoryId) throw new Error('original-category-read-unavailable')
    return { topics: [input.categoryId === category.categoryId ? topic : otherTopic], unavailable: [] }
  })
  const view = await mount(rpc)
  await click(categoryButton(view.element, category.categoryId)); fail = true
  await click([...view.element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '刷新目录')!)
  const branch = view.element.querySelector(`[data-topic-branch="${category.categoryId}"]`)!
  expect(branch.textContent).toContain('original-category-read-unavailable')
  expect(branch.querySelector('.mobile-topics-service')?.hasAttribute('open')).toBe(false)
  await click(branch.querySelector<HTMLButtonElement>('.mobile-topics-topic')!)
  expect(view.onOpenTopic).toHaveBeenCalledWith(topic)
  await act(async () => view.onBackChange.mock.calls.at(-1)![0]())
  await click(categoryButton(view.element, otherCategory.categoryId))
  expect(view.element.querySelector(`[data-topic-branch="${otherCategory.categoryId}"]`)?.textContent).not.toContain('original-category-read-unavailable')
})

it('retains previously confirmed children when an owner explicitly reports an unavailable empty observation', async () => {
  let unavailable = false
  const rpc = rpcMock(async method => method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
    : unavailable ? { topics: [], unavailable: [{ message: 'Original Topic owner unknown', recovery: 'Retry the original directory.' }] } : { topics: [topic], unavailable: [] })
  const view = await mount(rpc)
  await click(categoryButton(view.element, category.categoryId)); unavailable = true
  await click([...view.element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '刷新目录')!)
  const branch = view.element.querySelector(`[data-topic-branch="${category.categoryId}"]`)!
  expect(branch.textContent).toContain('Original Topic owner unknown')
  await click(branch.querySelector<HTMLButtonElement>('.mobile-topics-topic')!)
  expect(view.onOpenTopic).toHaveBeenCalledExactlyOnceWith(topic)
})

it('consumes real Topic owner category bindings through strict public RPC and opens the exact Topic workface', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-mobile-topics-tree-')))
  const path = join(directory, 'scratch'); await mkdir(path)
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Tree proof', hostId: 'local', path, kind: 'folder' as const }
  const state = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  const owner = new TopicKnowledgeOwner(new ScratchTopics(), files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(), categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const service = new AgentMuxRpcService({ topics: owner, coreClients: () => [] })
  try {
    const firstId = mintObjectId(), secondId = mintObjectId(), firstTopicId = mintObjectId(), secondTopicId = mintObjectId()
    await owner.call('topic.category.create', { categoryId: firstId, title: '同名真实分类' })
    await owner.call('topic.category.create', { categoryId: secondId, title: '同名真实分类' })
    await owner.call('topic.create', { topicId: firstTopicId, categoryId: firstId, title: '同名真实 Topic' })
    const created = (await owner.call('topic.create', { topicId: secondTopicId, categoryId: secondId, title: '同名真实 Topic' })).topic
    const rpc = vi.fn((method: any, input: any) => service.call(method, input, { principal: { kind: 'device', id: 'controlled-tree-device' } })) as unknown as TopicsRpc
    const view = await mount(rpc)
    await vi.waitFor(async () => { await act(async () => {}); expect(categoryButton(view.element, secondId)).not.toBeNull() }, { timeout: 10000 })
    await click(categoryButton(view.element, secondId))
    await vi.waitFor(async () => { await act(async () => {}); expect(view.element.querySelector(`[data-topic-branch="${secondId}"] .mobile-topics-topic`)).not.toBeNull() }, { timeout: 10000 })
    expect(rpc).toHaveBeenLastCalledWith('topic.ls', { categoryId: secondId })
    const branch = view.element.querySelector(`[data-topic-branch="${secondId}"]`)!
    expect(branch.querySelectorAll('.mobile-topics-topic')).toHaveLength(1)
    await click(branch.querySelector<HTMLButtonElement>('.mobile-topics-topic')!)
    expect(view.onOpenTopic).toHaveBeenCalledExactlyOnceWith(created)
    expect(view.element.querySelector(`[data-original-topic="${secondTopicId}"]`)).not.toBeNull()
    expect(created.zoneId).toBeTypeOf('string')
    expect(view.onOpenTopic.mock.calls[0]![0].categorySpaceIds).toEqual(created.categorySpaceIds)
    expect(vi.mocked(rpc).mock.calls.map(([method]) => method)).toEqual(['topic.category.ls', 'topic.ls'])
    if (process.env.MOBILE_TOPICS_OWNER_EVIDENCE) {
      const categoriesResult = await service.call('topic.category.ls', {}, { principal: { kind: 'device', id: 'controlled-tree-device' } })
      const firstTopics = await service.call('topic.ls', { categoryId: firstId }, { principal: { kind: 'device', id: 'controlled-tree-device' } })
      const secondTopics = await service.call('topic.ls', { categoryId: secondId }, { principal: { kind: 'device', id: 'controlled-tree-device' } })
      const sourcePaths = ['../mobile/src/topics/MobileTopicsSurface.tsx', '../mobile/src/topics/MobileTopicOrganization.tsx', '../mobile/src/topics/topics.css']
      writeFileSync(process.env.MOBILE_TOPICS_OWNER_EVIDENCE, JSON.stringify({ schema: 'agentmux.mobile-topics-owner-consumer.v1',
        sourceSHA256: Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
        categoriesResult, topicsByCategory: { [firstId]: firstTopics, [secondId]: secondTopics }, expandedCategoryId: secondId,
        openedTopic: view.onOpenTopic.mock.calls[0]![0], calls: vi.mocked(rpc).mock.calls.map(([method, input]) => ({ method, input })),
        owner: 'ScratchTopics + TopicKnowledgeOwner + TopicSpatialOwner + WorkspaceFiles → AgentMuxRpcService',
        at: new Date().toISOString() }, null, 2) + '\n')
    }

  } finally { await files.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 30000)
