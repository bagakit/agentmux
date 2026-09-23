import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/space-tree-alignment')
const generation = { id: `space-tree-${Date.now()}`, createdAt: new Date().toISOString() }
const proof = path.resolve(process.argv[2] ?? path.join(root, '.tmp/space-tree-navigation',generation.id))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const execFileAsync = promisify(execFile)
const baselineIndex=process.argv.indexOf('--baseline')
const baselineRevision=baselineIndex<0?null:process.argv[baselineIndex+1]
assert.ok(baselineIndex<0||baselineRevision,'--baseline requires an explicit immutable source revision')
const overrides=new Map()
const loadedOverrides=new Set()
const cssAliases=new Map()
let actualModules=[]
let actualCssImports=[]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, {withFileTypes:true})).map(entry=>
  entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]))).flat()
let inputs = [fileURLToPath(import.meta.url), path.join(desktop, 'scripts/probe-process.mjs'),
  ...['main.cjs', 'entry.mjs', 'index.html', 'scenario.md'].map(name => path.join(fixture, name)),
  ...(await fs.readdir(path.join(desktop, 'src/renderer/src/styles'))).filter(name => name.endsWith('.css')).map(name => path.join(desktop, 'src/renderer/src/styles', name))]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [path.relative(root, file),
  hash(overrides.get(file)?.bytes??await fs.readFile(file))])))
const result = { schema:'agentmux.space-tree-alignment-native.v2',passed: false,captureOnly:true,aestheticReview:'not-performed',
  generation,candidate:null,baseline:null,sourceOverrides:{},inputInventory:null,inputs:null,generatedInputs:{},compiledOutputs:{},
  compiledArtifacts:{preserved:true,recordOnly:false,pathBase:'receipt-directory'},native:null,phases:[],images:[],matrix:[],cleanup:null }
