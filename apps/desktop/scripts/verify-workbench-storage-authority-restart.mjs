import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Reuse the existing actual Main/PTY fixture, preserving its four-phase/LIVE predicates.
// Only this private generated copy receives storage qualification, refused-quit, and closed-DB reads.
const repositoryRoot = resolve(process.env.AGENTMUX_VERIFY_REPOSITORY_ROOT ?? resolve(import.meta.dirname, '../../..'))
const visualOnly = process.argv.includes('--visual-only')
const original = join(repositoryRoot, 'apps/desktop/scripts/verify-region-terminal-refresh.mjs')
let source = await readFile(original, 'utf8')
function replaceOnce(before, after) {
  assert.equal(source.split(before).length - 1, 1, `Nonempty unique fixture seam: ${before}`)
  source = source.replace(before, after)
}
replaceOnce('mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile', 'cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile')
replaceOnce("'apps/desktop/scripts/probe-process.mjs'", "'apps/desktop/scripts/probe-process.mjs',\n 'apps/desktop/src/main/index.ts','apps/desktop/src/main/workbench-storage-authority.ts','apps/desktop/src/main/window-state-persistence.ts',\n 'apps/desktop/src/main/client-observation.ts','apps/desktop/src/shared/client-observation.ts','apps/desktop/src/renderer/src/main.tsx','apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx',\n 'apps/desktop/scripts/package-macos.mjs','apps/desktop/scripts/package-runtime-upgrade.mjs','apps/desktop/scripts/verify-workbench-storage-authority-restart.mjs'")
replaceOnce("schema:'agentmux.region-terminal-refresh.v1'", "schema:'agentmux.workbench-storage-authority.v1'")
replaceOnce("const draft='Unsent exact Region draft survives failed observation and two restarts'", "let draft='Unsent exact Region draft survives failed observation and two restarts'")
replaceOnce("receipt.firstQuit=await normalQuit(first);await exactRun(item)", "await missingStorageKeepsWorking(first,durable,item,draft,'database');await missingStorageKeepsWorking(first,durable,item,draft,'category');\n draft=await finalDraft(first,durable,draft,'first');\n receipt.firstQuit=await normalQuit(first);await exactRun(item);await readClosedStorage('first',durable,draft)")
replaceOnce("receipt.secondQuit=await normalQuit(second);await exactRun(item)", "draft=await finalDraft(second,durable,draft,'second');\n receipt.secondQuit=await normalQuit(second);await exactRun(item);await readClosedStorage('second',durable,draft)")
replaceOnce('const nativeHome = await cdp.evaluate', 'await storageScope(main,cdp,label)\n  const nativeHome = await cdp.evaluate')
// The READY-file smoke branch has no successful RendererUpdates owner. Observe ordinary product
// startup instead; this public Electron read does not install state or change lifecycle facts.
replaceOnce('...fixtureEnvironment, AGENTMUX_DESKTOP_READY_FILE: readyFile', '...fixtureEnvironment')
replaceOnce("return JSON.parse(await readFile(readyFile, 'utf8'))", `return await main.evaluate("(() => {const e=process.getBuiltinModule('module').createRequire("+JSON.stringify(join(desktopRoot,'package.json'))+")('electron');const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));return e.app.isReady()&&w&&!w.webContents.isLoading()?{pid:process.pid,loaded:true}:null})()")`)
replaceOnce("join(repositoryRoot,'.tmp/region-terminal-refresh-last.json')", "join(repositoryRoot,'.tmp/workbench-storage-authority-last.json')")
const additional = String.raw`
async function storageScope(main,cdp,label) {
 const paths=await main.evaluate("(() => {const e=process.getBuiltinModule('module').createRequire("+JSON.stringify(join(desktopRoot,'package.json'))+")('electron');const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));return {userData:e.app.getPath('userData'),sessionData:e.app.getPath('sessionData'),actual:w.webContents.session.getStoragePath()}})()")
 assert.deepEqual(paths,{userData,sessionData:userData,actual:userData},'Actual window storage must be this invocation private root')
 const observed=(await control('inspect.client')).observation
 assert.deepEqual(observed.main.storage,{userData,sessionData:userData,directory:userData,localStorage:'present',detail:null})
 ;(receipt.storageScopes??=[]).push({label,...paths})
}
async function missingStorageKeepsWorking(probe,durable,item,draft,mode) {
 phase='actual-missing-'+mode+'-refuses-quit'
 const {requireOutgoingWorkbenchStorage}=await import(pathToFileURL(join(desktopRoot,'scripts/package-runtime-upgrade.mjs')))
 const directory=mode==='database'?join(userData,'Local Storage','leveldb'):join(userData,'Local Storage'),held=directory+'.held'
 assert.ok(userData.startsWith(root+'/'));assert.notEqual(root,'/');await rename(directory,held)
 try {
  const observed=(await control('inspect.client')).observation
  receipt.currentMissingCase={mode,directory,observedStorage:observed.main.storage,tabCount:observed.workbench.tabs.length};
  assert.ok(observed.workbench.tabs.length>0);assert.equal(observed.main.storage.directory,userData);assert.equal(observed.main.storage.localStorage,'missing')
  assert.throws(()=>requireOutgoingWorkbenchStorage(observed),/existing interface and Runs were kept/)
  const failure=await probe.cdp.evaluate("window.agentmux.ui.requestStorageFlush().then(()=>({fulfilled:true}),e=>({fulfilled:false,message:String(e)}))")
  assert.equal(failure.fulfilled,false,'An actual missing category must reject the platform save request')
  await probe.main.evaluate("process.getBuiltinModule('module').createRequire("+JSON.stringify(join(desktopRoot,'package.json'))+")('electron').app.quit()")
  const paused=await waitFor('refused quit service window',()=>probe.cdp.evaluate("document.body.textContent.includes('Quitting was paused because saving the workbench is unconfirmed')"),8_000).catch(error=>({unavailable:error.message}))
  assert.equal(paused,true,'The original window must remain and report the refused quit')
  assert.equal(probe.child.exitCode,null);assert.equal(probe.child.signalCode,null)
  await click(probe.cdp,'button[title="System notifications"]')
  await waitFor('actual save notice visible',()=>probe.cdp.evaluate("document.querySelector('.global-system-notices__details[data-state=\"open\"]')?.textContent.includes('Saving the workbench is unconfirmed')"))
  const png=await probe.cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});assert.ok(png.data.length>0)
  const imagePath=join(repositoryRoot,'.tmp/workbench-storage-'+mode+'-refused-quit.png');await writeFile(imagePath,Buffer.from(png.data,'base64'))
  ;(receipt.images??=[]).push({mode,path:imagePath,sha256:digest(Buffer.from(png.data,'base64'))})
  await click(probe.cdp,'button[title="Collapse system notifications"]')
  assert.deepEqual((await localState(probe.cdp)).restoredWorkbench,durable.workbench)
  assert.equal((await localState(probe.cdp)).agentComposerDrafts[session.agentSessionId],draft)
  const before=await status(item),runBefore=await exactRun(item)
  await keyboard(probe.cdp,durable.regionIds[0],'z')
  await waitFor('same child still receives input after save refusal',async()=> (await status(item)).z===before.z+1)
  const runAfter=await exactRun(item)
  assert.equal(runAfter.acceptedInputBytes,runBefore.acceptedInputBytes+1,'No automatic or unknown input is dispatched')
  assert.ok(runAfter.latestOutputBytes>runBefore.latestOutputBytes)
  receipt.missingStorage={originalRoot:userData,localStorage:observed.main.storage.localStorage,saveRejected:true,quitPaused:true,
   sameRun:item.runId,samePid:item.pid,inputDelta:1,outputIncreased:true,draftRetained:true,topologyRetained:true,
   mode,causeBoundary:'Private existing '+mode+' directory renamed; historical production directory disappearance remains unknown.'}
 } finally {await rename(held,directory)}
 await probe.cdp.evaluate('window.agentmux.ui.requestStorageFlush()')
 assert.equal((await control('inspect.client')).observation.main.storage.localStorage,'present')
 receipt.missingStorage.retryAccepted=true
 ;(receipt.missingCases??=[]).push(receipt.missingStorage)
}
async function finalDraft(probe,durable,draft,label) {
 await click(probe.cdp,'[data-workbench-region-id="'+durable.regionIds[0]+'"] .composer [role="textbox"]')
 const suffix=' '+label+'-last-change-before-quit'
 const changed=draft+suffix
 await probe.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4})
 await probe.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4})
 await probe.cdp.call('Input.insertText',{text:changed})
 // This is intentionally inside the 400ms trailing writer window; quit must land the pending batch.
 return changed
}
async function readClosedStorage(label,durable,draft) {
 phase='closed-database-read-'+label
 const readerRoot=join(root,'closed-reader-'+label),data=join(readerRoot,'user-data')
 await mkdir(readerRoot,{recursive:true});await cp(join(userData,'Local Storage'),join(data,'Local Storage'),{recursive:true})
 const blank=join(readerRoot,'blank.html'),entry=join(readerRoot,'read.cjs'),record=join(readerRoot,'record.json'),pathsFile=join(readerRoot,'paths.json')
 await writeFile(blank,'<!doctype html><title>Private closed storage reader</title>')
 await writeFile(entry,
  "const {app,BrowserWindow,session}=require('electron');const fs=require('node:fs');"+
  "app.setPath('userData',"+JSON.stringify(data)+");app.setPath('sessionData',"+JSON.stringify(data)+");app.setName('Private storage reader');"+
  "app.whenReady().then(async()=>{const paths={userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),actual:session.defaultSession.getStoragePath()};"+
  "if(Object.values(paths).some(p=>p!=="+JSON.stringify(data)+"))throw Error('Private storage authority mismatch');fs.writeFileSync("+JSON.stringify(pathsFile)+",JSON.stringify(paths));"+
  "const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadFile("+JSON.stringify(blank)+");"+
  "const raw=await w.webContents.executeJavaScript(\"localStorage.getItem('agentmux-workbench-v1')\");if(!raw)throw Error('Closed original workbench absent');"+
  "fs.writeFileSync("+JSON.stringify(record)+",raw);w.close();app.quit()}).catch(e=>{console.error(e.message);app.exit(1)});"
 )
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
 const child=spawn(require('electron'),[entry],{cwd:readerRoot,env,detached:true,stdio:['ignore','ignore','pipe']});children.add(child)
 let stderr='';child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-4096)})
 await waitFor('closed private reader exit',()=>child.exitCode!==null||child.signalCode!==null,20_000)
 assert.equal(child.exitCode,0,stderr);assert.equal(child.signalCode,null);children.delete(child)
 const bytes=await readFile(record),stored=JSON.parse(bytes).state,paths=JSON.parse(await readFile(pathsFile,'utf8'))
 assert.deepEqual(paths,{userData:data,sessionData:data,actual:data})
 assert.ok(Object.keys(stored.restoredWorkbench.tabs).length>0);assert.ok(Object.keys(stored.restoredWorkbench.layouts).length>0)
 assert.deepEqual(stored.restoredWorkbench,durable.workbench);assert.equal(stored.agentComposerDrafts[session.agentSessionId],draft)
 assert.ok(draft.length>0)
 ;(receipt.closedStorageReads??=[]).push({label,paths,sha256:digest(bytes),bytes:bytes.length,
  tabs:Object.keys(stored.restoredWorkbench.tabs).length,layouts:Object.keys(stored.restoredWorkbench.layouts).length,
  regions:durable.regionIds.length,draftSha256:digest(draft),draftRetained:true,noProductAppLoaded:true,noRuntimeConnected:true})
}
`
replaceOnce('const python=String.raw`', additional + '\nconst python=String.raw`')
if (visualOnly) {
  // A finite re-capture after summary-only presentation changes; never substitutes for the full gate.
  const start=source.indexOf(" draft=await finalDraft(first"),end=source.indexOf(" receipt.after=await identity()",start)
  assert.ok(start>0&&end>start,'Nonempty unique post-fault capture range')
  assert.equal(source.indexOf(" draft=await finalDraft(first",start+1),-1)
  source=source.slice(0,start)+" receipt.visualOnly=true;\n"+source.slice(end)
  replaceOnce("schema:'agentmux.workbench-storage-authority.v1'","schema:'agentmux.workbench-storage-visual.v1'")
}
const attempt = join(repositoryRoot, '.tmp/workbench-storage-authority-proofs', 'attempt-' + Date.now())
await mkdir(attempt, { recursive: true })
const generated = join(attempt, 'actual-private.mjs')
await writeFile(generated, source)
await writeFile(join(attempt, 'fixture-input.json'), JSON.stringify({ original, originalSha256: createHash('sha256').update(await readFile(original)).digest('hex'), generatedSha256: createHash('sha256').update(source).digest('hex'), extensionOnly: true }, null, 2)+'\n')
const child = spawn(process.execPath, [generated], { cwd: repositoryRoot, env: { ...process.env, AGENTMUX_VERIFY_REPOSITORY_ROOT: repositoryRoot }, stdio: 'inherit' })
const status = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal })) })
assert.equal(status.signal, null);assert.equal(status.code, 0, 'Actual storage authority/restart proof failed')
const receipt = JSON.parse(await readFile(join(repositoryRoot, '.tmp/workbench-storage-authority-last.json'), 'utf8'))
assert.equal(receipt.passed, true)
if (visualOnly) { assert.equal(receipt.visualOnly,true);assert.equal(receipt.images.length,2);assert.equal(receipt.storageScopes.length,1) }
else { assert.equal(receipt.storageScopes.length,3);assert.equal(receipt.closedStorageReads.length,2) }
assert.equal(receipt.missingCases.length,2);assert.deepEqual(receipt.missingCases.map(c=>c.mode),['database','category']);assert.equal(receipt.missingStorage.quitPaused,true);assert.equal(receipt.missingStorage.retryAccepted,true)
assert.deepEqual(receipt.cleanup.privateProcessesRemaining,[]);assert.equal(receipt.cleanup.rootRemoved,true)
await writeFile(join(attempt,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
