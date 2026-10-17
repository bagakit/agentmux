import { fixtureEpoch as _tailFixtureEpoch, fixtureIso as _tailFixtureIso } from "../../../test/fixture-values.mjs"
const { fixtureIso: _hygiene_fixtureIso, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { journalMessage, mailboxJournal } from './helpers/mailbox-journal-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { MailboxRecordRow } from '../src/renderer/src/components/MailboxReading'
import * as messageGrammar from '@agentmux/core/agent-message-render'
import { useAppStore } from '../src/renderer/src/store'
import type { AgentTimelineItem } from '@agentmux/core'

const dom = composerDOM()
let journal: ReturnType<typeof mailboxJournal>
beforeEach(() => { journal = mailboxJournal() })
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const longText = Array.from({ length: 80 }, (_, i) => `Original line ${i + 1}: retained exact words`).join('\n')
const item = (id: string, content: string, createdAt = _tailFixtureEpoch(0, 0, 1)): AgentTimelineItem => ({ id, agentSessionId: 'agent-1', kind: 'user_message', source: 'user', status: 'complete', title: 'Message', content, createdAt, updatedAt: createdAt })
function outgoingItem(id:string,text:string,createdAt=_tailFixtureEpoch(0, 0, 1)):AgentTimelineItem { return item(id,text,createdAt) }
beforeEach(() => useAppStore.setState({ sessions: [composerSession()], noticeReadReceipts: {} }))
async function open() { const e = new Event('toggle'); Object.defineProperty(e, 'newState', { value: 'open' }); await act(async () => panel().dispatchEvent(e)) }
async function choose(folder: string) {
  if (['inbox', 'outbox', 'collaboration'].includes(folder)) await dom.click('[id$="-agents-tab"]')
  await dom.click(`[role="tab"][id$="-${folder}-tab"]`)
}
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

it('keeps real pending order and exact inline actions without switching away from adjacent records', async () => {
  const send = vi.fn(),copy = vi.fn(),remove = vi.fn(async () => {})
  await dom.render(<SessionMailbox system={system} queued={[
    {id:'old',text:'Old Run exact words',status:'queued',deliverable:false,enqueuedAt:_tailFixtureEpoch(0, 0, 900)},
    {id:'next',text:longText,status:'deferred',deliverable:true,enqueuedAt:_tailFixtureEpoch(0, 0, 100)},
    {id:'later',text:'Later original text',status:'queued',deliverable:true,enqueuedAt:_tailFixtureEpoch(0, 0, 1)}
  ]} onSendQueued={send} onCopyQueued={copy} onArchiveQueued={remove} />)
  await open();await choose('user')
  expect([...panel().querySelectorAll('.composer-outbox [data-record-key]')].map(row => (row as HTMLElement).dataset.recordKey)).toEqual(['queue:old','queue:next','queue:later'])
  await read('queue:later');expect(panel().querySelector('.composer-mailbox__back')).toBeNull();expect(panel().querySelectorAll('.composer-outbox .composer-mailbox__row')).toHaveLength(3)
  await dom.click('.log-turn__action');expect(copy).toHaveBeenCalledExactlyOnceWith('Later original text')
  await read('queue:next')
  const button = panel().querySelector<HTMLButtonElement>('li[data-operation-id="next"] [aria-label="Send queued message"]')!;await act(async()=>button.click())
  expect(send).toHaveBeenCalledExactlyOnceWith('next');expect(remove).not.toHaveBeenCalled()
  expect(panel().querySelector('.log-turn__body')!.textContent).toBe(longText)
})

it('does not retain a different System occurrence and keeps a time-only update in the same detail', async () => {
  const action=vi.fn();let notice={id:'connection',cause:'one',observedAt:_tailFixtureEpoch(0, 0, 1),notice:{kind:'indeterminate' as const,notice:{step:'Original problem',mode:longText,restore:'Original recovery'}},action:{label:'Retry original',run:action}}
  const show=()=>dom.render(<SessionMailbox system={{available:true,notices:[notice],unread:[],acknowledge:vi.fn()}} queued={[]} />)
  await show();await open();await choose('system')
  const row=panel().querySelector<HTMLButtonElement>('[data-record-key]')!;await act(async()=>{row.focus();row.click()})
  expect(panel().querySelector('.service-window__mode')!.textContent).toBe(longText)
  notice={...notice,observedAt:_tailFixtureEpoch(0, 0, 2)};await show();expect(panel().querySelector('.service-window__mode')!.textContent).toBe(longText)
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
  expect(document.activeElement).toBe(panel().querySelector('[id$="-user-tab"]'))
  await read('timeline:same-id');const button=panel().querySelector<HTMLButtonElement>('.composer-mailbox__back button')!
  await act(async()=>button.focus());await back();expect(content.scrollTop).toBe(0)
  expect(panel().textContent).toContain('New Run message with the same legal source ID.')
})

it('keeps unknown author and time honest, uses only explicit human origin and never merges equal bodies', async () => {
  const outgoing=[outgoingItem('unknown','Same original text',_tailFixtureEpoch(0, 0, 40)),
    {...outgoingItem('human','Same original text',_tailFixtureEpoch(0, 0, 30)),authorHuman:true}]
  await dom.render(<SessionMailbox system={system} queued={[]} timeline={{agentSessionId:'agent-1',revision:1,items:outgoing}} userMessages={[{id:'captured:timeless',rawId:'timeless',agentSessionId:'agent-1',content:'An original record with no timestamp',contentParts:[],author:{kind:'unknown'},deliveryStatus:'complete',source:{kind:'captured',submissionId:'timeless'}}]} />);await open();await choose('user')
  const rows=[...panel().querySelectorAll<HTMLButtonElement>('[role="tabpanel"][id$="-user"] .composer-mailbox__row')]
  expect(rows.map(row=>row.dataset.recordKey)).toEqual(['timeline:unknown','timeline:human','timeline:timeless'])
  expect(rows[0]!.textContent).toContain('Author unknown');expect(rows[0]!.textContent).not.toContain('Human')
  expect(rows[1]!.textContent).toContain('Human');expect(rows[2]!.querySelector('time')).toBeNull()
  await read('timeline:timeless');expect(panel().querySelector('.log-turn__body')!.textContent).toBe('An original record with no timestamp')
  await dom.click('[aria-label="Message details"]');expect(panel().textContent).toContain('Time not recorded')
})

it('keeps any sending request from competing Send and preserves exact archive/move identities', async () => {
  const send=vi.fn(),remove=vi.fn(async () => {}),move=vi.fn();const queued=[
    {id:'first',text:'Current in-flight words',status:'queued' as const,deliverable:true,sending:true},
    {id:'second',text:'Exact second retained words',status:'deferred' as const,deliverable:true},
    {id:'third',text:'Exact third retained words',status:'queued' as const,deliverable:true}]
  await dom.render(<SessionMailbox system={system} queued={queued} onSendQueued={send} onArchiveQueued={remove} onMoveQueued={move} />)
  await open();await choose('user');const buttons=()=>[...panel().querySelectorAll<HTMLButtonElement>('.composer-outbox li[data-operation-id="'+(panel().querySelector('.composer-outbox__inline')?.closest('li')?.getAttribute('data-operation-id') ?? 'first')+'"] button')]
  expect(buttons().find(b=>b.getAttribute('aria-label')==='Send queued message')!.disabled).toBe(true)
  await read('queue:first');expect(buttons().find(b=>b.getAttribute('aria-label')==='归档这条待发消息')!.disabled).toBe(true)
  expect(buttons().find(b=>b.getAttribute('aria-label')==='Send queued message')!.disabled).toBe(true)
  await read('queue:second');expect(buttons().find(b=>b.getAttribute('aria-label')==='Move up')!.disabled).toBe(true)
  const down=buttons().find(b=>b.getAttribute('aria-label')==='Move down')!;await act(async()=>down.click());expect(move).toHaveBeenCalledExactlyOnceWith('second','down')
  const deleting=buttons().find(b=>b.getAttribute('aria-label')==='归档这条待发消息')!;await act(async()=>deleting.click());expect(remove).toHaveBeenCalledExactlyOnceWith('second','Exact second retained words',true);expect(send).not.toHaveBeenCalled()
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
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
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

it('renders A2A Inbox, native/captured Inputs and Pending with shared compact reading and honest identities', async () => {
  journal.set([journalMessage({ id: 'incoming', sender: 'reviewer', body: 'Inbox **original** words' })])
  const copy=vi.fn(async()=>true), unconfirmed={...outgoingItem('unconfirmed','Original **unconfirmed** record'),status:'failed' as const}
  await dom.render(<SessionMailbox control={composerSession().control} system={system} queued={[{id:'pending',text:'Pending **original** words',status:'deferred',deliverable:true}]}
    userMessages={[{id:'native',rawId:'raw-native',agentSessionId:'agent-1',content:'Native **original** words',contentParts:[{kind:'text',text:'Native **original** words'}],recordedAt:_tailFixtureEpoch(0, 0, 1),deliveryStatus:'unverified',author:{kind:'unknown'},source:{kind:'native',providerId:'codex',nativeSessionId:'native-session',recordId:'raw-native'}}]}
    timeline={{agentSessionId:'agent-1',revision:1,items:[unconfirmed]}} onCopyQueued={copy} />)
  await open();await choose('inbox');await read('a2a:incoming')
  expect(panel().querySelectorAll('.log-turn[data-compact]')).toHaveLength(1)
  expect(panel().querySelector('.log-turn strong')!.textContent).toBe('original')
  await back();await choose('user');await read('timeline:unconfirmed')
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
  await act(async()=>link.click());expect(file).toHaveBeenCalledExactlyOnceWith('src/owned.ts',{line:7},expect.objectContaining({ctrlKey:false,metaKey:false}))
  const web=panel().querySelector<HTMLButtonElement>('.md-link:not(.md-link--file)')!;expect(web).not.toBeNull()
  await act(async()=>web.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true,clientX:11,clientY:12})))
  expect(http).toHaveBeenCalledExactlyOnceWith('https://example.test/record',{metaKey:false,ctrlKey:true,altKey:false,clientX:11,clientY:12})
  expect(image).not.toHaveBeenCalled()
})

