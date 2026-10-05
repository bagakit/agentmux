import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root=resolve(import.meta.dirname,'../../..'), fixture=join(root,'apps/desktop/scripts/fixtures/recall-control-quality')
const workfaces=process.argv[3]==='--workfaces'
assert.ok(!process.argv[3]||workfaces,'Only the explicit workfaces assessment is supported')
const mutation=process.argv[4]==='--mutate-stacking'
assert.ok(!process.argv[4]||(workfaces&&mutation),'Mutation requires the original workfaces assessment')
const evidence=resolve(process.argv[2]??join(root,'.tmp/ui-design-cohesion/recall-renderer')), require=createRequire(import.meta.url)
const temporary=await mkdtemp(join(tmpdir(),'amx-recall-quality-')), compiled=join(temporary,'renderer')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'), inputs={}
const receipt={schema:'agentmux.recall-control-quality.v1',passed:false,captureOnly:true,aestheticReview:'not-performed',inputs,frames:[],
  boundary:workfaces
    ? 'Original App, GlobalFocusSurface, NewTabSurface, LaunchRefine, original store initialization and full CSS. Private preview configuration and Session facts; Chromium pointer/keyboard actions, real viewport resizing and exact original editor/draft/spatial retention. User App and Sessions untouched. No live Agent, Terminal Run, native IME or process-restart claim.'
    : 'Original App, Recall, shared SurfaceModeSwitch, NotebookSelector, graph and full CSS. Private preview notebook metadata and original note data; Chromium pointer/keyboard events. User App and Sessions untouched. Real filesystem/editor retention is covered separately by recall-notebook-views tests.'}
await mkdir(evidence,{recursive:true})
try {
  receipt.scope=workfaces?'Focus and Launcher original App assessment':'Recall controls and service notice'
  const owned=['apps/desktop/src/renderer/src/styles/recall.css','apps/desktop/src/renderer/src/styles/tokens.css','packages/client-ui/src/styles/palette.css', 'apps/desktop/src/renderer/src/components/NotebookViews.tsx','apps/desktop/src/renderer/src/components/NotebookNavigation.tsx','apps/desktop/src/renderer/src/components/NotebookSelector.tsx']
  if(workfaces)owned.push('apps/desktop/src/renderer/src/styles/focus.css','apps/desktop/src/renderer/src/styles/launcher.css','apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','apps/desktop/src/renderer/src/components/LaunchOptionControls.tsx')
  receipt.owned=Object.fromEntries(await Promise.all(owned.map(async file=>[file,hash(await readFile(join(root,file)))])))
  const mutations=[]
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',esbuild:{jsx:'automatic'},worker:{format:'es'},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},
    css:mutation?{postcss:{plugins:[{postcssPlugin:'remove-original-focus-stacking',OnceExit(css){css.walkAtRules('container',rule=>{if(rule.params==='focus-workface (max-width: 560px)'){mutations.push({file:rule.source?.input.file,before:hash(rule.toString())});rule.remove()}})}}]}}:undefined,
    plugins:[{name:'original-recall-product-inputs',enforce:'pre',async transform(_code,id){const file=id.split('?')[0];if(file.startsWith(root+'/')&&!file.includes('/node_modules/')&&/\.(?:[cm]?[jt]sx?|css)$/.test(file))inputs[relative(root,file)]=hash(await readFile(file))}}],build:{target:'esnext',minify:false,outDir:compiled,emptyOutDir:true}})
  for(const name of ['App.tsx','GlobalRecallSurface.tsx','NotebookViews.tsx','NotebookSelector.tsx','SurfaceModeSwitch.tsx']) assert.ok(Object.keys(inputs).some(file=>file.endsWith('/'+name)),'Original consumer '+name)
  if(workfaces)for(const name of ['GlobalFocusSurface.tsx','LaunchOptionControls.tsx','NewTabSurface.tsx'])assert.ok(Object.keys(inputs).some(file=>file.endsWith('/'+name)),'Original workface consumer '+name)
  receipt.mutation={requested:mutation,applied:mutations};if(mutation)assert.equal(mutations.length,1,'One original Focus CSS layout rule is mutated')
  receipt.compiled=Object.fromEntries(await Promise.all((await readdir(join(compiled,'assets'))).filter(file=>file.endsWith('.css')).map(async file=>[file,hash(await readFile(join(compiled,'assets',file)))])))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const logs=[]
  receipt.process=await runProbeProcess(require('electron'),[join(fixture,workfaces?'workfaces.cjs':'main.cjs'),join(compiled,'index.html'),temporary,evidence],{temporaryRoot:temporary,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
  await writeFile(join(evidence,'process.log'),logs.join('\n'));receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
  assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
  receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.path)))})))
  assert.ok(receipt.frames.length >= (workfaces?10:7));
  for(const [file,sha] of Object.entries(receipt.owned)) assert.equal(hash(await readFile(join(root,file))),sha,'Owned source stable: '+file)
  receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}
finally{receipt.cleanup={remaining:await listProbeProcesses(-1,temporary)};if(!receipt.cleanup.remaining.length){await rm(temporary,{recursive:true,force:true});receipt.cleanup.removed=true}await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure?.message}))}
