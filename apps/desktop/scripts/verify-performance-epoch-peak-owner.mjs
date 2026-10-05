import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { provePerformanceOwner, proofRoot as root, sha } from './performance-owner-proof.mjs'
const renderer = 'apps/desktop/src/renderer/src/lib/renderer-performance.ts'
const terminal = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const metrics = 'packages/core/src/metrics.ts'
const ui = 'apps/desktop/src/renderer/src/components/performance/PerformanceAttribution.tsx'
const store = 'apps/desktop/src/renderer/src/store.ts'
const unit = 'apps/desktop/test/performance-epoch-peak-owner.test.tsx'
const coverage = 'apps/desktop/test/renderer-performance-event-coverage.test.tsx'
const mounted = 'apps/desktop/test/terminal-checkpoint-continuation.test.tsx'
const visible = 'apps/desktop/test/performance-attribution.test.tsx'
const publicTest = 'packages/core/test/performance-public-diagnostics.test.ts'
const tests = [unit, coverage, mounted, visible, publicTest, 'apps/desktop/test/renderer-performance.test.tsx']
const owners = [renderer, terminal, metrics, ui, store]
const mutants = [
 ['latest-only', renderer, 'if (bucket && (!bucket[kind] || durationMs > bucket[kind]!.durationMs)) bucket[kind] = event', 'void bucket', [unit]],
 ['latest-unbounded', renderer, 'if (records.length === 4) records.shift()', 'if (records.length === 40) records.shift()', [unit]],
 ['ties-last-win', renderer, 'durationMs > bucket[kind]!.durationMs', 'durationMs >= bucket[kind]!.durationMs', [unit]],
 ['previous-peak-lost', renderer, 'previousPeaks = startMonoMs === currentEpoch.endMonoMs ? currentPeaks : peaks()', 'previousPeaks = peaks()', [unit]],
 ['idle-keeps-expired-peak', renderer, 'previousPeaks = startMonoMs === currentEpoch.endMonoMs ? currentPeaks : peaks()', 'previousPeaks = currentPeaks', [unit]],
 ['delivery-mistaken-for-occurrence', renderer, '? occurrence : null', '? deliveredAtMonoMs : null', [coverage]],
 ['unknown-mistaken-for-current-peak', renderer, 'const bucket = occurredAtMonoMs === null ? null :', 'const bucket = occurredAtMonoMs === null ? currentPeaks :', [coverage]],
 ['omissions-ignore-peaks', renderer, 'slowEventCounts[kind] - slowEvents.filter(event => event.kind === kind).length', 'slowEventCounts[kind] - slowByKind[kind].length', [unit]],
 ['context-snapshot-aliased', renderer, 'terminal: event.terminal && { ...event.terminal, payload: { ...event.terminal.payload } }', 'terminal: event.terminal', [unit]],
 ['peak-membership-duplicated', renderer, 'if (peak && !retained.includes(peak)) retained.push(peak)', 'if (peak) retained.push(peak)', [unit]],
 ['terminal-owner-disconnected', terminal, 'rendererPerformance.terminalWrite(observationVisible, data, observationStarted, observationContext)', "rendererPerformance.terminalWrite(observationVisible, data, observationStarted, { ...observationContext, runId: 'wrong-owner' })", [mounted]],
 ['region-read-at-completion', terminal, 'runId: session.control.run.runId, regionId: linkOriginRef.current.regionId ?? null, instanceId: performanceInstance, cause', 'runId: session.control.run.runId, get regionId() { return linkOriginRef.current.regionId ?? null }, instanceId: performanceInstance, cause', [mounted]],
 ['instance-reused-on-remount', terminal, 'const performanceInstance = rendererPerformance.allocateTerminalInstance()', 'const performanceInstance = terminalGeneration', [mounted]],
 ['checkpoint-cause-disconnected', terminal, "step.restoreBytes.subarray(0, checkpoint.resizeAfterRestoreBytes), async (data) => {\n                if (!disposed) await writeTerminal(data, 'checkpoint')", "step.restoreBytes.subarray(0, checkpoint.resizeAfterRestoreBytes), async (data) => {\n                if (!disposed) await writeTerminal(data, 'live')", [mounted]],
 ['continuation-cause-disconnected', terminal, "hydrateTerminalReplay(batch, data => writeOutput(data, 'history'))", "hydrateTerminalReplay(batch, data => writeOutput(data, 'live'))", [mounted]],
 ['live-cause-disconnected', terminal, "await writeOutput(data, 'live')", "await writeOutput(data, 'history')", [mounted]],
 ['backfill-cause-disconnected', terminal, "await writeOutput(data, 'history')", "await writeOutput(data, 'live')", [mounted]],
 ['public-retention-validation-lost', metrics, 'retainedAs: retentionParser', 'retainedAs: () => {}', [unit]],
 ['public-cause-validation-lost', metrics, "if (!['live', 'history', 'checkpoint'].includes(v as string)) invalid()", 'void v', [unit]],
 ['visible-wrong-period', ui, "event.retainedAs.includes(selected === 'current' ? 'current-peak' : 'previous-peak')", "event.retainedAs.includes('current-peak')", [visible]],
 ['visible-owner-disconnected', ui, '<span>Host {peak.terminal.hostId} · Session {peak.terminal.sessionId}</span>', '<span>Terminal owner unavailable</span>', [visible]],
 ['store-public-details-disconnected', store, 'performance: rendererPerformance.snapshot()', 'performance: { ...rendererPerformance.snapshot(), slowEvents: [] }', [coverage]]
]
const inputs = [...owners, ...tests, 'apps/desktop/scripts/verify-performance-epoch-peak-owner.mjs', 'apps/desktop/scripts/performance-owner-proof.mjs',
 'apps/desktop/test/performance-epoch-peak-owner.tsconfig.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json',
 'packages/core/src/renderer-performance.ts', 'packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/control-host.ts',
 'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/toolkit.ts',
 'packages/core/test/helpers/renderer-performance.ts', 'packages/core/test/helpers/toolkit-metrics.ts', 'packages/core/test/helpers/object-cli-rpc.ts',
 'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx', 'apps/desktop/src/renderer/src/styles/performance-toolkit.css',
 'apps/desktop/scripts/fixtures/performance-panel/data.ts', 'apps/desktop/resources/toolkit/performance.mjs', 'docs/design/behavior/settings-and-observation.md',
 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts', 'packages/core/bin/amux',
 ...['agentmux','control','control-codec','metrics','renderer-performance','toolkit','public-rpc-client','public-rpc-service'].map(file => `packages/core/dist/${file}.js`)]
