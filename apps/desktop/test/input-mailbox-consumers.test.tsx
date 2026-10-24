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
import { OriginalInputWaitingControl } from '../src/renderer/src/components/OriginalInputWaitingControl'
import type { AgentInputSubmissionReceipt, AgentInputWaitStopReceipt } from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
const dom = composerDOM(), closes: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  // Release mounted reading/observation leases before their original clients and files.
  // A cleanup failure must not strand a portal or skip another fixture's close.
  try { await dom.render(null) } catch (error) { failures.push(error) }
  try {
    for (const close of closes.splice(0).reverse()) {
      try { await close() } catch (error) { failures.push(error) }
    }
  } finally { vi.unstubAllEnvs() }
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Original mailbox fixture cleanup failed')
})
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
async function inputs() {
  const f = await ingressFixture(false)
  // Hosted disposal closes the logical request, not this source Core operation.
  // Keep its entire queue → Store read alive until it settles before deleting its files.
  const mailboxReads = new Set<Promise<AgentInputMailboxPage>>()
  const readMailbox = f.client.readAgentInputMailbox.bind(f.client)
  vi.spyOn(f.client, 'readAgentInputMailbox').mockImplementation((...args) => {
    const reading = readMailbox(...args)
    mailboxReads.add(reading)
    void reading.then(() => mailboxReads.delete(reading), () => mailboxReads.delete(reading))
    return reading
  })
  closes.push(async () => {
    while (mailboxReads.size) await Promise.allSettled(mailboxReads)
    await f.close()
  })
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
  await dom.click('[role="tab"][id$="-user-tab"]')
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
  expect(dom.container.querySelector('.input-mailbox')?.textContent).toContain(f.actor.userId)
  expect(dom.container.querySelector('.input-mailbox')?.textContent).toContain('已登记输入 · 更早历史未确认')
  const externalRow=[...dom.container.querySelectorAll('[data-input-mailbox-key]')].find(row=>row.querySelector('.composer-mailbox__row strong')?.textContent?.includes(f.actor.userId))!
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
    .filter(node=>node.dataset.inputMailboxKey || !node.closest('[data-input-mailbox-key]'))
    .map(node=>node.dataset.inputMailboxKey?'journal':node.dataset.inputHistoryId??node.dataset.recordKey?.replace('native:',''))
  expect(rows).toEqual(['native-new','journal','journal','native-old','native-unknown'])
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

async function waitingController() {
  const f = await inputs()
  vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('Declared unavailable Runtime transport'))
  const controller = new RuntimeController(f.store, async () => f.client); closes.push(() => controller.dispose())
  controller.commit(await controller.prepare(composerConfig))
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation((target, options) => controller.inputMailbox(target, options))
  const inspect = vi.spyOn(api.sessions, 'inspectInput').mockImplementation((target, key) => controller.inspectInput(target, key))
  const stop = vi.spyOn(api.sessions, 'stopInputWaiting').mockImplementation((target, ref, id) => controller.stopInputWaiting(target, ref, id))
  const page = await f.client.readAgentInputMailbox({ agentSessionId: f.session.agentSessionId })
  const external = page.items.find(entry => entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.intent.key.kind === 'message')!
  if (external.kind !== 'item' || external.item.kind !== 'controlled' || !external.item.receipt) throw Error('Missing original external input')
  return { ...f, controller, inspect, stop, receipt: external.item.receipt }
}

it('stops the original external wait from actual SessionMailbox through Runtime and Core without inspect, replay or current Run substitution', async () => {
  const f = await waitingController(), session = composerSession(f.session.agentSessionId, 'claude')
  session.control.run = { runId: 'a-new-current-run-that-does-not-own-the-original-input' }
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Unsent draft remains' } })
  const submit = vi.spyOn(f.client, 'submitAgentPrompt'), rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  await dom.render(<SessionMailbox control={session.control} system={system} queued={[]} />); await open()
  await flushUntil(() => expect(dom.container.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(2))
  expect(f.stop).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
  const row = [...dom.container.querySelectorAll('[data-input-mailbox-key]')].find(row => row.textContent?.includes(f.actor.userId))!
  await act(async () => row.querySelector<HTMLButtonElement>('.composer-mailbox__row')!.click())
  await dom.click('[data-input-wait-action="stop"]')
  await flushUntil(() => expect(dom.container.querySelector('[data-input-stop-outcome]')?.getAttribute('data-input-stop-outcome')).toBe('stopped-before-dispatch'))
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.inspect).not.toHaveBeenCalled()
  expect(f.stop.mock.calls[0]!.slice(0, 2)).toEqual([{ kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.receipt.key.expectedRun }, f.receipt.ref])
  expect(await f.client.inspectAgentInput({ key: f.receipt.key })).toMatchObject({ status: 'stopped', ref: f.receipt.ref })
  expect(submit).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(dom.draft(session.id)).toBe('Unsent draft remains')
})