await fs.mkdir(proof, { recursive: true })
assert.equal(await fs.access(path.join(proof,'receipt.json')).then(()=>true,()=>false),false,'Use a new evidence directory; a generation cannot overwrite another')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-space-tree-'))
try {
  const identity=await Promise.all(['HEAD','HEAD^{tree}'].map(rev=>execFileAsync('git',['rev-parse',rev],{cwd:root})))
  result.candidate={commit:identity[0].stdout.trim(),tree:identity[1].stdout.trim()}
  if(baselineRevision) {
    const {stdout}=await execFileAsync('git',['rev-parse',`${baselineRevision}^{commit}`],{cwd:root})
    const commit=stdout.trim()
    // Bounded historical substitutions. All other actual modules belong to this current harness.
    for(const relative of [
      'apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx',
      'apps/desktop/src/renderer/src/components/SpaceTopicsTree.tsx',
      'apps/desktop/src/renderer/src/components/ProjectIcon.tsx',
      'apps/desktop/src/renderer/src/lib/project-monogram.ts',
      'apps/desktop/src/renderer/src/styles/chrome.css',
      'apps/desktop/src/renderer/src/styles/conversation-avatar.css',
      'apps/desktop/src/renderer/src/components/SpaceSectionHeader.tsx',
      'apps/desktop/src/renderer/src/styles/index.css'
    ]) {
      const {stdout:bytes}=await execFileAsync('git',['show',`${commit}:${relative}`],{cwd:root,maxBuffer:4*1024*1024})
      assert.ok(bytes.length>0,`Historical ${relative} must be nonempty`)
      const preserved=`compiled/baseline-sources/${relative}`
      overrides.set(path.join(root,relative),{bytes,commit,path:relative,sha256:hash(bytes),preserved})
      await fs.mkdir(path.dirname(path.join(proof,preserved)),{recursive:true})
      await fs.writeFile(path.join(proof,preserved),bytes)
      result.sourceOverrides[relative]={commit,path:relative,sha256:hash(bytes),preserved}
      if(relative.endsWith('.css')&&!relative.endsWith('/index.css'))
        cssAliases.set(path.join(proof,preserved),path.join(root,relative))
    }
    result.baseline={commit,captureOnly:true,newContracts:'not-asserted',
      boundary:'Only these eight immutable Space product modules/styles are historical. All other loaded harness, Store, CSS and Core inputs belong to the current candidate; this is no claim of a complete historical main build.'}
  }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    resolve:{alias:[...cssAliases].map(([physical,logical])=>({find:`./${path.basename(logical)}`,replacement:physical}))},
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{name:'load-explicit-baseline-space-bytes',enforce:'pre',load(id){
      const override=overrides.get(id)
      if(override) {loadedOverrides.add(id);return override.bytes}
      return null
    }},
      { name: 'bind-tree-source', buildEnd() {
      actualModules=[...this.getModuleIds()].filter(file => file.startsWith(root + '/') && !file.includes('/node_modules/') && !file.includes('?'))
      const watched=new Set(this.getWatchFiles())
      actualCssImports=[...watched].filter(file=>file.endsWith('.css')).map(file=>cssAliases.get(file)??file)
      for(const [physical,logical] of cssAliases) {
        assert.equal(watched.has(physical),true,`Historical CSS must be a real Vite importer dependency: ${logical}`)
        loadedOverrides.add(logical)
        result.sourceOverrides[path.relative(root,logical)].loadedAs=path.relative(root,physical)
        result.sourceOverrides[path.relative(root,logical)].loader='vite-css-import-alias'
      }
      inputs = [...new Set([...inputs, ...actualModules])]
    } }],
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  result.inputs = await hashes()
  result.inputInventory={actualModules:actualModules.map(file=>path.relative(root,file)),
    actualCssImports:actualCssImports.filter(file=>file.startsWith(root+'/')).map(file=>path.relative(root,file)),
    registeredStyles:inputs.filter(file=>file.endsWith('.css')).map(file=>path.relative(root,file)),
    boundary:'inputs binds actual production modules plus runner/fixture files and all registered styles; registered styles absent from actualModules are not claimed to have been loaded.'}
  assert.ok(Object.keys(result.inputs).some(file => file.endsWith('/WorkspaceSidebar.tsx')))
  assert.ok(Object.keys(result.inputs).some(file => file.endsWith('/SpaceTopicsTree.tsx')))
  for(const [file,override] of overrides) {
    assert.equal(loadedOverrides.has(file),true,'Historical override must pass the actual Vite load hook')
    assert.equal(result.inputs[path.relative(root,file)],override.sha256,'Historical override must actually be loaded and bound')
  }
  result.generatedInputs=Object.fromEntries(Object.entries(result.inputs).filter(([file])=>file.startsWith('packages/core/dist/')))
  await fs.cp(path.join(privateRoot,'renderer'),path.join(proof,'compiled/renderer'),{recursive:true})
  for(const file of await files(path.join(proof,'compiled'))) result.compiledOutputs[path.relative(proof,file)]=hash(await fs.readFile(file))
  assert.ok(Object.keys(result.compiledOutputs).length>0)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  result.exit = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot,baselineRevision?'baseline':'seed',JSON.stringify(generation)],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 50000 })
  result.native = JSON.parse(await fs.readFile(path.join(privateRoot, 'native.json'), 'utf8'))
  result.phases.push({phase:baselineRevision?'baseline':'seed',exit:result.exit,native:result.native})
  result.matrix=result.native.matrix
  if (!baselineRevision && result.exit.exitCode === 0 && result.native.passed) {
    result.restartExit = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, 'restore',JSON.stringify(generation)],
      { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 35000 })
    result.restartNative = JSON.parse(await fs.readFile(path.join(privateRoot, 'native.json'), 'utf8'))
    result.phases.push({phase:'restore',exit:result.restartExit,native:result.restartNative})
    assert.equal(result.restartExit.exitCode, 0, result.restartNative.failure?.message)
    assert.equal(result.restartNative.passed, true)
    assert.notEqual(result.native.pid, result.restartNative.pid)
    assert.deepEqual(result.restartNative.restart.retained, result.native.durable)
  }

  result.images=result.phases.flatMap(phase=>phase.native.images)
  assert.ok(result.images.length>0)
  for(const image of result.images) {
    await fs.copyFile(path.join(privateRoot,image.file),path.join(proof,image.file))
    assert.equal(hash(await fs.readFile(path.join(proof,image.file))),image.sha256)
  }
  assert.equal(result.exit.timedOut, false)
  assert.equal(result.exit.exitCode, 0, result.native.failure?.message)
  assert.equal(result.native.passed, true)
  assert.equal(result.matrix.length,12)
  for(const phase of result.phases) {
    assert.deepEqual(phase.native.generation,generation)
    assert.ok(phase.native.operations.length>0)
  }
  assert.deepEqual(await hashes(), result.inputs)
  result.passed = true
} catch (error) { result.failure = { message: error.message, stack: error.stack } }
finally {
  result.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), rootRemoved: false }
  if (!result.cleanup.remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); result.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(proof, 'receipt.json'), JSON.stringify(result, null, 2))
}
assert.equal(result.cleanup.remaining.length, 0)
assert.equal(result.cleanup.rootRemoved, true)
assert.equal(result.passed, true, result.failure?.message)
console.log(JSON.stringify({ passed: true, pid: result.native.pid, inputs: Object.keys(result.inputs).length, cleanup: result.cleanup }))