const hashes = () => Object.fromEntries(inputs.map(path => [path, sha(readFileSync(join(root,path)))]))
const directory = join(root,'.local/state/t003-epoch'); mkdirSync(directory,{recursive:true})
const locator = join(directory,'qualification.json')
function validate(saved) {
 assert.equal(saved.passed,true); assert.deepEqual(saved.before,hashes()); assert.deepEqual(saved.after,saved.before); assert.deepEqual(saved.mutants,mutants)
 for (const [path,expected] of Object.entries(saved.evidence)) assert.equal(sha(readFileSync(path)),expected,path)
 const receipt=JSON.parse(readFileSync(saved.ownerReceipt)); assert.equal(receipt.passed,true)
 assert.deepEqual(receipt.runs.map(run=>run.name),['normal',...mutants.map(row=>row[0])])
 assert.equal(receipt.runs[0].tests,51)
 for (const owner of owners) assert.equal(receipt.runs[0].loadedSources[join(root,owner)],saved.before[owner])
 for (const [name,path,before,after] of mutants) {
  const result=JSON.parse(readFileSync(join(saved.ownerDirectory,name+'.json')))
  assert.ok(result.numTotalTests>0);assert.equal(result.numPendingTests,0)
  assert.ok(result.testResults.flatMap(s=>s.assertionResults).some(a=>a.status==='failed'&&a.failureMessages.some(m=>/AssertionError/u.test(m))))
  const source=readFileSync(join(root,path),'utf8');assert.equal(source.split(before).length,2)
  assert.equal(receipt.runs.find(row=>row.name===name).loadedSources[join(root,path)],sha(source.replace(before,after)))
 }
 const defaultReport=JSON.parse(readFileSync(saved.defaultReport));assert.equal(defaultReport.numTotalTests,51);assert.equal(defaultReport.numFailedTests,0);assert.equal(defaultReport.numPendingTests,0)
 assert.equal(saved.commands.every(row=>row.exit===0),true)
}
if (existsSync(locator)) {
 const saved=JSON.parse(readFileSync(locator));validate(saved)
 process.stdout.write(JSON.stringify({passed:true,exactEvidenceReused:true,normal:51,mutants:mutants.length,receipt:locator})+'\n')
} else {
 const before=hashes(),stamp=Date.now(),commands=[]
 function command(name,args) {
  const child=spawnSync('pnpm',['exec',...args],{cwd:root,env:{...process.env,pnpm_config_verify_deps_before_run:''},encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024})
  const log=join(directory,name+'-'+stamp+'.log');writeFileSync(log,(child.stdout??'')+(child.stderr??''));commands.push({name,args,exit:child.status,log})
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0)
 }
 command('desktop-types',['tsc','--noEmit','-p','apps/desktop/tsconfig.json'])
 command('focused-types',['tsc','--noEmit','-p','apps/desktop/test/performance-epoch-peak-owner.tsconfig.json'])
 const defaultReport=join(directory,'default-normal-'+stamp+'.json')
 command('default-normal',['vitest','run',...tests,'--reporter=json','--outputFile',defaultReport])
 const proof=provePerformanceOwner({name:'epoch-peak-owner',owners,tests,minimumTests:51,mutants,
  astOwners:[[store,'__AGENTMUX_RENDERER_STORE_SOURCE__']],callers:[
   [terminal,'rendererPerformance.allocateTerminalInstance()'],[terminal,'rendererPerformance.terminalWrite(observationVisible, data, observationStarted, observationContext)'],
   [terminal,"writeTerminal(data, 'checkpoint')"],[terminal,"data => writeOutput(data, 'history')"],[terminal,"await writeOutput(data, 'history')"],[terminal,"await writeOutput(data, 'live')"],
   [store,'rendererPerformance.snapshot()'],[ui,'event.retainedAs.includes('],[ui,'peak.terminal.cause'],
   ['apps/desktop/resources/toolkit/performance.mjs','const observation = parseMetricsObservation(value)'],
   ['packages/core/src/public-rpc.ts',"'system.metrics.get': 'metrics.get'"],['packages/core/src/public-rpc.ts',"'system.metrics.watch': 'metrics.watch'"]
  ]})
 const files=[defaultReport,...commands.map(row=>row.log),...['normal',...mutants.map(row=>row[0])].flatMap(name=>['.json','.loaded.json','.log','.config.mts'].map(ext=>join(proof.directory,name+ext))),join(proof.directory,'receipt.json')]
 const saved={passed:true,before,after:hashes(),mutants,commands,defaultReport,ownerDirectory:proof.directory,ownerReceipt:join(proof.directory,'receipt.json'),evidence:Object.fromEntries(files.map(path=>[path,sha(readFileSync(path))])),
  boundary:'51 exact normal cases at the default entry and production-source transform entry; actual mounted TerminalView/public xterm parser callbacks, actual Store control callback, bounded recorder/strict Core, actual private Unix get/watch, compiled metrics/Toolkit CLI, actual official Performance script stdout parsed as typed confirmed Toolkit, actual expanded Overview consumer. No native/user Run, input/output content capture, installed Renderer, original 15s causality, CPU/ACK or full Desktop restart claim. Visual review is separate.'}
 assert.deepEqual(saved.after,before);validate(saved);writeFileSync(locator,JSON.stringify(saved,null,2)+'\n')
 process.stdout.write(JSON.stringify({passed:true,normal:51,mutants:mutants.length,receipt:locator})+'\n')
}
