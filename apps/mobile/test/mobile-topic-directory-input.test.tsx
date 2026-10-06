import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileTopicsSurface } from '../src/topics/MobileTopicsSurface'
import { MobileTopicOrganization } from '../src/topics/MobileTopicOrganization'
import type { TopicsRpc } from '../src/topics/MobileTopicKnowledge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounts: Array<{ root: Root; element: HTMLDivElement }> = []
async function mount(node: ReactNode) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  await act(async () => root.render(node)); return element
}
afterEach(async () => { for (const { root, element } of mounts.splice(0)) { await act(async () => root.unmount()); element.remove() } })
async function fill(field: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function click(element: HTMLElement, text: string) {
  const button = [...element.querySelectorAll('button')].find(value => value.textContent === text)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
const category = { categoryId: 'original-category', title: '工作笔记', hostId: 'host', spaceId: 'original-space', directoryPath: fixturePath("category"), revision: 'original-revision' }

it('filters the original directory locally while retaining the untrimmed query and exact category identity', async () => {
  const rpc = vi.fn(async (method: string) => method === 'topic.category.ls' ? { categories: [category, { ...category, categoryId: 'other', title: '参考资料' }], unavailable: [] } : { topics: [], unavailable: [] }) as unknown as TopicsRpc
  const element = await mount(<MobileTopicsSurface rpc={rpc} onOpenTopic={vi.fn()} renderWorkface={() => null} openSource={vi.fn()} />)
  const field = element.querySelector<HTMLInputElement>('[aria-label="查找 Topic 或分类"]')!
  expect(field.placeholder).toBe('查找 Topic 或分类'); await fill(field, '  工作  ')
  expect(field.value).toBe('  工作  '); expect(element.querySelector('.mobile-topics-list')?.textContent).toBe('工作笔记')
  expect(vi.mocked(rpc).mock.calls).toHaveLength(1)
  await click(element, '工作笔记'); expect(rpc).toHaveBeenLastCalledWith('topic.ls', { categoryId: category.categoryId })
  expect(field.placeholder).toBe('查找 Topic 或分类'); expect(field.value).toBe('  工作  ')
})

it('keeps the exact organization draft and native attrs after an unknown original create without replaying it', async () => {
  const rpc = vi.fn(async (method: string) => { if (method === 'topic.category.create') throw Error('reply lost'); return { categories: [], unavailable: [] } }) as unknown as TopicsRpc
  const element = await mount(<MobileTopicOrganization rpc={rpc} categories={[category]} category={null} topic={null} onChanged={vi.fn()} />)
  await click(element, '新建分类'); const field = element.querySelector<HTMLInputElement>('[aria-label="分类或 Topic 名称"]')!
  expect(field.maxLength).toBe(120); await fill(field, '  新的工作记录  '); await click(element, '确认保存')
  expect(rpc).toHaveBeenCalledWith('topic.category.create', { categoryId: expect.any(String), title: '新的工作记录' })
  expect(field.value).toBe('  新的工作记录  '); expect(element.textContent).toContain('操作未确认')
  await click(element, '保留草稿并返回'); await click(element, '继续管理草稿'); expect(field.value).toBe('  新的工作记录  ')
  await click(element, '检查原操作结果'); expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'topic.category.create')).toHaveLength(1)
})
