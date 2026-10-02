import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Supplements the ordinary Runtime GUI with production presentation components.
// These explicit fixtures prove rendering/copy feedback, never CLI lifecycle facts.
const repository = resolve(import.meta.dirname, '../../../../..')
const desktop = join(repository, 'apps/desktop'), require = createRequire(join(desktop, 'package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const contextMode = process.env.AGENTMUX_RECOVERY_CONTEXT === '1'
const output = process.env.AGENTMUX_VERIFY_PRESENTATION_RECEIPT
assert.ok(output, 'Explicit private receipt required')
const evidence = resolve(output, '..'), temporary = await mkdtemp(join(repository, '.tmp/loading-presentation-'))
const prompt = 'Review the session recovery experience.\n保留原工作区与完整上下文，让下一次继续工作更自然。\n\n' + 'Verify the current state, original actions, complete prompt and retained layout. '.repeat(12)
const sources = [
  'apps/desktop/src/renderer/src/components/FullPageLoadingSurface.tsx',
  'apps/desktop/src/renderer/src/components/SessionConnectingSurface.tsx',
  'apps/desktop/src/renderer/src/styles/full-page-loading.css',
  'apps/desktop/src/renderer/src/styles/session-connecting.css',
  'apps/desktop/src/renderer/src/styles/tokens.css',
  'apps/desktop/resources/settings-banner.png',
  'apps/desktop/scripts/fixtures/session-loading-recovery-quality/presentation.mjs'
]
if(contextMode) sources.push('apps/desktop/src/renderer/src/components/SessionRecap.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx',
  'apps/desktop/src/renderer/src/styles/session-recap.css', 'apps/desktop/src/renderer/src/lib/launcher-resume.ts',
  'apps/desktop/scripts/fixtures/session-recovery-context/presentation-cases.tsx')
const inputsBefore = Object.fromEntries(await Promise.all(sources.map(async p => [p, hash(await readFile(join(repository, p)))])))
const entry = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { FullPageLoadingSurface } from '${join(desktop, 'src/renderer/src/components/FullPageLoadingSurface.tsx')}'
import { SessionConnectingSurface } from '${join(desktop, 'src/renderer/src/components/SessionConnectingSurface.tsx')}'
import { api } from '${join(desktop, 'src/renderer/src/lib/api.ts')}'
import { applyAppAppearance } from '${join(desktop, 'src/renderer/src/lib/app-appearance.ts')}'
import '${join(desktop, 'src/renderer/src/styles/index.css')}'
${contextMode ? `import { recoveryContextCase } from '${join(desktop,'scripts/fixtures/session-recovery-context/presentation-cases.tsx')}'` : ''}
const root=createRoot(document.getElementById('root'))
const prompt=${JSON.stringify(prompt)}
window.__fixtureCopied=[]
api.ui.writeClipboardText=async text=>{window.__fixtureCopied.push(text)}
window.__renderCase=(kind,light)=>{
 applyAppAppearance(light?'light':'dark')
 ${contextMode ? "if(kind.startsWith('context-')) { root.render(recoveryContextCase(kind)); return }" : ''}
 if(kind==='connecting') root.render(<SessionConnectingSurface phase="launch" surfaceKind="agent" request={{executorId:'fixture-reviewer',prompt}} executor={{label:'Code reviewer',providerId:'codex',command:'private-fixture',args:[],env:{},injectAgentMuxGuide:false}} />)
 else if(kind==='empty') root.render(<SessionConnectingSurface phase="connect" surfaceKind="agent" />)
 else if(kind==='startup') root.render(<FullPageLoadingSurface scope="app" phase="loading" eyebrow="AgentMux startup" title="Restoring your workspace" detail="Connecting to your saved sessions." />)
 else root.render(<FullPageLoadingSurface scope="region" phase={kind==='failed'?'failed':'parked'} title={kind==='failed'?'Restore could not complete':'Session state is unconfirmed'} detail={kind==='failed'?'The connection check failed. Your retained session is still available. Check this same session again.':'The restore check has not confirmed the process state. Your workspace and draft are retained. Check this same session again.'} actions={<button className="small-button" onClick={()=>window.__fixtureRetried=true}>Check again</button>} details={{summary:'Details',content:<p>Private presentation fixture. No lifecycle or process status is asserted.</p>}} />)
}
window.__fixtureReady=true
`
const main = `
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const hash=b=>createHash('sha256').update(b).digest('hex')
app.setPath('home',process.env.PRIVATE_HOME)
app.setPath('userData',process.env.PRIVATE_DATA)
let currentPhase='module'
const step=label=>{currentPhase=label;process.stderr.write('presentation phase: '+label+'\\n')}
step('module-loaded')
const report={schema:'agentmux.loading-presentation.v1',passed:false,kind:'production-components-private-presentation-fixture',userRuntimeTouched:false,images:[],limitations:['Explicit synthetic state and launch intent; no Core/CLI lifecycle claim. Copy uses a private transport sink; system clipboard is untouched.']}
let window
const wait=async(fn,label)=>{const end=Date.now()+12000;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,30));}throw new Error(label)}
app.whenReady().then(async()=>{
 step('app-ready')
 try{
  window=new BrowserWindow({width:1320,height:820,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  window.webContents.on('console-message',event=>{report.console??=[];report.console.push(event.message)})
  window.webContents.debugger.attach('1.3')
  const scripts=new Map()
  window.webContents.debugger.on('message',(_event,method,p)=>{if(method==='Debugger.scriptParsed'&&p.url)scripts.set(p.url,p.scriptId)})
  step('window-created')
  await window.loadURL(process.env.PRIVATE_PAGE)
  step('page-loaded')
  await window.webContents.debugger.sendCommand('Debugger.enable')
  const evaluate=x=>window.webContents.executeJavaScript(x,true)
  await wait(()=>evaluate('window.__fixtureReady'),'production component entry')
  step('components-ready')
  const cases=[['startup','startup',1320,820,false,false],['connecting','connecting',720,680,false,false],['connecting-narrow','connecting',320,520,false,false],['connecting-short','connecting',420,340,false,false],['connecting-light','connecting',720,680,true,false],['connection-unknown','unknown',520,520,false,false],['restore-failed','failed',520,520,false,false],['empty-connection','empty',520,520,false,false],['connecting-reduced','connecting',420,520,false,true]]
  ${contextMode ? "cases.splice(0,cases.length, ['connect-wide','context-connect',900,720,false,false],['connect-narrow','context-connect',340,560,false,false],['connect-light','context-connect',900,720,true,false],['restore-wide','context-restore',900,720,false,false],['restore-narrow','context-restore',340,560,false,false],['restore-short','context-restore',440,360,false,false],['restore-light','context-restore',900,720,true,false],['indexed-history','context-indexed',600,600,false,false],['unknown-history','context-unknown',600,560,false,false],['failed-history','context-failed',600,560,false,false],['empty-history','context-empty',600,560,false,false],['long-recap','context-long',340,560,false,false],['source-details','context-connect',720,820,false,false])" : ''}
  for(const[label,kind,width,height,light,reduced]of cases){
   step(label)
   window.setContentSize(width,height)
   await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]})
   await evaluate('window.__renderCase('+JSON.stringify(kind)+','+light+')')
   await wait(()=>evaluate(kind==='connecting'?'Boolean(document.querySelector(".session-connecting__prompt pre"))':kind==='empty'?'Boolean(document.querySelector(".session-connecting"))':'Boolean(document.querySelector(".full-page-loading h1"))'),'real heading')
   await new Promise(done=>setTimeout(done,kind==='startup'?600:150))
   if(kind.startsWith('context-')){
    await wait(()=>evaluate('Boolean(document.querySelector(".session-recap__metadata")) && !document.querySelector(".session-recap")?.textContent.includes("Reading saved")'),'settled context')
    if(label==='source-details') {
     await evaluate('document.querySelector(".session-recap__source summary").click()')
     await wait(()=>evaluate('document.querySelector(".session-recap__source").open'),'source disclosure opened')
    }
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    await new Promise(done=>setTimeout(done,80))
   }
   const facts=await evaluate('(()=>{const s=document.querySelector(".full-page-loading"),h=s.querySelector("h1"),p=s.querySelector("pre");return {title:h.textContent,headings:s.querySelectorAll("h1,h2").length,text:s.innerText,clientWidth:s.clientWidth,scrollWidth:s.scrollWidth,prompt:p?.textContent,promptOverflow:p?getComputedStyle(p).overflowY:null,reducedMotion:matchMedia("(prefers-reduced-motion:reduce)").matches,appearance:document.documentElement.dataset.appearance,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}}})()')
   if(facts.headings!==1||facts.scrollWidth!==facts.clientWidth)throw new Error('heading/width '+label+JSON.stringify(facts))
   if(kind.startsWith('context-')){
    const context=await evaluate('(()=>{const stage=document.querySelector(".full-page-loading__stage"),summary=document.querySelector(".session-recap__source summary");return {metadata:document.querySelector(".session-recap__metadata")?.innerText,time:document.querySelector(".session-recap time")?.dateTime,recap:document.querySelector(".session-recap__excerpt")?.textContent,action:document.querySelector(".full-page-loading__actions button")?.textContent,stageOverflow:getComputedStyle(stage).overflowY,sourceOpen:summary?.parentElement.open}})()')
    if(kind==='context-unknown'&&context.time)throw new Error('invented unknown time')
    if(kind==='context-indexed'&&/MiB|KiB/.test(context.metadata))throw new Error('invented indexed bytes')
    if(kind==='context-failed'&&!facts.text.includes('Recap could not be read.'))throw new Error('failure not visible')
    if(kind==='context-restore'||kind==='context-failed'||kind==='context-long')if(!context.action?.includes('Resume'))throw new Error('original restore action missing')
    if(label==='source-details'&&!context.sourceOpen)throw new Error('source disclosure closed')
    if(label==='restore-short'){
     context.scrolledMetadata=await evaluate('(()=>{const stage=document.querySelector(".full-page-loading__stage"),metadata=document.querySelector(".session-recap__metadata");stage.scrollTop=stage.scrollHeight;const value=metadata.getBoundingClientRect().bottom<=stage.getBoundingClientRect().bottom+1;stage.scrollTop=0;return value})()')
     if(!context.scrolledMetadata)throw new Error('short Region metadata is unreachable')
     await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    }
    facts.context=context
   }
   if(kind==='connecting'){
    if(facts.prompt!==${JSON.stringify(prompt)})throw new Error('complete prompt missing')
    await evaluate('document.querySelector(".session-connecting__copy").click()')
    await wait(()=>evaluate('document.querySelector(".session-connecting__copy")?.textContent.includes("Copied")'),'real Copy feedback')
    const copied=await evaluate('window.__fixtureCopied.at(-1)')
    if(copied!==${JSON.stringify(prompt)})throw new Error('complete Copy callback failed')
    facts.copiedComplete=true
   }
   const png=await window.webContents.capturePage(),bytes=png.toPNG(),path=process.env.PRIVATE_EVIDENCE+'/'+label+'.png'
   writeFileSync(path,bytes);report.images.push({label,path,sha256:hash(bytes),facts})
  }
  const moduleUrl=process.env.PRIVATE_MODULE_URL,scriptId=scripts.get(moduleUrl)
  if(!scriptId)throw new Error('real loaded script missing '+moduleUrl)
  const actual=await window.webContents.debugger.sendCommand('Debugger.getScriptSource',{scriptId})
  const expected=readFileSync(process.env.PRIVATE_MODULE)
  if(hash(Buffer.from(actual.scriptSource))!==hash(expected))throw new Error('loaded Renderer differs')
  report.loadedRendererSha256=hash(expected);report.passed=true
 }catch(e){report.phase=currentPhase;report.error=e.stack||String(e)}finally{writeFileSync(process.env.PRIVATE_REPORT,JSON.stringify(report,null,2));window?.destroy();app.exit(report.passed?0:1)}
})
`
let child, completed = false
try {
  await mkdir(evidence, {recursive:true}); await mkdir(join(temporary,'home')); await mkdir(join(temporary,'user-data'))
  await writeFile(join(temporary,'entry.tsx'),entry)
  const { build } = require('vite'), react = require('@vitejs/plugin-react').default
  const coreExports=JSON.parse(await readFile(join(repository,'packages/core/package.json'),'utf8')).exports
  const aliases=[...Object.entries(coreExports).map(([key,value])=>({find:new RegExp('^'+(key==='.'?'@agentmux/core':'@agentmux/core'+key.slice(1))+'$'),replacement:join(repository,'packages/core',value.import.replace('./dist/','./src/').replace(/\.js$/,'.ts'))})),
    {find:/^@agentmux\/layout$/,replacement:join(repository,'packages/layout/src/index.ts')},
    {find:/^@agentmux\/client-ui\/styles\/(.+)$/,replacement:join(repository,'packages/client-ui/src/styles/$1')},
    {find:/^@agentmux\/client-ui\/styles.css$/,replacement:join(repository,'packages/client-ui/src/styles/index.css')},
    {find:/^@agentmux\/client-ui\/components\/(.+)$/,replacement:join(repository,'packages/client-ui/src/components/$1.tsx')},
    {find:/^@agentmux\/client-ui\/platform$/,replacement:join(repository,'packages/client-ui/src/platform.tsx')},
    {find:/^@agentmux\/client-ui\/terminal\/(.+)$/,replacement:join(repository,'packages/client-ui/src/terminal/$1.ts')},
    {find:/^@agentmux\/client-ui\/(.+)$/,replacement:join(repository,'packages/client-ui/src/lib/$1.ts')},
    {find:/^@agentmux\/client-ui$/,replacement:join(repository,'packages/client-ui/src/index.ts')},
    ...Object.entries({react:join(desktop,'node_modules/react'),'react-dom':join(desktop,'node_modules/react-dom'),'lucide-react':join(desktop,'node_modules/lucide-react')}).map(([find,replacement])=>({find,replacement}))]
  const consumed={}
  await build({configFile:false,root:desktop,logLevel:'error',resolve:{alias:aliases},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},plugins:[{name:'private-react-classic',enforce:'pre',transform(code,id){if(id.startsWith(repository+'/')&&!id.includes('/node_modules/')&&!id.includes('/.tmp/'))consumed[id.slice(repository.length+1)]=hash(code);return id.endsWith('.tsx')&&id.includes('/src/')?{code:"import React from 'react'\n"+code,map:null}:undefined}},react({jsxRuntime:'classic'})],build:{outDir:temporary,emptyOutDir:false,lib:{entry:join(temporary,'entry.tsx'),formats:['es'],fileName:()=> 'renderer.mjs'}}})
  const css=(await readdir(temporary)).find(n=>n.endsWith('.css'));assert.ok(css)
  await writeFile(join(temporary,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./${css}"></head><body><div id="root"></div><script type="module" src="./renderer.mjs"></script></body></html>`)
  await writeFile(join(temporary,'main.mjs'),main)
  const environment={...process.env,PRIVATE_HOME:join(temporary,'home'),PRIVATE_DATA:join(temporary,'user-data'),PRIVATE_PAGE:pathToFileURL(join(temporary,'index.html')).href,PRIVATE_REPORT:join(temporary,'report.json'),PRIVATE_MODULE:join(temporary,'renderer.mjs'),PRIVATE_MODULE_URL:pathToFileURL(join(temporary,'renderer.mjs')).href,PRIVATE_EVIDENCE:evidence}
  for(const key of Object.keys(environment))if(key.startsWith('AGENTMUX_'))delete environment[key]
  delete environment.ELECTRON_RUN_AS_NODE
  child=spawn(require('electron'),[join(temporary,'main.mjs')],{env:environment,stdio:['ignore','ignore','pipe']})
  let diagnostics='';child.stderr.on('data',b=>{diagnostics=(diagnostics+b.toString()).slice(-2000)})
  const exit=await new Promise((done,fail)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');fail(new Error('Private presentation timed out: '+diagnostics))},90000);child.once('error',e=>{clearTimeout(timer);fail(e)});child.once('exit',(code,signal)=>{clearTimeout(timer);completed=true;done({code,signal})})})
  let report
  try { report=JSON.parse(await readFile(join(temporary,'report.json'),'utf8')) }
  catch(error){await writeFile(output,JSON.stringify({passed:false,exit,diagnostics,phase:'private-electron-before-report'},null,2));throw new Error('Private Electron did not produce its report: '+diagnostics,{cause:error})}
  report.inputsBefore=inputsBefore;report.inputsAfter=Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(join(repository,p)))])))
  report.consumedModules=consumed
  assert.deepEqual(report.inputsAfter,inputsBefore);report.exit=exit
  await writeFile(output,JSON.stringify(report,null,2)+'\n');assert.equal(exit.code,0,report.error??diagnostics);assert.equal(report.passed,true)
  console.log('Private production presentation: '+report.images.length+' full frames and complete Copy callback.')
} finally {
  if(child&&!completed){child.kill('SIGTERM');await new Promise(done=>child.once('exit',done))}
  await rm(temporary,{recursive:true,force:true})
}
