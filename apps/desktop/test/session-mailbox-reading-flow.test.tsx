const { fixtureIso: _hygiene_fixtureIso, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { MailboxRecordRow } from '../src/renderer/src/components/MailboxReading'
import * as messageGrammar from '@agentmux/core/agent-message-render'
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
  expect(panel().querySelector('.log-turn__body')!.textContent).toBe(longText)
  expect(panel().querySelectorAll('.log-turn__body')).toHaveLength(1)
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
  await read('queue:later');expect(panel().querySelector('[aria-label="Send queued message"]')).toBeNull()
  await dom.click('.log-turn__action');expect(copy).toHaveBeenCalledExactlyOnceWith('Later original text')
  await back();await read('queue:next')
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b=>b.getAttribute('aria-label')==='Send queued message')!;await act(async()=>button.click())
  expect(send).toHaveBeenCalledExactlyOnceWith('next');expect(remove).not.toHaveBeenCalled()
  expect(panel().querySelector('.log-turn__body')!.textContent).toBe(longText)
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
  await read('timeline:same-id');expect(panel().querySelector('.log-turn__body')!.textContent).toBe(longText)
  control={...control,run:{runId:'a-new-run'}};await show('New Run message with the same legal source ID.')
  expect(panel().querySelector('.log-turn__body')).toBeNull();expect(content.scrollTop).toBe(0)
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
  expect(rows[1]!.textContent).toContain('Human');expect(rows[2]!.querySelector('time')).toBeNull()
  await read('timeline:timeless');expect(panel().querySelector('.log-turn__body')!.textContent).toBe(outgoing[2]!.content)
  await dom.click('[aria-label="Message details"]');expect(panel().textContent).toContain('Time not recorded')
})

it('keeps any sending request from competing Send and preserves exact remove/move identities', async () => {
  const send=vi.fn(),remove=vi.fn(),move=vi.fn();const queued=[
    {id:'first',text:'Current in-flight words',status:'queued' as const,deliverable:true,sending:true},
    {id:'second',text:'Exact second retained words',status:'deferred' as const,deliverable:true},
    {id:'third',text:'Exact third retained words',status:'queued' as const,deliverable:true}]
  await dom.render(<SessionMailbox system={system} queued={queued} onSendQueued={send} onRemoveQueued={remove} onMoveQueued={move} />)
  await open();await choose('outbox');const buttons=()=>[...panel().querySelectorAll<HTMLButtonElement>('.composer-outbox button')]
  expect(buttons().find(b=>b.getAttribute('aria-label')==='Send queued message')!.disabled).toBe(true)
  await read('queue:first');expect(buttons().find(b=>b.getAttribute('aria-label')==='Remove')!.disabled).toBe(true)
  expect(buttons().find(b=>b.getAttribute('aria-label')==='Send queued message')!.disabled).toBe(true)
  await back();await read('queue:second');expect(buttons().find(b=>b.getAttribute('aria-label')==='Move up')!.disabled).toBe(true)
  const down=buttons().find(b=>b.getAttribute('aria-label')==='Move down')!;await act(async()=>down.click());expect(move).toHaveBeenCalledExactlyOnceWith('second','down')
  const deleting=buttons().find(b=>b.getAttribute('aria-label')==='Remove')!;await act(async()=>deleting.click());expect(remove).toHaveBeenCalledExactlyOnceWith('second');expect(send).not.toHaveBeenCalled()
})

