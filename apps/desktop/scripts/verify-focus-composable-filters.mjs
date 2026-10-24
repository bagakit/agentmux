import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { productInputs, captureInputs } from './fixtures/focus-composable-filters/inputs.mjs'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args[0] === '--source' && args.length === 1 || args[0] === '--scene' && args.length === 2, 'Use --source or --scene <receipt>')
const hash = value => createHash('sha256').update(value).digest('hex')
const renderer = 'apps/desktop/src/renderer/src/'
if (args[0] === '--scene') {
  const receiptPath = resolve(root, args[1]), scene = JSON.parse(await readFile(receiptPath, 'utf8'))
  const reviewPath = join(resolve(receiptPath, '..'), 'visual-review.json'), review = JSON.parse(await readFile(reviewPath, 'utf8'))
  assert.equal(scene.capturedPass, true)
  assert.equal(review.verdict, 'pass'); assert.equal(review.sceneReceiptSHA256, hash(await readFile(receiptPath)))
  assert.ok(scene.frames.length >= 4); assert.equal(review.viewedImages.length, scene.frames.length)
  for (const frame of scene.frames) {
    const digest = hash(await readFile(join(resolve(receiptPath, '..'), frame.file)))
    assert.equal(digest, frame.sha256)
    assert.ok(review.viewedImages.some(image => image.path === frame.file && image.sha256 === digest && image.viewed === true))
  }
  const inputs = Object.entries(scene.inputs); assert.ok(inputs.length > 10)
  const affectedInputs = new Set([...productInputs, ...captureInputs])
  for (const file of affectedInputs) {
    assert.ok(file in scene.inputs, 'Actual loaded Focus input ' + file)
    assert.equal(scene.sourceAfter[file], scene.inputs[file], 'Stable captured Focus input ' + file)
  }
  const peripheralDrift = [], peripheralCaptureDrift = []
  for (const [file, digest] of inputs) {
    const current = await readFile(join(root, file)).then(hash).catch(error => {
      if (error.code === 'ENOENT' && !affectedInputs.has(file)) return null
      throw error
    })
    if (affectedInputs.has(file)) assert.equal(current, digest, 'Current rendered Focus source ' + file)
    else {
      if (current !== digest) peripheralDrift.push({file,capturedSHA256:digest,currentSHA256:current})
      if (scene.sourceAfter[file] !== digest) peripheralCaptureDrift.push({file,capturedSHA256:digest,sourceAfterSHA256:scene.sourceAfter[file] ?? null})
    }
  }
  assert.equal(scene.cleanup.removed, true); assert.deepEqual(scene.cleanup.remaining, [])
  console.log(JSON.stringify({passed:true,scene:args[1],review:reviewPath,currentFocusInputs:affectedInputs.size,peripheralDrift,peripheralCaptureDrift,
    boundary:'The explicit affected Focus product and capture inputs match the independently reviewed scene. Peripheral App imports are provenance and any drift remains unqualified. No installation or real Provider/Runtime lifecycle claim'}))
  process.exit(0)
}
const evidence = join(root, '.local/state/focus-composable-filters/source'); await mkdir(evidence, {recursive:true})
const config = 'apps/desktop/test/vitest.focus-composable-filters.config.mts'
const testFiles = ['apps/desktop/test/focus-narrow-filters.test.tsx',
  'apps/desktop/test/focus-composable-filters.test.tsx', 'apps/desktop/test/focus-source-filter-membership.test.ts',
  'apps/desktop/test/focus-history-search.test.tsx', 'apps/desktop/test/focus-lane-origin.test.tsx',
  'apps/desktop/test/focus-coordination-projection.test.tsx', 'apps/desktop/test/focus-context-cost.test.ts']
const files = [...productInputs, 'apps/desktop/scripts/fixtures/focus-composable-filters/inputs.mjs', ...testFiles,
  'apps/desktop/test/fixtures/focus-filter-menu.ts', 'apps/desktop/test/fixtures/mote-workface.ts',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs',
  'packages/core/src/search-reader.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/session-history-reader.ts', 'packages/core/src/session-history-query.ts',
  config, 'apps/desktop/test/vitest.mote-context.config.mts', 'vitest.config.ts',
  'apps/desktop/test/tsconfig.focus-composable-filters.json', 'apps/desktop/tsconfig.json',
  'packages/core/package.json', 'packages/client-ui/package.json', 'packages/layout/package.json',
  'apps/desktop/scripts/verify-focus-composable-filters.mjs', 'apps/desktop/scripts/typecheck-focus-composable-filters.mjs']
