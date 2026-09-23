import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

// Actual private App/Store/Chromium presentation proof. Host/Session facts are synthetic preview
// inputs; no product Main, Agent, Native, user Runtime, model or physical keyboard is controlled.
const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/stopped-session-view-close')
const evidence = join(repository, '.tmp/stopped-session-view-close-visual', `attempt-${Date.now()}`)
const privateRoot = await mkdtemp('/tmp/amx-close-view-'), require = createRequire(join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const result = { schema: 'agentmux.stopped-view-close-private.v1', passed: false, privateRoot, evidence, phases: [], captureOnly: true, aestheticReview: 'not-performed', cleanup: {}, productionActions: [] }
const identity = async paths => Object.fromEntries(await Promise.all(paths.map(async path => { const bytes = await readFile(path); return [path, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] })))
const own = [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'), ...['entry.tsx', 'main.cjs', 'index.html'].map(name => join(fixture, name)), ...['store.ts', 'lib/workbench-view-close.ts', 'components/WorkspaceWorkbench.tsx'].map(name => join(desktop, 'src/renderer/src', name))]
try {
 await mkdir(evidence, { recursive: true }); result.inputsBefore = await identity(own)
 const core = join(repository, 'packages/core'), exports = JSON.parse(await readFile(join(core, 'package.json'), 'utf8')).exports
 const alias = Object.entries(exports).sort((a,b) => b[0].length-a[0].length).map(([key,value]) => ({ find: '@agentmux/core'+(key==='.'?'':key.slice(1)), replacement: join(core,value.import) }))
 const loaded = new Set()
 await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias },
  plugins: [{ name: 'actual-input-binding', load(id) { if (!id.includes('\0')) loaded.add(id.split('?')[0]); return null } }],
  define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
  build: { target: 'esnext', outDir: join(evidence, 'renderer'), emptyOutDir: true } })
 result.loadedInputsBefore = await identity([...loaded].filter(path => path.startsWith('/'))); assert.ok(Object.keys(result.loadedInputsBefore).length > 0)
 const assets = (await readdir(join(evidence, 'renderer/assets'))).map(name => join(evidence, 'renderer/assets', name))
 result.compiledInputs = await identity(assets); assert.ok(assets.length > 0)
 const env = { ...process.env, HOME: join(privateRoot,'home'), TMPDIR: privateRoot }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
 for (const phase of ['first','second','third']) {
  const log = [], child = await runProbeProcess(require('electron'), [join(fixture,'main.cjs'), join(evidence,'renderer/index.html'),privateRoot,evidence,phase], { temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 60000, onLine: line => log.push(line) })
  await writeFile(join(evidence,phase+'-process.log'),log.join('\n')+'\n')
  const rendered = JSON.parse(await readFile(join(evidence,phase+'-render.json'),'utf8')); result.phases.push({ phase, child, rendered })
  assert.equal(child.exitCode,0); assert.equal(child.timedOut,false); assert.equal(child.interruption,null); assert.equal(rendered.passed,true,rendered.failure?.message)
  assert.ok(Object.keys(rendered.closedState.restoredWorkbench.tabs).length > 0)
  if (phase !== 'first') {
   const first = result.phases[0].rendered.closedState
   assert.deepEqual(rendered.closedState.restoredWorkbench,first.restoredWorkbench)
   assert.deepEqual(rendered.closedState.agentComposerDrafts,first.agentComposerDrafts)
   const original = first.agentSteerQueues['session-codex']; assert.equal(original.length,1)
   assert.deepEqual(rendered.closedState.agentSteerQueues,{ 'session-codex':[{...original[0],status:'deferred',error:'Queued before restart. Choose Send to execute this message.',errorCode:'AGENT_EXECUTION_NOT_REQUESTED'}] })
  }
 }
 assert.equal(new Set(result.phases.map(p=>p.rendered.pid)).size,3,'Two ordinary process restart/open cycles use new actual PIDs')
 result.inputsAfter = await identity(own); assert.deepEqual(result.inputsAfter,result.inputsBefore)
 result.loadedInputsAfter = await identity(Object.keys(result.loadedInputsBefore)); assert.deepEqual(result.loadedInputsAfter,result.loadedInputsBefore)
 result.passed = true
} catch(error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
 result.cleanup.remaining = await listProbeProcesses(process.pid+1_000_000_000,privateRoot)
 if (result.cleanup.remaining.length===0) { await rm(privateRoot,{recursive:true}); result.cleanup.rootRemoved = true }
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2)+'\n')
 await writeFile(join(repository,'.tmp/stopped-session-view-close-last.json'),JSON.stringify({ evidence, passed: result.passed, failure: result.failure, cleanup: result.cleanup },null,2)+'\n')
}
console.log(JSON.stringify({ passed: result.passed, evidence, phases: result.phases.length, cleanup: result.cleanup, failure: result.failure }))
if (!result.passed) process.exitCode = 1