it('keeps Notices concise and reveals the original full recovery and exact action in its own detail', async () => {
  const action=vi.fn(),restore='Reconnect using the original recovery action.'
  await dom.render(<SessionMailbox system={{available:true,notices:[{id:'delivery',cause:'original',notice:{kind:'indeterminate',notice:{step:'Input delivery unknown',mode:longText,restore}},action:{label:'Retry exact delivery',run:action}}],unread:[],acknowledge:vi.fn()}} queued={[]} />)
  await open();await choose('system');const row=panel().querySelector<HTMLButtonElement>('.composer-mailbox__row')!
  expect(row.querySelector('.composer-mailbox__preview')!.textContent).toBe(longText.slice(0,240))
  expect(row.textContent).toContain('Input delivery unknown');expect(row.querySelector('button')).toBeNull()
  expect(action).not.toHaveBeenCalled();await act(async()=>row.click())
  expect(panel().querySelector('.service-window__mode')!.textContent).toBe(longText)
  expect(panel().querySelector('.service-window__restore')!.textContent).toBe(restore)
  expect(panel().textContent).toContain('Retry exact delivery')
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

it('renders Inbox, native/captured History and Pending with the actual shared compact message and honest record identity', async () => {
  const copy=vi.fn(async()=>true), unconfirmed={...item('unconfirmed','Original **unconfirmed** record'),authorAgentSessionId:undefined,status:'failed' as const}
  await dom.render(<SessionMailbox system={system} queued={[{id:'pending',text:'Pending **original** words',status:'deferred',deliverable:true}]}
    userMessages={[{id:'native',rawId:'raw-native',agentSessionId:'agent-1',content:'Native **original** words',contentParts:[{kind:'text',text:'Native **original** words'}],recordedAt:1,deliveryStatus:'unverified',author:{kind:'unknown'},source:{kind:'native',providerId:'codex',nativeSessionId:'native-session',recordId:'raw-native'}}]}
    timeline={{agentSessionId:'agent-1',revision:1,items:[item('incoming','Inbox **original** words'),unconfirmed]}} onCopyQueued={copy} />)
  await open();await choose('inbox');await read('timeline:incoming')
  expect(panel().querySelectorAll('.log-turn[data-compact]')).toHaveLength(1)
  expect(panel().querySelector('.log-turn strong')!.textContent).toBe('original')
  await back();await choose('outbox');await read('timeline:unconfirmed')
  expect(panel().querySelector('.log-turn')!.getAttribute('data-speaker-role')).toBe('unknown')
  expect(panel().querySelector('.log-turn__who')!.textContent).toBe('Author unknown')
  expect(panel().querySelector('.log-turn')!.getAttribute('data-status')).toBeNull()
  expect(panel().textContent).toContain('Delivery not confirmed')
  await dom.click('[aria-label="Message details"]');expect(panel().textContent).toContain('Captured input')
  await back();await read('native:native');await dom.click('[aria-label="Message details"]')
  expect(panel().textContent).toContain('Recorded · not a delivery receipt');expect(panel().textContent).toContain('raw-native')
  await back();await read('queue:pending')
  expect(panel().querySelectorAll('.log-turn[data-compact]')).toHaveLength(1)
  expect(panel().querySelector('.log-turn')!.getAttribute('data-status')).toBeNull()
  await dom.click('.log-turn__action');expect(copy).toHaveBeenCalledExactlyOnceWith('Pending **original** words')
  expect(panel().querySelector('.log-turn__actions')!.getAttribute('data-copy-state')).toBe('copied')
})

it('keeps the original target file/link/image reading capabilities in the shared body, rather than active Workspace', async () => {
  const file=vi.fn(),http=vi.fn(),image=vi.fn(async()=>({dataUrl:'data:image/png;base64,AA==',mimeType:'image/png'}))
  const original='Review [the file](src/owned.ts:7) and [the source](https://example.test/record).'
  await dom.render(<SessionMailbox system={system} queued={[]} timeline={{agentSessionId:'agent-1',revision:1,items:[item('context',original)]}}
    reading={{workspaceRoot:_hygiene_fixturePath("original/repo"),homeDir:_hygiene_fixturePath("original/home"),openWorkspaceFile:file,openHttpLink:http,readPastedImage:image}} />)
  await open();await read('timeline:context')
  const link=panel().querySelector<HTMLButtonElement>('.md-link--file')!;expect(link).not.toBeNull()
  await act(async()=>link.click());expect(file).toHaveBeenCalledExactlyOnceWith('src/owned.ts',{line:7})
  const web=panel().querySelector<HTMLButtonElement>('.md-link:not(.md-link--file)')!;expect(web).not.toBeNull()
  await act(async()=>web.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true,clientX:11,clientY:12})))
  expect(http).toHaveBeenCalledExactlyOnceWith('https://example.test/record',{metaKey:false,ctrlKey:true,clientX:11,clientY:12})
  expect(image).not.toHaveBeenCalled()
})