it('recovers a lost Core stop ACK only after another explicit click using the same ID after remount, and retains it when later reads fail', async () => {
  const f = await waitingController(), originalStop = f.controller.stopInputWaiting.bind(f.controller)
  f.stop.mockImplementationOnce(async (...args) => { await originalStop(...args); throw Error('Reply lost after Core saved the original stop') })
  await dom.render(<OriginalInputWaitingControl hostId="local" receipt={f.receipt} />)
  await dom.click('[data-input-wait-action="stop"]')
  await flushUntil(() => expect(dom.container.querySelector('[data-input-wait-error]')?.textContent).toContain('停止结果未确认'))
  expect(dom.container.querySelector('[data-input-stop-outcome]')).toBeNull()
  const firstId = f.stop.mock.calls[0]![2]
  await dom.render(null); await dom.render(<OriginalInputWaitingControl hostId="local" receipt={f.receipt} />)
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.inspect).not.toHaveBeenCalled()
  await dom.click('[data-input-wait-action="check"]')
  await flushUntil(() => expect(dom.container.querySelector('[data-input-wait-observation]')?.textContent).toBe('原输入已停止等待。'))
  expect(f.stop).toHaveBeenCalledTimes(1)
  // Reopen the retained original record: only another explicit stop retrieves that original operation's ACK.
  await dom.render(null)
  const refresh = vi.fn(async () => { throw Error('Mailbox read unavailable') })
  await dom.render(<OriginalInputWaitingControl hostId="local" receipt={f.receipt} onRefresh={refresh} />)
  await dom.click('[data-input-wait-action="stop"]')
  await flushUntil(() => expect(dom.container.querySelector('[data-input-stop-outcome]')?.textContent).toContain('原消息保留'))
  expect(f.stop.mock.calls[1]![2]).toBe(firstId)
  expect(dom.container.querySelector('[data-input-wait-error]')?.textContent).toContain('已收到的操作回执保留')
  f.inspect.mockRejectedValueOnce(Error('Original observation unavailable'))
  await dom.click('[data-input-wait-action="check"]')
  await flushUntil(() => expect(dom.container.querySelector('[data-input-wait-error]')?.textContent).toContain('本次检查未确认'))
  expect(dom.container.querySelector('[data-input-stop-outcome]')?.getAttribute('data-input-stop-outcome')).toBe('stopped-before-dispatch')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

function waitingReceipt(): AgentInputSubmissionReceipt {
  const key = { kind: 'message' as const, agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, messageId: 'original-message' }
  const ref = { key, waitGeneration: 1 }
  return { key, ref, persistence: 'confirmed', control: { ref, state: 'enabled', at: 1 }, admission: null, status: 'waiting', observation: 'rejoin-needed' }
}

it.each([
  ['stopped-before-dispatch', '原消息保留'], ['observation-stopped', '原输入可能已派发，未撤回'],
  ['already-settled', '请检查原输入结果'], ['stale-generation', '未停止新的等待']
] as const)('renders the exact %s stop ACK without claiming a reply or stopping a newer generation', async (outcome, message) => {
  const receipt = waitingReceipt(), stop = vi.spyOn(api.sessions, 'stopInputWaiting').mockImplementation(async (_target, ref, cancelOperationId) => ({ ref, cancelOperationId, outcome, at: 2 }))
  const inspect = vi.spyOn(api.sessions, 'inspectInput')
  await dom.render(<OriginalInputWaitingControl hostId="original-host" receipt={receipt} />)
  expect(stop).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
  await dom.click('[data-input-wait-action="stop"]')
  expect(dom.container.querySelector('[data-input-stop-outcome]')?.textContent).toContain(message)
  if (outcome === 'already-settled') {
    expect(dom.container.querySelector('[data-input-stop-outcome]')?.textContent).toContain('上方等待状态是此前观测')
    expect(dom.container.textContent).not.toContain('已被 Agent 接收')
  }
  expect(dom.container.querySelector('[data-input-wait-action="stop"]')).toBeNull()
  expect(stop.mock.calls[0]![1]).toEqual(receipt.ref)
})

it('isolates late Host, Session and generation results and distinguishes every full original identity in the stop ID', async () => {
  const receipt = waitingReceipt(), delayed: Array<(value: AgentInputWaitStopReceipt) => void> = []
  const stop = vi.spyOn(api.sessions, 'stopInputWaiting').mockImplementation(() => new Promise(resolve => delayed.push(resolve)))
  const variants = [
    { hostId: 'host-a', receipt }, { hostId: 'host-b', receipt },
    ...['session', 'run', 'id', 'kind', 'generation'].map(change => {
      const next = structuredClone(receipt)
      const key = change === 'kind' ? { kind: 'prompt' as const, agentSessionId: receipt.key.agentSessionId, expectedRun: receipt.key.expectedRun, submissionId: 'original-message' } : {
        ...receipt.key, ...(change === 'session' ? { agentSessionId: 'another-session' } : {}), ...(change === 'run' ? { expectedRun: { runId: 'another-run' } } : {}), ...(change === 'id' ? { messageId: 'another-message' } : {}) }
      next.key = key; next.ref = { key, waitGeneration: change === 'generation' ? 2 : 1 }; next.control.ref = next.ref
      return { hostId: 'host-a', receipt: next }
    })
  ]
  for (const props of variants) {
    await dom.render(<OriginalInputWaitingControl {...props} />)
    expect(dom.container.querySelector('[data-input-stop-outcome]')).toBeNull()
    await dom.click('[data-input-wait-action="stop"]')
  }
  expect(new Set(stop.mock.calls.map(call => call[2])).size).toBe(variants.length)
  await act(async () => delayed[0]!({ ref: receipt.ref, cancelOperationId: stop.mock.calls[0]![2], outcome: 'stopped-before-dispatch', at: 2 }))
  expect(dom.container.querySelector('[data-input-stop-outcome]')).toBeNull()
  const last = stop.mock.calls.at(-1)!
  await act(async () => delayed.at(-1)!({ ref: last[1], cancelOperationId: last[2], outcome: 'stale-generation', at: 2 }))
  expect(dom.container.querySelector('[data-input-stop-outcome]')?.getAttribute('data-input-stop-outcome')).toBe('stale-generation')
})

it('checks the original key without rejoin or stop, retains unknown, and does not grant Stop for another generation or settled receipts', async () => {
  const receipt = waitingReceipt(), stop = vi.spyOn(api.sessions, 'stopInputWaiting'), rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting')
  const inspect = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValueOnce(null)
  await dom.render(<OriginalInputWaitingControl hostId="original-host" receipt={receipt} />)
  await dom.click('[data-input-wait-action="check"]')
  expect(inspect).toHaveBeenCalledWith({ kind: 'agent', hostId: 'original-host', agentSessionId: receipt.key.agentSessionId, run: receipt.key.expectedRun }, receipt.key)
  expect(dom.container.querySelector('[data-input-wait-observation]')?.textContent).toContain('结果仍未确认')
  expect(dom.container.querySelector('[data-input-wait-action="stop"]')).not.toBeNull()
  const newer = structuredClone(receipt); newer.ref.waitGeneration = 2
  inspect.mockResolvedValueOnce(newer)
  await dom.click('[data-input-wait-action="check"]')
  expect(dom.container.querySelector('[data-input-wait-generation]')?.textContent).toContain('当前操作仍绑定原批次')
  expect(dom.container.querySelector('[data-input-wait-action="stop"]')).toBeNull()
  await dom.render(null)
  for (const status of ['admitted', 'terminal-confirmed', 'not-applied', 'stopped', 'unknown'] as const) {
    await dom.render(<OriginalInputWaitingControl hostId="original-host" receipt={{ ...receipt, status }} />)
    expect(dom.container.querySelector('[data-input-wait-action="stop"]')).toBeNull()
  }
  expect(stop).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
})

it('keeps an in-flight original stop result when the parent reads a newer waiting generation without silently targeting it', async () => {
  const f = await waitingController()
  const receipt = (await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: 'local-original' } }))!
  let release!: () => void
  const barrier = new Promise<void>(done => { release = done })
  f.stop.mockImplementation(async (...args) => { await barrier; return f.controller.stopInputWaiting(...args) })
  const refresh = vi.fn(async () => { throw Error('Refresh failed after original ACK') })
  await dom.render(<OriginalInputWaitingControl hostId="local" receipt={receipt} onRefresh={refresh} />)
  await dom.click('[data-input-wait-action="stop"]')
  const call = f.stop.mock.calls[0]!
  // A separate explicit owner action wins the race. The UI must not inherit its new generation.
  await f.client.stopAgentInputWaiting({ ref: receipt.ref, cancelOperationId: 'competing-original-stop' })
  const newer = await f.client.rejoinAgentInputWaiting({ ref: receipt.ref })
  expect(newer.ref.waitGeneration).toBe(receipt.ref.waitGeneration + 1)
  await dom.render(<OriginalInputWaitingControl hostId="local" receipt={newer} onRefresh={refresh} />)
  expect(dom.container.querySelector('[data-input-wait-generation]')?.textContent).toContain('当前操作仍绑定原批次')
  await act(async () => release())
  await flushUntil(() => expect(dom.container.querySelector('[data-input-stop-outcome]')?.getAttribute('data-input-stop-outcome')).toBe('stale-generation'))
  expect(dom.container.querySelector('[data-input-wait-generation]')).toBeNull()
  expect(dom.container.textContent!.split('等待批次已变化')).toHaveLength(2)
  expect(dom.container.querySelector('[data-input-wait-error]')?.textContent).toContain('已收到的操作回执保留')
  expect(dom.container.querySelector('[data-input-wait-action="stop"]')).toBeNull()
  expect(f.stop).toHaveBeenCalledTimes(1); expect(call[1].waitGeneration).toBe(1)
  expect(await f.client.inspectAgentInput({ key: receipt.key })).toMatchObject({ ref: newer.ref, control: { state: 'enabled' } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
