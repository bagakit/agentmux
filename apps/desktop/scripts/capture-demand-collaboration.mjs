import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {runProbeProcess,listProbeProcesses} from './probe-process.mjs'
const root=path.resolve(import.meta.dirname,'../../..'),desktop=path.join(root,'apps/desktop'),fixture=path.join(desktop,'scripts/fixtures/demand-picker')
const evidence=path.join(root,'.tmp/demand-picker','visual-'+globalThis.crypto.randomUUID()),privateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'amux-demand-product-review-'))
const require=createRequire(path.join(desktop,'package.json')),{build,loadConfigFromFile}=await import(pathToFileURL(require.resolve('vite')).href)
const sourceConfig=await loadConfigFromFile({command:'build',mode:'production'},path.join(fixture,'vitest.config.mts'))
assert.ok(sourceConfig?.config.resolve?.alias)
const files=[...['GoalDetail','GoalProperties','GoalExecution','GoalAgentPicker','GoalContinuationControl','GlobalBoardSurface'].map(name=>'src/renderer/src/components/'+name+'.tsx'),'src/renderer/src/lib/goal-agent-selection.ts','src/renderer/src/styles/goals.css','src/renderer/src/styles/goal-continuation.css','src/renderer/src/styles/goal-agent-picker.css','src/renderer/src/styles/index.css','src/renderer/src/styles/selection-field.css','src/renderer/src/components/SelectionField.tsx','scripts/fixtures/demand-picker/entry.tsx','scripts/fixtures/demand-picker/main.cjs']
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(desktop,file))).digest('hex')])))
await fs.mkdir(evidence,{recursive:true});const source=await hashes();await fs.writeFile(path.join(evidence,'source-hashes.json'),JSON.stringify(source,null,2)+'\n')
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
let receipt={passed:false,evidence,independentReview:'pending',source}
try{
 await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:sourceConfig.config.resolve,define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{target:'esnext',outDir:path.join(privateRoot,'renderer'),emptyOutDir:true}})
 const result=await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(privateRoot,'renderer/index.html'),privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>console.log(line)})
 assert.equal(result.timedOut,false);const render=JSON.parse(await fs.readFile(path.join(evidence,'render.json'),'utf8'));receipt.render=render;assert.equal(result.exitCode,0,render.failure?.message);assert.equal(render.passed,true);assert.equal(render.frames.length,38)
 assert.deepEqual(await hashes(),source,'Owning visual consumers changed during capture');receipt.passed=true
}catch(error){receipt.error={message:error.message,stack:error.stack}}
finally{assert.deepEqual(await listProbeProcesses(-1,privateRoot),[]);await fs.rm(privateRoot,{recursive:true,force:true});await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')}
console.log(JSON.stringify({passed:receipt.passed,evidence:path.join(evidence,'receipt.json'),frames:receipt.render?.frames.length,error:receipt.error?.message}));assert.equal(receipt.passed,true,receipt.error?.message)
