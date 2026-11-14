// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { buildBrowserControlFeedbackScript } from '../src/main/browser-control-feedback'
import { buildBrowserFeedbackSuppressionScript, withCleanBrowserFeedback, registerBrowserFeedbackTarget, removeBrowserFeedbackTarget, expireBrowserFeedbackTarget } from '../src/main/browser-feedback-presentation'
import { DEFAULT_BROWSER_AGENT_CONTROL } from '../src/shared/browser-agent-control'

const globals = globalThis as any
const evaluate = (code: string) => new Function('return ' + code)()
const control = (revision = 1) => evaluate(buildBrowserControlFeedbackScript({ revision, browserId: 'original-browser', ownerId: 'original-owner', navigationId: 'original-navigation', active: true, deadline: Number.MAX_SAFE_INTEGER }, DEFAULT_BROWSER_AGENT_CONTROL))
function fixture() {
  const contents = { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: vi.fn(async (_id: number, scripts: {code:string}[]) => evaluate(scripts[0]!.code)) }
  const open = vi.fn(() => { throw new Error('A top-only capture must not acquire a debugger') })
  return { contents, open, capture: <T>(body:()=>Promise<T>) => withCleanBrowserFeedback({ contents, navigationId:'original-navigation',worldId:1209,openTransport:open,capture:body }) }
}
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve} }
afterEach(()=>{globals.__agentMuxBrowserControlFeedback?.dispose();delete globals.__agentMuxBrowserControlFeedback;delete globals.__agentMuxBrowserFeedbackPresentation;document.body.replaceChildren();vi.restoreAllMocks();vi.useRealTimers()})