it('navigation action counts never combine the loaded History window with Pending', async()=>{
  await dom.render(<SessionMailbox system={system} queued={[{id:'one',text:'one',status:'queued',deliverable:true}]}
    timeline={{agentSessionId:'agent-1',revision:1,items:[outgoingItem('sent','history')]}} />)
  await open();await choose('user')
  const tab=panel().querySelector<HTMLButtonElement>('[id$="-user-tab"]')!
  expect(tab.getAttribute('aria-label')).toBe('Inputs: 1 pending');expect(tab.querySelector('.composer-mailbox__count')!.textContent).toBe('1')
  expect(panel().querySelector('[id$="-system-tab"] .composer-mailbox__count')).toBeNull()
  expect(panel().textContent).not.toContain('Read full message')
  expect(panel().textContent).not.toContain('Captured input')
})


it('reads native structured resources and pasted images through the shared body while Copy preserves the exact recorded string', async()=>{
  const raw=("Recorded **text** before the attachment.\n@" + _hygiene_fixturePath("original/home/.agentmux/pasted/12345678-1234-1234-1234-123456789abc.png")), copy=vi.fn(async()=>true), image=vi.fn(async()=>({path:_hygiene_fixturePath("original/image"),dataUrl:'data:image/png;base64,AA==',mimeType:'image/png'}))
  const native={id:'parts',rawId:'parts-raw',agentSessionId:'agent-1',content:raw,contentParts:[{kind:'text' as const,text:raw},{kind:'resource' as const,resourceType:'image' as const,reference:'original-native-image-reference',label:'Original attachment'}],deliveryStatus:'unverified' as const,author:{kind:'unknown' as const},source:{kind:'native' as const,providerId:'claude' as const,nativeSessionId:'parts-session',recordId:'parts-raw'}}
  await dom.render(<SessionMailbox system={system} queued={[]} userMessages={[native]} timeline={{agentSessionId:'agent-1',revision:0,items:[]}} onCopyQueued={copy} reading={{homeDir:_hygiene_fixturePath("original/home"),readPastedImage:image}} />)
  await open();await choose('user');await read('native:parts')
  expect(panel().querySelectorAll('.log-turn[data-compact]')).toHaveLength(1)
  expect(panel().querySelectorAll('.log-turn__resource')).toHaveLength(1)
  expect(panel().textContent).toContain('Original attachment');expect(panel().textContent).toContain('original-native-image-reference')
  expect(image).toHaveBeenCalledExactlyOnceWith(_hygiene_fixturePath("original/home/.agentmux/pasted/12345678-1234-1234-1234-123456789abc.png"))
  expect(panel().querySelector('.md-conversation-image img')).not.toBeNull()
  await dom.click('.log-turn__action');expect(copy).toHaveBeenCalledExactlyOnceWith(raw + '\nOriginal attachment\noriginal-native-image-reference')
  expect(panel().querySelector('.log-turn__actions')!.getAttribute('data-copy-state')).toBe('copied')
  await back();await dom.render(<SessionMailbox system={system} queued={[]} userMessages={[{...native,content:'',contentParts:[native.contentParts[1]!]}]} timeline={{agentSessionId:'agent-1',revision:0,items:[]}} onCopyQueued={copy} />)
  await read('native:parts');expect(panel().querySelector('.log-turn__resource')).not.toBeNull()
  expect(panel().querySelector('[aria-label="Copy message"]')).not.toBeNull();expect(panel().textContent).not.toContain('No text recorded')
})


