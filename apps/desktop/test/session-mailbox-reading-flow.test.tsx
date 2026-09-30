// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { useAppStore } from '../src/renderer/src/store'
import type { AgentTimelineItem } from '@agentmux/core'

const dom = composerDOM()
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const longText = Array.from({ length: 80 }, (_, i) => `Original line ${i + 1}: retained exact words`).join('\n')
const item = (id: string, content: string, createdAt = 1): AgentTimelineItem => ({ id, agentSessionId: 'agent-1', kind: 'user_message', source: 'user', status: 'complete', title: 'Message', content, createdAt, authorAgentSessionId: 'peer', updatedAt: createdAt })
beforeEach(() => useAppStore.setState({ sessions: [composerSession()], noticeReadReceipts: {} }))
async function open() { const e = new Event('toggle'); Object.defineProperty(e, 'newState', { value: 'open' }); await act(async () => panel().dispatchEvent(e)) }
async function choose(folder: string) { await dom.click(`[role="tab"][id$="-${folder}-tab"]`) }
async function read(key: string) {
  const rows = [...panel().querySelectorAll<HTMLButtonElement>('button[data-record-key]')]
  expect(rows.length).toBeGreaterThan(0)
  const row = rows.find(row => row.dataset.recordKey === key); expect(row).toBeDefined()
  await act(async () => { row!.focus(); row!.click() })
}
async function back() { await dom.click('.composer-mailbox__back button') }
const render = (items: AgentTimelineItem[] = [item('one', longText), item('two', 'Second exact message')]) => dom.render(<SessionMailbox system={system} queued={[]}
  timeline={{ agentSessionId: 'agent-1', revision: 1, items }} />)

it('mounts only bounded current-page prefixes, then one complete selectable original record, and returns focus and scroll', async () => {
  await render(); expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(0)
  await open(); const content = panel().querySelector<HTMLElement>('.composer-mailbox__content')!
  expect([...panel().querySelectorAll('.composer-mailbox__preview')].map(row => row.textContent)).toEqual([longText.slice(0,240),'Second exact message'])
  expect(panel().textContent).not.toContain('Original line 80:')
  content.scrollTop = 37; await read('timeline:one')
  expect(panel().querySelector('.composer-mailbox__full-text')!.textContent).toBe(longText)
  expect(panel().querySelectorAll('.composer-mailbox__full-text')).toHaveLength(1)
  expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(0)
  expect(document.activeElement).toBe(panel().querySelector('.composer-mailbox__back button'))
  const button = panel().querySelector<HTMLButtonElement>('.composer-mailbox__back button')!;button.focus();await back()
  expect(content.scrollTop).toBe(37)
  expect((document.activeElement as HTMLElement).dataset.recordKey).toBe('timeline:one')
  content.scrollTop=37;await choose('system');expect(content.scrollTop).toBe(0)
  expect(panel().textContent).not.toContain(longText.slice(0,60))
})

it('keeps real pending order, sends only the first deliverable ID and copies the exact selected object', async () => {
  const send = vi.fn(),copy = vi.fn(),remove = vi.fn()
  await dom.render(<SessionMailbox system={system} queued={[
    {id:'old',text:'Old Run exact words',status:'queued',deliverable:false,enqueuedAt:900},
    {id:'next',text:longText,status:'deferred',deliverable:true,enqueuedAt:100},
    {id:'later',text:'Later original text',status:'queued',deliverable:true,enqueuedAt:1}
  ]} onSendQueued={send} onCopyQueued={copy} onRemoveQueued={remove} />)
  await open();await choose('outbox')
  expect([...panel().querySelectorAll('.composer-outbox [data-record-key]')].map(row => (row as HTMLElement).dataset.recordKey)).toEqual(['queue:old','queue:next','queue:later'])
  await read('queue:later');expect(panel().textContent).not.toContain('Send queued message')
  await dom.click('.composer-outbox__actions button');expect(copy).toHaveBeenCalledExactlyOnceWith('Later original text')
  await back();await read('queue:next')
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Send queued message')!;await act(async()=>button.click())
  expect(send).toHaveBeenCalledExactlyOnceWith('next');expect(remove).not.toHaveBeenCalled()
  expect(panel().querySelector('.composer-mailbox__full-text')!.textContent).toBe(longText)
})

it('does not retain a different System occurrence and keeps a time-only update in the same detail', async () => {
  const action=vi.fn();let notice={id:'connection',cause:'one',observedAt:1,notice:{kind:'indeterminate' as const,notice:{step:'Original problem',mode:longText,restore:'Original recovery'}},action:{label:'Retry original',run:action}}
  const show=()=>dom.render(<SessionMailbox system={{available:true,notices:[notice],unread:[],acknowledge:vi.fn()}} queued={[]} />)
  await show();await open();await choose('system')
  const row=panel().querySelector<HTMLButtonElement>('[data-record-key]')!;await act(async()=>{row.focus();row.click()})
  expect(panel().querySelector('.service-window__mode')!.textContent).toBe(longText)
  notice={...notice,observedAt:2};await show();expect(panel().querySelector('.service-window__mode')!.textContent).toBe(longText)
  notice={...notice,cause:'two',notice:{...notice.notice,notice:{...notice.notice.notice,step:'New problem'}}};await show()
  expect(panel().querySelector('.composer-mailbox__back')).toBeNull();expect(panel().textContent).toContain('New problem')
  expect(action).not.toHaveBeenCalled();expect(panel().querySelector('.service-window__mode')).toBeNull()
})

