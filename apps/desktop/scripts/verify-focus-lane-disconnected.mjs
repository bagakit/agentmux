import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { laneSourceBinding, sha } from './fixtures/focus-lane-disconnected/source-binding.mjs'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), slice = args[args.indexOf('--slice') + 1]
assert.ok(['source', 'visual-restart'].includes(slice), 'Select source or visual-restart.')
const directory = path.join(root, `.tmp/focus-lane-disconnected-${slice}-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const binding = () => laneSourceBinding(root)
const receipt = { schema: 'agentmux.focus-lane-disconnected-qualification.v1', slice, candidate: spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(), before: binding(), phases: [], passed: false, taskDone: false }
function run(name, argv, env = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd:root, encoding:'utf8', env:{...process.env,...env}, timeout:120000, maxBuffer:8*1024*1024 })
  writeFileSync(path.join(directory,name+'.stdout.log'),result.stdout??'');writeFileSync(path.join(directory,name+'.stderr.log'),result.stderr??'')
  receipt.phases.push({ name, argv, cwd:root, exit:result.status, signal:result.signal, error:result.error?.message })
  console.log(`${name}: ${result.status}`);return result
}
function tests(name, config, mutation) {
  const output=path.join(directory,name+'.json'), loaded=path.join(directory,name+'.loaded.ndjson')
  const result=run(name,['node','node_modules/vitest/vitest.mjs','run','--config',config,'--maxWorkers=1','--reporter=json',`--outputFile=${output}`], mutation?{AGENTMUX_FOCUS_LANE_MUTATION:mutation,AGENTMUX_FOCUS_LANE_MUTATION_LOG:loaded}:{})
  assert.ok(!result.error && !result.signal, `${name} process must complete`)
  const report=JSON.parse(readFileSync(output,'utf8'));assert.ok(report.numTotalTests>0,`${name} actually collects`)
  if(mutation){assert.notEqual(result.status,0);assert.ok(report.numFailedTests>0 && report.testResults.some(file=>file.assertionResults.some(test=>test.failureMessages.some(message=>message.includes('AssertionError')))),`${name} needs loaded product assertion RED`);const records=readFileSync(loaded,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(records.length,1);assert.notEqual(records[0].originalSha,records[0].transformedSha);return {total:report.numTotalTests,failed:report.numFailedTests,loaded:records}}
  assert.equal(result.status,0,`${name} GREEN`);assert.equal(report.numFailedTests,0);return {total:report.numTotalTests,passed:report.numPassedTests}
}
try {
  if(slice==='source') {
    const config='apps/desktop/scripts/fixtures/focus-lane-disconnected/vitest.owning.config.mts'
    receipt.owning=tests('owning',config);receipt.mutations=[]
    for(const mutation of ['healthy-lost','idle-mix','topic-parent','search-aria']){const red=tests(mutation,'apps/desktop/scripts/fixtures/focus-lane-disconnected/vitest.mutation.config.mts',mutation);assert.equal(red.total,receipt.owning.total);const restored=tests(mutation+'-restored',config);receipt.mutations.push({mutation,...red,restored})}
    receipt.adjacent=tests('adjacent','apps/desktop/scripts/fixtures/focus-lane-disconnected/vitest.adjacent.config.mts')
    for(const [name,project] of [['production-types','apps/desktop/tsconfig.json'],['owning-types','apps/desktop/scripts/fixtures/focus-lane-disconnected/tsconfig.owning.json']]) assert.equal(run(name,['node','--max-old-space-size=768','node_modules/typescript/bin/tsc','--noEmit','-p',project]).status,0)
    const calls = { GlobalFocusSurface:['apps/desktop/src/renderer/src/App.tsx','<GlobalFocusSurface'], FocusDisconnectedGroup:['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','<FocusDisconnectedGroup'], FocusContextRow:['apps/desktop/src/renderer/src/components/FocusDisconnectedGroup.tsx','<FocusContextRow'], SpaceObjectIcon:['apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx','<SpaceObjectIcon'], deriveFocusProjectLanes:['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','deriveFocusProjectLanes('] }
    receipt.callers=Object.fromEntries(Object.entries(calls).map(([symbol,[file,invocation]])=>{const text=readFileSync(path.join(root,file),'utf8'),index=text.indexOf(invocation);assert.ok(index>=0,`${symbol} non-definition caller`);return [symbol,{file,invocation,line:text.slice(0,index).split('\n').length}]}))
    receipt.scope='Actual mounted lane source and types; visual/restart gate remains separate. No package/user Runtime control.'
  } else {
    const guiFile=process.env.AGENTMUX_FOCUS_LANE_GUI_RECEIPT,reviewFile=process.env.AGENTMUX_FOCUS_LANE_VISUAL_REVIEW
    assert.ok(guiFile && reviewFile,'Supply exact private GUI and independent image review; capture alone is not aesthetic acceptance.')
    const guiBytes=readFileSync(path.resolve(root,guiFile)),gui=JSON.parse(guiBytes),reviewBytes=readFileSync(path.resolve(root,reviewFile)),review=JSON.parse(reviewBytes)
    assert.equal(gui.schema,'agentmux.focus-lane-disconnected-gui.v1');assert.equal(gui.passed,true);assert.equal(gui.phases.length,2);assert.notEqual(gui.phases[0].pid,gui.phases[1].pid)
    assert.deepEqual(gui.before,receipt.before);assert.deepEqual(gui.after,receipt.before);assert.equal(gui.cleanup.rootRemoved,true);assert.deepEqual(gui.cleanup.remaining,[])
    assert.ok(gui.scenes.length>=5);assert.ok(gui.scenes.every(scene=>scene.columns.length===5&&scene.horizontalOverflow===false&&scene.hits.length>0&&scene.hits.every(hit=>hit.matched)))
    assert.equal(review.verdict,'pass');assert.equal(review.guiReceiptSha256,sha(guiBytes));assert.ok(review.reviewerAgentId);assert.equal(review.viewedImages.length,gui.images.length)
    for(const image of gui.images){const bytes=readFileSync(path.resolve(root,image));assert.ok(review.viewedImages.some(viewed=>viewed.path===image&&viewed.sha256===sha(bytes)&&viewed.observation?.trim()),'Exact image was independently viewed')}
    receipt.gui={file:guiFile,sha256:sha(guiBytes)};receipt.review={file:reviewFile,sha256:sha(reviewBytes)};receipt.visualRestartQualified=true;receipt.scope=gui.boundary
  }
  receipt.after=binding();assert.deepEqual(receipt.after,receipt.before,'Exact own Source unchanged; timeline CSS outside lane scope may progress independently')
  receipt.passed=true
} catch(error){receipt.error={name:error.name,message:error.message};console.error(error.message);process.exitCode=1}
writeFileSync(path.join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(path.relative(root,path.join(directory,'receipt.json')))
