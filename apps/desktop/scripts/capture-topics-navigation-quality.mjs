import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root=resolve(import.meta.dirname,'../../..'), fixture=join(root,'apps/desktop/scripts/fixtures/topics-navigation-quality')
const evidence=resolve(process.argv[2]??join(root,'.tmp/ui-design-cohesion/topics-renderer')), require=createRequire(import.meta.url)
const temporary=await mkdtemp(join(tmpdir(),'amx-topics-quality-')), compiled=join(temporary,'renderer')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'), inputs={}
const recordInput=async id=>{const file=id.split('?')[0]; if(file.startsWith(root+'/')&&!file.includes('/node_modules/')&&/\.(?:[cm]?[jt]sx?|css|html)$/.test(file)) inputs[relative(root,file)]=hash(await readFile(file))}
const files=async directory=>(await Promise.all((await readdir(directory,{withFileTypes:true})).map(entry=>entry.isDirectory()?files(join(directory,entry.name)):[join(directory,entry.name)]))).flat()
const receipt={schema:'agentmux.topics-navigation-quality.v1',passed:false,captureOnly:true,aestheticReview:'not-performed',inputs,frames:[],
  boundary:'Original App/SurfaceToolDock/WorkspaceFilesTool/TopicFilesTool/WorkspaceFilesFrame/TopicNavigationPanel/WorkspaceTopicsPanel/FileExplorer/Knowledge and full CSS; private controlled Topics/files/knowledge transport facts and no-op initialization. Chromium mouse and insertText. No user profile or live Run. Real process/Run recovery is a separate original topic-terminal-open-close-restart proof.'}
await mkdir(evidence,{recursive:true})
try {
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',esbuild:{jsx:'automatic'},worker:{format:'es'},
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},
    plugins:[{name:'original-topics-product-inputs',enforce:'pre',async transform(_code,id){await recordInput(id)},async generateBundle(){await Promise.all(this.getWatchFiles().map(recordInput))}}],
    build:{target:'esnext',outDir:compiled,emptyOutDir:true}})
  await Promise.all([new URL(import.meta.url).pathname,join(fixture,'main.cjs')].map(recordInput))
  for(const path of ['apps/desktop/src/renderer/src/styles/topic-knowledge.css','apps/desktop/src/renderer/src/styles/selector.css','apps/desktop/src/renderer/src/styles/dock.css']) assert.ok(inputs[path],'Owning stylesheet is a loaded build input: '+path)
  receipt.compiled=Object.fromEntries(await Promise.all((await files(compiled)).map(async file=>[relative(compiled,file),hash(await readFile(file))])))
  assert.ok(Object.keys(receipt.compiled).some(file=>file.endsWith('.css'))&&Object.keys(receipt.compiled).some(file=>file.endsWith('.js')))
  for(const path of ['App.tsx','SurfaceToolDock.tsx','WorkspaceFilesTool.tsx','TopicFilesTool.tsx','WorkspaceFilesFrame.tsx','TopicNavigationPanel.tsx','WorkspaceTopicsPanel.tsx','FileExplorer.tsx']) assert.ok(Object.keys(inputs).some(file=>file.endsWith('/'+path)),'Original production consumer '+path)
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE
  const logs=[]; receipt.process=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),join(compiled,'index.html'),temporary,evidence],{temporaryRoot:temporary,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
  await writeFile(join(evidence,'process.log'),logs.join('\n')); receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
  assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message); assert.equal(receipt.actual.passed,true)
  receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.path)))})))
  assert.equal(receipt.frames.length,8); receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}
finally{receipt.cleanup={remaining:await listProbeProcesses(-1,temporary)};if(!receipt.cleanup.remaining.length){await rm(temporary,{recursive:true,force:true});receipt.cleanup.removed=true}await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure?.message}))}
