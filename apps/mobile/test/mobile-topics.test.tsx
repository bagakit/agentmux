import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileTopicsSurface } from '../src/topics/MobileTopicsSurface'
import { MobileTopicOrganization } from '../src/topics/MobileTopicOrganization'
import { MobileTopicKnowledge, MobileTopicKnowledgeEditor, type TopicsRpc } from '../src/topics/MobileTopicKnowledge'
import type { TopicKnowledge } from '@agentmux/core/control'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounted: { root: Root; element: HTMLDivElement }[] = []
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
const knowledge: TopicKnowledge = { topicId: topic.topicId, entryId: 'entry-original', title: '原知识', content: '# 原正文\n\n完整内容', form: 'reference', certainty: 'fact', revision: 'original-revision', updatedAt: 123,
  sources: [{ kind: 'survey', zoneId: 'other-zone', tabId: 'other-tab', regionId: 'other-region' }, { kind: 'note', noteId: 'note-original', blockId: 'block-original' }] }
function rpcMock(implementation: (method: string, params: any) => Promise<unknown>) { return vi.fn(implementation) as unknown as TopicsRpc }

describe('original Topic mobile consumers', () => {
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
    const saved = vi.fn(), rpc = rpcMock(async (_method, params) => ({ entry: { ...knowledge, ...params }, diskDurability: 'confirmed' }))
    const view = await mount(<MobileTopicKnowledgeEditor rpc={rpc} target={{ topicId: topic.topicId, entry: knowledge }} onClose={vi.fn()} onSaved={saved} />)
    await input(view.element.querySelector('textarea')!, '修改后的完整正文')
    await view.render(<MobileTopicKnowledgeEditor rpc={rpc} target={{ topicId: 'view:later' }} onClose={vi.fn()} onSaved={saved} />)
    await click(button(view.element, '保存知识'))
    expect(rpc).toHaveBeenCalledWith('topic.knowledge.write', expect.objectContaining({ topicId: topic.topicId, entryId: knowledge.entryId, expectedRevision: knowledge.revision, sources: knowledge.sources, content: '修改后的完整正文' }))
    expect(saved).toHaveBeenCalledOnce()
  })
  it('retains a failed new draft and checks the same entry before an explicit retry', async () => {
    const rpc = rpcMock(async (method, params) => { if (method === 'topic.knowledge.write') throw new Error('response lost'); return { entry: { ...knowledge, entryId: params.entryId, revision: 'confirmed-revision' } } })
    const { element } = await mount(<MobileTopicKnowledgeEditor rpc={rpc} target={{ topicId: topic.topicId }} onClose={vi.fn()} onSaved={vi.fn()} />)
    await input(element.querySelector('input')!, '新知识'); await input(element.querySelector('textarea')!, '保留的草稿')
    await click(button(element, '保存知识'))
    const first = vi.mocked(rpc).mock.calls[0]![1] as { entryId: string; expectedRevision: unknown }
    expect(first.expectedRevision).toBeNull(); expect(first.entryId).toMatch(/^[0-9a-f-]{36}$/)
    expect(element.querySelector('textarea')?.value).toBe('保留的草稿'); expect(button(element, '保存知识').disabled).toBe(true)
    await click(button(element, '检查原保存结果'))
    expect(rpc).toHaveBeenLastCalledWith('topic.knowledge.read', { topicId: topic.topicId, entryId: first.entryId })
    await click(button(element, '以检查结果为基准继续编辑'))
    expect(vi.mocked(rpc).mock.calls.filter(value => value[0] === 'topic.knowledge.write')).toHaveLength(1)
    await click(button(element, '保存知识'))
    expect(rpc).toHaveBeenLastCalledWith('topic.knowledge.write', expect.objectContaining({ entryId: first.entryId, expectedRevision: 'confirmed-revision', content: '保留的草稿' }))
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
    expect(original.topicId).toMatch(/^view:[0-9a-f-]{36}$/)
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