it('clears detail, old row focus and saved scrolling when the same record ID belongs to a new Run', async () => {
  let control = composerSession().control
  const show = (text: string) => dom.render(<SessionMailbox control={control} system={system} queued={[]}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items: [item('same-id',text)] }} />)
  await show(longText);await open()
  const content = panel().querySelector<HTMLElement>('.composer-mailbox__content')!;content.scrollTop=45
  await read('timeline:same-id');expect(panel().querySelector('.composer-mailbox__full-text')!.textContent).toBe(longText)
  control={...control,run:{runId:'a-new-run'}};await show('New Run message with the same legal source ID.')
  expect(panel().querySelector('.composer-mailbox__full-text')).toBeNull();expect(content.scrollTop).toBe(0)
  expect(document.activeElement).toBe(panel().querySelector('[id$="-inbox-tab"]'))
  await read('timeline:same-id');const button=panel().querySelector<HTMLButtonElement>('.composer-mailbox__back button')!
  await act(async()=>button.focus());await back();expect(content.scrollTop).toBe(0)
  expect(panel().textContent).toContain('New Run message with the same legal source ID.')
})

it('keeps unknown author and time honest, uses only explicit human origin and never merges equal bodies', async () => {
  const outgoing=[{...item('unknown','Same original text',40),authorAgentSessionId:undefined},
    {...item('human','Same original text',30),authorAgentSessionId:undefined,authorHuman:true},
    {...item('timeless','An original record with no timestamp'),createdAt:undefined,authorAgentSessionId:undefined}]
  await render(outgoing);await open();await choose('outbox')
  const rows=[...panel().querySelectorAll<HTMLButtonElement>('.composer-mailbox__history .composer-mailbox__row')]
  expect(rows.map(row=>row.dataset.recordKey)).toEqual(['timeline:unknown','timeline:human','timeline:timeless'])
  expect(rows[0]!.textContent).toContain('Author unknown');expect(rows[0]!.textContent).not.toContain('Human')
  expect(rows[1]!.textContent).toContain('Human');expect(rows[2]!.textContent).toContain('Time not recorded')
  await read('timeline:timeless');expect(panel().querySelector('.composer-mailbox__full-text')!.textContent).toBe(outgoing[2]!.content)
  expect(panel().textContent).toContain('Time not recorded')
})

it('keeps any sending request from competing Send and preserves exact remove/move identities', async () => {
  const send=vi.fn(),remove=vi.fn(),move=vi.fn();const queued=[
    {id:'first',text:'Current in-flight words',status:'queued' as const,deliverable:true,sending:true},
    {id:'second',text:'Exact second retained words',status:'deferred' as const,deliverable:true},
    {id:'third',text:'Exact third retained words',status:'queued' as const,deliverable:true}]
  await dom.render(<SessionMailbox system={system} queued={queued} onSendQueued={send} onRemoveQueued={remove} onMoveQueued={move} />)
  await open();await choose('outbox');const buttons=()=>[...panel().querySelectorAll<HTMLButtonElement>('.composer-outbox button')]
  expect(buttons().find(b=>b.textContent==='Send queued message')!.disabled).toBe(true)
  await read('queue:first');expect(buttons().find(b=>b.textContent==='Remove')!.disabled).toBe(true)
  expect(buttons().find(b=>b.textContent==='Send queued message')!.disabled).toBe(true)
  await back();await read('queue:second');expect(buttons().find(b=>b.textContent==='Move up')!.disabled).toBe(true)
  const down=buttons().find(b=>b.textContent==='Move down')!;await act(async()=>down.click());expect(move).toHaveBeenCalledExactlyOnceWith('second','down')
  const deleting=buttons().find(b=>b.textContent==='Remove')!;await act(async()=>deleting.click());expect(remove).toHaveBeenCalledExactlyOnceWith('second');expect(send).not.toHaveBeenCalled()
})

it('makes the original recovery and actual action label independently scannable before opening System detail', async () => {
  const action=vi.fn(),restore='Reconnect using the original recovery action.'
  await dom.render(<SessionMailbox system={{available:true,notices:[{id:'delivery',cause:'original',notice:{kind:'indeterminate',notice:{step:'Input delivery unknown',mode:longText,restore}},action:{label:'Retry exact delivery',run:action}}],unread:[],acknowledge:vi.fn()}} queued={[]} />)
  await open();await choose('system');const row=panel().querySelector<HTMLButtonElement>('.composer-mailbox__row')!
  expect(row.querySelector('.composer-mailbox__preview')!.textContent).toBe(longText.slice(0,240))
  expect(row.querySelector('.composer-mailbox__notice-restore')!.textContent).toBe(restore)
  expect(row.textContent).toContain('Action: Retry exact delivery');expect(row.querySelector('button')).toBeNull()
  expect(action).not.toHaveBeenCalled();await act(async()=>row.click())
  expect(panel().querySelector('.service-window__mode')!.textContent).toBe(longText)
  await dom.click('.composer-notice__body button');expect(action).toHaveBeenCalledOnce()
})

it('bounds the open native surface again when the original editor and Region resize', async () => {
  let top=220,width=320
  const original=HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){
    if(this.classList.contains('composer')||this.hasAttribute('data-workbench-region-id'))return new DOMRect(0,top,width,200)
    return original.call(this)
  })
  await dom.render(<section data-workbench-region-id="original-region"><div className="composer"><SessionMailbox system={system} queued={[]}
    timeline={{agentSessionId:'agent-1',revision:1,items:[item('geometry',longText)]}} /></div></section>)
  await open();expect(panel().style.maxWidth).toBe('308px');expect(panel().style.maxHeight).toBe('208px')
  top=150;width=280;await act(async()=>window.dispatchEvent(new Event('resize')))
  expect(panel().style.maxWidth).toBe('268px');expect(panel().style.maxHeight).toBe('138px')
  expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(1)
})
