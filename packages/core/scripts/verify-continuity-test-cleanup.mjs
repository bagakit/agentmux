import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const consumers = ['session-continuity-supervision', 'session-continuity-control', 'resume-context-observation',
  'session-continuity-executor', 'initial-continuity-cancellation'].map(name => ({ name, file: `packages/core/test/${name}.test.ts` }))
assert.equal(new Set(consumers.map(one => one.file)).size, 5)
const output = join(root, 'packages/core/.tmp/continuity-test-cleanup')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), inputs = {}
for (const file of ['packages/core/scripts/verify-continuity-test-cleanup.mjs', ...consumers.map(one => one.file)]) inputs[file] = hash(await readFile(join(root, file)))
const receipt = { schema: 'agentmux.continuity-test-cleanup-proof.v1', passed: false, sourceStable: false, inputs,
  consumers: [], results: [], scope: 'Actual test-module afterEach callbacks only; unrelated business cases are registered, never executed or claimed. No product or user Runtime is started.' }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await save()

// Observe the framework boundary without running the unrelated registered business tests.
const shim = join(attempt, 'vitest-observation.mjs')
await writeFile(shim, `export const hooks=[], state={order:[],registered:0,executedBusinessCases:0,mode:'normal'};
export const afterEach=callback=>hooks.push(callback);
export const it=()=>{state.registered++}; it.each=()=>it;
export const expect=()=>{throw Error('Unrelated business assertion executed')};
export const vi={restoreAllMocks(){state.order.push('restore-mocks');state.mock.value=state.original;
 if(state.mode==='failure')throw state.mockError},unstubAllEnvs(){state.order.push('restore-env');
 delete process.env.AGENTMUX_PRIVATE_CLEANUP_PROBE;if(state.mode==='failure')throw state.envError}};
`)
const probe = join(attempt, 'probe.mjs')
await writeFile(probe, `import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {pathToFileURL} from 'node:url';import {hooks,state} from './vitest-observation.mjs';
const [moduleFile,mode,resultFile]=process.argv.slice(2);
const result={schema:'agentmux.actual-fixture-cleanup-consumer.v1',passed:false,mode,outerCleanup:{confirmed:false}};
let child,privateRoot,resourceExit,exitFact,resourceCleanupRan=false,hookError;
async function exitOwnedChild(){if(!child)return;if(child.exitCode===null&&child.signalCode===null){
 const exited=once(child,'exit');child.kill('SIGTERM');await exited;}exitFact={pid:child.pid,code:child.exitCode,signal:child.signalCode};}
try {
 const imported=await import(pathToFileURL(moduleFile));assert.equal(hooks.length,1,'one original afterEach registration');
 assert.ok(state.registered>0,'actual authored module registers its business case definitions');
 assert.equal(state.executedBusinessCases,0);assert.ok(Array.isArray(imported.__fixtureCleanupQueue));
 privateRoot=await mkdtemp(join(tmpdir(),'agentmux-fixture-cleanup-'));
 child=spawn(process.execPath,['-e',"process.send({kind:'fixture-resource-ready'});setInterval(()=>{},1000)"],
  {cwd:privateRoot,stdio:['ignore','ignore','ignore','ipc']});
 const [ready]=await once(child,'message');assert.deepEqual(ready,{kind:'fixture-resource-ready'});
 assert.ok(child.pid>0);result.originalChildPid=child.pid;
 const firstError=new Error('original first registered cleanup'),lastError=new Error('original last registered cleanup');
 state.mockError=new Error('original mock restoration');state.envError=new Error('original environment restoration');
 state.original={original:true};state.mock={value:{temporary:true}};state.mode=mode;
 process.env.AGENTMUX_PRIVATE_CLEANUP_PROBE='temporary';
 imported.__fixtureCleanupQueue.push(async()=>{state.order.push('first');if(mode==='failure')throw firstError},
  async()=>{state.order.push('resource');resourceCleanupRan=true;await exitOwnedChild();resourceExit={...exitFact}},
  async()=>{state.order.push('last');if(mode==='failure')throw lastError});
 try{await hooks[0]()}catch(error){hookError=error}
 assert.equal(resourceCleanupRan,true,'every original registered resource finalizer executes after an earlier failure');
 assert.equal(process.env.AGENTMUX_PRIVATE_CLEANUP_PROBE,undefined,'environment restoration executes after an earlier cleanup or mock failure');
 assert.equal(state.mock.value,state.original,'mock restoration executes after an earlier cleanup failure');
 assert.deepEqual(state.order,['last','resource','first','restore-mocks','restore-env'],'sequential reverse registration and restoration order is preserved');
 assert.equal(imported.__fixtureCleanupQueue.length,0,'the original cleanup queue is consumed once');
 assert.ok(resourceExit&&resourceExit.pid===child.pid&&resourceExit.signal==='SIGTERM','the actual registered cleanup confirms its owned native child exit');
 if(mode==='failure'){
  assert.ok(hookError instanceof AggregateError,'original cleanup failures remain observable as AggregateError');
  const originals=[lastError,firstError,state.mockError,state.envError];
  assert.ok(hookError.errors.length===originals.length&&hookError.errors.every((one,index)=>one===originals[index]),
   'every collected cleanup error retains its original object identity');
  result.originalErrorsPreserved=originals.length;
 }else assert.equal(hookError,undefined,'successful cleanup does not report failure');
 result.passed=true;result.actualHook={registeredCallbacks:hooks.length,unrelatedDefinitions:state.registered,
  executedBusinessCases:state.executedBusinessCases,order:state.order,resourceExit};
}catch(error){result.failure={name:error.name,message:error.message,code:error.code,stack:error.stack};process.exitCode=1}
finally{
 try{await exitOwnedChild();if(privateRoot)await rm(privateRoot,{recursive:true});
  result.outerCleanup={confirmed:true,exit:exitFact,privateRootRemoved:!!privateRoot};
 }catch(error){result.outerCleanup={confirmed:false,message:error.message};result.passed=false;process.exitCode=1}
 delete process.env.AGENTMUX_PRIVATE_CLEANUP_PROBE;
 await writeFile(resultFile,JSON.stringify(result,null,2)+'\\n');
}
`)