it('[clean-feedback] hides only the original display host and restores it after capture failure', async()=>{
 const f=fixture();const input=document.createElement('input');input.value='Original page draft';document.body.append(input);input.focus()
 const page=document.createElement('div');page.setAttribute('data-agentmux-browser-control-feedback','');page.style.opacity='.7';document.body.append(page)
 control();const state=globals.__agentMuxBrowserControlFeedback,host=state.host,revision=state.revision
 await expect(f.capture(async()=>{expect(host.style.opacity).toBe('0');expect(page.style.opacity).toBe('.7');expect(state.revision).toBe(revision);throw new Error('Original pixels failed')})).rejects.toThrow('Original pixels failed')
 expect(state.host).toBe(host);expect(host.style.opacity).toBe('1');expect(document.activeElement).toBe(input);expect(input.value).toBe('Original page draft');expect(f.open).not.toHaveBeenCalled()
})
it('[clean-feedback] overlapping captures and replacement decorations share tokens without reviving disposed hosts', async()=>{
 const f=fixture();control();const old=globals.__agentMuxBrowserControlFeedback.host,a=deferred<void>(),b=deferred<void>(),entered=deferred<void>();let both=0
 const body=async(wait:Promise<void>)=>{if(++both===2)entered.resolve();await wait;expect(globals.__agentMuxBrowserControlFeedback.host.style.opacity).toBe('0')}
 const first=f.capture(()=>body(a.promise)),second=f.capture(()=>body(b.promise));await entered.promise
 control(2);const current=globals.__agentMuxBrowserControlFeedback.host;expect(current).not.toBe(old);expect(old.isConnected).toBe(false);expect(current.style.opacity).toBe('0')
 a.resolve();await first;expect(current.style.opacity).toBe('0');b.resolve();await second;expect(current.style.opacity).toBe('1');expect(globals.__agentMuxBrowserFeedbackPresentation.tokens.size).toBe(0)
})
it('[clean-feedback] includes the original named iframe world using its exact OOPIF sender before its parent tree',async()=>{
 const f=fixture();control();const child=vi.fn(async(method:string,params?:Record<string,unknown>)=>{
  if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'owned-frame'}}}
  if(method==='Page.createIsolatedWorld')return{executionContextId:42}
  if(method==='Runtime.evaluate')return{result:{value:evaluate(params!.expression as string)}}
  throw new Error('Unexpected child command '+method)
 });const main=vi.fn(async(method:string)=>{if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'main'},childFrames:[{frame:{id:'owned-frame'}}]}};throw new Error('The parent cannot drive this child world')})
 const target={send:child,id:42,frameId:'owned-frame',navigationId:'original-navigation'};await registerBrowserFeedbackTarget(f.contents,target)
 try{const outcome=await withCleanBrowserFeedback({contents:f.contents,navigationId:'original-navigation',worldId:1209,transport:{sendCommand:main,frames:new Map([['oopif-original',child]])},openTransport:f.open,capture:async()=>{expect(globals.__agentMuxBrowserControlFeedback.host.style.opacity).toBe('0');return 'original child pixels'}}).then(value=>({value}),error=>({error:String(error)}));expect(outcome).toEqual({value:'original child pixels'})
 expect(child).toHaveBeenCalledWith('Page.createIsolatedWorld',{frameId:'owned-frame',worldName:'agentmux-browser-operation-feedback'});expect(main.mock.calls.every(row=>row[0]==='Page.getFrameTree')).toBe(true);expect(globals.__agentMuxBrowserControlFeedback.host.style.opacity).toBe('1')
 }finally{removeBrowserFeedbackTarget(f.contents,target)}
})
it('[clean-feedback] retires expired completed cues before acquiring unrelated CDP or rejecting a missing old frame',async()=>{
 const f=fixture();vi.useFakeTimers();const target={send:vi.fn(),id:42,frameId:'expired-frame',navigationId:'original-navigation'}
 await registerBrowserFeedbackTarget(f.contents,target);expireBrowserFeedbackTarget(f.contents,target,Date.now()+900);vi.advanceTimersByTime(901)
 const outcome=await f.capture(async()=>true).then(value=>({value}),error=>({error:String(error)}));expect(outcome).toEqual({value:true});expect(f.open).not.toHaveBeenCalled()
})
it('[clean-feedback] restores already suppressed hosts when a target world is unavailable and keeps both capture/restoration errors',async()=>{
 const f=fixture();control();const target={send:vi.fn(),id:42,frameId:'owned-frame',navigationId:'original-navigation'};await registerBrowserFeedbackTarget(f.contents,target)
 try{await expect(withCleanBrowserFeedback({contents:f.contents,navigationId:'original-navigation',worldId:1209,transport:{sendCommand:vi.fn(async()=>{throw new Error('Original target unavailable')}),frames:new Map()},openTransport:f.open,capture:vi.fn()})).rejects.toThrow('Original target unavailable');expect(globals.__agentMuxBrowserControlFeedback.host.style.opacity).toBe('1')}
 finally{removeBrowserFeedbackTarget(f.contents,target)}
 const original=f.contents.executeJavaScriptInIsolatedWorld;f.contents.executeJavaScriptInIsolatedWorld=vi.fn(async(id,scripts)=>scripts[0]!.code.includes(',false)')?false:original(id,scripts))
 await expect(f.capture(async()=>{throw new Error('Pixels failed')})).rejects.toBeInstanceOf(AggregateError)
})
it('[clean-feedback] newly registered exact targets inherit an in-flight capture and restore in finally',async()=>{
 const f=fixture();control();const entered=deferred<void>(),done=deferred<void>();const running=f.capture(async()=>{entered.resolve();await done.promise});await entered.promise
 const send=vi.fn(async(method:string,params?:Record<string,unknown>)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'new-frame'}}}:method==='Page.createIsolatedWorld'?{executionContextId:7}:{result:{value:evaluate(params!.expression as string)}})
 const target={send,id:7,frameId:'new-frame',navigationId:'original-navigation'}
 // This fixture supplies a live original capture lease only when a target actually appears.
 f.open.mockImplementation(()=>({sendCommand:send,frames:new Map(),detach:vi.fn(()=>null)}) as never)
 await registerBrowserFeedbackTarget(f.contents,target);expect(globals.__agentMuxBrowserFeedbackPresentation.tokens.size).toBe(1);done.resolve();await running;expect(globals.__agentMuxBrowserFeedbackPresentation.tokens.size).toBe(0);removeBrowserFeedbackTarget(f.contents,target)
})

