import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root,'apps/desktop'), fixture = path.join(desktop,'scripts/fixtures/settings-structure')
const require = createRequire(path.join(desktop,'package.json')), ts = require('typescript')
const postcss = createRequire(require.resolve('vite/package.json'))('postcss')
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const configFile = path.join(fixture,'vitest.config.mts')
const { config } = await loadConfigFromFile({command:'build',mode:'production'},configFile,root)
const evidence = path.join(root,'.tmp/settings-structure',`run-${Date.now()}-${randomUUID()}`)
await fs.mkdir(evidence,{recursive:true})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), runs = [], callers = []
const owningOnly = process.argv.includes('--owning-only')
const footerOnly = process.argv.includes('--footer-only')
assert.ok(!(owningOnly&&footerOnly),'Select one bounded diagnostic mode')
const qualification = footerOnly?'partial-footer-only':owningOnly?'partial-owning-only':'full-renderer'
const panelFile = path.join(desktop,'src/renderer/src/components/SettingsPanel.tsx')
const chromeFile = path.join(desktop,'src/renderer/src/components/TopRowChrome.tsx')
const panelSource = await fs.readFile(panelFile,'utf8'), chromeSource = await fs.readFile(chromeFile,'utf8')
const tree = (file,source) => ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const collect = (sourceTree,predicate) => {const found=[];const visit=node=>{if(predicate(node))found.push(node);ts.forEachChild(node,visit)};visit(sourceTree);return found}
const panel = tree(panelFile,panelSource), chrome = tree(chromeFile,chromeSource)
const one = (nodes,label) => {assert.equal(nodes.length,1,`Exactly one actual ${label}`);return nodes[0]}
const ordinary = one(collect(chrome,n=>ts.isCallExpression(n)&&n.expression.getText(chrome)==='onOpenSettings'&&n.arguments[0]?.getText(chrome)==="'appearance'"),'ordinary Settings callback argument').arguments[0]
const general = one(collect(panel,n=>ts.isJsxSelfClosingElement(n)&&n.tagName.getText(panel)==='GeneralSettingsPane'),'General JSX')
const generalSave = one(general.attributes.properties.filter(n=>ts.isJsxAttribute(n)&&n.name.getText(panel)==='onSave'),'General save attribute').initializer.expression
assert.equal(generalSave.getText(panel),'saveCopyPathsAsAbsolute')
const visited = one(collect(panel,n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.getText(panel)==='visited.map'),'visited rendering receiver').expression.expression
const groups = one(collect(panel,n=>ts.isVariableDeclaration(n)&&n.name.getText(panel)==='navGroups'),'navigation groups initializer').initializer
const sections = one(collect(panel,n=>ts.isVariableDeclaration(n)&&n.name.getText(panel)==='SECTIONS'),'actual sections').initializer
assert.ok(ts.isArrayLiteralExpression(sections)&&sections.elements.length>0)
const sectionsActual = sections.elements.map(entry=>{
  assert.ok(ts.isObjectLiteralExpression(entry));const fields=new Map(entry.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(panel),p.initializer]))
  const value=name=>{let n=fields.get(name);while(ts.isAsExpression(n))n=n.expression;assert.ok(ts.isStringLiteral(n));return n.text}
  return{id:value('id'),title:value('title'),group:value('group')}
})
assert.deepEqual(sectionsActual.map(n=>n.id),['appearance','notifications','browser','general','agents','prompts','workspaces','hosts'])
assert.deepEqual(sectionsActual.map(n=>n.group),['preferences','preferences','preferences','preferences','resources','resources','resources','resources'])
const mutate = (source,node,replacement) => {const start=node.getStart(),end=node.end;assert.ok(start>=0&&end>start&&source.slice(start,end)===node.getText());return source.slice(0,start)+replacement+source.slice(end)}
const mutants = [
  {id:'ordinary-entry',file:chromeFile,source:chromeSource,node:ordinary,replacement:"'workspaces'",assertion:'Actual ordinary Settings entry opens Appearance'},
  {id:'general-save-owner',file:panelFile,source:panelSource,node:generalSave,replacement:'async () => {}',assertion:'General save reaches the original public config owner exactly once'},
  {id:'visited-draft',file:panelFile,source:panelSource,node:visited,replacement:'[active]',assertion:'Visited General preserves the original mounted draft control'},
  {id:'whole-navigation-empty',file:panelFile,source:panelSource,node:groups,replacement:'[]',assertion:'Complete preference/resource groups are nonempty'}
].map(m=>({...m,mutated:mutate(m.source,m.node,m.replacement),position:{start:m.node.getStart(),end:m.node.end}}))
const cssFile = path.join(desktop,'src/renderer/src/styles/agent.css')
const cssSource = await fs.readFile(cssFile,'utf8')
const cssBaselineCommit = '3ac660d2'
const { stdout: cssBaseline } = await promisify(execFile)('git',['show',`${cssBaselineCommit}:apps/desktop/src/renderer/src/styles/agent.css`],{cwd:root,maxBuffer:1024*1024})
const media = (source,file) => one(postcss.parse(source,{from:file}).nodes.filter(n=>n.type==='atrule'&&n.name==='media'&&n.params==='(max-width: 560px)'&&n.nodes?.some(r=>r.selector==='.surface-navigation__slot')),'actual compact footer media owner')
const currentMedia=media(cssSource,cssFile),oldMedia=media(cssBaseline,cssFile)
const cssStart=currentMedia.source.start.offset,cssEnd=currentMedia.source.end.offset
assert.equal(cssSource.slice(cssStart,cssEnd),currentMedia.toString())
const cssMutated=cssSource.slice(0,cssStart)+oldMedia.toString()+cssSource.slice(cssEnd)
mutants.push({id:'compact-footer-css',file:cssFile,source:cssSource,mutated:cssMutated,css:true,
  position:{start:cssStart,end:cssEnd},assertion:'Control has five actual CSS hits',baseline:{commit:cssBaselineCommit,sha256:hash(cssBaseline),block:oldMedia.toString()}})
