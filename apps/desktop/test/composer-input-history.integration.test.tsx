// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHostedHistoryFixture } from '../../../packages/core/test/helpers/session-history-query'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionHistoryReadPage } from '@agentmux/core'

const dom = composerDOM(), cleanups: (() => Promise<unknown>)[] = []
const sid = 'original-agent'
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const list = () => panel().querySelector<HTMLElement>('.input-history')!
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: import('@tiptap/core').Editor }
const wait = async (check: () => void) => { await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() }) }
const clickText = async (text: string, root: ParentNode = list()) => {
 const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
 expect(button, text).toBeDefined(); await act(async () => button!.click())
}
async function open() {
 const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
 await act(async () => panel().dispatchEvent(event))
 await dom.click('[role="tab"][id$="-outbox-tab"]')
}
async function search(query: string) {
 const input = list().querySelector<HTMLInputElement>('input')!
 const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
 await act(async () => { setter.call(input, query); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
 await act(async () => list().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
beforeEach(() => {
 vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
 Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
 useAppStore.setState({ sessions: [composerSession(sid, 'claude')], timelines: {}, agentComposerHistory: {}, agentComposerHistoryNavigation: {}, agentComposerDrafts: { [sid]: 'unfinished original' } })
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('actual Composer → Unix Hosted SDK → Core Provider reads older native input, fills once with Undo, and leaves original delivery unchanged', async () => {
 const f = await createHostedHistoryFixture('claude', 352); cleanups.push(() => f.dispose())
 vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, context) => f.client.readAgentSessionHistory({ ...input, ...reference }, context))
 const controls = ['send', 'enqueueAgentSteer', 'interrupt', 'respondInteraction'].map(name => vi.spyOn(useAppStore.getState(), name as 'send'))
 const unknown = { operationId: 'unknown-original', runId: 'original-run', text: 'original uncertain body', status: 'deferred' as const, errorCode: 'NO_ACK', logId: 'original-log', inputIntakeStarted: true }
 useAppStore.setState({ agentSteerQueues: { [sid]: [unknown] } })
 await dom.render(<AgentSessionComposer sessionId={sid} />); await open()
 await wait(() => expect(list().querySelectorAll('[data-input-history-id]').length, list().textContent ?? '').toBeGreaterThan(0))
 await wait(() => expect(list().textContent).toContain('原生记录 · 入口未记录'))
 await search('needle')
 await wait(() => expect(list().textContent).toContain('继续查找原生记录'))
 expect(list().textContent).toContain('已读取范围内没有匹配项')
 expect(list().querySelectorAll('[data-input-history-id]')).toHaveLength(0)
 await clickText('继续查找原生记录')
 await wait(() => expect(list().textContent).toContain('needle older than three hundred records'))
 expect(list().textContent).toContain('已查完可用记录')
 await clickText('复制正文'); expect(api.ui.writeClipboardText).toHaveBeenCalledWith('needle older than three hundred records')
 await clickText('填入草稿'); expect(dom.draft(sid)).toBe('needle older than three hundred records')
 await act(async () => { expect(editor().editor.commands.undo()).toBe(true) }); expect(dom.draft(sid)).toBe('unfinished original')
 expect(useAppStore.getState().agentSteerQueues[sid]).toEqual([unknown])
 for (const control of controls) expect(control).not.toHaveBeenCalled()
 await f.noControls()
})

it('arrows consume native records after focused reading and restore the current Agent draft', async () => {
 const f = await createHostedHistoryFixture('pi', 3); cleanups.push(() => f.dispose())
 const read = vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, context) => f.client.readAgentSessionHistory({ ...input, ...reference }, context))
 await dom.render(<AgentSessionComposer sessionId={sid} />)
 await act(async () => editor().focus())
 await wait(() => expect(api.sessions.readHistory).toHaveBeenCalledTimes(2))
 await act(async () => { await Promise.all(read.mock.results.map(result => result.value)); editor().editor.commands.setTextSelection(1) })
 const key = async (name: string) => { await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))) }
 await key('ArrowUp'); expect(dom.draft(sid)).toBe('input 2')
 await key('ArrowDown'); expect(dom.draft(sid)).toBe('unfinished original')
 await f.noControls()
})

it('a foreign receipt is a local reading failure and never disables ordinary Send', async () => {
 vi.spyOn(api.sessions, 'readHistory').mockResolvedValue({ hostId: 'foreign', agentSessionId: 'neighbor', source: 'native', kind: 'user-message', items: [], userMessages: [], scan: { examined: 0, complete: true }, nextCursor: null } as unknown as AgentSessionHistoryReadPage)
 const send = vi.spyOn(useAppStore.getState(), 'send').mockReturnValue(false)
 await dom.render(<AgentSessionComposer sessionId={sid} />); await open()
 await wait(() => expect(list().textContent).toContain('历史结果不属于当前 Agent'))
 expect(dom.draft(sid)).toBe('unfinished original')
 await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })))
 expect(send).toHaveBeenCalledWith(sid, 'unfinished original', expect.any(Function), 'manual')
})
