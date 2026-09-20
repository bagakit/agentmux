import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const desktop=path.join(root,'apps/desktop'),fixture=path.join(desktop,'scripts/fixtures/settings-agents-toolbar')
const require=createRequire(path.join(desktop,'package.json'))
const {build,loadConfigFromFile}=await import(pathToFileURL(require.resolve('vite')).href)
const configFile=path.join(fixture,'vitest.config.mts'),{config}=await loadConfigFromFile({command:'build',mode:'production'},configFile,root)
const privateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'agentmux-settings-agents-toolbar-'))
const evidence=path.join(root,'.tmp/settings-agents-toolbar',`run-${Date.now()}`);await fs.mkdir(evidence,{recursive:true})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),runs=[]
const surfaceFile=path.join(desktop,'src/renderer/src/styles/surfaces.css'),entryFile=path.join(desktop,'src/renderer/src/styles/index.css')
const original=await fs.readFile(surfaceFile,'utf8'),entryCSS=await fs.readFile(entryFile,'utf8')
const owner='.settings-executor-tools { display: flex; flex-wrap: wrap;',basis='.settings-executor-tools .settings-resource-search { flex: 1 1 16rem; }',media='@media (max-width: 560px) {'
for(const anchor of [owner,basis,media])assert.equal(original.split(anchor).length,2,'Actual nonempty owning CSS rule')
const mutations={basis:original.replace(basis,'.settings-executor-tools .settings-resource-search { flex: 1; }'),
  wrap:original.replace(owner,'.settings-executor-tools { display: flex;').replace(media,media+'\n  .settings-executor-tools { flex-wrap: wrap; }')}