it('places actual Pending risks before a long body, keeps ordinary queue meaning in Info and uses neutral working facts', async () => {
  const pending = {id:'risk',text:longText,status:'deferred' as const,deliverable:true}
  const show = (overrides = {}) => dom.render(<SessionMailbox system={system} queued={[{...pending,...overrides}]} />)
  await show();await open();await choose('user');await read('queue:risk')
  expect(panel().querySelector('.composer-mailbox__risk')).toBeNull()
  await dom.click('[aria-label="Message details"]')
  expect(panel().textContent).toContain('尚未发送。点击发送只提交这条消息')
  const recordedReason = 'Confirmation was not observed\nOriginal diagnostic remains intact.'
  await show({error:recordedReason})
  const risk = panel().querySelector<HTMLElement>('.message-delivery-failure')!, body = panel().querySelector('.log-turn__body')!
  expect(risk).not.toBeNull()
  expect(risk.textContent).toContain(recordedReason)
  expect(risk.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(panel().querySelector('.composer-mailbox__record-facts')!.textContent).toContain(recordedReason)
  await show({deliverable:false,error:undefined})
  expect(panel().querySelector('.composer-mailbox__risk')!.textContent).toContain('绑定的 Run 不可用或已改变')
  expect(panel().textContent).toContain('不会投递到其他 Run')
  expect(panel().querySelector('[aria-label="Send queued message"]')).toBeNull()
  await show({sending:true,status:'restoring',error:undefined})
  expect(panel().querySelector<HTMLElement>('.composer-mailbox__risk')!.dataset.kind).toBe('working')
  expect(panel().querySelector('.composer-mailbox__risk')!.textContent).toContain('正在提交原消息，等待投递确认')
})

it('keeps an authored packet prefix literal in the journal list and reads its complete body through shared Copy', async () => {
  const body = 'Check **the handoff** before editing the original file.'
  const wire = ("<bagakit-msg type=\"agent-v1\" name=\"Review team\" time=\"" + _tailFixtureIso().replace('.000Z', 'Z') + "\">") + body + '</bagakit-msg>'
  journal.set([journalMessage({ id: 'packet', body: wire })])
  const copy = vi.fn(async () => true)
  await dom.render(<SessionMailbox control={composerSession().control} system={system} queued={[]} onCopyQueued={copy} />)
  await open(); await choose('inbox')
  expect(panel().querySelector('.composer-mailbox__preview')!.textContent).toBe(wire.slice(0,240))
  expect(panel().querySelectorAll('.log-turn')).toHaveLength(0)
  expect(journal.read).not.toHaveBeenCalled()
  await read('a2a:packet')
  expect(panel().querySelector('.log-turn__body strong')!.textContent).toBe('the handoff')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire)
})

