import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
import './mobile-lan-crypto.setup'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileTopicsSurface, type MobileTopicsContext } from '../src/topics/MobileTopicsSurface'
import { MobileTopicOrganization } from '../src/topics/MobileTopicOrganization'
import { MobileTopicKnowledge, MobileTopicKnowledgeEditor, type TopicsRpc } from '../src/topics/MobileTopicKnowledge'
import type { TopicKnowledge } from '@agentmux/core/control'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounted: { root: Root; element: HTMLDivElement }[] = []
const hostScope = { origin: 'http://192.168.2.45:8443', runtimeId: 'original-topic-runtime', deviceHostId: 'original-topic-device' }
beforeEach(async () => {
  localStorage.clear()
  await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), hostUrl: hostScope.origin,
    host: { origin: hostScope.origin, hostId: hostScope.deviceHostId } })
})
function hosted(rpc: TopicsRpc): AgentMuxHostedClient {
  return { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: hostScope.runtimeId,
    ownerInstanceId: 'original-topic-process', availability: 'connected' }) } as unknown as AgentMuxHostedClient
}
async function waitFor(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
async function mount(node: ReactNode) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  await act(async () => { root.render(node) })
  return { element, render: async (next: ReactNode) => { await act(async () => { root.render(next) }) } }
}
afterEach(async () => { for (const { root, element } of mounted.splice(0)) { await act(async () => root.unmount()); element.remove() } })
function button(element: HTMLElement, text: string): HTMLButtonElement {
  const found = [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)
  expect(found, text).toBeDefined(); return found!
}
async function click(value: HTMLButtonElement) { await act(async () => value.click()) }
async function input(value: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    const proto = value.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(value, text)
    value.dispatchEvent(new Event('input', { bubbles: true })); value.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const category = { categoryId: 'category-original', title: '原分类', hostId: 'host', spaceId: 'category-space', directoryPath: fixturePath("category"), revision: 'category-revision' }
const topic = { topicId: 'view:original', title: '同名 Topic', summary: '原一句说明', hostId: 'host', zoneId: 'zone-exact', directoryPath: fixturePath("topic"), categorySpaceIds: ['category-space'], chatIds: ['tab-second', 'tab-first'], spatialRevision: 17 }
const knowledge: TopicKnowledge = { topicId: topic.topicId, entryId: '11111111-1111-4111-8111-111111111111', title: '原知识', content: '# 原正文\n\n完整内容', form: 'reference', certainty: 'fact', revision: 'sha256:' + '1'.repeat(64), updatedAt: _reshape_fixtureEpoch(0, 0, 123),
  sources: [{ kind: 'survey', zoneId: 'other-zone', tabId: 'other-tab', regionId: 'other-region' }, { kind: 'note', noteId: 'note-original', blockId: 'block-original' }] }
function rpcMock(implementation: (method: string, params: any) => Promise<unknown>) { return vi.fn(implementation) as unknown as TopicsRpc }

describe('original Topic mobile consumers', () => {
  it('returns a Topic source to its owning origin only after knowledge and organization back layers', async () => {
    const rpc = rpcMock(async method => method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
      : method === 'topic.ls' ? { topics: [topic], unavailable: [] } : method === 'topic.inspect' ? { topic, unavailable: [] }
      : method === 'topic.knowledge.ls' ? { entries: [knowledge], unavailable: [] } : { entry: knowledge })
    const leave = vi.fn(), back = vi.fn()
    const { element } = await mount(<MobileTopicsSurface initialContext={{ categoryId: category.categoryId, topicId: topic.topicId, mode: 'discussion' }}
      rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={() => <div>准确原讨论</div>} openSource={vi.fn()} onBackChange={back} onLeaveTopic={leave} topicBackLabel="返回知识" />)
    const goBack = async () => act(async () => back.mock.calls.at(-1)![0]())
    await click(button(element, '知识')); await click(button(element, '原知识事实')); await click(button(element, '编辑知识'))
    const draft = element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
    await input(draft, '来源返回前的原知识草稿')
    await goBack(); await goBack(); await goBack()
    expect(leave).not.toHaveBeenCalled(); expect(draft.value).toBe('来源返回前的原知识草稿')
    await click(button(element, '移动 Topic'))
    await goBack(); expect(leave).not.toHaveBeenCalled()
    await goBack(); expect(leave).toHaveBeenCalledOnce()
    expect(element.querySelector('header h1')?.textContent).toBe(topic.title)
    await click(element.querySelector<HTMLButtonElement>('[aria-label="返回知识"]')!)
    expect(leave).toHaveBeenCalledTimes(2)
    expect(vi.mocked(rpc).mock.calls.some(([method]) => method === 'topic.knowledge.write')).toBe(false)
  })

  it('retains the exact prior discussion workface across another Topic source and returns without requiring an offline lookup', async () => {
    const other = { ...topic, topicId: 'view:source', title: '来源 Topic' }
    let unavailable = false
    const rpc = rpcMock(async (method, params) => {
      if (unavailable) throw new Error('原查询暂不可用')
      return method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
        : method === 'topic.ls' ? { topics: [topic, other], unavailable: [] }
        : { topic: params.topicId === other.topicId ? other : topic, unavailable: [] }
    })
    const context: MobileTopicsContext = { categoryId: category.categoryId, topicId: topic.topicId, mode: 'discussion' }
    const renderWorkface = vi.fn((value: typeof topic, visible: boolean) => <div hidden={!visible}><input aria-label={`原 Chat 草稿 ${value.topicId}`} defaultValue="" /></div>)
    const renderTopics = (value = context) => <MobileTopicsSurface initialContext={value} rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={renderWorkface} openSource={vi.fn()} />
    const view = await mount(renderTopics())
    const draft = view.element.querySelector<HTMLInputElement>(`[aria-label="原 Chat 草稿 ${topic.topicId}"]`)!
    await input(draft, '返回前的准确原 Chat 草稿')
    await view.render(renderTopics({ ...context, topicId: other.topicId }))
    expect(draft.closest('[hidden]')).not.toBeNull()
    unavailable = true
    const lookups = vi.mocked(rpc).mock.calls.length
    await view.render(renderTopics())
    expect(view.element.querySelector('header h1')?.textContent).toBe(topic.title)
    expect(view.element.querySelector(`[aria-label="原 Chat 草稿 ${topic.topicId}"]`)).toBe(draft)
    expect(draft.closest('[hidden]')).toBeNull(); expect(draft.value).toBe('返回前的准确原 Chat 草稿')
    expect(renderWorkface).toHaveBeenCalledWith(topic, true)
    expect(vi.mocked(rpc).mock.calls).toHaveLength(lookups)
  })

  it('restores exact presentation references from the original owner and returns another Topic source to the retained knowledge draft and unknown revision', async () => {
    const other = { ...topic, topicId: 'view:source', title: '来源 Topic' }
    const rpc = rpcMock(async (method, params) => method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
      : method === 'topic.ls' ? { topics: [topic, other], unavailable: [] }
      : method === 'topic.inspect' ? { topic: params.topicId === other.topicId ? other : topic, unavailable: [] }
      : method === 'topic.knowledge.ls' ? { entries: [knowledge], unavailable: [] }
      : method === 'topic.knowledge.write' ? Promise.reject(new Error('原保存回执未知')) : { entry: knowledge })
    const context: MobileTopicsContext = { categoryId: category.categoryId, topicId: topic.topicId, mode: 'knowledge' }
    const report = vi.fn(), source = vi.fn(), open = vi.fn()
    const client = hosted(rpc)
    const renderTopics = (value = context, target = value.topicId) => <MobileTopicsSurface initialContext={value} topicId={target} onContextChange={report} rpc={rpc} client={client} connected onOpenTopic={open} renderWorkface={() => <div>准确原 Chat 候选</div>} openSource={source} />
    const view = await mount(renderTopics())
    expect(rpc).toHaveBeenCalledWith('topic.inspect', { topicId: topic.topicId })
    expect(rpc).toHaveBeenCalledWith('topic.ls', { categoryId: category.categoryId })
    expect(report).toHaveBeenLastCalledWith(context)
    await click(button(view.element, '原知识事实')); await click(button(view.element, '编辑知识'))
    const draft = view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
    await input(draft, '原对象和修订上的未保存正文')
    await click(button(view.element, '保存知识'))
    await waitFor(() => expect(view.element.textContent).toContain('保存未确认'))
    expect(rpc).toHaveBeenCalledWith('topic.knowledge.write', expect.objectContaining({ topicId: topic.topicId, entryId: knowledge.entryId, expectedRevision: knowledge.revision, sources: knowledge.sources }))
    await view.render(renderTopics({ ...context, topicId: other.topicId, mode: 'discussion' }))
    expect(view.element.querySelector('header h1')?.textContent).toBe('来源 Topic')
    await view.render(renderTopics())
    expect(view.element.querySelector('header h1')?.textContent).toBe(topic.title)
    expect(view.element.querySelector('[aria-label="知识正文"]')).toBe(draft)
    expect(draft.value).toBe('原对象和修订上的未保存正文')
    expect(view.element.textContent).toContain('原保存回执未知')
    expect(vi.mocked(rpc).mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(1)
    expect(report).toHaveBeenLastCalledWith(context); expect(open).not.toHaveBeenCalled()
  })

  it('returns organization editing to its exact prior frame, preserves draft and does not navigate on a late restored Topic lookup', async () => {
    let resolve!: (value: unknown) => void
    const rpc = rpcMock(async method => method === 'topic.inspect' ? await new Promise(done => { resolve = done })
      : method === 'topic.category.ls' ? { categories: [category], unavailable: [] } : { topics: [topic], unavailable: [] })
    const back = vi.fn(), report = vi.fn()
    const { element } = await mount(<MobileTopicsSurface initialContext={{ categoryId: category.categoryId, topicId: 'view:pending', mode: 'discussion' }} onContextChange={report} rpc={rpc} onBackChange={back} onOpenTopic={vi.fn()} renderWorkface={() => null} openSource={vi.fn()} />)
    await act(async () => back.mock.calls.at(-1)![0]())
    await act(async () => resolve({ topic: { ...topic, topicId: 'view:pending', title: '迟到 Topic' }, unavailable: [] }))
    expect(element.querySelector('header h1')?.textContent).toBe('Topics')
    expect(element.querySelector('header small')?.textContent).toBe(category.title)
    expect(report).toHaveBeenLastCalledWith({ categoryId: category.categoryId, topicId: null, mode: 'discussion' })
    await click(button(element, '新建 Topic'))
    const title = element.querySelector<HTMLInputElement>('[aria-label="分类或 Topic 名称"]')!
    await input(title, '准确分类上的未保存管理草稿')
    await act(async () => back.mock.calls.at(-1)![0]())
    expect(element.querySelector('header h1')?.textContent).toBe('Topics')
    expect(element.querySelector('header small')?.textContent).toBe(category.title)
    await click(button(element, '继续管理草稿'))
    expect(element.querySelector<HTMLInputElement>('[aria-label="分类或 Topic 名称"]')?.value).toBe('准确分类上的未保存管理草稿')
    expect(vi.mocked(rpc).mock.calls.some(([method]) => method === 'topic.create')).toBe(false)
  })

  it('returns editor → reader → knowledge list → discussion → category → directory while retaining its draft and stable callback', async () => {
    const rpc = rpcMock(async method => method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
      : method === 'topic.ls' ? { topics: [topic], unavailable: [] }
      : method === 'topic.knowledge.ls' ? { entries: [knowledge], unavailable: [] } : { entry: knowledge })
    const back = vi.fn(), open = vi.fn(), workface = vi.fn(() => <div>原讨论工作面</div>), source = vi.fn()
    const renderTopics = (visible = true) => <MobileTopicsSurface rpc={rpc} visible={visible} onOpenTopic={open} renderWorkface={workface} openSource={source} onBackChange={back} />
    const view = await mount(renderTopics())
    const visibleButton = (text: string) => [...view.element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text && !value.closest('[hidden]'))!
    const goBack = async () => { const handler = back.mock.calls.at(-1)![0]; expect(handler).toBeTypeOf('function'); await act(async () => handler()) }
    expect(back).toHaveBeenLastCalledWith(null)
    await click(visibleButton('原分类')); await click(visibleButton('同名 Topic原一句说明')); await click(visibleButton('知识'))
    await click(visibleButton('原知识事实')); await click(visibleButton('编辑知识'))
    const draft = view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
    const editorBack = back.mock.calls.at(-1)![0], registrations = back.mock.calls.length
    await input(draft, '原知识未保存草稿'); await view.render(renderTopics())
    expect(back.mock.calls).toHaveLength(registrations)
    await goBack()
    expect(draft.closest('[hidden]')).not.toBeNull()
    expect(view.element.querySelector('.mobile-topic-reading')?.textContent).toContain('完整内容')
    expect(back.mock.calls.at(-1)![0]).not.toBe(editorBack)
    await goBack()
    expect(view.element.querySelector('.mobile-topic-reading')).toBeNull()
    await goBack()
    expect(workface).toHaveBeenLastCalledWith(topic, true)
    await goBack()
    expect(view.element.querySelector('header h1')?.textContent).toBe('Topics')
    expect(view.element.querySelector('header small')?.textContent).toBe(category.title)
    await goBack()
    expect(back).toHaveBeenLastCalledWith(null)
    expect(view.element.querySelector('header h1')?.textContent).toBe('Topics')
    await click(visibleButton('原分类')); await click(visibleButton('同名 Topic原一句说明')); await click(visibleButton('知识')); await click(visibleButton('继续编辑草稿'))
    expect(view.element.querySelector('[aria-label="知识正文"]')).toBe(draft)
    expect(draft.value).toBe('原知识未保存草稿')
    await view.render(renderTopics(false)); const hiddenRegistrations = back.mock.calls.length
    await view.render(renderTopics(false))
    expect(back.mock.calls).toHaveLength(hiddenRegistrations)
    expect(vi.mocked(rpc).mock.calls.some(([method]) => method === 'topic.knowledge.write')).toBe(false)
  })

  it('keeps the currently visible retained Topic reader back handler when another scope becomes hidden', async () => {
    const other = { ...topic, topicId: 'view:other', title: '第二 Topic' }, secondKnowledge = { ...knowledge, topicId: other.topicId, entryId: '22222222-2222-4222-8222-222222222222', title: '第二知识' }
    const rpc = rpcMock(async (method, params) => method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
      : method === 'topic.ls' ? { topics: [topic, other], unavailable: [] }
      : method === 'topic.knowledge.ls' ? { entries: [params.topicId === topic.topicId ? knowledge : secondKnowledge], unavailable: [] }
      : { entry: params.topicId === topic.topicId ? knowledge : secondKnowledge })
    const back = vi.fn(), view = await mount(<MobileTopicsSurface rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={() => null} openSource={vi.fn()} onBackChange={back} />)
    const visibleButton = (text: string) => [...view.element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text && !value.closest('[hidden]'))!
    await click(visibleButton('原分类')); await click(visibleButton('同名 Topic原一句说明')); await click(visibleButton('知识')); await click(visibleButton('原知识事实')); await click(visibleButton('编辑知识'))
    await click(view.element.querySelector<HTMLButtonElement>('[aria-label="返回分类目录"]')!)
    await click(visibleButton('第二 Topic原一句说明')); await click(visibleButton('知识')); await click(visibleButton('第二知识事实')); await click(visibleButton('编辑知识'))
    const firstDraft = view.element.querySelectorAll<HTMLTextAreaElement>('[aria-label="知识正文"]')[0]!
    const secondDraft = view.element.querySelectorAll<HTMLTextAreaElement>('[aria-label="知识正文"]')[1]!
    expect(firstDraft.closest('[hidden]')).not.toBeNull(); expect(secondDraft.closest('[hidden]')).toBeNull()
    await act(async () => back.mock.calls.at(-1)![0]())
    expect(secondDraft.closest('[hidden]')).not.toBeNull()
    expect(view.element.querySelector('header h1')?.textContent).toBe('第二 Topic')
    await act(async () => back.mock.calls.at(-1)![0]())
    expect(view.element.querySelectorAll('.mobile-topic-reading')).toHaveLength(1)
    expect(view.element.querySelector('.mobile-topic-reading')?.closest('[hidden]')).not.toBeNull()
  })

  it('cancels an original knowledge body read when back leaves the visible knowledge layer', async () => {
    let resolve!: (value: unknown) => void
    const rpc = rpcMock(async method => method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
      : method === 'topic.ls' ? { topics: [topic], unavailable: [] }
      : method === 'topic.knowledge.ls' ? { entries: [knowledge], unavailable: [] }
      : await new Promise(done => { resolve = done }))
    const back = vi.fn(), workface = vi.fn(() => null)
    const { element } = await mount(<MobileTopicsSurface rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={workface} openSource={vi.fn()} onBackChange={back} />)
    await click(button(element, '原分类')); await click(button(element, '同名 Topic原一句说明')); await click(button(element, '知识')); await click(button(element, '原知识事实'))
    expect(element.querySelector('.mobile-topic-reading')?.textContent).toContain('原条目正文待重新读取')
    // The selected ID is already a detail reference while its body is pending:
    // first Back leaves that detail, then Back leaves the Knowledge list.
    await act(async () => back.mock.calls.at(-1)![0]())
    expect(element.querySelector('.mobile-topic-reading')).toBeNull()
    expect(workface).toHaveBeenLastCalledWith(topic, false)
    await act(async () => back.mock.calls.at(-1)![0]())
    await act(async () => resolve({ entry: knowledge }))
    expect(workface).toHaveBeenLastCalledWith(topic, true)
    expect(element.querySelector('.mobile-topic-reading')).toBeNull()
    await click(button(element, '知识'))
    expect(element.querySelector('.mobile-topic-reading')).toBeNull()
    expect(vi.mocked(rpc).mock.calls.filter(([method]) => method === 'topic.knowledge.read')).toHaveLength(1)
  })

  it('uses category ID and immediately delegates the exact Topic, Zone and original Tab IDs without choosing a Session', async () => {
    const rpc = rpcMock(async method => method === 'topic.category.ls' ? { categories: [category], unavailable: [] } : { topics: [topic], unavailable: [] })
    const open = vi.fn(), workface = vi.fn(() => <div>原工作面</div>)
    const { element } = await mount(<MobileTopicsSurface rpc={rpc} onOpenTopic={open} renderWorkface={workface} openSource={vi.fn()} />)
    await click(button(element, '原分类'))
    expect(rpc).toHaveBeenCalledWith('topic.ls', { categoryId: category.categoryId })
    await click(button(element, '同名 Topic原一句说明'))
    expect(open).toHaveBeenCalledExactlyOnceWith(topic)
    expect(workface).toHaveBeenCalledWith(topic, true)
    expect(element.querySelector('input[aria-label="查找 Topic 或分类"]')?.closest('[hidden]')).not.toBeNull()
    expect(button(element, '讨论')).toBeDefined(); expect(button(element, '知识')).toBeDefined()
    expect(vi.mocked(rpc).mock.calls.map(value => value[0])).toEqual(['topic.category.ls', 'topic.ls'])
  })
  it('resolves a supplied Topic deep link through inspect without replaying navigation callbacks', async () => {
    const rpc = rpcMock(async method => method === 'topic.inspect' ? { topic, unavailable: [] } : { categories: [category], unavailable: [] })
    const open = vi.fn(), workface = vi.fn(() => <div>原 Zone</div>)
    const view = await mount(<MobileTopicsSurface topicId={topic.topicId} rpc={rpc} onOpenTopic={open} renderWorkface={workface} openSource={vi.fn()} />)
    expect(rpc).toHaveBeenCalledWith('topic.inspect', { topicId: topic.topicId })
    expect(workface).toHaveBeenCalledWith(topic, true); expect(open).not.toHaveBeenCalled()
    await view.render(<MobileTopicsSurface topicId={null} rpc={rpc} onOpenTopic={open} renderWorkface={workface} openSource={vi.fn()} />)
    expect(workface).toHaveBeenLastCalledWith(topic, false)
  })
  it('keeps a Topic knowledge draft across discussion and directory navigation without reading hidden knowledge', async () => {
    const rpc = rpcMock(async method => method === 'topic.category.ls' ? { categories: [category], unavailable: [] }
      : method === 'topic.ls' ? { topics: [topic], unavailable: [] } : { entries: [], unavailable: [] })
    const { element } = await mount(<MobileTopicsSurface rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={() => <div>讨论内容</div>} openSource={vi.fn()} />)
    await click(button(element, '原分类')); await click(button(element, '同名 Topic原一句说明'))
    expect(vi.mocked(rpc).mock.calls.filter(value => value[0] === 'topic.knowledge.ls')).toHaveLength(0)
    await click(button(element, '知识')); await click(button(element, '新建知识'))
    await input(element.querySelector('textarea')!, '原 Topic 草稿')
    await click(button(element, '讨论'))
    await click(element.querySelector<HTMLButtonElement>('[aria-label="返回分类目录"]')!)
    await click(button(element, '同名 Topic原一句说明')); await click(button(element, '知识'))
    expect(element.querySelector('textarea')?.value).toBe('原 Topic 草稿')
    expect(vi.mocked(rpc).mock.calls.filter(value => value[0] === 'topic.knowledge.write')).toHaveLength(0)
  })
  it('does not let a late deep link replace a later explicit Topic choice', async () => {
    let resolve!: (value: unknown) => void
    const other = { ...topic, topicId: 'view:other', title: '后来 Topic' }
    const rpc = rpcMock(async method => method === 'topic.inspect' ? await new Promise(value => { resolve = value })
      : method === 'topic.category.ls' ? { categories: [category], unavailable: [] } : { topics: [other], unavailable: [] })
    const workface = vi.fn(() => null)
    const { element } = await mount(<MobileTopicsSurface topicId={topic.topicId} rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={workface} openSource={vi.fn()} />)
    await click(button(element, '原分类')); await click(button(element, '后来 Topic原一句说明'))
    await act(async () => resolve({ topic, unavailable: [] }))
    expect(workface).toHaveBeenLastCalledWith(other, true)
    expect(element.querySelector('header h1')?.textContent).toBe('后来 Topic')
  })
  it('keeps confirmed directory and usable Topic callbacks after a failed refresh', async () => {
    let failed = false
    const rpc = rpcMock(async method => { if (failed) throw new Error('Host unavailable'); return method === 'topic.category.ls' ? { categories: [category], unavailable: [] } : { topics: [topic], unavailable: [] } })
    const open = vi.fn()
    const { element } = await mount(<MobileTopicsSurface rpc={rpc} onOpenTopic={open} renderWorkface={() => null} openSource={vi.fn()} />)
    await click(button(element, '原分类')); failed = true; await click(button(element, '刷新目录'))
    expect(element.textContent).toContain('Host unavailable')
    await click(button(element, '同名 Topic原一句说明')); expect(open).toHaveBeenCalledWith(topic)
  })
  it('searches All Topics explicitly, reads exact entry content and sends untouched source references', async () => {
    const rpc = rpcMock(async method => method === 'topic.knowledge.search' ? { entries: [knowledge], unavailable: [] } : { entry: knowledge })
    const source = vi.fn()
    const { element } = await mount(<MobileTopicKnowledge rpc={rpc} title="All Topics" openSource={source} />)
    expect(rpc).not.toHaveBeenCalled()
    await input(element.querySelector('input')!, '原知识'); await click(button(element, '搜索'))
    expect(rpc).toHaveBeenCalledWith('topic.knowledge.search', { query: '原知识' })
    await click(button(element, '原知识事实 · view:original'))
    expect(rpc).toHaveBeenCalledWith('topic.knowledge.read', { topicId: topic.topicId, entryId: knowledge.entryId })
    expect(element.querySelector('article h1')?.textContent).toBe('原正文')
    await click(button(element, '原研究')); expect(source).toHaveBeenCalledWith(knowledge.sources[0])
    await click(button(element, '原笔记 / 块')); expect(source).toHaveBeenCalledWith(knowledge.sources[1])
  })
  it('keeps original revision and sources on editing, never infers a newer target', async () => {
    const saved = vi.fn(), rpc = rpcMock(async (_method, params) => {
      const { expectedRevision: _revision, ...payload } = params
      return { entry: { ...knowledge, ...payload, revision: 'sha256:' + '2'.repeat(64) }, diskDurability: 'confirmed' }
    }), client = hosted(rpc)
    const view = await mount(<MobileTopicKnowledgeEditor rpc={rpc} client={client} connected target={{ topicId: topic.topicId, entry: knowledge }} onClose={vi.fn()} onSaved={saved} />)
    await input(view.element.querySelector('textarea')!, '修改后的完整正文')
    await view.render(<MobileTopicKnowledgeEditor rpc={rpc} client={client} connected target={{ topicId: 'view:later' }} onClose={vi.fn()} onSaved={saved} />)
    await click(button(view.element, '保存知识'))
    await waitFor(() => expect(saved).toHaveBeenCalledOnce())
    expect(rpc).toHaveBeenCalledWith('topic.knowledge.write', expect.objectContaining({ topicId: topic.topicId, entryId: knowledge.entryId, expectedRevision: knowledge.revision, sources: knowledge.sources, content: '修改后的完整正文' }))
    expect(saved).toHaveBeenCalledOnce()
  })
  it('retains a failed new draft and checks the same entry before an explicit retry', async () => {
    const checkedRevision = 'sha256:' + '2'.repeat(64)
    const rpc = rpcMock(async (method, params) => { if (method === 'topic.knowledge.write') throw new Error('response lost'); return { entry: { ...knowledge, entryId: params.entryId, revision: checkedRevision } } })
    const { element } = await mount(<MobileTopicKnowledgeEditor rpc={rpc} client={hosted(rpc)} connected target={{ topicId: topic.topicId }} onClose={vi.fn()} onSaved={vi.fn()} />)
    await input(element.querySelector('input')!, '新知识'); await input(element.querySelector('textarea')!, '保留的草稿')
    await click(button(element, '保存知识'))
    await waitFor(() => expect(element.textContent).toContain('保存未确认'))
    const first = vi.mocked(rpc).mock.calls[0]![1] as { entryId: string; expectedRevision: unknown }
    expect(first.expectedRevision).toBeNull(); expect(first.entryId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(element.querySelector('textarea')?.value).toBe('保留的草稿'); expect(button(element, '保存知识').disabled).toBe(true)
    await click(button(element, '检查原保存结果'))
    expect(rpc).toHaveBeenLastCalledWith('topic.knowledge.read', { topicId: topic.topicId, entryId: first.entryId })
    await click(button(element, '以检查结果为基准继续编辑'))
    await waitFor(() => expect(button(element, '保存知识').disabled).toBe(false))
    expect(vi.mocked(rpc).mock.calls.filter(value => value[0] === 'topic.knowledge.write')).toHaveLength(1)
    await click(button(element, '保存知识'))
    await waitFor(() => expect(vi.mocked(rpc).mock.calls.filter(value => value[0] === 'topic.knowledge.write')).toHaveLength(2))
    expect(rpc).toHaveBeenLastCalledWith('topic.knowledge.write', expect.objectContaining({ entryId: first.entryId, expectedRevision: checkedRevision, content: '保留的草稿' }))
  })
  it('ignores a late body read after leaving its scope and never starts an Agent', async () => {
    let resolve!: (value: unknown) => void
    const rpc = rpcMock(async method => method === 'topic.knowledge.ls' ? { entries: [knowledge], unavailable: [] } : await new Promise(value => { resolve = value }))
    const view = await mount(<MobileTopicKnowledge rpc={rpc} topicId={topic.topicId} title="原 Topic" openSource={vi.fn()} />)
    await click(button(view.element, '原知识事实'))
    await view.render(<MobileTopicKnowledge rpc={rpc} topicId="view:later" title="后来 Topic" openSource={vi.fn()} />)
    await act(async () => resolve({ entry: knowledge }))
    expect(view.element.querySelector('article')).toBeNull()
    expect(vi.mocked(rpc).mock.calls.map(value => value[0])).toEqual(['topic.knowledge.ls', 'topic.knowledge.read', 'topic.knowledge.ls'])
  })
  it('moves the exact Topic at its observed spatial revision to the selected category', async () => {
    const rpc = rpcMock(async () => ({ topic, diskDurability: 'confirmed' })), changed = vi.fn()
    const { element } = await mount(<MobileTopicOrganization rpc={rpc} category={category} categories={[category]} topic={topic} onChanged={changed} />)
    await click(button(element, '移动 Topic'))
    expect(element.querySelector('.mobile-topic-organization > .mobile-topics-actions')).toBeNull()
    await act(async () => { const select = element.querySelector('select')!; select.value = category.categoryId; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await click(button(element, '保留草稿并返回'))
    expect(element.querySelector('.mobile-topic-organization > .mobile-topics-actions')).not.toBeNull()
    expect(element.querySelector('select')?.value).toBe(category.categoryId)
    await click(button(element, '继续管理草稿'))
    expect(element.querySelector('.mobile-topic-organization > .mobile-topics-actions')).toBeNull()
    expect(element.querySelector('select')?.value).toBe(category.categoryId)
    await click(button(element, '确认保存'))
    expect(rpc).toHaveBeenCalledExactlyOnceWith('topic.move', { topicId: topic.topicId, categoryId: category.categoryId, expectedRevision: topic.spatialRevision })
    expect(changed).toHaveBeenCalledOnce()
  })
  it('checks an unconfirmed create by its original new Topic ID and allows explicit continuation without inventing another identity', async () => {
    const rpc = rpcMock(async (method, params) => { if (method === 'topic.create') throw new Error('response lost'); return { topic: { ...topic, topicId: params.topicId }, unavailable: [] } })
    const { element } = await mount(<MobileTopicOrganization rpc={rpc} category={category} categories={[category]} topic={null} onChanged={vi.fn()} />)
    await click(button(element, '新建 Topic')); await input(element.querySelector('input')!, '新 Topic'); await click(button(element, '确认保存'))
    const original = vi.mocked(rpc).mock.calls[0]![1] as { topicId: string }
    expect(original.topicId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    await click(button(element, '检查原操作结果'))
    expect(rpc).toHaveBeenLastCalledWith('topic.inspect', { topicId: original.topicId })
    await click(button(element, '以检查结果为基准继续'))
    expect(button(element, '确认保存').disabled).toBe(false)
    expect(vi.mocked(rpc).mock.calls.filter(value => value[0] === 'topic.create')).toHaveLength(1)
  })
})


it('does not clear a failed Topic observation when an unrelated category refresh succeeds', async () => {
  let topicReads = 0
  const rpc = rpcMock(async method => {
    if (method === 'topic.ls' && ++topicReads > 1) return new Promise(() => {})
    if (method === 'topic.ls') throw new Error('Topic owner unavailable')
    return { categories: [category], unavailable: [] }
  })
  const view = await mount(<MobileTopicsSurface rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={() => null} openSource={vi.fn()} />)
  await click(button(view.element, '原分类'))
  expect(view.element.textContent).toContain('Topic owner unavailable')
  await view.render(<MobileTopicsSurface rpc={rpc} visible={false} onOpenTopic={vi.fn()} renderWorkface={() => null} openSource={vi.fn()} />)
  await view.render(<MobileTopicsSurface rpc={rpc} visible onOpenTopic={vi.fn()} renderWorkface={() => null} openSource={vi.fn()} />)
  expect(view.element.textContent).toContain('Topic owner unavailable')
})
