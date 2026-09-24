import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/settings-overview')
const require = createRequire(path.join(desktop, 'package.json'))
const ts = require('typescript')
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const configFile = path.join(fixture, 'vitest.config.mts')
const { config } = await loadConfigFromFile({ command:'build', mode:'production' }, configFile, root)
const evidence = path.join(root, '.tmp/settings-overview', 'run-' + Date.now() + '-' + randomUUID())
await fs.mkdir(evidence, { recursive:true })
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-settings-overview-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), runs = []
const file = relative => path.join(desktop, relative)
const panelFile = file('src/renderer/src/components/SettingsPanel.tsx')
const appFile = file('src/renderer/src/App.tsx')
const chromeFile = file('src/renderer/src/components/TopRowChrome.tsx')
const cssFile = file('src/renderer/src/styles/settings-overview.css')
const [panel, app, chrome, css] = await Promise.all([panelFile,appFile,chromeFile,cssFile].map(f=>fs.readFile(f,'utf8')))
const tree = (filename, text) => ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const collect = (sourceTree, predicate) => {
  const found = []
  const visit = node => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit) }
  visit(sourceTree)
  return found
}
const one = (nodes, label) => { assert.equal(nodes.length, 1, 'Exactly one nonempty ' + label); return nodes[0] }
const p = tree(panelFile,panel), a = tree(appFile,app), c = tree(chromeFile,chrome)
const ordinary = one(collect(c,n=>ts.isCallExpression(n)&&n.expression.getText(c)==='onOpenSettings'&&n.arguments[0]?.getText(c)==="'overview'"), 'ordinary Settings argument').arguments[0]
const visited = one(collect(p,n=>ts.isCallExpression(n)&&n.expression.getText(p)==='visited.map'), 'visited rendering').expression.expression
const settings = one(collect(a,n=>(ts.isJsxSelfClosingElement(n)||ts.isJsxOpeningElement(n))&&n.tagName.getText(a)==='SettingsPanel'), 'actual App SettingsPanel')
const target = one(settings.attributes.properties.filter(n=>ts.isJsxAttribute(n)&&n.name.getText(a)==='initialSection'), 'actual route forwarding').initializer.expression
const pause = [...css.matchAll(/animation-play-state:\s*paused/g)]
assert.equal(pause.length, 1, 'One actual Overview paused declaration')
const mutate = (source, node, replacement) => {
  const start = node.getStart(), end = node.end
  assert.ok(start >= 0 && end > start)
  assert.equal(source.slice(start,end), node.getText())
  return source.slice(0,start) + replacement + source.slice(end)
}
const mutants = [
  { id:'ordinary-entry', mode:'entry', file:chromeFile, source:chrome, mutated:mutate(chrome,ordinary,"'appearance'"), assertion:'Ordinary Settings opens Overview' },
  { id:'visited-draft', mode:'draft', file:panelFile, source:panel, mutated:mutate(panel,visited,'[active]'), assertion:'Visited General preserves original draft control' },
  { id:'exact-executor-target', mode:'target', file:appFile, source:app, mutated:mutate(app,target,"'overview'"), assertion:'Actual Executor entry bypasses Overview' },
  { id:'hidden-motion', mode:'motion', file:cssFile, source:css, mutated:css.slice(0,pause[0].index)+pause[0][0].replace('paused','running')+css.slice(pause[0].index+pause[0][0].length), assertion:'Hidden page pauses the actual decorative animation' }
]
async function bind(filename) {
  const bytes = await fs.readFile(filename), stat = await fs.stat(filename)
  const record = { sha256:hash(bytes), bytes:bytes.length, mode:stat.mode&0o777 }
  if (inputs.has(filename)) assert.deepEqual(record, inputs.get(filename), 'Proof input changed: ' + filename)
  else {
    inputs.set(filename,record)
    const relative = filename.startsWith(root+path.sep) ? path.relative(root,filename) : path.join('external',hash(filename),path.basename(filename))
    const destination = path.join(evidence,'source',relative)
    await fs.mkdir(path.dirname(destination),{recursive:true})
    await fs.writeFile(destination,bytes)
    await fs.chmod(destination,record.mode)
  }
}
async function files(directory, prefix='') {
  const found = []
  for (const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})) {
    const relative = path.join(prefix,entry.name)
    if (entry.isDirectory()) found.push(...await files(directory,relative))
    else { const bytes=await fs.readFile(path.join(directory,relative)); found.push({ file:relative,bytes:bytes.length,sha256:hash(bytes) }) }
  }
  return found.sort((x,y)=>x.file.localeCompare(y.file))
}
async function run(id, mutant=null, mode='full') {
  const directory=path.join(evidence,id), output=path.join(privateRoot,id)
  await fs.mkdir(directory)
  let consumed=0
  const privateCSS = mutant?.file===cssFile ? path.join(privateRoot,id+'-source','settings-overview.css') : null
  if (privateCSS) { await fs.mkdir(path.dirname(privateCSS),{recursive:true}); await fs.writeFile(privateCSS,mutant.mutated) }
  const aliases=Array.isArray(config.resolve.alias)?config.resolve.alias:Object.entries(config.resolve.alias).map(([find,replacement])=>({find,replacement}))
  const resolve={...config.resolve,alias:privateCSS?[{find:'./settings-overview.css',replacement:privateCSS},...aliases]:aliases}
  let owningCSSLoads=0
  await build({ configFile:false, root:fixture, base:'./', logLevel:'error',
    resolve, define:{ __AGENTMUX_WEB_PREVIEW__:'true' },
    css:{postcss:{plugins:[{postcssPlugin:'actual-overview-css-source-binding',async OnceExit(cssTree) {
      const loaded=new Map()
      cssTree.walk(n=>{const input=n.source?.input;if(input?.file)loaded.set(input.file,input.css)})
      assert.ok(loaded.size>0,'Actual stylesheet import scan is nonempty')
      for (const [filename,source] of loaded) {
        await bind(filename)
        if (filename===(privateCSS??cssFile)) {
          assert.equal(source,privateCSS?mutant.mutated:css,'Actual owning stylesheet bytes were loaded')
          owningCSSLoads++
          if (privateCSS) consumed++
        }
      }
    }}]}},
    plugins:[{ name:'actual-owning-overview-source', enforce:'pre', async transform(code,id) {
      const filename=id.split('?')[0]
      if (!path.isAbsolute(filename) || filename.includes('/node_modules/')) return null
      try { await bind(filename) } catch(error) { if(error.code==='ENOENT'||error.code==='EISDIR')return null;throw error }
      if (mutant && filename===mutant.file && !privateCSS) {
        assert.equal(code,mutant.source,'Mutation consumes actual owning source')
        consumed++
        return { code:mutant.mutated,map:null }
      }
      return null
    }}],
    build:{ outDir:output,emptyOutDir:true,minify:false,target:'esnext' }
  })
  assert.equal(owningCSSLoads,1,'One actual Overview stylesheet import')
  if (mutant) assert.equal(consumed,1,'Actual owning mutation loaded exactly once')
  const compiled=await files(output)
  assert.ok(compiled.length>0)
  if (!mutant&&runs.length) assert.deepEqual(compiled,runs[0].compiled,'Restored actual bundle/asset bytes are exact')
  await fs.cp(output,path.join(directory,'compiled'),{recursive:true})
  assert.deepEqual(await files(path.join(directory,'compiled')),compiled)
  if (mutant) await fs.writeFile(path.join(directory,'owning-mutant-source'+path.extname(mutant.file)),mutant.mutated)
  const stderr=[],env={...process.env}
  delete env.ELECTRON_RUN_AS_NODE
  const execution=await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(output,'index.html'),privateRoot,directory,mode],
    { temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>stderr.push(line) })
  await fs.writeFile(path.join(directory,'execution.json'),JSON.stringify(execution,null,2))
  await fs.writeFile(path.join(directory,'stderr.log'),stderr.join('\n'))
  const render=JSON.parse(await fs.readFile(path.join(directory,'render.json'),'utf8'))
  const record={ id,mode,execution,compiled,frames:render.frames,failure:render.failure,
    owning:mutant?{file:path.relative(root,mutant.file),source:hash(mutant.source),mutated:hash(mutant.mutated),consumed}:null }
  runs.push(record)
  assert.equal(execution.timedOut,false)
  if (mutant) {
    assert.equal(execution.exitCode,1)
    assert.equal(render.passed,false)
    assert.equal(render.failure.name,'AssertionError','Only behavioral assertion counts as owning RED')
    assert.ok(render.failure.message.includes(mutant.assertion),render.failure.message)
  } else {
    assert.equal(execution.exitCode,0,render.failure?.message)
    assert.equal(render.passed,true)
    if (mode==='full') assert.equal(render.frames.length,6)
  }
  console.log(JSON.stringify({id,mode,passed:!mutant,owningAssertionRed:!!mutant,evidence:directory}))
}
try {
  for (const filename of [fileURLToPath(import.meta.url),configFile,path.join(fixture,'main.cjs'),path.join(fixture,'entry.mjs'),path.join(fixture,'index.html'),
    file('scripts/fixtures/settings-structure/entry.mjs'),file('scripts/fixtures/settings-workbench/entry.mjs'),file('scripts/probe-process.mjs'),
    path.join(root,'pnpm-lock.yaml'),path.join(root,'package.json'),path.join(desktop,'package.json')]) await bind(filename)
  await run('control')
  for (const mutant of mutants) {
    await run(mutant.id+'-red',mutant,mutant.mode)
    await run(mutant.id+'-restored',null,mutant.mode)
  }
  const callers=[]
  for (const [symbol,filename] of [['SettingsPanel',appFile],['SettingsOverviewPane',panelFile],['SurfaceSwitch',appFile]]) {
    const source=await fs.readFile(filename,'utf8'),ast=tree(filename,source)
    const actual=collect(ast,n=>(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n))&&n.tagName.getText(ast)===symbol)
    assert.ok(actual.length>0,'Definition-excluded actual caller: '+symbol)
    callers.push(...actual.map(n=>({symbol,file:path.relative(root,filename),line:ast.getLineAndCharacterOfPosition(n.getStart()).line+1})))
  }
  const avatarFile=file('src/renderer/src/components/AgentAvatar.tsx'), avatar=await fs.readFile(avatarFile,'utf8'), avatarTree=tree(avatarFile,avatar)
  const route=one(collect(avatarTree,n=>ts.isCallExpression(n)&&n.expression.getText(avatarTree)==='navigation.open'),'actual Executor settings call')
  callers.push({symbol:'SettingsNavigation.open',file:path.relative(root,avatarFile),line:avatarTree.getLineAndCharacterOfPosition(route.getStart()).line+1,expression:route.getText(avatarTree)})
  assert.ok(inputs.size>0)
  for (const filename of [panelFile,appFile,chromeFile,cssFile,file('resources/settings-banner.png')]) assert.ok(inputs.has(filename),'Actual loaded input missing: '+filename)
  for (const [filename,record] of inputs) {
    const bytes=await fs.readFile(filename),stat=await fs.stat(filename)
    assert.deepEqual({sha256:hash(bytes),bytes:bytes.length,mode:stat.mode&0o777},record,'Actual input changed after proof')
  }
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify({passed:true,boundary:'Actual isolated Renderer/CSS/public Preview. Controlled visibility seam. No Core/Native durable/restart/user installation.',runs,actualExternalProductCallers:callers,
    inputs:Object.fromEntries([...inputs].map(([filename,record])=>[path.relative(root,filename),record])),sourceUnchanged:true,compiledAndAssetBytesArchived:true,aestheticReview:'pending independent complete PNG review'},null,2))
  console.log(JSON.stringify({passed:true,evidence,inputs:inputs.size,runs:runs.length,frames:6}))
} catch(error) {
  await fs.writeFile(path.join(evidence,'failure.json'),JSON.stringify({name:error.name,message:error.message,stack:error.stack,runs,
    inputs:Object.fromEntries([...inputs].map(([filename,record])=>[path.relative(root,filename),record]))},null,2))
  throw error
} finally {
  assert.deepEqual(await listProbeProcesses(-1,privateRoot),[],'Owned private preview processes remain')
  await fs.rm(privateRoot,{recursive:true,force:true})
  await assert.rejects(fs.stat(privateRoot),{code:'ENOENT'})
  await fs.writeFile(path.join(evidence,'cleanup.json'),JSON.stringify({privateRoot,ownedProcessesReaped:true,privateRootRemoved:true}))
}
