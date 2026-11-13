import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FileBookRealms,WorkspaceFileSources,WorkspaceCbrArchives,WorkspaceFiles,WorkbenchUserStateStore,assertAppDocumentSender,ipcResult } from './host.mjs'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
const require=createRequire(import.meta.url),__dirname=fileURLToPath(new URL('.',import.meta.url))
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url')
const root=process.argv[2],mode=process.argv[3],buildRoot=__dirname
const entryUptimeMs=process.uptime()*1000
const coreEntry=import.meta.resolve('@agentmux/core')
const phase=value=>console.error('book_file_restart_phase='+JSON.stringify({schema:'agentmux.book-file-restart-phase.v1',phase:value,uptimeMs:process.uptime()*1000}))
phase('entry')
app.on('window-all-closed',()=>{})
for(const[key,value]of Object.entries({home:process.env.HOME,appData:path.join(root,'app-data'),userData:path.join(root,'profile'),sessionData:path.join(root,'session-data')}))app.setPath(key,value)
app.whenReady().then(async()=>{
  const report={mode,pid:process.pid,checks:0,diagnostics:[],startup:{entryUptimeMs,coreEntry}};let window,sources,books,files,unsubscribe
  const check=(value,label)=>{report.checks++;assert.ok(value,label)}
  const stage=value=>console.error('book_file_restart_stage='+value)
  try{
    stage('host import')
    stage('static production owners loaded')
    const config={version:9,hosts:[{id:'local',kind:'local',label:'Private fixture Host'}],executors:{},workspaces:[{id:'workspace',name:'Reading',hostId:'local',path:path.join(root,'workspace'),kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
    const user=new WorkbenchUserStateStore(path.join(root,'profile/workbench-user-state.json')),spatial=new AgentMuxSpatialStateStore(path.join(root,'runtime/spatial-state.json'))
    files=new WorkspaceFiles(()=>new LocalExecutionHost());sources=new WorkspaceFileSources(files,id=>config.workspaces.find(w=>w.id===id));const archives=new WorkspaceCbrArchives(sources)
    books=new FileBookRealms(sources,archives,{rendererFile:path.join(buildRoot,'renderer/apps/desktop/src/renderer/book-reader/index.html'),preload:path.join(buildRoot,'book-reader.cjs')})
    window=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,preload:path.join(buildRoot,'index.cjs')}})
    const page=path.join(buildRoot,'renderer/apps/desktop/test/helpers/book-reader-restart/index.html'),original={current:{mode:'prod',filePath:page},loading:null}
    // The same original native top-frame admission used by product IPC.
    const counts={}
    const handleWithEvent=(channel,action)=>ipcMain.handle(channel,(event,...args)=>{assertAppDocumentSender(event,window.webContents,original);counts[channel]=(counts[channel]||0)+1;return action(event,...args)})
    require('./bindings.cjs')({handleWithEvent,fileSources:sources,comicArchives:archives,bookRealms:books,workspace:(cfg,id)=>{const value=cfg.workspaces.find(w=>w.id===id);if(!value)throw new Error('Unknown fixture Workspace');return value},config,workbenchUserState:user,ipcResult})
    ipcMain.on('ui:themeBootstrap',event=>{event.returnValue={status:'unavailable',message:'This bounded File fixture owns no platform theme bootstrap; the actual renderer theme runtime projects Graphite.'}})
    handleWithEvent('config:get',()=>config)
    handleWithEvent('providers:list',(_event,options)=>options?.observation?{catalog:[],warnings:[]}:[])
    handleWithEvent('demands:list',()=>[])
    handleWithEvent('sessions:snapshot',()=>({sessions:[],timelines:{},recoveryCandidates:[],runtimeEndpointWarnings:[],localHome:process.env.HOME}))
    handleWithEvent('sessions:endpointWarnings',()=>[])
    handleWithEvent('spatial:read',()=>spatial.read())
    handleWithEvent('spatial:commit',(_event,input)=>spatial.commit(input))
    handleWithEvent('spatial:retainLabels',(_event,values)=>spatial.retainDisplayLabels(values))
    handleWithEvent('spatial:confirmNameCommit',(_event,id)=>spatial.confirmNameCommit(id))
    handleWithEvent('ui:spatialLinksReady',()=>true)
    handleWithEvent('files:read',()=>{throw new Error('A book must never enter the whole UTF-8 text route')})
    handleWithEvent('files:readPreview',()=>{throw new Error('A book must never enter the whole bytes snapshot route')})
    unsubscribe=spatial.subscribe(value=>{if(!window.webContents.isDestroyed())window.webContents.send('spatial:changed',value)})
    window.webContents.on('console-message',event=>{if(event.level==='error')report.diagnostics.push(event.message.slice(0,600))})
    stage('load File document');await window.loadFile(page)
    stage('initialize Store')
    await window.webContents.executeJavaScript('bootBookRestart('+JSON.stringify(mode)+')')
    stage('Store initialized')
    report.startup.businessUptimeMs=process.uptime()*1000;phase('business')
    const execute=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(r=>setTimeout(r,ms))
    const wait=async predicate=>{const until=Date.now()+15000;while(Date.now()<until){const value=await execute('inspectBookRestart()');if(predicate(value))return value;await pause(30)}throw new Error('The original File did not become readable: '+JSON.stringify(await execute('inspectBookRestart()')))}
    let visible=await wait(value=>value.bookState==='ready')
    check(visible.tab.id==='retained-book-tab'&&visible.tab.regions['retained-book-region'].path==='long.epub','The original Tab and File Region are mounted')
    check(visible.tab.regions['retained-neighbor'].path==='neighbor.txt','The original split neighbor is retained')
    check(visible.draft==='An unsent draft survives the book restart','The original unsent user draft remains available')
    check(visible.text.includes('The Original File'),'The actual FileSurfaceView consumes the book document')
    check(await execute(`(()=>{const w=document.querySelector('iframe').contentWindow;return typeof w.agentmux==='undefined'&&typeof w.bookBytes==='undefined'})()`),'The real App preload does not leak into the displayed book document')
    const active=[...books.realms.values()][0],initialBookId=active.id
    await execute(`(()=>{const state=window.inspectBookRestart();window.__bookBefore=state})()`)
    if(mode==='writer'){
      await execute('checkpointBookRestart()');await pause(50);const costBefore={...counts}
      await execute(`(()=>{const d=document.querySelector('iframe').contentDocument,s=d.scrollingElement;s.scrollTop=(s.scrollHeight-s.clientHeight)*.67;d.dispatchEvent(new Event('scroll'))})()`)
      visible=await wait(value=>value.reading?.position?.progress>.65)
      await pause(900)
      report.hotPath=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value-(costBefore[key]||0)]))
      check(report.hotPath['ui:writeFileViewReading']>=1,'Ordinary reading writes only its typed native preference member')
      check(['spatial:read','spatial:commit','ui:writeWorkbenchState','files:openBook','files:openSource'].every(key=>!report.hotPath[key]),'Ordinary reading neither traverses Core topology nor rewrites the root user document or reopens the book')
      await execute('checkpointBookRestart()')
      const graph=await spatial.read(),resource=graph.graph.resources['region:retained-book-region'],saved=await user.readFileViewReading(visible.reading.owner)
      check(saved.position.progress>.65,'The actual Store commits reading metadata through the typed native File view member')
      check(!Object.hasOwn(resource,'bookReading'),'The Core spatial resource contains no Book reading state')
      check(user.observe().lastConfirmedWrite?.diskDurability==='confirmed','The native user document has a real durable writer receipt')
      const before=books.realms.size
      await execute(`hideBookRestart()`)
      for(let i=0;i<50&&books.realms.size;i++)await pause(20)
      check(books.realms.size===0,'Hiding the actual File consumer releases its exact parser realm')
      await execute(`window.__bookShow=1`)
      // Use the existing Store selector as a real visibility change, not a remount oracle.
      await execute(`window.showBookRestart()`)
      visible=await wait(value=>value.bookState==='ready')
      check(Math.abs(visible.reading.position.progress-saved.position.progress)<.03,'Showing the same File restores its saved reading place')
      await execute('checkpointBookRestart()')
      await execute(`(()=>{const d=document.querySelector('iframe').contentDocument,s=d.scrollingElement;s.scrollTop=(s.scrollHeight-s.clientHeight)*.8})()`);await execute('checkpointBookRestart()');visible=await execute('inspectBookRestart()');const instant=await user.readFileViewReading(visible.reading.owner);check(instant.position.progress>.79,'Controlled checkpoint captures DOM .8 before the ordinary 500ms publisher');
      report.readingReceipt={owner:instant.owner,position:instant.position};
      report.expected={tab:visible.tab,layout:visible.layout,activeWorkspaceId:visible.activeWorkspaceId,draft:visible.draft,progress:visible.reading.position.progress,readingOwner:visible.reading.owner,sectionId:visible.reading.position.sectionId}
      report.nativeReceipt=user.observe();report.spatialRevision=(await spatial.read()).revision
      await fs.writeFile(path.join(root,'expected.json'),JSON.stringify(report.expected))
    }else{
      const expected=JSON.parse(await fs.readFile(path.join(root,'expected.json'),'utf8'))
      check(visible.tab.id===expected.tab.id&&JSON.stringify(visible.tab.layout)===JSON.stringify(expected.tab.layout),'A second Electron process restores the original split topology and focus')
      check(JSON.stringify(visible.layout)===JSON.stringify(expected.layout),'The original display layout survives the actual process restart')
      check(visible.reading.position.sectionId===expected.sectionId,'Reading restores the original section identity')
      const physical=await execute(`(()=>{const s=document.querySelector('iframe').contentDocument.scrollingElement;return s.scrollTop/Math.max(1,s.scrollHeight-s.clientHeight)})()`)
      check(Math.abs(physical-expected.progress)<.03,'The restarted native book frame restores the physical reading position')
      report.restored=true;report.physicalProgress=physical;report.expected=expected;report.actual=visible
    }
    if(process.argv[4]){await fs.mkdir(process.argv[4],{recursive:true});await fs.writeFile(path.join(process.argv[4],mode==='writer'?'file-book-before-restart.png':'file-book-after-restart.png'),(await window.webContents.capturePage()).toPNG())}
    if(mode==='reader'){
      await execute(`document.querySelector('[aria-label="Next section"]').click()`)
      visible=await wait(value=>value.bookState==='ready'&&value.text.includes('Second chapter'))
      await pause(800)
      const navigated=await user.readFileViewReading(visible.reading.owner)
      check(navigated.position.section===1,'Explicit section navigation saves its place while idle without a scroll, close or checkpoint')
      const ownerBefore=JSON.stringify(visible.reading.owner),oldSource=[...books.realms.values()][0].source
      await fs.appendFile(path.join(root,'workspace/long.epub'),'\n')
      await execute(`document.querySelector('[aria-label="Previous section"]').click()`)
      await wait(value=>value.bookState==='error')
      await execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Reload original file').click()`)
      visible=await wait(value=>value.bookState==='ready')
      const refreshed=[...books.realms.values()][0]
      check(refreshed.source!==oldSource&&JSON.stringify(visible.reading.owner)===ownerBefore,'In-band Reload reopens the changed original File with a fresh pinned fd and preserves its reading identity')
      const firstReloadSource=refreshed.source
      await execute(`document.querySelector('[aria-label="Reload file preview"]').click()`)
      visible=await wait(value=>value.bookState==='ready')
      check([...books.realms.values()][0].source!==firstReloadSource&&JSON.stringify(visible.reading.owner)===ownerBefore,'The existing File toolbar Reload also refreshes the actual book source')
      report.recovery={sameOwner:true,changedSourceReopened:true,toolbarReload:true,navigationSaved:true}
    }
    await execute('closeBookRestart()')
    report.finalSpatial=await spatial.read();report.finalNativeReceipt=user.observe()
  }catch(error){report.failure=String(error.stack||error)}
  finally{unsubscribe?.();books?.dispose();await sources?.dispose();await files?.dispose();await fs.writeFile(path.join(root,mode+'.json'),JSON.stringify(report,null,2));if(window&&!window.isDestroyed())window.destroy();app.exit(report.failure?1:0)}
})