it('navigation action counts never combine the loaded History window with Pending', async()=>{
  await dom.render(<SessionMailbox system={system} queued={[{id:'one',text:'one',status:'queued',deliverable:true}]}
    timeline={{agentSessionId:'agent-1',revision:1,items:[{...item('sent','history'),authorAgentSessionId:undefined}]}} />)
  await open();await choose('outbox')
  const tab=panel().querySelector<HTMLButtonElement>('[id$="-outbox-tab"]')!
  expect(tab.getAttribute('aria-label')).toBe('Outbox: 1 pending');expect(tab.querySelector('.composer-mailbox__count')!.textContent).toBe('1')
  expect(panel().querySelector('[id$="-system-tab"] .composer-mailbox__count')).toBeNull()
  expect(panel().textContent).not.toContain('Read full message')
  expect(panel().textContent).not.toContain('Captured input')
})


it('reads native structured resources and pasted images through the shared body while Copy preserves the exact recorded string', async()=>{
  const raw=("Recorded **text** before the attachment.\n@" + _hygiene_fixturePath("original/home/.agentmux/pasted/12345678-1234-1234-1234-123456789abc.png")), copy=vi.fn(async()=>true), image=vi.fn(async()=>({path:_hygiene_fixturePath("original/image"),dataUrl:'data:image/png;base64,AA==',mimeType:'image/png'}))
  const native={id:'parts',rawId:'parts-raw',agentSessionId:'agent-1',content:raw,contentParts:[{kind:'text' as const,text:raw},{kind:'resource' as const,resourceType:'image' as const,reference:'original-native-image-reference',label:'Original attachment'}],deliveryStatus:'unverified' as const,author:{kind:'unknown' as const},source:{kind:'native' as const,providerId:'claude' as const,nativeSessionId:'parts-session',recordId:'parts-raw'}}
  await dom.render(<SessionMailbox system={system} queued={[]} userMessages={[native]} timeline={{agentSessionId:'agent-1',revision:0,items:[]}} onCopyQueued={copy} reading={{homeDir:_hygiene_fixturePath("original/home"),readPastedImage:image}} />)
  await open();await choose('outbox');await read('native:parts')
  expect(panel().querySelectorAll('.log-turn[data-compact]')).toHaveLength(1)
  expect(panel().querySelectorAll('.log-turn__resource')).toHaveLength(1)
  expect(panel().textContent).toContain('Original attachment');expect(panel().textContent).toContain('original-native-image-reference')
  expect(image).toHaveBeenCalledExactlyOnceWith(_hygiene_fixturePath("original/home/.agentmux/pasted/12345678-1234-1234-1234-123456789abc.png"))
  expect(panel().querySelector('.md-conversation-image img')).not.toBeNull()
  await dom.click('.log-turn__action');expect(copy).toHaveBeenCalledExactlyOnceWith(raw)
  expect(panel().querySelector('.log-turn__actions')!.getAttribute('data-copy-state')).toBe('copied')
  await back();await dom.render(<SessionMailbox system={system} queued={[]} userMessages={[{...native,content:'',contentParts:[native.contentParts[1]!]}]} timeline={{agentSessionId:'agent-1',revision:0,items:[]}} onCopyQueued={copy} />)
  await read('native:parts');expect(panel().querySelector('.log-turn__resource')).not.toBeNull()
  expect(panel().querySelector('.log-turn__action')).toBeNull();expect(panel().textContent).not.toContain('No text recorded')
})