const bindings = async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(join(root,file)))])))
const before = await bindings(), receipt = {schema:'agentmux.focus-composable-filters-source.v1',passed:false,sourceBefore:before,mutations:[]}
// Reuse proof only for the exact owned source, tests and verifier content. This
// lets Tracker bind a fresh shared-main receipt without rerunning unchanged
// semantic mutations when unrelated collaborators commit during qualification.
try {
  const previous=JSON.parse(await readFile(join(evidence,'receipt.json'),'utf8'))
  if(previous.passed&&JSON.stringify(previous.sourceAfter)===JSON.stringify(before)) {
    console.log(JSON.stringify({passed:true,reused:true,evidence,scope:'Unchanged owned filter candidate; original baseline/mutation/type receipts retained'}))
    process.exit(0)
  }
}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error}
async function run(label, command, parameters, env={}) {
  let result
  try {const r=await promisify(execFile)(command,parameters,{cwd:root,env:{...process.env,...env},maxBuffer:8*1024*1024,timeout:180000});result={code:0,output:r.stdout+r.stderr}}
  catch(e){result={code:e.code,signal:e.signal,output:(e.stdout??'')+(e.stderr??'')}}
  await writeFile(join(evidence,label+'.log'),result.output)
  return result
}
async function tests(label, mutant) {
  const report = join(evidence,label+'.json'), loaded = join(evidence,label+'-loaded.jsonl')
  await writeFile(loaded,'')
  const narrowed = mutant ? ['apps/desktop/test/focus-narrow-filters.test.tsx','apps/desktop/test/focus-composable-filters.test.tsx','apps/desktop/test/focus-source-filter-membership.test.ts','apps/desktop/test/focus-coordination-projection.test.tsx'] : []
  const r=await run(label,process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config',config,...narrowed,'--reporter=json','--outputFile='+report],
    {AGENTMUX_FOCUS_COMPOSABLE_LOADED:loaded,...(mutant?{AGENTMUX_FOCUS_COMPOSABLE_MUTANT:mutant}:{})})
  const result=JSON.parse(await readFile(report,'utf8')), modules=(await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
  assert.ok(result.numTotalTests >= (mutant ? 17 : 25), 'Nonempty owning consumer and source tests')
  for (const file of mutant ? narrowed : testFiles) assert.ok(result.testResults.some(suite =>
    suite.name === join(root, file) && suite.assertionResults.some(test => test.status === 'passed' || mutant && test.status === 'failed')), 'Actual executed suite ' + file)
  for(const file of ['components/GlobalFocusSurface.tsx', 'components/FocusFilters.tsx',
    'lib/focus-filters.ts', 'lib/focus-lane-origin.ts', 'lib/focus-context.ts',
    'components/FocusContextCardBody.tsx', 'App.tsx'].map(file => renderer + file)) assert.ok(modules.some(module=>module.path===file),'Actual loaded '+file)
  const changed=modules.filter(module=>module.mutant)
  if(mutant){
    assert.ok(changed.length>0);for(const module of changed){assert.equal(module.mutant,mutant);assert.notEqual(module.originalSHA256,module.loadedSHA256)}
    assert.ok(r.code>0&&!r.signal);assert.ok(result.numFailedTests>0)
    assert.ok(result.testResults.flatMap(file=>file.assertionResults).some(test=>test.failureMessages.some(message=>message.includes('AssertionError'))),'Semantic assertion RED, not compilation failure')
  }else{assert.equal(r.code,0,r.output.slice(-2500));assert.equal(result.numFailedTests,0);assert.ok(result.numPassedTests>=25);assert.deepEqual(changed,[])}
  return {label,passed:result.numPassedTests,failed:result.numFailedTests,collected:result.numTotalTests,changed,loadedCount:modules.length}
}
try {
  receipt.baseline=await tests('baseline')
  const mutants=['drop-types','drop-state','drop-project','remove-survey','close-multi-select','forget-unavailable','drop-coordination','read-coordination-body','recap-read','wrong-mote-scope']
  for(let i=0;i<mutants.length;i+=2) receipt.mutations.push(...await Promise.all(mutants.slice(i,i+2).map(mutant=>tests(mutant,mutant))))
  receipt.restored=await tests('restored')
  const types=await run('types',process.execPath,['apps/desktop/scripts/typecheck-focus-composable-filters.mjs']);assert.equal(types.code,0,types.output)
  receipt.types={code:types.code}
  receipt.callers={entry:'App -> GlobalFocusSurface',conditions:'Original Focus projection -> focusLaneOrigins.contextTypes / typed state -> matching -> existing FocusContextCards',workface:'Original WorkspaceWorkbench projection remains outside filtering',transport:'No new RPC/CLI or owner writes; existing Core catalogs and status observations consumed'}
  receipt.sourceAfter=await bindings();assert.deepEqual(receipt.sourceAfter,before)
  receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure?.message}))}
