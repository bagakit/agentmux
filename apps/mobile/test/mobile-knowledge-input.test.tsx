import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileTopicKnowledge, MobileTopicKnowledgeEditor, type TopicsRpc } from '../src/topics/MobileTopicKnowledge'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear()
  await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), hostUrl: 'http://192.168.2.45:8443', host: { origin: 'http://192.168.2.45:8443', hostId: 'original-input-device' } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const setDom = (n: HTMLTextAreaElement | HTMLInputElement, v: string) => Object.getOwnPropertyDescriptor(n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(n, v)

it('keeps composition in the original Knowledge edit when a later target prop arrives', async () => {
  const saved = vi.fn(), rpc = vi.fn(async (_method, params) => {
    const { expectedRevision: _revision, ...payload } = params
    return { entry: { ...payload, revision: 'sha256:' + '1'.repeat(64), updatedAt: 123 }, diskDurability: 'confirmed' }
  }) as unknown as TopicsRpc
  const client = { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: 'original-input-runtime', ownerInstanceId: 'original-input-process', availability: 'connected' }) } as unknown as AgentMuxHostedClient
  const render = async (topicId: string) => { await act(async () => root.render(<MobileTopicKnowledgeEditor rpc={rpc} client={client} connected target={{ topicId }} onClose={() => {}} onSaved={saved} />)) }
  await render('view:original')
  const body = host.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await act(async () => { body.focus(); setDom(body, '原组字候选'); body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await render('view:later')
  expect(body.value).toBe('原组字候选')
  expect(document.activeElement).toBe(body)
  await act(async () => { setDom(body, '原正文\n准确完整文本'); body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); const title = host.querySelector<HTMLInputElement>('[aria-label="知识标题"]')!; setDom(title, '原知识'); title.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(async () => { await act(async () => {}); expect(saved).toHaveBeenCalledOnce() }, { timeout: 10000 })
  expect(rpc).toHaveBeenCalledExactlyOnceWith('topic.knowledge.write', expect.objectContaining({ topicId: 'view:original', content: '原正文\n准确完整文本', title: '原知识', expectedRevision: null }))
  expect(saved).toHaveBeenCalledOnce()
})

it('forwards the search field through the original explicit search RPC without write or implicit submission', async () => {
  const rpc = vi.fn(async () => ({ entries: [], unavailable: [] })) as unknown as TopicsRpc
  await act(async () => root.render(<MobileTopicKnowledge rpc={rpc} title="All Topics" openSource={() => {}} />))
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索知识"]')!
  expect(input.type).toBe('text'); expect(input.placeholder).toBe('搜索 All Topics')
  await act(async () => { setDom(input, '  保留原文  '); input.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(rpc).not.toHaveBeenCalled()
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(rpc).toHaveBeenCalledExactlyOnceWith('topic.knowledge.search', { query: '保留原文' })
  expect(input.value).toBe('  保留原文  ')
})
import './mobile-lan-crypto.setup'
