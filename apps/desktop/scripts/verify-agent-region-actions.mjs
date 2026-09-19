import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from './probe-process.mjs'
import { reapDetachedRuns } from './probe-owned-run.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(import.meta.url), { build } = await import('vite')
const privateRoot = await mkdtemp('/tmp/amx-region-actions-')
const evidence = join(repository, '.tmp/agent-region-actions'), fixture = join(desktop, 'scripts/fixtures/agent-region-actions')
const result = { schema: 'agentmux.region-actions-delivery.v1', passed: false, sourceBefore: {}, sourceAfter: {}, cleanup: {}, userRunTouched: false }
const sourceFiles = [import.meta.filename, ...['main.cjs','entry.tsx','index.html'].map(name => join(fixture, name)),
  ...['components/WorkspaceWorkbench.tsx','components/AgentRegionHeader.tsx','components/RegionContextMenu.tsx','components/SessionPane.tsx','components/SessionHistoryView.tsx','components/TerminalView.tsx','store.ts','lib/workbench-tabs.ts','lib/workbench-surface-kinds.ts'].map(name => join(desktop, 'src/renderer/src', name)),
  ...['verify-workbench-persistence-restart.mjs','probe-process.mjs','probe-owned-run.mjs'].map(name => join(desktop, 'scripts', name))]
const styles = (await readdir(join(desktop, 'src/renderer/src/styles'))).filter(name => name.endsWith('.css'))
assert.ok(styles.length > 0, 'Actual styles must be included in the input binding')
for (const name of styles) sourceFiles.push(join(desktop, 'src/renderer/src/styles', name))
async function hashes() { return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])) ) }
async function execute(binary, args, timeout) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  let diagnostics = ''
  const outcome = await runProbeProcess(binary, args, { temporaryRoot: privateRoot, cwd: repository, env,
    timeoutMs: timeout, onLine: line => { diagnostics = (diagnostics + line + '\n').slice(-8192) } })
  assert.equal(outcome.exitCode, 0, `Private proof exited ${outcome.exitCode}: ${diagnostics}`)
  assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
}
async function restartProof(watchdog) {
  const directory=join(privateRoot,watchdog?'restart-watchdog':'restart-normal')
  await mkdir(directory)
  const args=[join(desktop,'scripts/verify-workbench-persistence-restart.mjs'),'--close-region',`--probe-root=${directory}`]
  if(watchdog)args.push('--hold-for-watchdog')
  let outcome,runReady=false,diagnostics='',detachedRuns
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  try {
    outcome=await runProbeProcess(process.execPath,args,{temporaryRoot:privateRoot,cwd:repository,env,
      timeoutMs:watchdog?20000:125000,onLine:line=>{runReady ||= line==='region_restart_private_run_ready';diagnostics=(diagnostics+line+'\n').slice(-8192)}})
  } finally { detachedRuns=await reapDetachedRuns(directory) }
  if(watchdog) {
    assert.equal(runReady,true,'The watchdog counterexample must reach an actual private Run')
    assert.equal(outcome.timedOut,true);assert.equal(outcome.exitCode,1)
    assert.equal(detachedRuns.length,1);assert.equal(detachedRuns[0].reaped,true)
    assert.equal(detachedRuns[0].innerFinallyReached,false,'Owned cleanup must work when SIGKILL skips Node finally')
    return {passed:true,...outcome,detachedRuns}
  }
  assert.equal(outcome.exitCode,0,diagnostics);assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
}
try {
  await mkdir(evidence, { recursive: true }); result.sourceBefore = await hashes()
  if (process.argv.includes('--watchdog-only')) result.watchdog = await restartProof(true)
  else {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' }, build: { outDir: join(privateRoot, 'renderer'), emptyOutDir: true } })
  await execute(require('electron'), [join(fixture, 'main.cjs'), join(privateRoot, 'renderer/index.html'), privateRoot, evidence], 60_000)
  result.render = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8'))
  assert.equal(result.render.passed, true)
  if (!process.argv.includes('--render-only')) {
    await restartProof(false)
    result.restart = JSON.parse(await readFile(join(repository, '.tmp/workbench-persistence-last-crash.json'), 'utf8'))
    assert.equal(result.restart.passed, true); assert.equal(result.restart.regionClose, true)
    result.watchdog = await restartProof(true)
  }
  }
  result.sourceAfter = await hashes(); assert.deepEqual(result.sourceAfter, result.sourceBefore)
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message } }
finally {
  await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot)
  result.cleanup.remaining = await listProbeProcesses(process.pid + 1_000_000_000, privateRoot)
  assert.deepEqual(result.cleanup.remaining, [])
  await rm(privateRoot, { recursive: true }); result.cleanup.rootRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, frames: result.render?.frames.length, restart: result.restart?.passed, receipt: join(evidence, 'receipt.json'), failure: result.failure }))
if (!result.passed) process.exitCode = 1
