import {app,BrowserWindow} from 'electron'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {BrowserCdpSession} from '../../../src/main/browser-cdp-session'
import {createBrowserNetworkRouting} from '@agentmux/browser/operations'
const root=process.env.PRIVATE_NETWORK_ROOT!,url=process.env.PRIVATE_NETWORK_URL!,out=process.env.PRIVATE_NETWORK_RECEIPT!
app.setPath('userData',root);app.setPath('sessionData',join(root,'session'))
const receipt:any={passed:false,cases:[],notes:[],stage:'starting'};let window:BrowserWindow, session:BrowserCdpSession, owner:ReturnType<typeof createBrowserNetworkRouting>
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
 try{
 window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL(url)
 session=BrowserCdpSession.attach(window.webContents);receipt.version=await session.sendCommand('Browser.getVersion')
 const signal=new AbortController();const cleanups:(()=>Promise<void>)[]=[]
 owner=createBrowserNetworkRouting({session,signal:signal.signal,pageInfo:()=>({navigationId:'original'}),registerCleanup:fn=>cleanups.push(fn),note:note=>receipt.notes.push(note)})
 const fetch=()=>window.webContents.executeJavaScript("fetch('/submit',{method:'POST'}).then(r=>r.text()).catch(e=>'failed:'+e.message)")
 receipt.baseline=await fetch();receipt.stage='mock';receipt.configured=await owner.route([{match:{url:url+'submit'},action:'mock',body:'mocked'}]);receipt.mocked=await fetch();receipt.withdrawn=await owner.unroute();receipt.afterUnroute=await fetch()
 receipt.stage='conditions';receipt.conditions=await owner.setConditions({offline:true});receipt.offline=await fetch();receipt.cleared=await owner.clearConditions();receipt.online=await fetch()
 receipt.stage='latency';await owner.setConditions({latencyMs:200});const latencyStart=performance.now();await fetch();receipt.latencyMs=performance.now()-latencyStart;await owner.clearConditions();
 receipt.stage='stop';await owner.route([{match:{url:url+'submit'},action:'abort'}]);signal.abort();for(const cleanup of cleanups)await cleanup()
 receipt.afterStop=await fetch();receipt.originalReader=!!(await session.sendCommand('DOM.getDocument') as {root?:unknown}).root
 const faultSignal=new AbortController(),faultCleanups:(()=>Promise<void>)[]=[];let lateClose:undefined|(()=>Promise<void>)
 const faultSession={sendCommand:session.sendCommand,frames:session.frames,endedReason:session.endedReason,frameDiscoveryFailure:session.frameDiscoveryFailure,observe:session.observe.bind(session),openNetworkSession:async()=>{const native=await session.openNetworkSession();return{...native,get endedReason(){return native.endedReason},close:()=>new Promise<void>((resolve,reject)=>{lateClose=()=>native.close().then(resolve,reject)})}}}
 const faultOwner=createBrowserNetworkRouting({session:faultSession,signal:faultSignal.signal,pageInfo:()=>({navigationId:'original'}),registerCleanup:fn=>faultCleanups.push(fn),note:note=>receipt.notes.push(note)})
 await faultOwner.route([{match:{url:url+'submit'},action:'mock',body:'must not be replayed'}]);faultSignal.abort();const cleanupStart=performance.now();for(const cleanup of faultCleanups)await cleanup();receipt.unknownCleanupMs=performance.now()-cleanupStart;receipt.afterUnknown=await fetch();receipt.originalAfterUnknown=!!(await session.sendCommand('DOM.getDocument') as {root?:unknown}).root;await lateClose!();await faultOwner.dispose()
 receipt.passed=receipt.baseline==='accepted'&&receipt.mocked==='mocked'&&receipt.afterUnroute==='accepted'&&receipt.offline.startsWith('failed:')&&receipt.online==='accepted'&&receipt.afterStop==='accepted'&&receipt.originalReader&&receipt.latencyMs>=140&&receipt.unknownCleanupMs<3000&&receipt.afterUnknown==='accepted'&&receipt.originalAfterUnknown&&receipt.notes.some((note:string)=>note.includes('cleanup is unconfirmed'))
 }catch(error){receipt.error=String((error as Error).stack??error)}finally{await owner?.dispose();session?.detach();window?.destroy();await writeFile(out,JSON.stringify(receipt,null,2));app.exit(receipt.passed?0:1)}
})
