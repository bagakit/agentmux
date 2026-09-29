import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..'), sourceRoot=join(desktop,'src/renderer/src')
const require=createRequire(import.meta.url), {build}=await import('vite'), ts=require('typescript'), postcss=createRequire(require.resolve('vite'))('postcss')
const fixture=join(desktop,'scripts/fixtures/dialog-surface-craft'), recovery=process.argv.includes('--recovery'), candidateOnly=process.argv.includes('--candidate-only')
const privateRoot=await mkdtemp('/tmp/amx-dialog-craft-'), evidence=join(repository,'.tmp/dialog-surface-craft',`attempt-${Date.now()}${recovery?'-recovery':''}`)
const hash=value=>createHash('sha256').update(value).digest('hex')
const files=['components/ConfirmationDialog.tsx','components/WorkspaceWorkbench.tsx','components/GoalDetail.tsx','components/QuickSwitcher.tsx','components/SpaceIconPicker.tsx','styles/overlays.css','styles/source-control.css','styles/board.css','styles/space-object-appearance.css']
const result={schema:'agentmux.dialog-surface-craft.v1',passed:false,recovery,candidateOnly,userRunTouched:false,
  boundary:'Actual isolated production Renderer, original Workbench/Store/confirmation and navigation callers. Controlled preview API and gallery facts; no real CLI, installed App, user Run, TCC or durable restart claim.',
  aestheticReview:'Root self-review only; independent image review pending under user no-messaging instruction',mutations:[],callers:[]}
// The no-write invariant belongs to the production files this harness mutates.
 // Concurrent caller edits are separately bound by each build identity; they are not a probe write.
async function sources(){return Object.fromEntries(await Promise.all(['components/ConfirmationDialog.tsx','styles/overlays.css'].map(async file=>[file,hash(await readFile(join(sourceRoot,file)))])))}
async function observedInputs(){return Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(join(sourceRoot,file)))])))}
function replaceOne(source,from,to){assert.equal(source.split(from).length,2,'Private mutation anchors one real production block');return source.replace(from,to)}
const mutations=[
  {label:'destructive-autofocus',file:'components/ConfirmationDialog.tsx',expected:/destructive dialog focuses Cancel/,
    change:source=>replaceOne(source,'cancelRef.current?.focus()', "document.querySelector('.confirmation-dialog .danger-button')?.focus()")},
  {label:'busy-dismissal',file:'components/ConfirmationDialog.tsx',expected:/Busy shared confirmation/,
    change:source=>replaceOne(replaceOne(replaceOne(source,'!next && !busy && onCancel()','!next && onCancel()'),
      'onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}','onEscapeKeyDown={(event) => {}}'),
      'onInteractOutside={(event) => { if (busy) event.preventDefault() }}','onInteractOutside={(event) => {}}')},
  {label:'long-subject-clipped',file:'styles/overlays.css',expected:/long subject wraps|horizontal overflow/,
    change:source=>replaceOne(source,'overflow-wrap: anywhere; user-select: text;','overflow-wrap: normal; user-select: text;')},
  {label:'busy-action-shifts',file:'styles/overlays.css',expected:/Busy action keeps its original size/,
    change:source=>replaceOne(source,'button[data-confirm-label] { display: grid;', 'button[data-confirm-label] { display: inline-flex;')}
]
async function renderer(label,mutation=null){
  const directory=join(evidence,label), processRoot=join(privateRoot,label),outDir=join(processRoot,'out')
  await mkdir(directory,{recursive:true});await mkdir(processRoot,{recursive:true})
  const main=join(processRoot,'main.cjs'), mainBytes=await readFile(join(fixture,'main.cjs'));await writeFile(main,mainBytes)
  const wrapper=join(processRoot,'xterm.mjs');await writeFile(wrapper,`import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};
export class Terminal extends xterm.Terminal { constructor(...args){super(...args);const entries=globalThis.resultReadyTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)} dispose(){this.probeIdentity.disposed=true;return super.dispose()} }
`)
  const loadedSources={},importedStyles={},changes=[]
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:wrapper}]},
    plugins:[{name:'chrome-craft-owned-private-transform',enforce:'pre',async transform(source,id){
      if(id.startsWith(join(desktop,'src')+'/')&&!id.includes('?'))loadedSources[id.slice(repository.length+1)]=hash(source)
      if(mutation&&!mutation.file.endsWith('.css')&&id===join(sourceRoot,mutation.file)){
        const changed=mutation.change(source);assert.notEqual(changed,source)
        await writeFile(join(directory,'original-source.txt'),source);await writeFile(join(directory,'mutated-source.txt'),changed)
        changes.push({file:mutation.file,original:hash(source),mutated:hash(changed),productionWritten:false});return changed
      }
    },async generateBundle(){for(const file of this.getWatchFiles())if(file.startsWith(sourceRoot+'/')&&file.endsWith('.css'))importedStyles[file.slice(repository.length+1)]=hash(await readFile(file))}}],
    css:{postcss:{plugins:[{postcssPlugin:'chrome-craft-actual-imported-css',async Once(root){
      if(!mutation?.file.endsWith('.css'))return
      const file=join(sourceRoot,mutation.file),original=await readFile(file,'utf8'),changed=mutation.change(original)
      const replacements=[];postcss.parse(changed,{from:file}).walkDecls(decl=>replacements.push(decl))
      const targets=[];root.walkDecls(decl=>{if(decl.source?.input.file!==file)return
        const replacement=replacements.find(d=>d.source.start.line===decl.source.start.line&&d.source.start.column===decl.source.start.column&&d.prop===decl.prop)
        if(replacement&&replacement.value!==decl.value){targets.push({selector:decl.parent.selector,property:decl.prop,original:decl.value,mutated:replacement.value});decl.value=replacement.value}
      })
      if(!targets.length)return
      assert.equal(changes.length,0,'One actual CSS import owns this mutation')
      await writeFile(join(directory,'original-source.txt'),original);await writeFile(join(directory,'mutated-source.txt'),changed)
      changes.push({file:mutation.file,original:hash(original),mutated:hash(changed),targets,productionWritten:false})
    }}]}},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},
    build:{outDir,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  for(const file of files.filter(f=>f.endsWith('.tsx')))assert.ok(loadedSources['apps/desktop/src/renderer/src/'+file],'Actual product caller compiled: '+file)
  for(const file of files.filter(f=>f.endsWith('.css')))assert.equal(importedStyles['apps/desktop/src/renderer/src/'+file],hash(await readFile(join(sourceRoot,file))),'Actual product style imported: '+file)
  if(mutation)assert.equal(changes.length,1,'The intended real production source is privately mutated once')
  const compiled={};for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true}))if(entry.isFile()){
    const file=join(entry.parentPath,entry.name);compiled[file.slice(outDir.length+1)]=hash(await readFile(file))
  }
  assert.ok(Object.keys(compiled).length>0)
  const identity={loadedSources,importedStyles,compiled,changes,mainSha256:hash(mainBytes)};await writeFile(join(directory,'compiled.json'),JSON.stringify(identity,null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const lines=[],outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),processRoot,directory,recovery?'recovery':'terminal'],{
    temporaryRoot:processRoot,cwd:repository,env,timeoutMs:90_000,onLine:line=>lines.push(line)})
  await writeFile(join(directory,'process.log'),lines.join('\n'));assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
  const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'))
  // runProbeProcess has observed exit and reaped owned descendants. Keep pictures,
  // source pairs and build hashes; release this completed build before the next one.
  await rm(processRoot,{recursive:true})
  return {directory,outcome,rendered,identity}
}
async function callers(){
  for(const caller of ['components/WorkspaceWorkbench.tsx','components/WorkspaceSidebar.tsx','components/BranchesPanel.tsx','components/FileExplorer.tsx','components/settings/HostSettingsPane.tsx','components/GoalDetail.tsx']){
    const file=join(sourceRoot,caller),text=await readFile(file,'utf8'),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),hits=[]
    function visit(node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)==='ConfirmationDialog')hits.push(node.getText(source));ts.forEachChild(node,visit)}
    visit(source);assert.ok(hits.length>0,'Non-definition actual confirmation caller: '+caller);result.callers.push({symbol:'ConfirmationDialog',caller,hits,sha256:hash(text)})
  }
}