it('reads exactly one bounded snippet per row and preserves the original prefix when a long packet cannot be interpreted within it', async () => {
  const long = `<amux:a2a from="reviewer" msg-id="example">\n<bagakit-msg type="agent-v1" name="Review team" time="${_hygiene_fixtureIso(23817600000, "zone-second", 480)}">${longText}</bagakit-msg>\n</amux:a2a>`
  const incomplete = '<amux:a2a from="reviewer" msg-id="example">\n<bagakit-msg type="agent-v1"'
  const plain = longText
  const parser = vi.spyOn(messageGrammar, 'parseAgentMuxMessagePrefix')
  await dom.render(<>{[long,incomplete,plain].map((text,index) => <MailboxRecordRow key={index} recordKey={`bounded:${index}`} label="Original author" text={text} metadata={null} onOpen={vi.fn()} />)}</>)
  expect(parser.mock.calls.map(call => call[0])).toEqual([long.slice(0,240),incomplete,plain.slice(0,240)])
  expect([...dom.container.querySelectorAll('.composer-mailbox__preview')].map(row => row.textContent)).toEqual([long.slice(0,240),incomplete,plain.slice(0,240)])
})

it('reads actual captured and native unknown-author user messages without timeline, deduplicating identity rather than equal bodies', async () => {
  const captured = {id:'captured:original',rawId:'original',agentSessionId:'agent-1',content:'Same exact body',contentParts:[{kind:'text' as const,text:'Same exact body'}],author:{kind:'unknown' as const},deliveryStatus:'complete' as const,source:{kind:'captured' as const,submissionId:'original'}}
  const native = {...captured,id:'native-original',rawId:'native-raw',deliveryStatus:'unverified' as const,source:{kind:'native' as const,providerId:'codex',nativeSessionId:'native-session',recordId:'native-raw'}}
  const show = (timeline = undefined as Parameters<typeof SessionMailbox>[0]['timeline']) => dom.render(<SessionMailbox control={composerSession().control} system={system} queued={[]}
    userMessages={[captured,native,{...native,id:'duplicate-wrapper'},{...captured,id:'captured:distinct',source:{kind:'captured',submissionId:'distinct'}},{...captured,id:'foreign',agentSessionId:'foreign'}]} timeline={timeline} />)
  await show();await open();await choose('user')
  expect([...panel().querySelectorAll<HTMLElement>('.composer-mailbox__row')].map(row=>row.dataset.recordKey)).toEqual(['timeline:original','native:native-original','timeline:distinct'])
  await read('timeline:original');expect(panel().querySelector('.log-turn__body')!.textContent).toBe('Same exact body')
  await back();await show({agentSessionId:'agent-1',revision:1,items:[item('original','Authoritative original body')]})
  expect(panel().querySelectorAll('[data-record-key="timeline:original"]')).toHaveLength(1)
  await read('timeline:original');expect(panel().querySelector('.log-turn__body')!.textContent).toBe('Authoritative original body')
})

