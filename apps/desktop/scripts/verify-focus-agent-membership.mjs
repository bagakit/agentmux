import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceBinding, sha } from './fixtures/focus-agent-membership/source-binding.mjs'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), slice = args[args.indexOf('--slice') + 1]
assert.equal(slice,'source-visual','Select the original source-visual contract.')
const directory = path.join(root, `.tmp/focus-agent-membership-${slice}-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const binding = () => sourceBinding(root)
const fixtureFiles = ['vitest.owning.config.mts','vitest.adjacent.config.mts','vitest.mutation.config.mts','tsconfig.owning.json','capture.mjs','entry.mjs','main.cjs','index.html','source-binding.mjs'].map(file=>'apps/desktop/scripts/fixtures/focus-agent-membership/'+file)
const qualificationFiles = [...fixtureFiles,'apps/desktop/test/focus-agent-membership.test.tsx','apps/desktop/test/focus-terminal-owner-identity.test.tsx','apps/desktop/test/focus-pmo-attention.test.tsx','apps/desktop/test/recent-focus-timeline.test.tsx','apps/desktop/scripts/verify-focus-agent-membership.mjs']
const qualificationBinding = () => Object.fromEntries(qualificationFiles.map(file=>[file,sha(readFileSync(path.join(root,file)))]))
const receipt = { qualificationInputs:qualificationBinding(), schema: 'agentmux.focus-agent-membership-qualification.v1', slice, candidate: spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(), before: binding(), phases: [], passed: false, taskDone: false }
function run(name, argv, env = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd:root, encoding:'utf8', env:{...process.env,...env}, timeout:120000, maxBuffer:8*1024*1024 })
  writeFileSync(path.join(directory,name+'.stdout.log'),result.stdout??'');writeFileSync(path.join(directory,name+'.stderr.log'),result.stderr??'')
  receipt.phases.push({ name, argv, cwd:root, exit:result.status, signal:result.signal, error:result.error?.message })
  console.log(`${name}: ${result.status}`);return result
}
function tests(name, config, mutation) {
  const output=path.join(directory,name+'.json'), loaded=path.join(directory,name+'.loaded.ndjson')
  const result=run(name,['node','node_modules/vitest/vitest.mjs','run','--config',config,'--maxWorkers=1','--reporter=json',`--outputFile=${output}`], mutation?{AGENTMUX_FOCUS_MEMBERSHIP_MUTATION:mutation,AGENTMUX_FOCUS_MEMBERSHIP_MUTATION_LOG:loaded}:{})
  assert.ok(!result.error && !result.signal, `${name} process must complete`)
  const report=JSON.parse(readFileSync(output,'utf8'));assert.ok(report.numTotalTests>0,`${name} actually collects`)
  if(mutation){assert.notEqual(result.status,0);assert.ok(report.numFailedTests>0 && report.testResults.some(file=>file.assertionResults.some(test=>test.failureMessages.some(message=>message.includes('AssertionError')))),`${name} needs loaded product assertion RED`);const records=readFileSync(loaded,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(records.length,1);assert.notEqual(records[0].originalSha,records[0].transformedSha);return {total:report.numTotalTests,failed:report.numFailedTests,loaded:records}}
  assert.equal(result.status,0,`${name} GREEN`);assert.equal(report.numFailedTests,0);return {total:report.numTotalTests,passed:report.numPassedTests}
}
try {
  const config='apps/desktop/scripts/fixtures/focus-agent-membership/vitest.owning.config.mts'
  receipt.owning=tests('owning',config);receipt.mutations=[]
  for(const mutation of ['eligibility','hover-only','workspace-cleared','empty-set']){const red=tests(mutation,'apps/desktop/scripts/fixtures/focus-agent-membership/vitest.mutation.config.mts',mutation);assert.equal(red.total,receipt.owning.total);const restored=tests(mutation+'-restored',config);receipt.mutations.push({mutation,...red,restored})}
  receipt.adjacent=tests('adjacent','apps/desktop/scripts/fixtures/focus-agent-membership/vitest.adjacent.config.mts')
  for(const [name,project] of [['production-types','apps/desktop/tsconfig.json'],['owning-types','apps/desktop/scripts/fixtures/focus-agent-membership/tsconfig.owning.json']])assert.equal(run(name,['node','--max-old-space-size=768','node_modules/typescript/bin/tsc','--noEmit','-p',project]).status,0)
  const calls={createFocusProjectionSelector:['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','useMemo(createFocusProjectionSelector'],FocusNavigationPreview:['apps/desktop/src/renderer/src/components/TopRowChrome.tsx','<FocusNavigationPreview'],FocusNavigationButton:['apps/desktop/src/renderer/src/components/TopRowChrome.tsx','? FocusNavigationButton :'],tabForFocusedSession:['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','tabForFocusedSession(tabs, selectedId)']}
  receipt.callers=Object.fromEntries(Object.entries(calls).map(([symbol,[file,invocation]])=>{const text=readFileSync(path.join(root,file),'utf8'),index=text.indexOf(invocation);assert.ok(index>=0,`${symbol} non-definition product caller`);return[symbol,{file,invocation,line:text.slice(0,index).split('\n').length}]}))
  receipt.sourcePass=true
  const guiFile=process.env.AGENTMUX_FOCUS_MEMBERSHIP_GUI_RECEIPT,reviewFile=process.env.AGENTMUX_FOCUS_MEMBERSHIP_VISUAL_REVIEW
  assert.ok(guiFile&&reviewFile,'Supply exact compiled GUI and independent image review; capture success is not aesthetic acceptance')
  const guiBytes=readFileSync(path.resolve(root,guiFile)),gui=JSON.parse(guiBytes),reviewBytes=readFileSync(path.resolve(root,reviewFile)),review=JSON.parse(reviewBytes)
  assert.equal(gui.schema,'agentmux.focus-agent-membership-gui.v1');assert.equal(gui.passed,true);assert.equal(gui.phases.length,1);assert.ok(gui.phases[0].actual.pid>0)
  assert.deepEqual(gui.before,receipt.before);assert.deepEqual(gui.after,receipt.before);assert.equal(gui.cleanup.rootRemoved,true);assert.deepEqual(gui.cleanup.remaining,[])
  assert.deepEqual(gui.scenes.map(scene=>scene.width),[640,1440]);for(const scene of gui.scenes){assert.deepEqual(scene.rows,['attention','healthy-lost','idle','offline','results','session-codex']);assert.equal(scene.slot,'fixture-tab');assert.equal(scene.focus,'ordinary');assert.equal(scene.terminalRegion,true);assert.equal(scene.xterm,true);assert.equal(scene.draft,'不要丢失这份终端草稿');assert.ok(scene.historyTracks.includes('ordinary'));assert.ok(scene.target.hit&&scene.target.width>0&&scene.target.height>0)}
  assert.equal(review.verdict,'pass');assert.equal(review.guiReceiptSha256,sha(guiBytes));assert.ok(review.reviewerAgentId);assert.equal(review.viewedImages.length,gui.images.length)
  for(const image of gui.images){const bytes=readFileSync(path.resolve(root,image));assert.ok(review.viewedImages.some(viewed=>viewed.path===image&&viewed.sha256===sha(bytes)&&viewed.observation?.trim()),'Exact image was independently viewed')}
  receipt.gui={file:guiFile,sha256:sha(guiBytes)};receipt.review={file:reviewFile,sha256:sha(reviewBytes)};receipt.visualQualified=true;receipt.scope=gui.boundary
  receipt.after=binding();assert.deepEqual(receipt.after,receipt.before,'Exact consumed Source unchanged during qualification')
  receipt.passed=true
} catch(error){receipt.error={name:error.name,message:error.message};console.error(error.message);process.exitCode=1}
receipt.after=binding();receipt.qualificationAfter=qualificationBinding();if(JSON.stringify(receipt.qualificationAfter)!==JSON.stringify(receipt.qualificationInputs)){receipt.passed=false;receipt.sourcePass=false;receipt.error={name:'AssertionError',message:'Qualification inputs changed'};process.exitCode=1}
writeFileSync(path.join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(path.relative(root,path.join(directory,'receipt.json')))