try{
  await mkdir(evidence,{recursive:true});result.sourceBefore=await sources();result.observedInputsBefore=await observedInputs();await callers();result.candidate=await renderer('candidate')
  assert.equal(result.candidate.outcome.exitCode,0,result.candidate.rendered.failure?.message);assert.equal(result.candidate.rendered.passed,true)
  console.log('Candidate actual scenes GREEN: '+evidence)
  if(!candidateOnly)for(const mutation of mutations.filter(m=>(!process.argv.includes('--long-subject-only')||m.label==='long-subject-clipped')&&(!process.argv.includes('--busy-action-only')||m.label==='busy-action-shifts'))){
    const red=await renderer(mutation.label+'-red',mutation);assert.equal(red.outcome.exitCode,1,'Mutant must fail in the actual scene')
    assert.equal(red.rendered.failure.name,'AssertionError');assert.match(red.rendered.failure.message,mutation.expected)
    assert.deepEqual(await sources(),result.sourceBefore,'Mutations do not write production source')
    const restored=await renderer(mutation.label+'-restored');assert.equal(restored.outcome.exitCode,0,restored.rendered.failure?.message);assert.equal(restored.rendered.passed,true)
    result.mutations.push({label:mutation.label,red,restored});await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2));console.log(mutation.label+' RED / original source unchanged / GREEN')
  }
  result.observedInputsAfter=await observedInputs();result.concurrentInputChanges=Object.keys(result.observedInputsBefore).filter(file=>result.observedInputsBefore[file]!==result.observedInputsAfter[file]);result.sourceAfter=await sources();assert.deepEqual(result.sourceAfter,result.sourceBefore);result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
  const remaining=await listProbeProcesses(-1,privateRoot);for(const pid of remaining)await signalOwnedProbeProcess(pid,privateRoot,'SIGKILL')
  result.cleanup={before:remaining,after:await listProbeProcesses(-1,privateRoot)};assert.equal(result.cleanup.after.length,0)
  result.privateRoot=privateRoot;await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify({passed:result.passed,evidence,failure:result.failure??null}));process.exitCode=result.passed?0:1
}