it('[clean-feedback] includes its real operation cursor and click ripple without clearing phase, token or the page',async()=>{
 const {buildBrowserOperationTargetFeedbackDeclaration}=await import('../src/main/browser-operation-feedback')
 const {browserAgentEffectsCss}=await import('../src/shared/browser-agent-control')
 const f=fixture(),button=document.createElement('button');button.textContent='Original page button';document.body.append(button)
 button.getBoundingClientRect=()=>new DOMRect(20,30,80,24)
 const shown=new WeakSet<Element>(),matches=Element.prototype.matches
 vi.spyOn(Element.prototype,'matches').mockImplementation(function(this:Element,selector:string){return selector===':popover-open'?shown.has(this):matches.call(this,selector)})
 const previous=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'showPopover');Object.defineProperty(HTMLElement.prototype,'showPopover',{configurable:true,value:function(this:HTMLElement){shown.add(this)}})
 const payload={revision:1,operationId:'original-operation',navigationId:'original-navigation',phase:'running',kind:'target',token:'original-action-token',label:'Agent · Click',method:'click',keyLabel:'',operatorName:'Agent',actionLabel:'Click',deadline:Number.MAX_SAFE_INTEGER,completedMs:900,moveMs:0,clearReason:'invalidate',preferences:DEFAULT_BROWSER_AGENT_CONTROL,css:browserAgentEffectsCss(DEFAULT_BROWSER_AGENT_CONTROL)}
 try{
  new Function('return ('+buildBrowserOperationTargetFeedbackDeclaration()+')')().call(button,payload)
  const state=globals.__agentMuxBrowserOperationFeedback,host=state.host
  expect(host).not.toBeNull()
  await f.capture(async()=>{
    expect(host.style.opacity).toBe('0');state.click({...payload,revision:2})
    const ripple=document.querySelector<HTMLElement>('[data-agentmux-browser-click-feedback]')!
    expect(ripple).not.toBeNull();expect(ripple.style.opacity).toBe('0');expect(state.phase).toBe('running');expect(state.token).toBe('original-action-token')
  })
  expect(state.host).toBe(host);expect(host.style.opacity).toBe('1');expect(document.querySelector<HTMLElement>('[data-agentmux-browser-click-feedback]')!.style.opacity).toBe('1');expect(button.isConnected).toBe(true)
  state.cleanup();delete globals.__agentMuxBrowserOperationFeedback
 }finally{if(previous)Object.defineProperty(HTMLElement.prototype,'showPopover',previous);else Reflect.deleteProperty(HTMLElement.prototype,'showPopover')}
})

it('[clean-feedback-paint] shares one original submitted-frame observation and primer between concurrent captures',async()=>{
 const {confirmBrowserFeedbackPaint}=await import('../src/main/browser-feedback-presentation')
 const {EventEmitter}=await import('node:events')
 const f=fixture(),primer=deferred<void>();let present!:()=>void
 const contents=Object.assign(new EventEmitter(),f.contents,{beginFrameSubscription:vi.fn((_dirty:boolean,callback:()=>void)=>{present=callback}),endFrameSubscription:vi.fn(),invalidate:vi.fn(),capturePage:vi.fn(()=>primer.promise)})
 const first=confirmBrowserFeedbackPaint(contents as never),second=confirmBrowserFeedbackPaint(contents as never)
 expect(contents.beginFrameSubscription).toHaveBeenCalledTimes(1);expect(contents.capturePage).toHaveBeenCalledExactlyOnceWith(undefined,{stayHidden:true});present();primer.resolve();await Promise.all([first,second])
 expect(contents.endFrameSubscription).toHaveBeenCalledTimes(1);expect(contents.eventNames()).toEqual([])
})
it('[clean-feedback-paint] releases its one-shot observer on original native pixel failure',async()=>{
 const {confirmBrowserFeedbackPaint}=await import('../src/main/browser-feedback-presentation')
 const {EventEmitter}=await import('node:events')
 const f=fixture(),contents=Object.assign(new EventEmitter(),f.contents,{beginFrameSubscription:vi.fn(),endFrameSubscription:vi.fn(),invalidate:vi.fn(),capturePage:vi.fn(async()=>{throw new Error('Original repaint capture failed')})})
 await expect(confirmBrowserFeedbackPaint(contents as never)).rejects.toThrow('Original repaint capture failed');expect(contents.endFrameSubscription).toHaveBeenCalledTimes(1);expect(contents.eventNames()).toEqual([])
})

