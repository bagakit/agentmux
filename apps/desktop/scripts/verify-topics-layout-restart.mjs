import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative} from 'node:path'
import {build} from 'vite'
import {runProbeProcess,listProbeProcesses} from './probe-process.mjs'
const root=resolve(import.meta.dirname,'../../..'),fixture=join(root,'apps/desktop/scripts/fixtures/topics-navigation-quality')
const evidence=resolve(process.argv[2]??join(root,'.tmp/ui-design-cohesion/topics-layout-restart')),require=createRequire(import.meta.url)
const temporary=await mkdtemp(join(tmpdir(),'amx-topics-layout-')),compiled=join(temporary,'renderer'),inputs={}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const record=async id=>{const file=id.split('?')[0];if(file.startsWith(root+'/')&&!file.includes('/node_modules/')&&/\.(?:[cm]?[jt]sx?|css|html)$/.test(file))inputs[relative(root,file)]=hash(await readFile(file))}
const files=async directory=>(await Promise.all((await readdir(directory,{withFileTypes:true})).map(entry=>entry.isDirectory()?files(join(directory,entry.name)):[join(directory,entry.name)]))).flat()
const receipt={schema:'agentmux.topics-layout-restart.v1',passed:false,inputs,phases:[],
  boundary:'Two sequential real Electron processes with the same private Chromium profile and original Core AgentMuxSpatialStateStore file. Original App initialize, DesktopSpatialPersistence and UI persistence restore the same file Tabs/Regions, split geometry, selection, unsaved file and composer drafts, focus and explicit expanded Files preference. Only first process seeds. Files/config/Topics metadata are controlled public transport facts. No Session or Run exists in this layout proof; no Agent recovery or installation claim.'}
await mkdir(evidence,{recursive:true})
try{
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',esbuild:{jsx:'automatic'},worker:{format:'es'},
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},
    plugins:[{name:'topics-restart-original-inputs',enforce:'pre',async transform(_code,id){await record(id)},async generateBundle(){await Promise.all(this.getWatchFiles().map(record))}}],
    build:{target:'esnext',outDir:compiled,emptyOutDir:true,rollupOptions:{input:join(fixture,'restart.html')}}})
  await Promise.all([new URL(import.meta.url).pathname,join(fixture,'restart-main.cjs'),join(fixture,'restart-preload.cjs'),join(root,'packages/core/dist/spatial-state.js')].map(record))
  receipt.compiled=Object.fromEntries(await Promise.all((await files(compiled)).map(async file=>[relative(compiled,file),hash(await readFile(file))])))
  for(const file of ['App.tsx','store.ts','WorkspaceFilesFrame.tsx','TopicFilesTool.tsx','topic-knowledge.css'])assert.ok(Object.keys(inputs).some(path=>path.endsWith('/'+file)),file+' is a compiled production input')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  for(const phase of ['seed','restore']){
    const logs=[]
    const process=await runProbeProcess(require('electron'),[join(fixture,'restart-main.cjs'),join(compiled,'restart.html'),temporary,evidence,phase],
      {temporaryRoot:temporary,cwd:root,env,timeoutMs:45000,onLine:line=>logs.push(line)})
    await writeFile(join(evidence,'restart-'+phase+'.log'),logs.join('\n'))
    const actual=JSON.parse(await readFile(join(evidence,'restart-'+phase+'.json'),'utf8'))
    receipt.phases.push({phase,process,actual})
    assert.equal(process.exitCode,0,actual.failure?.message)
    assert.equal(actual.passed,true)
  }
  assert.notEqual(receipt.phases[0].actual.pid,receipt.phases[1].actual.pid,'A second real process must restore after the original exits')
  receipt.frames=await Promise.all(['seed','restore','focus-narrow','returned'].map(async phase=>({path:'topics-restart-'+phase+'.png',sha256:hash(await readFile(join(evidence,'topics-restart-'+phase+'.png')))})))
  receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}
finally{receipt.cleanup={remaining:await listProbeProcesses(-1,temporary)};if(!receipt.cleanup.remaining.length){await rm(temporary,{recursive:true,force:true});receipt.cleanup.removed=true}await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure?.message}))}
