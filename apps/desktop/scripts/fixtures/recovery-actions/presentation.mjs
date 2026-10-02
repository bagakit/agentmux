import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../../../..'), desktop = join(root, 'apps/desktop'), require = createRequire(join(desktop, 'package.json'))
const output = process.env.AGENTMUX_RECOVERY_ACTION_PRESENTATION
assert.ok(output, 'Explicit private presentation receipt is required.')
const evidence = resolve(output, '..'), temporary = await mkdtemp(join(root, '.tmp/recovery-actions-presentation-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const entry = `import React from 'react';import { createRoot } from 'react-dom/client';
import { initializeRecoveryScene,recoveryScene } from '${join(desktop, 'scripts/fixtures/recovery-actions/presentation-cases.tsx')}';
import { applyAppAppearance } from '${join(desktop,'src/renderer/src/lib/app-appearance.ts')}';
import '${join(desktop,'src/renderer/src/styles/index.css')}';
await initializeRecoveryScene();applyAppAppearance('dark');const root=createRoot(document.getElementById('root'));root.render(recoveryScene());
window.__fixtureReady=true;window.__setLight=light=>{applyAppAppearance(light?'light':'dark')};`
const main = `import { app,BrowserWindow } from 'electron';import { readFileSync,writeFileSync } from 'node:fs';import { createHash } from 'node:crypto';
app.setPath('home',process.env.PRIVATE_HOME);app.setPath('userData',process.env.PRIVATE_DATA);
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={schema:'agentmux.session-recovery-actions-presentation.v1',passed:false,userRuntimeTouched:false,images:[],limitations:['Actual production SessionPane and dialog mounted in a private Electron renderer, with explicit synthetic Store/API replies. No native restore, user GUI, input, Runtime or installed package qualification.']};
let window;const wait=async(fn,label)=>{const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,25))}throw new Error(label)};
app.whenReady().then(async()=>{try{
 window=new BrowserWindow({width:820,height:760,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 window.webContents.on('console-message',event=>{report.console??=[];report.console.push(event.message)});
 window.webContents.debugger.attach('1.3');const scripts=new Map();window.webContents.debugger.on('message',(_event,method,p)=>{if(method==='Debugger.scriptParsed'&&p.url)scripts.set(p.url,p.scriptId)});
 await window.loadURL(process.env.PRIVATE_PAGE);await window.webContents.debugger.sendCommand('Debugger.enable');const evaluate=x=>window.webContents.executeJavaScript(x,true);
 await wait(()=>evaluate('window.__fixtureReady && !!document.querySelector(".session-recovery-actions")'),'real SessionPane actions');
 const click=text=>evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw new Error("button missing");b.click()})()');
 const choose=(label,value)=>evaluate('(()=>{const s=document.querySelector('+JSON.stringify('select[aria-label="'+label+'"]')+');s.value='+JSON.stringify(value)+';s.dispatchEvent(new Event("change",{bubbles:true}))})()');
 const frame=async(label,width,height,light)=>{report.phase=label;window.setContentSize(width,height);await evaluate('window.__setLight('+light+')');await new Promise(r=>setTimeout(r,50));
  await evaluate('Promise.allSettled((document.querySelector(".session-recovery-dialog")?.getAnimations()??[]).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))))');
  const facts=await evaluate('(()=>{const d=document.querySelector(".session-recovery-dialog"),a=document.querySelector(".session-recovery-actions");return {title:d?.querySelector("h2")?.textContent,dialogText:d?.innerText,actions:a?.innerText,executor:[...document.querySelectorAll("select")].find(s=>s.ariaLabel==="Recovery Executor")?.value,historySource:[...document.querySelectorAll("select")].find(s=>s.ariaLabel==="Original history source")?.value,busy:d?.getAttribute("aria-busy")==="true",dialogRect:d?{width:d.getBoundingClientRect().width,left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right,top:d.getBoundingClientRect().top,bottom:d.getBoundingClientRect().bottom,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth}:null,viewport:{width:innerWidth,height:innerHeight}}})()');
  if(facts.dialogRect&&(facts.dialogRect.left<0||facts.dialogRect.right>width+1||facts.dialogRect.top<0||facts.dialogRect.bottom>height+1||facts.dialogRect.scrollWidth>facts.dialogRect.clientWidth))throw new Error('Dialog escaped viewport: '+label);
  const png=await window.webContents.capturePage(),bytes=png.toPNG(),path=process.env.PRIVATE_EVIDENCE+'/'+label+'.png';writeFileSync(path,bytes);report.images.push({label,path,sha256:hash(bytes),facts});};
 await frame('original-three-actions-dark',820,760,false);await click('Take over…');await wait(()=>evaluate('!!document.querySelector(".session-recovery-dialog")'),'takeover dialog');await choose('Recovery Executor','codex');
 await frame('takeover-dark',820,760,false);await frame('takeover-narrow',360,620,false);await frame('takeover-light',680,740,true);await click('Cancel');
 await click('Analyze…');await wait(()=>evaluate('!!document.querySelector(".session-recovery-dialog")'),'analysis dialog');await choose('Recovery Executor','claude');await frame('analysis-agent-dark',820,760,false);
 await evaluate('[...document.querySelectorAll("input[type=radio]")].find(input=>input.parentElement.textContent.includes("Chosen Mote")).click()');
 await wait(()=>evaluate('[...document.querySelectorAll("select")].find(s=>s.ariaLabel==="Analysis Mote")?.options.length>1'),'real chosen Mote input');
 await evaluate('(()=>{const s=[...document.querySelectorAll("select")].find(s=>s.ariaLabel==="Analysis Mote");s.value=s.options[1].value;s.dispatchEvent(new Event("change",{bubbles:true}))})()');await click('Send analysis');await wait(()=>evaluate('typeof window.__releaseRecoveryAnalysis==="function" && !!document.querySelector(".session-recovery-dialog[aria-busy=true]")'),'actual chosen Mote pending send');await frame('analysis-chosen-mote-dark',820,760,false);await evaluate('window.__releaseRecoveryAnalysis()');await wait(()=>evaluate('document.querySelector(".session-recovery-dialog")?.getAttribute("aria-busy")==="false"'),'actual chosen Mote settle');await click('Cancel');
 await click('Take over…');await wait(()=>evaluate('!!document.querySelector(".session-recovery-dialog")'),'second takeover dialog');await choose('Recovery Executor','codex');await click('Create takeover Agent');
 await wait(()=>evaluate('document.querySelector(".session-recovery-dialog")?.textContent.includes("Creation is unconfirmed")'),'actual unknown creation notice');await frame('unknown-original-request-dark',820,820,false);
 const scriptId=scripts.get(process.env.PRIVATE_MODULE_URL);if(!scriptId)throw new Error('Loaded production Renderer module absent');const actual=await window.webContents.debugger.sendCommand('Debugger.getScriptSource',{scriptId});
 report.loadedRendererSha256=hash(readFileSync(process.env.PRIVATE_MODULE));if(hash(Buffer.from(actual.scriptSource))!==report.loadedRendererSha256)throw new Error('Loaded Renderer bytes differ');report.passed=true;
}catch(error){report.error=error.stack||String(error)}finally{writeFileSync(process.env.PRIVATE_REPORT,JSON.stringify(report,null,2));window?.destroy();app.exit(report.passed?0:1)}});`
let child, completed = false
try {
 await mkdir(evidence,{recursive:true});await mkdir(join(temporary,'home'));await mkdir(join(temporary,'user-data'))
 await writeFile(join(temporary,'entry.tsx'),entry);await writeFile(join(temporary,'terminal.tsx'),'export function TerminalView(){return null}')
 const {build}=require('vite'),react=require('@vitejs/plugin-react').default,coreExports=JSON.parse(await readFile(join(root,'packages/core/package.json'),'utf8')).exports
 const aliases=[{find:/^\.\/TerminalView$/,replacement:join(temporary,'terminal.tsx')},
  ...Object.entries(coreExports).map(([key,value])=>({find:new RegExp('^'+(key==='.'?'@agentmux/core':'@agentmux/core'+key.slice(1))+'$'),replacement:join(root,'packages/core',value.import.replace('./dist/','./src/').replace(/\.js$/,'.ts'))})),
  {find:/^@agentmux\/layout$/,replacement:join(root,'packages/layout/src/index.ts')},{find:/^@agentmux\/client-ui\/styles\/(.+)$/,replacement:join(root,'packages/client-ui/src/styles/$1')},
  {find:/^@agentmux\/client-ui\/styles.css$/,replacement:join(root,'packages/client-ui/src/styles/index.css')},{find:/^@agentmux\/client-ui\/components\/(.+)$/,replacement:join(root,'packages/client-ui/src/components/$1.tsx')},
  {find:/^@agentmux\/client-ui\/platform$/,replacement:join(root,'packages/client-ui/src/platform.tsx')},{find:/^@agentmux\/client-ui\/terminal\/(.+)$/,replacement:join(root,'packages/client-ui/src/terminal/$1.ts')},
  {find:/^@agentmux\/client-ui\/(.+)$/,replacement:join(root,'packages/client-ui/src/lib/$1.ts')},{find:/^@agentmux\/client-ui$/,replacement:join(root,'packages/client-ui/src/index.ts')},
  ...Object.entries({react:join(desktop,'node_modules/react'),'react-dom':join(desktop,'node_modules/react-dom'),'lucide-react':join(desktop,'node_modules/lucide-react')}).map(([find,replacement])=>({find,replacement}))]
 const sourcePins={}
 await build({configFile:false,root:desktop,logLevel:'error',resolve:{alias:aliases},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},plugins:[{name:'private-production-source-pins',enforce:'pre',transform(code,id){const file=id.split('?')[0];if(file.startsWith(root+'/')&&!file.includes('/node_modules/')&&!file.includes('/.tmp/'))sourcePins[file.slice(root.length+1)]=hash(readFileSync(file));return id.endsWith('.tsx')&&id.includes('/src/')?{code:"import React from 'react'\n"+code,map:null}:undefined}},react({jsxRuntime:'classic'})],build:{target:'esnext',outDir:temporary,emptyOutDir:false,lib:{entry:join(temporary,'entry.tsx'),formats:['es'],fileName:()=> 'renderer.mjs'}}})
 const css=(await readdir(temporary)).find(name=>name.endsWith('.css'));assert.ok(css)
 await writeFile(join(temporary,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./${css}"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="./renderer.mjs"></script></body></html>`);await writeFile(join(temporary,'main.mjs'),main);execFileSync(process.execPath,['--check',join(temporary,'main.mjs')])
 const env={...process.env,PRIVATE_HOME:join(temporary,'home'),PRIVATE_DATA:join(temporary,'user-data'),PRIVATE_PAGE:pathToFileURL(join(temporary,'index.html')).href,PRIVATE_REPORT:join(temporary,'report.json'),PRIVATE_MODULE:join(temporary,'renderer.mjs'),PRIVATE_MODULE_URL:pathToFileURL(join(temporary,'renderer.mjs')).href,PRIVATE_EVIDENCE:evidence}
 for(const key of Object.keys(env))if(key.startsWith('AGENTMUX_'))delete env[key];delete env.ELECTRON_RUN_AS_NODE
 child=spawn(require('electron'),[join(temporary,'main.mjs')],{env,stdio:['ignore','ignore','pipe']});let diagnostics='';child.stderr.on('data',bytes=>{diagnostics=(diagnostics+bytes.toString()).slice(-4000)})
 const exit=await new Promise((done,fail)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');fail(new Error('Private presentation timed out: '+diagnostics))},60000);child.once('error',error=>{clearTimeout(timer);fail(error)});child.once('exit',(code,signal)=>{clearTimeout(timer);completed=true;done({code,signal})})})
 const report=JSON.parse(await readFile(join(temporary,'report.json'),'utf8'));report.exit=exit;report.sourcePins=sourcePins
 for(const[file,sha]of Object.entries(sourcePins))assert.equal(hash(await readFile(join(root,file))),sha,'Source changed during capture: '+file)
 await writeFile(output,JSON.stringify(report,null,2)+'\n');assert.equal(exit.code,0,report.error??diagnostics);assert.equal(report.passed,true)
 console.log('Private production SessionPane: '+report.images.length+' actual frames; independent image review pending.')
}finally{if(child&&!completed){child.kill('SIGTERM');await new Promise(done=>child.once('exit',done))}await rm(temporary,{recursive:true,force:true})}
