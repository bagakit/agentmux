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
const inputsBefore = Object.fromEntries(await Promise.all(sources.map(async p => [p, hash(await readFile(join(repository, p)))])))
const entry = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { FullPageLoadingSurface } from '${join(desktop, 'src/renderer/src/components/FullPageLoadingSurface.tsx')}'
import { SessionConnectingSurface } from '${join(desktop, 'src/renderer/src/components/SessionConnectingSurface.tsx')}'
import { api } from '${join(desktop, 'src/renderer/src/lib/api.ts')}'
import { applyAppAppearance } from '${join(desktop, 'src/renderer/src/lib/app-appearance.ts')}'
import '${join(desktop, 'src/renderer/src/styles/index.css')}'
const root=createRoot(document.getElementById('root'))
const prompt=${JSON.stringify(prompt)}
window.__fixtureCopied=[]
api.ui.writeClipboardText=async text=>{window.__fixtureCopied.push(text)}
window.__renderCase=(kind,light)=>{
 applyAppAppearance(light?'light':'dark')
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
  for(const[label,kind,width,height,light,reduced]of cases){
   step(label)
   window.setContentSize(width,height)
   await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]})
   await evaluate('window.__renderCase('+JSON.stringify(kind)+','+light+')')
   await wait(()=>evaluate(kind==='connecting'?'Boolean(document.querySelector(".session-connecting__prompt pre"))':kind==='empty'?'Boolean(document.querySelector(".session-connecting"))':'Boolean(document.querySelector(".full-page-loading h1"))'),'real heading')
   await new Promise(done=>setTimeout(done,kind==='startup'?600:150))
   const facts=await evaluate('(()=>{const s=document.querySelector(".full-page-loading"),h=s.querySelector("h1"),p=s.querySelector("pre");return {title:h.textContent,headings:s.querySelectorAll("h1,h2").length,text:s.innerText,clientWidth:s.clientWidth,scrollWidth:s.scrollWidth,prompt:p?.textContent,promptOverflow:p?getComputedStyle(p).overflowY:null,reducedMotion:matchMedia("(prefers-reduced-motion:reduce)").matches,appearance:document.documentElement.dataset.appearance,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}}})()')
   if(facts.headings!==1||facts.scrollWidth!==facts.clientWidth)throw new Error('heading/width '+label+JSON.stringify(facts))
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
  await build({configFile:false,root:desktop,logLevel:'error',resolve:{alias:{react:join(desktop,'node_modules/react'),'react-dom':join(desktop,'node_modules/react-dom'),'lucide-react':join(desktop,'node_modules/lucide-react')}},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},plugins:[{name:'private-react-classic',enforce:'pre',transform(code,id){return id.endsWith('.tsx')&&id.includes('/src/')?{code:"import React from 'react'\n"+code,map:null}:undefined}},react({jsxRuntime:'classic'})],build:{outDir:temporary,emptyOutDir:false,lib:{entry:join(temporary,'entry.tsx'),formats:['es'],fileName:()=> 'renderer.mjs'}}})
  const css=(await readdir(temporary)).find(n=>n.endsWith('.css'));assert.ok(css)
  await writeFile(join(temporary,'index.html'),`<!doctype html><html><head><link rel="stylesheet" href="./${css}"></head><body><div id="root"></div><script type="module" src="./renderer.mjs"></script></body></html>`)
  await writeFile(join(temporary,'main.mjs'),main)
  const environment={...process.env,PRIVATE_HOME:join(temporary,'home'),PRIVATE_DATA:join(temporary,'user-data'),PRIVATE_PAGE:pathToFileURL(join(temporary,'index.html')).href,PRIVATE_REPORT:join(temporary,'report.json'),PRIVATE_MODULE:join(temporary,'renderer.mjs'),PRIVATE_MODULE_URL:pathToFileURL(join(temporary,'renderer.mjs')).href,PRIVATE_EVIDENCE:evidence}
  for(const key of Object.keys(environment))if(key.startsWith('AGENTMUX_'))delete environment[key]
  child=spawn(require('electron'),[join(temporary,'main.mjs')],{env:environment,stdio:['ignore','ignore','pipe']})
  let diagnostics='';child.stderr.on('data',b=>{diagnostics=(diagnostics+b.toString()).slice(-2000)})
  const exit=await new Promise((done,fail)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');fail(new Error('Private presentation timed out: '+diagnostics))},90000);child.once('error',e=>{clearTimeout(timer);fail(e)});child.once('exit',(code,signal)=>{clearTimeout(timer);completed=true;done({code,signal})})})
  const report=JSON.parse(await readFile(join(temporary,'report.json'),'utf8'))
  report.inputsBefore=inputsBefore;report.inputsAfter=Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(join(repository,p)))])))
  assert.deepEqual(report.inputsAfter,inputsBefore);report.exit=exit
  await writeFile(output,JSON.stringify(report,null,2)+'\n');assert.equal(exit.code,0,report.error??diagnostics);assert.equal(report.passed,true)
  console.log('Private production presentation: '+report.images.length+' full frames and complete Copy callback.')
} finally {
  if(child&&!completed){child.kill('SIGTERM');await new Promise(done=>child.once('exit',done))}
  await rm(temporary,{recursive:true,force:true})
}
