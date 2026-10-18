import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { connectHostedAgentMux, type AgentMuxHostedClient, type AgentMuxHostedRpcPort } from '@agentmux/core/hosted'
import { MobileConversationSurface } from '@mobile/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '@mobile/platform/browser'
import { getDeviceWorkface } from '@mobile/recovery/device-workface'
import type { MobileConnection } from '@mobile/conversation/use-hosted-conversation'
import { AgentMuxError } from '../../../../../packages/core/src/errors'
import '@agentmux/client-ui/styles.css'
import '@mobile/mobile.css'

type Setup = { url: string; token: string; agentSessionId: string; runtimeId: string }
const copies: string[] = []
const platform = createBrowserPlatform({clipboard:{writeText:async text=>{copies.push(text)}}})
const bridge = (window as any).originalMobileRpc
type Failure = { agentMux: boolean; fields: { name: string; message: string; code?: string; [key: string]: unknown } }
const restoreError = ({agentMux,fields}: Failure): Error => Object.assign(agentMux
  ? new AgentMuxError(fields.message,fields.code!) : new Error(fields.message),fields)
function result<T>(reply: {ok:true;value:T} | {ok:false;error:Failure}): T {
  if (!reply.ok) throw restoreError(reply.error)
  return reply.value
}
let update!: (value: { client: AgentMuxHostedClient | null; connection: MobileConnection; visible: boolean }) => void
let release = () => {}
const rpc: AgentMuxHostedRpcPort = {
  async call(method,params,options={}) {
    const {signal,...rest}=options,id=crypto.randomUUID(),abort=()=>{void bridge.cancel(id)}
    signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true})
    try{return result(await bridge.call(method,params,id,rest))}finally{signal?.removeEventListener('abort',abort)}
  },
  async subscribe(method,params,handlers) {
    const {signal,onInitial,onEvent,onEnd,...rest}=handlers,id=crypto.randomUUID(),abort=()=>{void bridge.cancel(id)}
    signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true})
    try{result(await bridge.subscribe(method,params,id,rest,{onInitial,onEvent,...(onEnd?{onEnd:(failure?:Failure)=>onEnd(failure?restoreError(failure):undefined)}:{})}))}
    catch(error){signal?.removeEventListener('abort',abort);throw error}
    return {dispose:async()=>{signal?.removeEventListener('abort',abort);await bridge.cancel(id)}}
  }
}
let client: AgentMuxHostedClient | null = null, setup: Setup, visible = true
let connection: MobileConnection = { state: 'connecting', message: '正在连接原 Host' }
const operations: unknown[] = [], reads: unknown[] = []
const conversationReads: unknown[] = []
const frames: number[] = [], longTasks: number[] = [], bodyMounts = new Map<string, number>()
let firstFrame: { at: number; nodes: number; bodies: number; markdown: number } | null = null
let frame = 0
requestAnimationFrame(function sample(now) {
  if(frame) frames.push(now-frame); frame=now
  const feed=document.querySelector('.mobile-conversation__reading')
  if(!firstFrame&&feed?.querySelector('[data-native-record-id]'))firstFrame={at:now,nodes:feed.querySelectorAll('*').length,bodies:feed.querySelectorAll('.log-turn__body:not(.conversation-progressive-body__placeholder)').length,markdown:feed.querySelectorAll('[data-markdown-root],.md-paragraph').length}
  requestAnimationFrame(sample)
})
new PerformanceObserver(list => { for(const entry of list.getEntries()) longTasks.push(entry.duration) }).observe({type:'longtask',buffered:true})
new MutationObserver(records => { for(const record of records) for(const node of record.addedNodes) if(node instanceof Element){
  const bodies=[...(node.matches('.log-turn__body')?[node]:[]),...node.querySelectorAll('.log-turn__body')]
  for(const body of bodies){if(body.classList.contains('conversation-progressive-body__placeholder'))continue;const id=body.closest('[data-message-id]')?.getAttribute('data-message-id')??'unknown';bodyMounts.set(id,(bodyMounts.get(id)??0)+1)}
} }).observe(document.documentElement,{childList:true,subtree:true})
const publish = () => update({ client, connection, visible })
function Surface() {
  const [state, setState] = useState({ client, connection, visible }); update = setState
  return <div className="mobile-app" data-connection={state.connection.state}><main className="mobile-main"><div className="mobile-conversation-panel" hidden={!state.visible}>
    <MobileConversationSurface client={state.client} agentSessionId={setup.agentSessionId} connection={state.connection}
      platform={platform} visible={state.visible} displayName="阅读验收" />
  </div></main></div>
}
async function connect() {
  result(await bridge.connect(setup.url,setup.token))
  const observed = new Proxy(rpc, {get(target,key){
    if(key!=='call')return Reflect.get(target,key)
    return async (method: string, params: unknown, options: unknown) => {
      const event={method,params,started:performance.now(),finished:0,failed:false};reads.push(event)
      try{return await target.call(method as never,params as never,options as never)}catch(error){event.failed=true;throw error}finally{event.finished=performance.now()}
    }
  }})
  client = await connectHostedAgentMux({ rpc:observed, expectedRuntimeId: setup.runtimeId })
  for (const method of ['readAgentConversation', 'readConversationChanges'] as const) {
    const original = client[method]
    Reflect.set(client, method, async (...args: Parameters<typeof original>) => {
      const started = performance.now(), page = await Reflect.apply(original, client, args) as Awaited<ReturnType<typeof original>>
      conversationReads.push({ method, started, finished: performance.now(), hostId: page.hostId, agentSessionId: page.agentSessionId,
        requestCursor: args[0].cursor ?? null, olderCursor: page.window.navigation.older ?? null,
        windowId: page.window.id, revision: page.window.revision, complete: page.window.complete, anchor: page.window.anchor ?? null, navigation: page.window.navigation,
        nativeCut: page.window.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')?.checkpoint.cursor,
        nativeIds: page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.flatMap(record =>
          record.original.kind === 'native' ? [record.original.item.id] : []) : []) })
      return page
    })
  }
  release = client.onEvent(event => {
    if (event.type !== 'connection-state') return
    connection = { state: event.state === 'restored' ? 'connected' : 'disconnected', message: event.state === 'restored' ? '已连接原 Host' : '连接中断；原会话和草稿保留。' }
    operations.push({ type: 'connection', state: connection.state }); publish()
  })
  connection = { state: 'connected', message: '已连接原 Host' }; publish()
}
Object.assign(window, {
  async mountOriginalMobile(value: Setup) {
    setup = value
    createRoot(document.getElementById('root')!).render(<Surface />)
    await new Promise(resolve => requestAnimationFrame(resolve))
    await connect()
  },
  mobileReading: {
    facts() {
      let session = null, sessionError = null
      try { session = client?.agentSession(setup.agentSessionId) ?? null }
      catch (error) { const original = error as Error & {code?:string}; sessionError = {name:original.name,code:original.code,message:original.message} }
      return { owner: client?.runtimeOwnerIdentity(), session, sessionError,
      connection, visible, operations, reads, conversationReads, copies, metrics:{firstFrame,frames,longTasks,bodyMounts:[...bodyMounts]}, device: getDeviceWorkface().snapshot().record,
      selection: document.getSelection()?.toString(), text: document.querySelector('.mobile-conversation')?.textContent } },
    async disconnect() {
      release(); connection = { state: 'disconnected', message: '连接中断；原会话和草稿保留。' }; publish()
      await client?.dispose(); await bridge.dispose(); operations.push({ type: 'disconnect' })
    },
    async reconnect() { await connect(); operations.push({ type: 'reconnect' }) },
    visible(value: boolean) { visible = value; publish() }
  }
})