const variants = [
  { name: 'candidate' },
  { name: 'short-circuit', from: 'try { await cleanup() } catch (error) { errors.push(error) }', to: 'await cleanup()',
    expected: 'every original registered resource finalizer executes after an earlier failure' },
  { name: 'lost-original-error', from: 'try { await cleanup() } catch (error) { errors.push(error) }',
    to: "try { await cleanup() } catch (error) { errors.push(new Error('changed cleanup error')) }",
    expected: 'every collected cleanup error retains its original object identity' },
  { name: 'skipped-restoration', from: 'try { vi.unstubAllEnvs() } catch (error) { errors.push(error) }',
    to: 'try { /* restoration omitted */ } catch (error) { errors.push(error) }',
    expected: 'environment restoration executes after an earlier cleanup or mock failure' }
]
function execute(args, env, log) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }), chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk))
    child.once('error', reject)
    child.once('exit', async (code, signal) => {
      try { await writeFile(log, Buffer.concat(chunks)); resolvePromise({ code, signal }) } catch (error) { reject(error) }
    })
  })
}
try {
  for (const consumer of consumers) {
    const sourcePath = join(root, consumer.file), source = await readFile(sourcePath, 'utf8'), originalSha256 = hash(source)
    assert.equal(originalSha256, inputs[consumer.file]); assert.ok(source.includes('afterEach(async () => {'))
    const runs = []
    for (const variant of variants) {
      let changed = source
      if (variant.from) {
        assert.equal(source.split(variant.from).length - 1, 1, 'One exact original hook mutation anchor: ' + consumer.name + '/' + variant.name)
        changed = source.replace(variant.from, variant.to)
      }
      const name = consumer.name + '-' + variant.name, bundle = join(attempt, name + '.mjs')
      const result = await build({ absWorkingDir: root, entryPoints: [sourcePath], outfile: bundle, bundle: true,
        packages: 'external', platform: 'node', format: 'esm', target: 'node24', metafile: true, logLevel: 'silent',
        plugins: [{ name: 'actual-authored-cleanup-hook', setup(plugin) {
          plugin.onResolve({ filter: /^vitest$/ }, () => ({ path: shim, external: true }))
          plugin.onLoad({ filter: /\.test\.ts$/ }, args => args.path === sourcePath
            ? { contents: changed + '\nexport { cleanups as __fixtureCleanupQueue }\n', loader: 'ts', resolveDir: dirname(sourcePath) } : undefined)
        } }] })
      assert.ok(Object.keys(result.metafile.inputs).some(file => resolve(root, file) === sourcePath), 'The actual authored test module must be compiled')
      const bundleSha256 = hash(await readFile(bundle)), modes = variant.name === 'candidate' ? ['normal', 'failure'] : ['failure']
      for (const mode of modes) {
        const raw = join(attempt, name + '-' + mode + '.json'), log = join(attempt, name + '-' + mode + '.log')
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_TEST_')))
        const processResult = await execute([probe, bundle, mode, raw], env, log), bytes = await readFile(raw), observed = JSON.parse(bytes)
        assert.equal(observed.schema, 'agentmux.actual-fixture-cleanup-consumer.v1'); assert.equal(observed.outerCleanup.confirmed, true)
        assert.equal(observed.outerCleanup.privateRootRemoved, true); assert.ok(observed.originalChildPid > 0)
        if (variant.name === 'candidate') {
          assert.equal(processResult.code, 0); assert.equal(processResult.signal, null); assert.equal(observed.passed, true)
          assert.equal(observed.actualHook.executedBusinessCases, 0)
        } else {
          assert.equal(processResult.code, 1); assert.equal(processResult.signal, null); assert.equal(observed.passed, false)
          assert.equal(observed.failure?.name, 'AssertionError'); assert.ok(observed.failure.message.includes(variant.expected), 'Exact business cleanup assertion must fail')
        }
        const fact = { consumer: consumer.name, variant: variant.name, mode, ...processResult, originalSha256,
          loadedSourceSha256: hash(changed), bundleSha256, raw: relative(root, raw), rawSha256: hash(bytes),
          passed: observed.passed, semanticRed: variant.name !== 'candidate', ...(variant.expected ? { expected: variant.expected } : {}),
          outerCleanup: observed.outerCleanup }
        receipt.results.push(fact); runs.push(fact); await save()
      }
    }
    assert.equal(runs.filter(one => one.variant === 'candidate').length, 2)
    assert.equal(runs.filter(one => one.semanticRed).length, 3)
    assert.equal(new Set(runs.map(one => one.bundleSha256)).size, 4, 'Each loaded business variant must change actual compiled bytes')
    receipt.consumers.push({ name: consumer.name, file: consumer.file, originalSha256, registeredHookLoaded: true,
      normalAndFailureCases: 2, loadedBusinessCounterexamples: 3 }); await save()
  }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, file))), digest, 'Owning Source changed during cleanup qualification')
  assert.equal(receipt.consumers.length, 5); assert.equal(receipt.results.filter(one => !one.semanticRed).length, 10)
  assert.equal(receipt.results.filter(one => one.semanticRed).length, 15)
  assert.equal(new Set(receipt.results.map(one => one.outerCleanup.exit.pid)).size, 25, 'Each consumer executes a real independently owned native child')
  receipt.sourceStable = true; receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error
} finally { await save() }
console.log(JSON.stringify({ passed: receipt.passed, sourceStable: receipt.sourceStable, consumers: receipt.consumers.length,
  baselineCases: 10, loadedBusinessCounterexamples: 15, receipt: relative(root, join(attempt, 'receipt.json')) }))
