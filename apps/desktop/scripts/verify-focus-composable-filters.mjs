import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args[0] === '--source' && args.length === 1 || args[0] === '--scene' && args.length === 2, 'Use --source or --scene <receipt>')
const hash = value => createHash('sha256').update(value).digest('hex')
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
  const driftReviewPath = join(resolve(receiptPath, '..'), 'source-drift-review.json')
  let reviewedCoreDrift = []
  try { const driftReview = JSON.parse(await readFile(driftReviewPath, 'utf8'))
    assert.equal(driftReview.verdict, 'pass'); assert.equal(driftReview.sceneReceiptSHA256, hash(await readFile(receiptPath)))
    reviewedCoreDrift = driftReview.changes
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  // This Task qualifies the Focus change, not every transitive module imported
  // by App. Keep the complete captured bundle provenance and expose peripheral
  // drift, while requiring the current affected surface and its original Focus
  // projections to match the independently reviewed Renderer exactly.
  const renderer = 'apps/desktop/src/renderer/src/'
  const entryInputs = new Set(['App.tsx', 'components/GlobalFocusSurface.tsx',
    'components/WorkspaceWorkbench.tsx', 'components/StableWorkbenchView.tsx',
    'lib/agent-focus.ts', 'lib/desktop-focus-navigation.ts', 'lib/workbench-navigation-catalog.ts',
    'lib/workbench-projection.ts', 'lib/scratch-topic-snapshots.ts', 'lib/mobile-presentation.ts', 'styles/focus.css'].map(file => renderer + file))
  const currentFocusInput = file => entryInputs.has(file)
    || file.startsWith(renderer + 'components/Focus')
    // Original projection, source, typed observation and spatial helpers are
    // also inputs even when their filename does not mention Focus.
    || file.startsWith(renderer + 'lib/') || file.startsWith(renderer + 'hooks/')
    || file.startsWith('apps/desktop/src/shared/') || file.startsWith('packages/core/')
    || file === 'apps/desktop/scripts/capture-focus-composable-filters.mjs'
    || file.startsWith('apps/desktop/scripts/fixtures/focus-composable-filters/')
  const peripheralDrift = [], reviewedDependencies = []; let currentFocusInputs = 0
  for (const [file, digest] of inputs) {
    const current = hash(await readFile(join(root, file)))
    if (currentFocusInput(file)) {
      currentFocusInputs++
      if (current !== digest && file.startsWith('packages/core/') && reviewedCoreDrift.some(change => change.file === file
        && change.capturedSHA256 === digest && change.currentSHA256 === current && change.affectsExercisedFocus === false && change.reason)) {
        reviewedDependencies.push({file,capturedSHA256:digest,currentSHA256:current})
      } else assert.equal(current, digest, 'Current rendered Focus source '+file)
    }
    else if (current !== digest) peripheralDrift.push({file,capturedSHA256:digest,currentSHA256:current})
  }
  for (const file of entryInputs) assert.ok(file in scene.inputs, 'Actual loaded Focus entry '+file)
  assert.ok(currentFocusInputs > 20, 'Nonempty current affected Focus consumer scope')
  assert.deepEqual(scene.sourceAfter, scene.inputs)
  assert.equal(scene.cleanup.removed, true); assert.deepEqual(scene.cleanup.remaining, [])
  console.log(JSON.stringify({passed:true,scene:args[1],review:reviewPath,currentFocusInputs,exactInputs:currentFocusInputs-reviewedDependencies.length,reviewedDependencies,peripheralDrift,
    boundary:'Current Focus Renderer and projections match the captured scene. Explicitly reviewed Core deltas do not affect the exercised path; other peripheral drift is not qualified. No installation or real Provider/Runtime lifecycle claim'}))
  process.exit(0)
}
const evidence = join(root, '.local/state/focus-composable-filters/source'); await mkdir(evidence, {recursive:true})
const config = 'apps/desktop/test/vitest.focus-composable-filters.config.mts'
const files = ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'apps/desktop/src/renderer/src/components/FocusFilters.tsx',
  'apps/desktop/src/renderer/src/lib/focus-filters.ts', 'apps/desktop/src/renderer/src/lib/focus-lane-origin.ts',
  'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/components/FocusHistorySearch.tsx',
  'apps/desktop/src/renderer/src/components/FocusSearchLocations.tsx', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/test/focus-narrow-filters.test.tsx',
  'apps/desktop/test/focus-composable-filters.test.tsx', 'apps/desktop/test/focus-source-filter-membership.test.ts',
  'apps/desktop/test/focus-history-search.test.tsx',config,'apps/desktop/test/tsconfig.focus-composable-filters.json',
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
  const narrowed = mutant ? ['apps/desktop/test/focus-narrow-filters.test.tsx','apps/desktop/test/focus-composable-filters.test.tsx','apps/desktop/test/focus-source-filter-membership.test.ts'] : []
  const r=await run(label,process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config',config,...narrowed,'--reporter=json','--outputFile='+report],
    {AGENTMUX_FOCUS_COMPOSABLE_LOADED:loaded,...(mutant?{AGENTMUX_FOCUS_COMPOSABLE_MUTANT:mutant}:{})})
  const result=JSON.parse(await readFile(report,'utf8')), modules=(await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
  assert.ok(result.numTotalTests >= (mutant ? 17 : 25), 'Nonempty owning consumer and source tests')
  for(const file of [files[0],files[1],files[2],files[3],'apps/desktop/src/renderer/src/App.tsx']) assert.ok(modules.some(module=>module.path===file),'Actual loaded '+file)
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
  const mutants=['drop-types','drop-state','drop-project','remove-survey','close-multi-select','forget-unavailable']
  for(let i=0;i<mutants.length;i+=2) receipt.mutations.push(...await Promise.all(mutants.slice(i,i+2).map(mutant=>tests(mutant,mutant))))
  receipt.restored=await tests('restored')
  const types=await run('types',process.execPath,['apps/desktop/scripts/typecheck-focus-composable-filters.mjs']);assert.equal(types.code,0,types.output)
  receipt.types={code:types.code}
  receipt.callers={entry:'App -> GlobalFocusSurface',conditions:'Original Focus projection -> focusLaneOrigins.contextTypes / typed state -> matching -> existing FocusContextCards',workface:'Original WorkspaceWorkbench projection remains outside filtering',transport:'No new RPC/CLI or owner writes; existing Core catalogs and status observations consumed'}
  receipt.sourceAfter=await bindings();assert.deepEqual(receipt.sourceAfter,before)
  receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure?.message}))}