await fs.writeFile(path.join(evidence,'agent-css-baseline-3ac660d2.css'),cssBaseline)

async function bind(file) {
  const bytes=await fs.readFile(file),stat=await fs.stat(file),record={sha256:hash(bytes),bytes:bytes.length,mode:stat.mode&0o777}
  if(inputs.has(file))assert.deepEqual(record,inputs.get(file),`Actual proof input changed: ${file}`)
  else{inputs.set(file,record);const target=path.join(evidence,'source',path.relative(root,file));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);await fs.chmod(target,record.mode)}
}
async function files(directory,prefix='') {
  const found=[]
  for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){
    const file=path.join(prefix,entry.name)
    if(entry.isDirectory())found.push(...await files(directory,file))
    else{const bytes=await fs.readFile(path.join(directory,file));found.push({file,bytes:bytes.length,sha256:hash(bytes)})}
  }
  return found.sort((a,b)=>a.file.localeCompare(b.file))
}
async function run(id,mutant,mode) {
  const directory=path.join(evidence,id),output=path.join(privateRoot,id);await fs.mkdir(directory)
  let consumed=0
  const cssInputs=new Set()
  let privateCSS=mutant?.css?path.join(privateRoot,id+'-source','agent.css'):null
  if(privateCSS){await fs.mkdir(path.dirname(privateCSS),{recursive:true});await fs.writeFile(privateCSS,mutant.mutated);privateCSS=await fs.realpath(privateCSS)}
  const alias = Array.isArray(config.resolve.alias)?config.resolve.alias:Object.entries(config.resolve.alias).map(([find,replacement])=>({find,replacement}))
  const resolve = {...config.resolve,alias:privateCSS?[{find:'./agent.css',replacement:privateCSS},...alias]:alias}
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve,
    css:{postcss:{plugins:[{postcssPlugin:'actual-loaded-css-source-binding',async OnceExit(css){
      const loaded=new Map()
      css.walk(n=>{const input=n.source?.input;if(input?.file)loaded.set(input.file,input.css)})
      assert.ok(loaded.size>0,'Actual CSS load yielded source dependencies')
      for(const[file,source]of loaded){
        if(file===privateCSS){assert.equal(source,mutant.mutated);consumed++;cssInputs.add(file)}
        else if(file.startsWith(root+'/')&&!file.includes('/node_modules/')){await bind(file);cssInputs.add(file)}
      }
    }}]}},
    define:{...config.define,'process.env.NODE_ENV':'"production"'},
    plugins:[{name:'actual-settings-structure-owning-source',enforce:'pre',async transform(code,id){
      const file=id.split('?')[0]
      if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)
      if(mutant&&!mutant.css&&file===mutant.file){assert.equal(code,mutant.source);consumed++;return mutant.mutated}
    }}],build:{target:'esnext',outDir:output,emptyOutDir:true}})
  await fs.writeFile(path.join(directory,'loaded-css-sources.json'),JSON.stringify({privateCSS,consumed,files:[...cssInputs]},null,2))
  if(mutant)assert.equal(consumed,1,mutant.css?'The actual agent.css import resolves once to the private owning stylesheet':'The actual owning module was transformed exactly once')
  assert.ok(cssInputs.size>0)
  assert.ok(cssInputs.has(privateCSS??cssFile),'The actual agent.css dependency was consumed by PostCSS')
  const compiled=await files(output);assert.ok(compiled.length>0)
  if(!mutant&&runs.length)assert.deepEqual(compiled,runs[0].compiled,'Restored Renderer is byte-exact to the actual control bundle')
  await fs.cp(output,path.join(directory,'compiled'),{recursive:true});assert.deepEqual(await files(path.join(directory,'compiled')),compiled)
  await fs.writeFile(path.join(directory,'compiled-manifest.json'),JSON.stringify(compiled,null,2))
  if(mutant)await fs.writeFile(path.join(directory,'owning-mutant-source'+(mutant.css?'.css':'.tsx')),mutant.mutated)
  const compiledCss=compiled.filter(record=>record.file.endsWith('.css'));assert.ok(compiledCss.length>0)
  const widths=[]
  for(const record of compiledCss){const text=await fs.readFile(path.join(output,record.file),'utf8');postcss.parse(text).walkAtRules('media',rule=>{
    if(!rule.params.replaceAll(' ','').includes('max-width:560px'))return
    rule.walkRules('.surface-navigation__slot',slot=>slot.walkDecls('width',decl=>widths.push(decl.value)))
  })}
  assert.deepEqual(widths,[mutant?.css?'26px':'24px'],'Actual compiled compact slot reflects the selected real stylesheet')
  const cssBinding={loadedFiles:[...cssInputs].map(file=>file===privateCSS?'private-owning/agent.css':path.relative(root,file)),compiledCss,widths,
    sourceSha256:hash(mutant?.css?mutant.mutated:cssSource),importCallerUnchanged:true,baseline:mutant?.css?mutant.baseline:undefined}
  await fs.writeFile(path.join(directory,'css-binding.json'),JSON.stringify(cssBinding,null,2))
  const stderr=[],env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const execution=await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(output,'index.html'),privateRoot,directory,mode],
    {temporaryRoot:privateRoot,cwd:root,env,timeoutMs:mode==='matrix'?90000:30000,onLine:line=>stderr.push(line)})
  await fs.writeFile(path.join(directory,'execution.json'),JSON.stringify(execution,null,2));await fs.writeFile(path.join(directory,'stderr.log'),stderr.join('\n'))
  const render=JSON.parse(await fs.readFile(path.join(directory,'render.json'),'utf8'))
  const record={id,mode,execution,compiled,cssBinding,frames:render.frames.length,failure:render.failure,
    owning:mutant?{file:path.relative(root,mutant.file),source:hash(mutant.source),mutated:hash(mutant.mutated),position:mutant.position}:null}
  runs.push(record)
  assert.equal(execution.timedOut,false)
  if(mutant){assert.equal(execution.exitCode,1);assert.equal(render.passed,false);assert.equal(render.failure.name,'AssertionError');assert.ok(render.failure.message.includes(mutant.assertion),render.failure.message)}
  else{assert.equal(execution.exitCode,0,render.failure?.message);assert.equal(render.passed,true);assert.equal(render.frames.length,mode==='matrix'?48:0)}
  console.log(JSON.stringify({id,passed:!mutant,owningAssertionRed:!!mutant,frames:render.frames.length,evidence:directory}))
}
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(),'agentmux-settings-structure-'))
try {
  for(const file of [fileURLToPath(import.meta.url),path.join(fixture,'main.cjs'),path.join(fixture,'entry.mjs'),path.join(fixture,'index.html'),configFile,
    path.join(desktop,'scripts/fixtures/settings-workbench/entry.mjs'),path.join(desktop,'scripts/fixtures/settings-search-refinement/vitest.config.mts'),
    path.join(desktop,'scripts/probe-process.mjs'),path.join(root,'pnpm-lock.yaml'),path.join(root,'package.json'),path.join(desktop,'package.json'),
    path.join(root,'packages/core/package.json')])await bind(file)
  await run('control',null,footerOnly?'footer':owningOnly?'owning':'matrix')
  for(const mutant of mutants.filter(m=>!footerOnly||m.css)){await run(`${mutant.id}-red`,mutant,mutant.css?'footer':owningOnly?'owning':'behavior');await run(`${mutant.id}-restored`,null,mutant.css?'footer':owningOnly?'owning':'behavior')}
  for(const [symbol,file] of [['SettingsPanel',path.join(desktop,'src/renderer/src/App.tsx')],['SurfaceSwitch',path.join(desktop,'src/renderer/src/App.tsx')],['GeneralSettingsPane',panelFile]]){
    await bind(file);const source=await fs.readFile(file,'utf8'),sourceTree=tree(file,source)
    const uses=collect(sourceTree,n=>(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n))&&n.tagName.getText(sourceTree)===symbol)
    assert.ok(uses.length>0,`No definition-excluded actual product JSX caller: ${symbol}`)
    callers.push(...uses.map(n=>({symbol,file:path.relative(root,file),line:sourceTree.getLineAndCharacterOfPosition(n.getStart()).line+1})))
  }
  const saveOwner=one(collect(panel,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='saveCopyPathsAsAbsolute'),'copy save function')
  const ownerCalls=collect(saveOwner,n=>ts.isCallExpression(n)&&n.expression.getText(panel)==='api.config.save')
  assert.equal(ownerCalls.length,1);callers.push({symbol:'api.config.save',file:path.relative(root,panelFile),line:panel.getLineAndCharacterOfPosition(ownerCalls[0].getStart()).line+1,actualGeneralOnSave:generalSave.getText(panel)})
  assert.ok(inputs.size>0)
  for(const file of [panelFile,chromeFile,path.join(desktop,'src/renderer/src/App.tsx'),path.join(desktop,'src/renderer/src/components/settings/GeneralSettingsPane.tsx'),path.join(desktop,'src/renderer/src/styles/index.css')])assert.ok(inputs.has(file),`Actual loaded input missing: ${file}`)
  for(const[file,record]of inputs){const bytes=await fs.readFile(file),stat=await fs.stat(file);assert.deepEqual({sha256:hash(bytes),bytes:bytes.length,mode:stat.mode&0o777},record,`Actual input changed after proof: ${file}`)}
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify({passed:true,captureOnly:true,aestheticReview:'not-performed',
    boundary:'Finite actual Renderer/CSS/public Preview only. Electron executor/dependencies are not claimed by compiled Renderer hashes. No Runtime/Core build/durable restart/file manager/user installation.',
    qualification,matrixCompleted:!owningOnly&&!footerOnly,runs,sourceSections:sectionsActual,actualExternalProductCallers:callers,inputs:Object.fromEntries([...inputs].map(([f,r])=>[path.relative(root,f),r])),
    sourceUnchanged:true,privateCompiledBytesArchived:true},null,2))
  console.log(JSON.stringify({passed:true,evidence,inputs:inputs.size,runs:runs.length,frames:owningOnly||footerOnly?0:48,qualification}))
}catch(error){await fs.writeFile(path.join(evidence,'failure.json'),JSON.stringify({name:error.name,message:error.message,stack:error.stack,runs},null,2));throw error}
finally{
  assert.deepEqual(await listProbeProcesses(-1,privateRoot),[],'Owned Renderer processes remain')
  await fs.rm(privateRoot,{recursive:true,force:true});await assert.rejects(fs.stat(privateRoot),{code:'ENOENT'})
  await fs.writeFile(path.join(evidence,'cleanup.json'),JSON.stringify({privateRoot,privateProcessesReaped:true,temporaryRootRemoved:true}))
}
