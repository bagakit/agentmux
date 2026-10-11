// @vitest-environment happy-dom
import { act } from 'react'
import { useAgentInputMailbox, type InputMailboxRead } from '@agentmux/client-ui/use-agent-input-mailbox'
import { InputMailboxRecords, inputMailboxPresentation } from '@agentmux/client-ui/components/InputMailboxRecords'
import type { AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { RuntimeController } from '../src/main/runtime-controller'
import { MobileMailbox } from '../../mobile/src/conversation/MobileMailbox'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
const dom = composerDOM(), closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
async function inputs() {
  const f = await ingressFixture(false); closes.push(f.close)
  const incoming = await f.receive(), delivered = await f.ingress.dispatch(incoming.ingress.ingressId)
  expect(delivered.inputReceipt?.key.kind).toBe('message')
  const local = await f.client.submitAgentPrompt({ agentSessionId: f.input.agentSessionId, expectedRun: f.session.run,
    operationId: 'local-original', prompt: 'Exact local original input', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  expect(local).toMatchObject({ status: 'waiting' })
  return f
}
async function open() {
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const event = new Event('toggle'); Object.defineProperty(event,'newState',{value:'open'})
  await act(async () => panel.dispatchEvent(event))
  await dom.click('[role="tab"][id$="-outbox-tab"]')
}
it('reads actual local and connector inputs through the original Desktop API into the same mailbox without dispatch', async () => {
  const f = await inputs(), session = composerSession(f.input.agentSessionId,'claude')
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Unsent original draft' } })
  vi.spyOn(f.client,'connect').mockRejectedValue(new Error('Declared unavailable Runtime transport'))
  const controller = new RuntimeController(f.store, async () => f.client); closes.push(() => controller.dispose())
  controller.commit(await controller.prepare(composerConfig))
  const read = vi.spyOn(api.sessions,'inputMailbox').mockImplementation(async (target, options) => {
    expect(target).toEqual({hostId:'local',agentSessionId:session.id})
    return controller.inputMailbox(target,options)
  })
  const submit = vi.spyOn(f.client,'submitAgentPrompt'), rejoin = vi.spyOn(f.client,'rejoinAgentInputWaiting')
  await dom.render(<SessionMailbox control={session.control} system={system} queued={[]} onCopyQueued={async () => true} />)
  await open()
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(dom.container.querySelectorAll('[data-input-mailbox-key]'), dom.container.querySelector('.input-mailbox')?.textContent).toHaveLength(2) })
  expect(dom.container.querySelector('.input-mailbox')?.textContent).toContain(f.event().body.slice(0,20))
  expect(dom.container.querySelector('.input-mailbox')?.textContent).toContain('Exact local original input')
  expect(dom.container.querySelector('.input-mailbox')?.textContent).toContain(f.actor.application.domain)
  expect(dom.container.querySelector('.input-mailbox')?.textContent).toContain('已登记输入 · 更早历史未确认')
  const externalRow=[...dom.container.querySelectorAll('[data-input-mailbox-key]')].find(row=>row.querySelector('[data-mailbox-author]')?.textContent?.includes(f.actor.userId))!
  expect(externalRow.textContent!.split(f.actor.application.domain)).toHaveLength(2)
  expect([...dom.container.querySelectorAll('.input-mailbox button')].filter(button=>button.textContent==='刷新发送记录')).toHaveLength(1)
  expect(read).toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(dom.draft(session.id)).toBe('Unsent original draft')
})

it('reads the same local and connector inventory through actual Hosted SDK into Mobile without creating local attempts', async () => {
  const f = await inputs()
  const service = new AgentMuxHostedRuntimeService(f.client,f.store.path,() => hostedTestOwner(f.client)); closes.push(() => service.dispose())
  const socket = join(f.root,'mailbox-mobile.sock'), server = new AgentMuxControlServer({socketPath:socket,coreClients:f.coreClients,hostedRuntime:() => service})
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({endpoint:{transport:'unix',path:socket}}); closes.push(() => rpc.dispose())
  vi.spyOn(f.client,'connect').mockRejectedValue(new Error('Declared unavailable Runtime transport'))
  const client = await connectHostedAgentMux({rpc,waitForReady:false}); closes.push(async () => client.dispose())
  const submit = vi.spyOn(f.client,'submitAgentPrompt'), rejoin = vi.spyOn(f.client,'rejoinAgentInputWaiting')
  const copy = vi.fn(async () => true)
  const platform = {copyText:copy,overlayContainer:() => document.body,bindComposerFocus:() => () => {},renderMessageAvatar:() => null,renderProjectIcon:() => null,renderProjectLabel:() => null,renderIcon:() => null}
  await dom.render(<MobileMailbox client={client} session={f.session} connected messages={[]} platform={platform}
    describeSpeaker={() => ({name:'Original author'})} refresh={() => {}} historyScope="original-mobile-history"
    readHistory={async () => {throw new Error('History is a separate original reader')}} onHistoryFill={async () => {}} onHistoryCopy={copy} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!.click())
  await vi.waitFor(async () => { await act(async () => {await new Promise(resolve => setTimeout(resolve,10))}); expect(document.querySelectorAll('.mobile-message-tools [data-input-mailbox-key]')).toHaveLength(2) })
  const mailbox = document.querySelector('.mobile-message-tools .input-mailbox')!
  expect(mailbox.textContent).toContain('已登记输入 · 更早历史未确认')
  const externalRow=[...mailbox.querySelectorAll('[data-input-mailbox-key]')].find(row=>row.querySelector('[data-mailbox-author]')?.textContent?.includes(f.actor.userId))!
  expect(externalRow.textContent!.split(f.actor.application.domain)).toHaveLength(2)
  expect([...mailbox.querySelectorAll('button')].some(button=>button.textContent==='刷新发送记录')).toBe(false)
  expect(mailbox.textContent).not.toContain('发送登记与原始来源记录')
  expect(mailbox.textContent).toContain(f.actor.userId); expect(mailbox.textContent).toContain('Exact local original input')
  const reads=vi.spyOn(client,'readAgentInputMailbox')
  await act(async () => document.querySelector<HTMLButtonElement>('.mobile-message-tools__actions button')!.click())
  await flushUntil(() => expect(reads).toHaveBeenCalled())
  expect(submit).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

let probe: ReturnType<typeof useAgentInputMailbox>
function MailboxProbe({ read, hostId = 'local', sessionId = 'original-agent', copy }: {
  read: InputMailboxRead; hostId?: string; sessionId?: string; copy?: (text:string) => Promise<boolean>
}) {
  probe = useAgentInputMailbox({hostId,agentSessionId:sessionId,enabled:true,read})
  return <InputMailboxRecords mailbox={probe} hostId={hostId} onCopy={copy} />
}
const flushUntil = async (assertion: () => unknown) => {
  let failure: unknown
  for(let attempt=0;attempt<150;attempt++){
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})
    try { assertion(); return } catch(error) { failure=error }
  }
  throw failure
}
it('retains the accepted window when a continuation returns another exact journal or cut', async () => {
  const f = await inputs(), another = await inputs()
  let wrong = false
  const read: InputMailboxRead = async input => wrong
    ? another.client.readAgentInputMailbox({agentSessionId:input.agentSessionId,...(input.maxBytes === undefined ? {} : {maxBytes:input.maxBytes})})
    : f.client.readAgentInputMailbox({...input,limit:1})
  await dom.render(<MailboxProbe read={read} />)
  await flushUntil(() => expect(probe.items).toHaveLength(1))
  const original = probe.items[0], cut = probe.page!.cut
  expect(probe.hasMore).toBe(true); wrong = true
  await act(async () => {await probe.loadEarlier()})
  expect(probe.items).toEqual([original]); expect(probe.page!.cut).toEqual(cut)
  expect(dom.container.textContent).toContain('来源或读取位置已变化')
})
it('rejects delayed Host results and wrong Session replies while retaining the current accepted body', async () => {
  const f = await inputs()
  let resolve!: (page: AgentInputMailboxPage) => void
  const delayed: InputMailboxRead = () => new Promise(done => {resolve=done})
  const read: InputMailboxRead = input => f.client.readAgentInputMailbox(input)
  await dom.render(<MailboxProbe read={delayed} hostId="route-a" />)
  await dom.render(<MailboxProbe read={read} hostId="route-b" />)
  await flushUntil(() => expect(probe.items).toHaveLength(2))
  const page = await f.client.readAgentInputMailbox({agentSessionId:'original-agent',maxBytes:128*1024})
  await act(async () => resolve(page))
  expect(probe.scope).toBe(JSON.stringify(['route-b','original-agent'])); expect(probe.items).toHaveLength(2)
  const rows = dom.container.querySelectorAll<HTMLElement>('[data-input-mailbox-key]')
  expect([...rows].every(row => JSON.parse(row.dataset.inputMailboxKey!)[0] === 'route-b')).toBe(true)
  const wrong: InputMailboxRead = async () => ({...page,agentSessionId:'another-session'})
  await dom.render(<MailboxProbe read={wrong} hostId="route-b" />)
  await flushUntil(() => expect(probe.error).toBeTruthy())
  expect(probe.items).toHaveLength(2); expect(probe.page!.agentSessionId).toBe('original-agent')
})
it('assembles a complete original Unicode input through the Core byte helper and reads earlier only on request', async () => {
  const f = await inputs(), body = '\0'.repeat(40000)+'完整 Unicode original'
  await f.client.submitAgentPrompt({agentSessionId:f.input.agentSessionId,expectedRun:f.session.run,operationId:'large-original',prompt:body,
    admissionIntent:{kind:'manual-actor'},execution:'immediate',authorHuman:true})
  await expect.poll(async () => (await f.client.inspectAgentInput({key:{kind:'prompt',agentSessionId:f.input.agentSessionId,expectedRun:f.session.run,submissionId:'large-original'}}))?.control.waiting?.phase).toBe('runtime')
  const read = vi.fn<InputMailboxRead>(input => f.client.readAgentInputMailbox(input)), copy = vi.fn(async () => true)
  await dom.render(<MailboxProbe read={read} copy={copy} />)
  await flushUntil(() => expect(probe.items).toHaveLength(1))
  expect(read.mock.calls.length).toBeGreaterThan(1); expect(probe.hasMore).toBe(true)
  expect(inputMailboxPresentation(probe.items[0]!).text).toBe(body)
  const details=dom.container.querySelector<HTMLDetailsElement>('[data-input-mailbox-key] > details')!
  await act(async () => {details.open=true;details.dispatchEvent(new Event('toggle'))})
  await dom.click('[aria-label="Copy message"]'); expect(copy).toHaveBeenCalledExactlyOnceWith(body)
  await act(async () => {await probe.loadEarlier()}); expect(probe.items).toHaveLength(3)
  await act(async () => {await probe.refresh()}); expect(probe.items).toHaveLength(3)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('keeps unknown original receipts and complete bodies through read failure without claiming success or replay', async () => {
  const f = await inputs(), inspect = f.client.inspectAgentPromptSubmission.bind(f.client)
  vi.spyOn(f.client,'inspectAgentPromptSubmission').mockImplementation(async key => {
    if (key.kind==='prompt' && key.submissionId==='local-original') throw new Error('Only this original observation is unavailable')
    return inspect(key)
  })
  let fail=false
  const read: InputMailboxRead = input => fail ? Promise.reject(new Error('Mailbox transport unavailable')) : f.client.readAgentInputMailbox(input)
  const submit=vi.spyOn(f.client,'submitAgentPrompt'), rejoin=vi.spyOn(f.client,'rejoinAgentInputWaiting')
  await dom.render(<MailboxProbe read={read} />); await flushUntil(() => expect(probe.items).toHaveLength(2))
  const unknown=probe.items.find(item => item.kind==='controlled' && item.intent.key.kind==='prompt')!
  expect(unknown).toMatchObject({receipt:null,failure:{message:'Only this original observation is unavailable'}})
  expect(dom.container.textContent).toContain('原输入观察未确认'); expect(dom.container.textContent).not.toContain('输入已确认')
  const original=probe.items
  fail=true;await act(async () => {await probe.refresh()})
  expect(probe.items).toEqual(original);expect(dom.container.textContent).toContain('Mailbox transport unavailable')
  expect(submit).not.toHaveBeenCalled();expect(rejoin).not.toHaveBeenCalled();expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('keeps unsent editing and the original draft while the actual Composer consumes exact journal identities once', async () => {
  const f=await inputs(),session=composerSession(f.input.agentSessionId,'claude'), key={kind:'prompt' as const,agentSessionId:session.id,expectedRun:session.control.run,submissionId:'local-original'}
  const receipt=await f.client.inspectAgentInput({key}); expect(receipt).not.toBeNull()
  useAppStore.setState({sessions:[session],agentComposerDrafts:{[session.id]:'Keep the independent editor draft'},agentSteerQueues:{[session.id]:[
    {operationId:'local-original',text:'Exact local original input',status:'deferred',promptCondition:null,inputIntakeStarted:true,directInputBinding:{expectedRun:session.control.run,admissionIntent:{kind:'manual-actor'}},directInputControl:session.control,inputReceipt:receipt!},
    {operationId:'unsent-editor',text:'Original editable intent',status:'queued',promptCondition:null}
  ]}})
  vi.spyOn(api.sessions,'inputMailbox').mockImplementation((target,options) => f.client.readAgentInputMailbox({...options,agentSessionId:target.agentSessionId}))
  const submit=vi.spyOn(f.client,'submitAgentPrompt'),rejoin=vi.spyOn(f.client,'rejoinAgentInputWaiting')
  await dom.render(<AgentSessionComposer sessionId={session.id} />);await open()
  await flushUntil(() => expect(dom.container.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(2))
  expect(dom.container.querySelector('[data-operation-id="local-original"]')).toBeNull()
  expect(dom.container.querySelector('[data-operation-id="unsent-editor"]')).not.toBeNull()
  const old=dom.draft(session.id)
  await dom.click('[data-operation-id="unsent-editor"] [aria-label="编辑这条待发消息"]')
  const text=dom.container.querySelector<HTMLTextAreaElement>('[aria-label="编辑待发消息"]')!
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(text,'Edited unsent intent');text.dispatchEvent(new Event('input',{bubbles:true}))})
  await dom.click('[aria-label="保存待发消息"]')
  expect(useAppStore.getState().agentSteerQueues[session.id]!.find(entry => entry.operationId==='unsent-editor')!.text).toBe('Edited unsent intent')
  expect(dom.draft(session.id)).toBe(old);expect(submit).not.toHaveBeenCalled();expect(rejoin).not.toHaveBeenCalled()
  expect(dom.container.textContent).not.toContain('发送登记与原始来源记录')
})
it('keeps the selected Host route on actual Runtime mailbox continuations even when two routes select the same Core', async () => {
  const f=await inputs();vi.spyOn(f.client,'connect').mockRejectedValue(new Error('Declared unavailable Runtime transport'))
  const controller=new RuntimeController(f.store,async () => f.client);closes.push(() => controller.dispose())
  controller.commit(await controller.prepare({...composerConfig,hosts:[{id:'route-a',kind:'ssh',hostname:'route-a.invalid',label:'A'},{id:'route-b',kind:'ssh',hostname:'route-b.invalid',label:'B'}]}))
  const first=await controller.inputMailbox({hostId:'route-a',agentSessionId:f.session.agentSessionId},{limit:1})
  expect(first.nextCursor).toBeTruthy()
  await expect(controller.inputMailbox({hostId:'route-b',agentSessionId:f.session.agentSessionId},{cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_AGENT_INPUT_CURSOR'})
  expect((await controller.inputMailbox({hostId:'route-a',agentSessionId:f.session.agentSessionId},{cursor:first.nextCursor!})).items).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('rereads the same original keys after remount without replay or fabricated controls for a readonly admission', async () => {
  const h=await rpcOwnerFixture(['recipient']);closes.push(h.close)
  await h.client.submitAgentPrompt({agentSessionId:'recipient',operationId:'accepted-original',expectedRun:{runId:'run-recipient'},afterSubmissionId:null,prompt:'Delivered original body',execution:'immediate',allowUncertainTurn:true,authorHuman:true})
  const read: InputMailboxRead=input => h.client.readAgentInputMailbox(input)
  const input=vi.spyOn(h.client,'submitAgentPrompt'),rejoin=vi.spyOn(h.client,'rejoinAgentInputWaiting'),stop=vi.spyOn(h.client,'stopAgentInputWaiting')
  await dom.render(<MailboxProbe read={read} sessionId="recipient" />);await flushUntil(() => expect(probe.items).toHaveLength(1))
  const original=probe.items[0]!;expect(original.kind).toBe('submission')
  const key=dom.container.querySelector<HTMLElement>('[data-input-mailbox-key]')!.dataset.inputMailboxKey
  await dom.render(null);await dom.render(<MailboxProbe read={read} sessionId="recipient" />)
  await flushUntil(() => expect(probe.items).toHaveLength(1))
  expect(dom.container.querySelector<HTMLElement>('[data-input-mailbox-key]')!.dataset.inputMailboxKey).toBe(key)
  const details=dom.container.querySelector<HTMLDetailsElement>('[data-input-mailbox-key] > details')!
  await act(async () => {details.open=true;details.dispatchEvent(new Event('toggle'))})
  expect(dom.container.textContent).toContain('Delivered original body');expect(dom.container.querySelector('[aria-label="停止等待"]')).toBeNull()
  expect(input).not.toHaveBeenCalled();expect(rejoin).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled()
})

it('preserves a prior exact stopped receipt separately from a current original read failure and rejects changed immutable content', async () => {
  const f=await inputs(), key={kind:'prompt' as const,agentSessionId:f.session.agentSessionId,expectedRun:f.session.run,submissionId:'local-original'}
  const receipt=await f.client.inspectAgentInput({key});expect(receipt).not.toBeNull()
  await f.client.stopAgentInputWaiting({ref:receipt!.ref,cancelOperationId:'stop-original-wait'})
  const inspect=f.client.inspectAgentPromptSubmission.bind(f.client)
  let fail=false, changed=false
  vi.spyOn(f.client,'inspectAgentPromptSubmission').mockImplementation(async input => {
    if (fail && input.kind==='prompt' && input.submissionId===key.submissionId) throw new Error('Current original observation failed')
    return inspect(input)
  })
  const read: InputMailboxRead=async input => {
    const page=await f.client.readAgentInputMailbox(input)
    if (changed) for (const entry of page.items) if(entry.kind==='item' && entry.item.kind==='controlled' && entry.item.intent.source.kind==='prompt') entry.item.intent.source.prompt='A different immutable input'
    return page
  }
  await dom.render(<MailboxProbe read={read} />);await flushUntil(() => expect(probe.items).toHaveLength(2))
  const original=probe.items.find(item => item.kind==='controlled' && item.intent.key.kind==='prompt')!
  expect(original).toMatchObject({receipt:{status:'stopped'}})
  fail=true;await act(async () => {await probe.refresh()})
  expect(probe.items.find(item => item.kind==='controlled' && item.intent.key.kind==='prompt')).toBe(original)
  expect(probe.failures).toHaveLength(1);expect(probe.failures[0]).toMatchObject({receipt:null,failure:{message:'Current original observation failed'}})
  expect(dom.container.textContent).toContain('此前已读');expect(dom.container.textContent).toContain('当前观察未确认')
  const originalItems=probe.items,cut=probe.page!.cut
  changed=true;await act(async () => {await probe.refresh()})
  expect(probe.items).toEqual(originalItems);expect(probe.page!.cut).toEqual(cut);expect(dom.container.textContent).toContain('不可变内容身份未确认')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['desktop','mobile'] as const)('interleaves the original journal and source history by original display time in actual %s consumer', async surface => {
  const f=await inputs(), page=await f.client.readAgentInputMailbox({agentSessionId:f.session.agentSessionId})
  const times=page.items.flatMap(entry=>entry.kind==='item'?[entry.item.recordedAt]:[])
  expect(times).toHaveLength(2)
  const native=(id:string,recordedAt?:number):import('@agentmux/core').AgentSessionUserMessage=>({id,rawId:id,
    agentSessionId:f.session.agentSessionId,source:{kind:'native',providerId:'claude',nativeSessionId:'ingress-native',recordId:id},
    author:{kind:'unknown'},content:id,contentParts:[],...(recordedAt===undefined?{}:{recordedAt})})
  const messages=[native('native-old',Math.min(...times)-10),native('native-unknown'),native('native-new',Math.max(...times)+10)]
  vi.spyOn(f.client,'connect').mockRejectedValue(new Error('Declared unavailable Runtime transport'))
  if(surface==='desktop') {
    const session=composerSession(f.session.agentSessionId,'claude')
    useAppStore.setState({sessions:[session]})
    const controller=new RuntimeController(f.store,async()=>f.client);closes.push(()=>controller.dispose())
    controller.commit(await controller.prepare(composerConfig))
    vi.spyOn(api.sessions,'inputMailbox').mockImplementation((target,options)=>controller.inputMailbox(target,options))
    await dom.render(<SessionMailbox control={session.control} system={system} queued={[]} userMessages={messages} />)
    await open()
  } else {
    const service=new AgentMuxHostedRuntimeService(f.client,f.store.path,()=>hostedTestOwner(f.client));closes.push(()=>service.dispose())
    const socket=join(f.root,'ordered-mail.sock'),server=new AgentMuxControlServer({socketPath:socket,coreClients:f.coreClients,hostedRuntime:()=>service})
    await server.start();closes.push(()=>server.stop())
    const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:socket}});closes.push(()=>rpc.dispose())
    const client=await connectHostedAgentMux({rpc,waitForReady:false});closes.push(async()=>client.dispose())
    const platform={copyText:async()=>true,overlayContainer:()=>document.body,bindComposerFocus:()=>()=>{},renderMessageAvatar:()=>null,renderProjectIcon:()=>null,renderProjectLabel:()=>null,renderIcon:()=>null}
    await dom.render(<MobileMailbox client={client} session={f.session} connected messages={messages} platform={platform} describeSpeaker={()=>({name:'Original author'})}
      refresh={()=>{}} historyScope="ordered-originals" readHistory={async()=>{throw Error('Declared source unavailable; retain original window')}}
      onHistoryFill={async()=>{}} onHistoryCopy={async()=>true} />)
    await act(async()=>dom.container.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!.click())
  }
  await flushUntil(()=>expect(document.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(2))
  const rows=[...document.querySelectorAll<HTMLElement>('[data-input-mailbox-key], [data-input-history-id], .composer-mailbox__row[data-record-key]')]
    .map(node=>node.dataset.inputMailboxKey?'journal':node.dataset.inputHistoryId??node.dataset.recordKey?.replace('native:',''))
  expect(rows).toEqual(['native-new','journal','journal','native-old','native-unknown'])
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
