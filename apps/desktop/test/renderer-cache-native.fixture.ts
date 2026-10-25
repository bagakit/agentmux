import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { RendererCacheController } from '../src/main/renderer-cache.js'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import { registerPerformanceCaptureIpc } from '../src/main/performance-capture-ipc.js'
import { CONTROL_REQUEST_CHANNEL, CONTROL_RESPONSE_CHANNEL, CONTROL_CANCEL_CHANNEL } from '../src/shared/contracts.js'
import { THEME_BOOTSTRAP_CHANNEL } from '../src/shared/theme-bootstrap.js'

async function run() {
  const directory = process.env.RENDERER_CACHE_NATIVE_DIRECTORY!
  app.setPath('userData', join(directory, 'user-data'))
  app.setActivationPolicy('prohibited')
  await app.whenReady(); app.dock?.hide()
  ipcMain.on(THEME_BOOTSTRAP_CHANNEL, event => { event.returnValue = {status:'unavailable', message:'Private qualification window'} })
  const http = createServer((request,response) => {
    if(request.url==='/resource.svg') {response.setHeader('Content-Type','image/svg+xml');response.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="green"/></svg>');return}
    if(request.url==='/style.css') {response.setHeader('Content-Type','text/css');response.end('#reader {height:120px;overflow:auto} #body {height:2400px}');return}
    if(request.url==='/consumer.js') {response.setHeader('Content-Type','text/javascript');response.end(readFileSync(join(directory,'consumer.js')));return}
    response.setHeader('Content-Type','text/html');response.end('<title>Original cache consumer</title><link rel="stylesheet" href="/style.css"><textarea id="draft"></textarea><img id="resource" src="/resource.svg"><div id="reader"><div id="body">Retained reader</div></div><script src="/consumer.js"></script>')
  })
  await new Promise<void>(resolve => http.listen(0,'127.0.0.1',resolve))
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,preload:join(directory,'preload.cjs')}})
  const contents=window.webContents, deliveries: unknown[]=[]
  const currentTarget=()=>{if(window.isDestroyed()||contents.isLoadingMainFrame())return null;const pid=contents.getOSProcessId(),metric=app.getAppMetrics().find(m=>m.pid===pid);return metric ? {windowId:window.id,webContentsId:contents.id,generation:1,pid,creationTime:metric.creationTime} : null}
  const bridge=new DesktopControlIpcBridge({isAvailable:()=>!contents.isDestroyed(),sendRequest:request=>{deliveries.push(request);contents.send(CONTROL_REQUEST_CHANNEL,request)},sendCancellation:cancel=>contents.send(CONTROL_CANCEL_CHANNEL,cancel)})
  ipcMain.on(CONTROL_RESPONSE_CHANNEL,(event,response)=>{if(event.sender===contents)bridge.accept(response)})
  const cache=new RendererCacheController(bridge,currentTarget)
  const metrics=createResourceMetricsPort({sampler:{subscribe(){throw Error('No sampler may start')}} as never,currentWindow:currentTarget,cache})
  registerPerformanceCaptureIpc(metrics,(channel,listener)=>ipcMain.handle(channel,(event,raw)=>{if(event.sender!==contents)throw Error('wrong sender');return listener(event,raw)}))
  const owner=new AgentMuxControlServer({metrics,coreClients:()=>[]},process.env.RENDERER_CACHE_NATIVE_SOCKET!)
  const address=http.address();if(!address||typeof address==='string')throw Error('private HTTP address missing')
  await window.loadURL('http://127.0.0.1:'+address.port)
  await contents.executeJavaScript(`(async()=>{await document.querySelector('#resource').decode();globalThis.originalNode=document.querySelector('#draft');globalThis.liveObject={value:42};originalNode.value='unsaved original draft';originalNode.setSelectionRange(3,10);document.querySelector('#reader').scrollTop=743;localStorage.setItem('cache-qualification','durable-value');sessionStorage.setItem('cache-qualification','session-value');globalThis.cacheState=()=>({sameNode:originalNode===document.querySelector('#draft'),draft:originalNode.value,selection:[originalNode.selectionStart,originalNode.selectionEnd],scroll:document.querySelector('#reader').scrollTop,local:localStorage.getItem('cache-qualification'),session:sessionStorage.getItem('cache-qualification'),live:liveObject.value,image:document.querySelector('#resource').naturalWidth});globalThis.cacheStateBefore=cacheState()})()`)
  await owner.start()
  writeFileSync(join(directory,'ready.json'),JSON.stringify({target:currentTarget(),electron:process.versions.electron,chromium:process.versions.chrome}))
  console.log('ready')
  const input=createInterface({input:process.stdin})
  input.on('line',async line=>{if(line!=='quit')return
    const target=currentTarget()
    const gui=await contents.executeJavaScript(`agentmux.performance.inspectCache(${JSON.stringify({target})})`)
    const preservation=await contents.executeJavaScript(`(()=>{const before=cacheStateBefore,after=cacheState();liveObject.value++;originalNode.value+='!';return{before,after,continued:liveObject.value===43&&originalNode.value.endsWith('!')}})()`)
    writeFileSync(join(directory,'final.json'),JSON.stringify({target,gui,preservation,deliveries,visible:window.isVisible(),attached:contents.debugger.isAttached()},null,2))
    input.close();await owner.stop();metrics.dispose();bridge.dispose();window.destroy();await new Promise<void>(resolve=>http.close(()=>resolve()));app.quit()
  })
}
void run().catch(error=>{console.error(error);app.exit(1)})