it('keeps Archived beside active Pending, preserves unknown cause and locates only the exact confirmed History', async () => {
  const archive=vi.fn(async()=>{}), send=vi.fn(), queued=[
    {id:'active',text:'Exact active',status:'queued' as const,deliverable:true},
    {id:'unknown',text:'Original possibly input',status:'deferred' as const,deliverable:true,archived:true as const,unconfirmed:true,errorCode:'AGENT_PROMPT_PREPARATION_FAILED',error:'Original transport cause'},
    {id:'confirmed',text:'Original already input',status:'queued' as const,deliverable:true,archived:true as const}]
  await dom.render(<SessionMailbox control={composerSession().control} system={system} queued={queued} onArchiveQueued={archive} onSendQueued={send}
    timeline={{agentSessionId:'agent-1',revision:1,items:[outgoingItem('prompt:confirmed','Original confirmed History')]}} />)
  await open();await choose('user');expect(panel().querySelector('[id$="-user-tab"]')!.getAttribute('aria-label')).toBe('Inputs: 1 pending')
  expect([...panel().querySelectorAll<HTMLElement>('li[data-operation-id]')].map(row => row.dataset.operationId)).toEqual(['active','unknown','confirmed'])
  await read('queue:unknown');expect(panel().querySelector('.composer-mailbox__back')).toBeNull()
  expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(4)
  expect(panel().querySelector('.composer-outbox__inline')!.textContent).toContain('此前是否已输入仍待核实')
  expect(panel().querySelector('.composer-outbox__inline')!.textContent).toContain('Original transport cause')
  const unknown=panel().querySelector<HTMLElement>('li[data-operation-id="unknown"]')!
  expect(unknown.querySelector('[aria-label="Send queued message"]')).toBeNull()
  await act(async()=>unknown.querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')!.click())
  expect(archive).toHaveBeenCalledExactlyOnceWith('unknown','Original possibly input',false);expect(send).not.toHaveBeenCalled()
  await read('queue:confirmed')
  const confirmed=panel().querySelector<HTMLElement>('li[data-operation-id="confirmed"]')!
  expect(confirmed.querySelector('.composer-mailbox__risk')).toBeNull()
  expect(confirmed.textContent).toContain('输入已确认')
  expect(confirmed.querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')!.disabled).toBe(true)
  await act(async()=>confirmed.querySelector<HTMLButtonElement>('[aria-label="读取原记录"]')!.click())
  expect(panel().querySelector('.log-turn__body')!.textContent).toBe('Original confirmed History')
  expect(archive).toHaveBeenCalledTimes(1);expect(send).not.toHaveBeenCalled()
})

it('copies the exact inline row with a truthful Check and edits it without jumping to a detail page or moving neighbors', async () => {
  const copy=vi.fn(async()=>true),edit=vi.fn(async()=>{}),send=vi.fn(),queued=[{id:'first',text:'First exact',status:'queued' as const,deliverable:true,editable:true},{id:'second',text:'Second original\nExact full tail',status:'queued' as const,deliverable:true,editable:true}]
  await dom.render(<SessionMailbox system={system} queued={queued} onCopyQueued={copy} onEditQueued={edit} onSendQueued={send} />)
  await open();await choose('user');const row=panel().querySelector<HTMLElement>('li[data-operation-id="second"]')!
  await act(async()=>row.querySelector<HTMLButtonElement>('[aria-label="复制这条待发消息"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(queued[1]!.text)
  expect(row.querySelector('[data-copy-state="copied"] [data-semantic-icon="status.copied"]')).not.toBeNull()
  await act(async()=>row.querySelector<HTMLButtonElement>('[aria-label="编辑这条待发消息"]')!.click())
  expect(panel().querySelector('.composer-mailbox__back')).toBeNull();expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(2)
  expect(row.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(queued[1]!.text)
  const textarea=row.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async()=>textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})))
  expect(row.querySelector('[data-editing-id]')!.getAttribute('data-editing-id')).toBe('second')
  await act(async()=>row.querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!.click())
  expect(edit).toHaveBeenCalledExactlyOnceWith('second',queued[1]!.text,queued[1]!.text)
  expect(send).not.toHaveBeenCalled()
})


it('cannot confirm or hide an original Pending record with a foreign timeline that repeats its operation ID', async () => {
  await dom.render(<SessionMailbox control={composerSession().control} system={system} queued={[{id:'original',text:'Keep actual original',status:'queued',deliverable:true}]}
    timeline={{agentSessionId:'foreign',revision:1,items:[item('prompt:original','Foreign confirmed')]}} />)
  await open();await choose('user')
  expect(panel().querySelector('li[data-operation-id="original"]')).not.toBeNull()
  expect(panel().querySelector('[role="tabpanel"][id$="-user"]')!.textContent).not.toContain('Foreign confirmed')
  await choose('inbox');expect(panel().textContent).not.toContain('Foreign confirmed')
})

it('reveals the exact last original row only for an explicit floating More, without focus or arrival scrolling', async () => {
  const queued=Array.from({length:100},(_,i)=>({id:'original-'+i,text:'Original row '+i,status:'queued' as const,deliverable:true,editable:true}))
  const copy=vi.fn(async()=>true)
  const save=vi.fn(async()=>{throw new Error('Original edit refusal')})
  const revealed:string[]=[],revealTargets:HTMLElement[]=[],scroll=vi.spyOn(HTMLElement.prototype,'scrollIntoView').mockImplementation(function(this:HTMLElement){revealed.push(this.dataset.recordKey??this.querySelector<HTMLElement>('.composer-mailbox__row[data-record-key]')?.dataset.recordKey??this.closest('li')?.querySelector<HTMLElement>('.composer-mailbox__row[data-record-key]')?.dataset.recordKey??'floating');revealTargets.push(this)})
  const show=(entries=queued)=>dom.render(<SessionMailbox control={composerSession().control} system={system} queued={entries} onCopyQueued={copy} onEditQueued={save}>{(mailbox,pending)=><>{mailbox}{pending}</>}</SessionMailbox>)
  await show();Object.defineProperty(panel(),'showPopover',{configurable:true,value:()=>{const event=new Event('toggle');Object.defineProperty(event,'newState',{value:'open'});panel().dispatchEvent(event)}})
  revealed.length=0;revealTargets.length=0
  const more=document.querySelector<HTMLButtonElement>('.composer-pending__card[data-operation-id="original-99"] .composer-pending__more')!
  await act(async()=>more.click())
  expect(panel().querySelector('.composer-outbox__inline')!.getAttribute('data-record-key')).toBe('queue:original-99')
  expect(revealed.filter(key=>key.startsWith('queue:'))).toEqual(['queue:original-99'])
  const ownCopy=panel().querySelector<HTMLButtonElement>('li[data-operation-id="original-99"] .log-turn__action')!
  const originalContainer=panel().querySelector<HTMLElement>('li[data-operation-id="original-99"]')!
  expect(revealTargets).toContain(originalContainer)
  expect(originalContainer.contains(ownCopy)).toBe(true)
  expect(originalContainer.contains(panel().querySelector('.composer-outbox__inline'))).toBe(true)
  await act(async()=>ownCopy.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith('Original row 99')
  expect(originalContainer.querySelector('.log-turn__actions')!.getAttribute('data-copy-state')).toBe('copied');expect(ownCopy.getAttribute('aria-label')).toBe('Message copied');expect(ownCopy.textContent).toContain('Copied')
  const focus=document.activeElement
  await show([...queued,{id:'later',text:'Later arrival',status:'queued',deliverable:true,editable:true}])
  expect(revealed.filter(key=>key.startsWith('queue:'))).toEqual(['queue:original-99'])
  expect(document.activeElement).toBe(focus)
  await act(async()=>more.click())
  expect(revealed.filter(key=>key.startsWith('queue:'))).toEqual(['queue:original-99','queue:original-99'])
  expect(document.activeElement).toBe(focus)
  const edit=originalContainer.querySelector<HTMLButtonElement>('[aria-label="编辑这条待发消息"]')!
  await act(async()=>edit.click())
  const editor=originalContainer.querySelector<HTMLElement>('.composer-queued-editor')!
  expect(revealTargets.at(-1)).toBe(editor)
  expect(editor.dataset.editingId).toBe('original-99')
  expect(editor.querySelector('.composer-queued-editor__actions button:last-child')).not.toBeNull()
  const editingScrolls=revealTargets.length,editingFocus=document.activeElement
  await show([...queued,{id:'later',text:'Later arrival',status:'queued',deliverable:true,editable:true}])
  expect(revealTargets).toHaveLength(editingScrolls)
  expect(document.activeElement).toBe(editingFocus)
  await act(async()=>editor.querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!.click())
  expect(save).toHaveBeenCalledExactlyOnceWith('original-99','Original row 99','Original row 99')
  expect(editor.querySelector('[role="alert"]')!.textContent).toContain('Original edit refusal')
  expect(revealTargets).toHaveLength(editingScrolls+1)
  expect(revealTargets.at(-1)).toBe(editor)
  await show(queued.map(entry=>entry.id==='original-99'?{...entry,editable:false}:entry))
  expect(editor.querySelector('[role="status"]')).not.toBeNull()
  expect(revealTargets).toHaveLength(editingScrolls+2)
  expect(revealTargets.at(-1)).toBe(editor)
  scroll.mockRestore()
})