async function bind(file){const raw=await fs.readFile(file),digest=hash(raw);if(inputs.has(file))assert.equal(digest,inputs.get(file),`Proof input changed: ${file}`);else{inputs.set(file,digest);const target=path.join(evidence,'source',path.relative(root,file));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,raw)}}
async function compiledFiles(directory,prefix=''){const entries=[];for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){const file=path.join(prefix,entry.name);if(entry.isDirectory())entries.push(...await compiledFiles(directory,file));else{const raw=await fs.readFile(path.join(directory,file));entries.push({file,bytes:raw.length,sha256:hash(raw)})}}return entries}
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
try {
  for(const file of [fileURLToPath(import.meta.url),path.join(fixture,'main.cjs'),path.join(fixture,'entry.ts'),path.join(fixture,'index.html'),configFile,
    path.join(desktop,'scripts/fixtures/settings-search-refinement/vitest.config.mts'),path.join(desktop,'scripts/probe-process.mjs'),
    path.join(root,'pnpm-lock.yaml'),path.join(root,'package.json'),path.join(root,'packages/core/package.json'),path.join(desktop,'package.json'),entryFile])await bind(file)
  const imports=[...entryCSS.matchAll(/@import '([^']+)';/g)];assert.ok(imports.length>0)
  for(const match of imports)await bind(path.resolve(path.dirname(entryFile),match[1]))
  assert.ok(inputs.has(surfaceFile),'The actual surface CSS is imported by the real entry')
  for(const mode of ['control','basis-mutant','wrap-mutant','restored']) {
    const directory=path.join(evidence,mode);await fs.mkdir(directory);const output=path.join(privateRoot,mode)
    const mutated=mode.endsWith('-mutant'),selected=mode==='basis-mutant'?mutations.basis:mode==='wrap-mutant'?mutations.wrap:original
    let consumed=0
    const mutationFile=path.join(privateRoot,`${mode}-surfaces.css`)
    if(mutated){await fs.writeFile(mutationFile,selected);await fs.writeFile(path.join(directory,'mutated-surfaces.css'),selected)}
    await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:config.resolve,define:{...config.define,'process.env.NODE_ENV':'"production"'},
      plugins:[{name:'bound-owning-agents-toolbar-proof',enforce:'pre',async transform(code,id){
        const file=id.split('?')[0];if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)
        if(file===entryFile){assert.equal(code,entryCSS);consumed++;const anchor="@import './surfaces.css';";assert.equal(code.split(anchor).length,2);if(mutated)return code.replace(anchor,`@import ${JSON.stringify(mutationFile)};`)}
      }}],build:{target:'esnext',outDir:output,emptyOutDir:true}})
    assert.equal(consumed,1,'The actual style entry is consumed once by the product build')
    const compiled=await compiledFiles(output);assert.ok(compiled.length>0)
    const styles=compiled.filter(file=>file.file.endsWith('.css'));assert.ok(styles.length>0)
    const compiledCSS=(await Promise.all(styles.map(file=>fs.readFile(path.join(output,file.file),'utf8')))).join('\n')
    assert.ok(compiledCSS.includes('.settings-executor-tools{'));assert.ok(compiledCSS.includes('.settings-executor-tools .settings-resource-search{'))
    if(mode==='basis-mutant')assert.ok(compiledCSS.includes('.settings-executor-tools .settings-resource-search{flex:1}'))
    else assert.ok(compiledCSS.includes('.settings-executor-tools .settings-resource-search{flex:1 1 16rem}'))
    await fs.cp(output,path.join(directory,'compiled'),{recursive:true});assert.deepEqual(await compiledFiles(path.join(directory,'compiled')),compiled)
    await fs.writeFile(path.join(directory,'compiled-manifest.json'),JSON.stringify(compiled,null,2))
    const stderr=[]
    const execution=await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(output,'index.html'),privateRoot,directory],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:30000,onLine:line=>stderr.push(line)})
    await fs.writeFile(path.join(directory,'execution.json'),JSON.stringify(execution,null,2));await fs.writeFile(path.join(directory,'stderr.log'),stderr.join('\n'))
    const render=JSON.parse(await fs.readFile(path.join(directory,'render.json'),'utf8'));assert.equal(execution.timedOut,false)
    if(mutated){assert.equal(execution.exitCode,1);assert.equal(render.passed,false);assert.equal(render.failure.name,'AssertionError');assert.ok(render.failure.message.includes(mode==='basis-mutant'?'Entered short query is fully readable':'Long Host keeps the entire search on its own row'))}
    else{assert.equal(execution.exitCode,0,render.failure?.message);assert.equal(render.passed,true);assert.equal(render.frames.length,16);assert.equal(render.scopes.length,8)}
    runs.push({mode,execution,frames:render.frames.length,assertion:render.failure?.message,compiled,actualSurfaceSHA256:hash(original),consumedSurfaceSHA256:hash(selected)})
  }
  assert.deepEqual(runs[0].compiled,runs[3].compiled,'Exact baseline restore produces the identical private compiled files')
  const callerFile=path.join(desktop,'src/renderer/src/components/SettingsPanel.tsx'),ts=require('typescript'),source=await fs.readFile(callerFile,'utf8'),tree=ts.createSourceFile(callerFile,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),callers=[]
  const visit=node=>{if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(tree)==='AgentSettingsPane')callers.push({file:path.relative(root,callerFile),line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1,symbol:'AgentSettingsPane',kind:'external product JSX'});ts.forEachChild(node,visit)};visit(tree);assert.ok(callers.length>0)
  const selectors=[...original.matchAll(/(^|\n)([^\n{}]+)\{([^{}]*)\}/g)].filter(match=>match[2].includes('.settings-executor-tools')).map(match=>({selector:match[2].trim(),declarations:match[3].trim()}));assert.ok(selectors.length>0)
  for(const selector of ['.settings-executor-tools','.settings-executor-tools .settings-resource-search'])assert.equal(selectors.filter(rule=>rule.selector===selector).length,1,'Unique actual source-derived owner selector')
  for(const [file,digest]of inputs)assert.equal(hash(await fs.readFile(file)),digest,`Proof input changed: ${file}`)
  assert.ok(inputs.size>0)
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify({passed:true,captureOnly:true,aestheticReview:'not-performed',boundary:'Finite actual product Renderer/CSS/Preview with trusted events; no Core build, native CLI/Runtime/Run/restart/install or aesthetic acceptance.',runs,
    sourceSelectors:selectors,actualExternalProductJSXCallers:callers,inputs:Object.fromEntries([...inputs].map(([file,digest])=>[path.relative(root,file),digest])),sourceUnchanged:true,privateCompiledBytesArchived:true},null,2))
  console.log(JSON.stringify({passed:true,evidence,inputs:inputs.size,runs:runs.map(run=>({mode:run.mode,frames:run.frames,assertion:run.assertion}))}))
} catch(error){await fs.writeFile(path.join(evidence,'failure.json'),JSON.stringify({name:error.name,message:error.message,stack:error.stack,runs},null,2));throw error}
finally{assert.deepEqual(await listProbeProcesses(-1,privateRoot),[],'Owned renderer processes remain');await fs.rm(privateRoot,{recursive:true,force:true});await assert.rejects(fs.stat(privateRoot),{code:'ENOENT'});await fs.writeFile(path.join(evidence,'cleanup.json'),JSON.stringify({privateRoot,privateProcessesReaped:true,temporaryRootRemoved:true}))}
