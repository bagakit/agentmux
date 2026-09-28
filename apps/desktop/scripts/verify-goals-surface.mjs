import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from './probe-process.mjs'
const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..'), fixture=join(desktop,'scripts/fixtures/goals-surface')
const require=createRequire(import.meta.url),exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const privateRoot=await mkdtemp('/tmp/amx-goals-visual-'), evidence=join(repository,'.tmp/goals-surface',`attempt-${Date.now()}`)
const ownedSources = ['src/renderer/src/lib/goals-entry-actions.ts', 'src/renderer/src/lib/workbench-tabs.ts', 'src/renderer/src/components/NewTabSurface.tsx', 'src/renderer/src/store.ts', 'src/renderer/src/components/GlobalBoardSurface.tsx', 'src/renderer/src/components/GoalDetail.tsx', 'src/renderer/src/components/GoalAlignment.tsx', 'src/renderer/src/components/GoalProperties.tsx', 'src/renderer/src/components/GoalExecution.tsx', 'src/renderer/src/lib/goal-presentation.ts', 'src/renderer/src/styles/goals.css', 'src/renderer/src/styles/tokens.css', 'src/renderer/src/styles/index.css', 'scripts/fixtures/goals-surface/entry.tsx', 'scripts/fixtures/goals-surface/main.cjs', 'scripts/fixtures/goals-surface/controls.cjs']
const sourceHashes = async () => Object.fromEntries(await Promise.all(ownedSources.map(async file => [file, hash(await readFile(join(desktop, file)))])))
// Default proof follows the current Goals entry acceptance; the broader detail workflow remains explicit.
const mode=process.argv.includes('--full-workflow')?'full-workflow':'entry-controls'
const result={schema:'agentmux.goals-visual-capture.v1',captureOnly:true,aestheticReview:'not-performed',mode,passed:false,userRunTouched:false}
try{
  await mkdir(evidence,{recursive:true});result.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim()
  result.sourceBefore=await sourceHashes()
  const outDir=join(privateRoot,'renderer')
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,minify:false,sourcemap:true,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  const compiled={};for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true})){if(entry.isFile()){const p=join(entry.parentPath,entry.name);compiled[p.slice(outDir.length+1)]=hash(await readFile(p))}}
  assert.ok(Object.keys(compiled).length>0);await writeFile(join(evidence,'compiled.json'),JSON.stringify(compiled,null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const log=[]
  result.outcome=await runProbeProcess(require('electron'),[join(fixture,mode==='full-workflow'?'main.cjs':'controls.cjs'),join(outDir,'index.html'),privateRoot,evidence],{temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:60000,onLine:line=>log.push(line)})
  await writeFile(join(evidence,'process.log'),log.join('\n'));result.render=JSON.parse(await readFile(join(evidence,'render.json'),'utf8'))
  assert.equal(result.outcome.exitCode,0,JSON.stringify(result.render.failure));assert.equal(result.render.passed,true);result.sourceAfter=await sourceHashes();assert.deepEqual(result.sourceAfter,result.sourceBefore,'Owned Goals sources remained identical through compilation and capture');result.passed=true
  await writeFile(join(evidence,'review.md'),['# Goals screenshots — independent review pending','',`Candidate HEAD: ${result.sourceCommit}. Actual private Renderer build: [compiled.json](compiled.json). Capture receipt does not prove aesthetic approval.`, '', 'Real App → Goals, product components and product CSS; preview data only. Native/CLI/Mote delivery and restart are outside this capture. Original user App and Runs were not touched.','',...result.render.frames.map(frame=>`- ${frame.name}: [screenshot](${frame.file})`),'','Review the complete normal and narrow images against Goals SSOT. Record actual images seen, reading hierarchy, noise, controls, clipping and concrete revisions. Re-capture changed code before approving.',''].join('\n'))
}catch(error){result.failure={name:error.name,message:error.message}}
finally{await stopProbeProcesses(process.pid+1000000000,privateRoot);result.remaining=await listProbeProcesses(process.pid+1000000000,privateRoot);assert.deepEqual(result.remaining,[]);await rm(privateRoot,{recursive:true});await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))}
console.log(JSON.stringify({passed:result.passed,receipt:join(evidence,'receipt.json'),review:join(evidence,'review.md'),failure:result.failure}));if(!result.passed)process.exitCode=1