it('places actual Pending risks before a long body, keeps ordinary queue meaning in Info and uses neutral working facts', async () => {
  const pending = {id:'risk',text:longText,status:'deferred' as const,deliverable:true}
  const show = (overrides = {}) => dom.render(<SessionMailbox system={system} queued={[{...pending,...overrides}]} />)
  await show();await open();await choose('outbox');await read('queue:risk')
  expect(panel().querySelector('.composer-mailbox__risk')).toBeNull()
  await dom.click('[aria-label="Message details"]')
  expect(panel().textContent).toContain('Not delivered yet — still queued.')
  const recordedReason = 'Confirmation was not observed\nOriginal diagnostic remains intact.'
  await show({error:recordedReason})
  const risk = panel().querySelector<HTMLElement>('.composer-mailbox__risk')!, body = panel().querySelector('.log-turn__body')!
  expect(risk).not.toBeNull()
  expect(risk.textContent).toContain('Delivery needs attention')
  expect(risk.dataset.kind).toBe('attention')
  expect(risk.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(panel().querySelector('.composer-mailbox__record-facts')!.textContent).toContain(recordedReason)
  await show({deliverable:false})
  expect(panel().querySelector('.composer-mailbox__risk')!.textContent).toContain('Bound Run unavailable. Delivery is unknown.')
  expect(panel().textContent).toContain('it will not be replayed on another Run')
  expect(panel().querySelector('[aria-label="Send queued message"]')).toBeNull()
  await show({sending:true,status:'restoring'})
  expect(panel().querySelector<HTMLElement>('.composer-mailbox__risk')!.dataset.kind).toBe('working')
  expect(panel().querySelector('.composer-mailbox__risk')!.textContent).toContain('has not been dispatched')
})

it('shows the original body of a complete short packet in the list and keeps the full authored header in shared Copy', async () => {
  const body = 'Check **the handoff** before editing the original file.'
  const wire = (("[Message from Agent reviewer]\n<bagakit-msg type=\"agent-v1\" name=\"Review team\" time=\"" + _hygiene_fixtureIso(23817600000, "zone-second", 480) + "\">") + (body) + "</bagakit-msg>")
  const copy = vi.fn(async () => true)
  await dom.render(<SessionMailbox system={system} queued={[]} timeline={{agentSessionId:'agent-1',revision:1,items:[item('packet',wire)]}} onCopyQueued={copy} />)
  await open()
  expect(panel().querySelector('.composer-mailbox__preview')!.textContent).toBe(body)
  expect(panel().querySelector('.composer-mailbox__row')!.getAttribute('aria-label')).toContain(body)
  expect(panel().querySelectorAll('.log-turn')).toHaveLength(0)
  await read('timeline:packet')
  expect(panel().querySelector('.log-turn__body strong')!.textContent).toBe('the handoff')
  expect(panel().querySelector('.log-turn__declared-source')!.textContent).toBe('Message header: Agent reviewer')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire)
})

it('reads exactly one bounded snippet per row and preserves the original prefix when a long packet cannot be interpreted within it', async () => {
  const long = (("[Message from Agent reviewer]\n<bagakit-msg type=\"agent-v1\" name=\"Review team\" time=\"" + _hygiene_fixtureIso(23817600000, "zone-second", 480) + "\">") + (longText) + "</bagakit-msg>")
  const incomplete = '[Message from Agent reviewer]\n<bagakit-msg type="agent-v1"'
  const plain = longText
  const parser = vi.spyOn(messageGrammar, 'parseAgentMuxMessagePrefix')
  await dom.render(<>{[long,incomplete,plain].map((text,index) => <MailboxRecordRow key={index} recordKey={`bounded:${index}`} label="Original author" text={text} metadata={null} onOpen={vi.fn()} />)}</>)
  expect(parser.mock.calls.map(call => call[0])).toEqual([long.slice(0,240),incomplete,plain.slice(0,240)])
  expect([...dom.container.querySelectorAll('.composer-mailbox__preview')].map(row => row.textContent)).toEqual([long.slice(0,240),incomplete,plain.slice(0,240)])
})