it('[clean-feedback-paint] a returned primer without any submitted frame ends only this observation and restores the original host',async()=>{
 const {confirmBrowserFeedbackPaint}=await import('../src/main/browser-feedback-presentation')
 const {EventEmitter}=await import('node:events');vi.useFakeTimers();control()
 const f=fixture(),contents=Object.assign(new EventEmitter(),f.contents,{beginFrameSubscription:vi.fn(),endFrameSubscription:vi.fn(),invalidate:vi.fn(),capturePage:vi.fn(async()=>undefined)})
 let outcome:unknown
 const running=withCleanBrowserFeedback({contents,navigationId:'original-navigation',worldId:1209,openTransport:f.open,confirmPaint:()=>confirmBrowserFeedbackPaint(contents as never),capture:vi.fn(async()=>true)}).then(()=>({status:'unexpected-clean'}),error=>({status:'unconfirmed',message:String(error)})).then(value=>{outcome=value})
 try { await vi.advanceTimersByTimeAsync(1501);expect(outcome).toEqual({status:'unconfirmed',message:expect.stringContaining('observation budget')}) } finally { contents.emit('destroyed');await running }
 expect(contents.endFrameSubscription).toHaveBeenCalledTimes(1);expect(contents.eventNames()).toEqual([]);expect(globals.__agentMuxBrowserControlFeedback.host.style.opacity).toBe('1');expect(globals.__agentMuxBrowserFeedbackPresentation.tokens.size).toBe(0);expect(vi.getTimerCount()).toBe(0)
})

it('[clean-feedback-paint] a pending native primer retains the original resource hold after the observation ends without replay',async()=>{
 const {confirmBrowserFeedbackPaint}=await import('../src/main/browser-feedback-presentation')
 const {EventEmitter}=await import('node:events');vi.useFakeTimers()
 const f=fixture(),primer=deferred<void>();let present!:()=>void,reads=0
 const contents=Object.assign(new EventEmitter(),f.contents,{beginFrameSubscription:vi.fn((_dirty:boolean,callback:()=>void)=>{present=callback}),endFrameSubscription:vi.fn(),invalidate:vi.fn(),capturePage:vi.fn(()=>primer.promise)})
 const retain=(pending:Promise<unknown>)=>{reads++;void pending.then(()=>reads--,()=>reads--)}
 const first=confirmBrowserFeedbackPaint(contents as never,100,retain).then(()=>({status:'unexpected-clean'}),error=>({status:'unconfirmed',message:String(error)}))
 present();await vi.advanceTimersByTimeAsync(101);expect(await first).toEqual({status:'unconfirmed',message:expect.stringContaining('observation budget')})
 expect(reads).toBe(1);expect(contents.endFrameSubscription).toHaveBeenCalledTimes(1);expect(contents.eventNames()).toEqual([])
 await expect(confirmBrowserFeedbackPaint(contents as never,100,retain)).rejects.toThrow('observation budget');expect(contents.capturePage).toHaveBeenCalledTimes(1);expect(reads).toBe(1)
 primer.resolve();await primer.promise;await Promise.resolve();expect(reads).toBe(0)
})
