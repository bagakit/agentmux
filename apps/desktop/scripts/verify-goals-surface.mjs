import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from './probe-process.mjs'
const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..'), fixture=join(desktop,'scripts/fixtures/goals-surface')
const require=createRequire(import.meta.url),exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
assert.ok(process.argv.slice(2).every(flag=>['--plan-only','--plan-and-maturity','--workflow-only','--cohesion-only','--common-actions','--full-workflow','--corrections-only','--focus-only','--maturity','--before-only','--legibility-only','--width-only','--return-only','--density-only','--density-before-only','--density-list-only','--direct-goal-only','--direct-reading-only','--project-links-only','--project-file-display-only','--goal-main-mote-only'].includes(flag)),'Unknown Goals capture flag')
const captureMaturity=process.argv.includes('--plan-and-maturity')
const planOnly=process.argv.includes('--plan-only')||captureMaturity
assert.ok(!planOnly || process.argv.slice(2).length === 1, 'Plan capture is one explicit bounded mode')
const directReading=process.argv.includes('--direct-reading-only')
const direct=process.argv.includes('--direct-goal-only')||directReading
const mainMote=process.argv.includes('--goal-main-mote-only')
assert.ok(!mainMote || process.argv.slice(2).length === 1, 'Main Mote capture is one explicit bounded mode')
const fileDisplayOnly=process.argv.includes('--project-file-display-only')
const links=process.argv.includes('--project-links-only')||fileDisplayOnly
assert.ok(!links || process.argv.slice(2).length === 1, 'Project links capture is one explicit bounded mode')
assert.ok(!direct || process.argv.slice(2).length === 1, 'Direct Goal capture is one explicit bounded mode')
const density=process.argv.includes('--density-only')||process.argv.includes('--density-before-only')
const densityList=process.argv.includes('--density-list-only')
assert.ok(!densityList || process.argv.includes('--maturity') && process.argv.includes('--density-only') && process.argv.slice(2).length===3, 'Density list capture requires exactly --maturity --density-only --density-list-only')
assert.ok(!density||process.argv.includes('--maturity'),'Density uses the actual maturity Renderer fixture')
const evidenceRoot=process.env.AGENTMUX_GOALS_EVIDENCE_ROOT||join(repository,'.tmp/goals-surface')
const privateRoot=await mkdtemp(_hygiene_fixturePath("tmp/amx-goals-visual-")), evidence=join(evidenceRoot,("attempt-" + (globalThis.crypto.randomUUID()) + ""))
const densityBaseline=process.env.AGENTMUX_GOALS_DENSITY_BASELINE||join(evidenceRoot,'density-baseline.json')
const ownedSources = ['scripts/verify-goals-surface.mjs', 'src/renderer/src/lib/goals-entry-actions.ts', 'src/renderer/src/lib/goals-direct-pmo.ts', '../host/src/goal-project-context.ts', 'src/renderer/src/lib/workbench-tabs.ts', 'src/renderer/src/components/NewTabSurface.tsx', 'src/renderer/src/store.ts', 'src/renderer/src/components/GlobalBoardSurface.tsx', 'src/renderer/src/components/GoalsCollection.tsx', 'src/renderer/src/components/GoalDetail.tsx', 'src/renderer/src/components/GoalAlignment.tsx', 'src/renderer/src/components/GoalProperties.tsx', 'src/renderer/src/components/GoalExecution.tsx', 'src/renderer/src/lib/goal-presentation.ts', 'src/renderer/src/styles/goals.css', 'src/renderer/src/styles/tokens.css', '../../packages/client-ui/src/styles/palette.css', 'src/renderer/src/styles/index.css', 'scripts/fixtures/goals-surface/entry.tsx', 'scripts/fixtures/goals-surface/main.cjs', 'scripts/fixtures/goals-surface/controls.cjs']
if(planOnly)ownedSources.push('src/renderer/src/lib/goal-discussion-request.ts','src/renderer/src/lib/goal-discussion-recipient.ts')
if(planOnly||mainMote||direct||process.argv.includes('--common-actions')||process.argv.includes('--maturity'))ownedSources.push('src/renderer/src/components/GoalsCommonActions.tsx','src/renderer/src/lib/goals-common-actions.ts','src/renderer/src/lib/goals-common-actions-config.ts','src/shared/contracts.ts','src/shared/composer-shortcut-library.ts','src/shared/config-edit.ts','scripts/fixtures/goals-surface/common-actions.cjs','../../packages/client-ui/brand/heroes/origin-banner.avif')
if(process.argv.includes('--cohesion-only'))ownedSources.push('scripts/fixtures/goals-surface/cohesion.cjs','src/renderer/src/components/SelectionField.tsx','src/renderer/src/components/SurfaceModeSwitch.tsx','src/renderer/src/styles/surface-mode-switch.css')
if(process.argv.includes('--workflow-only')) ownedSources.push('scripts/fixtures/goals-surface/workflow-restart.cjs','scripts/fixtures/goals-surface/workflow.cjs','src/renderer/src/components/GoalEvidence.tsx','src/renderer/src/components/GoalFiniteStartControl.tsx','src/renderer/src/lib/goal-finite-start.ts','src/renderer/src/lib/goal-discussion-recipient.ts','src/renderer/src/styles/goal-finite-start.css','../../packages/demand/src/goals.ts','../../packages/demand/src/evidence.ts','../../packages/core/src/goal-evidence.ts')
if(planOnly||mainMote||direct||process.argv.includes('--maturity'))ownedSources.push('scripts/fixtures/goals-surface/maturity.cjs','src/renderer/src/lib/session-presentation.ts','src/renderer/src/lib/workspace-projects.ts')
if(planOnly||mainMote||density||direct||links)ownedSources.push('src/renderer/src/App.tsx')
if(mainMote||direct)ownedSources.push('src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx','src/renderer/src/lib/pmo-teams-topic-floating.ts','src/renderer/src/styles/pmo-teams-topic.css','src/renderer/src/styles/launcher.css','src/renderer/src/lib/app-appearance.ts','src/renderer/src/lib/theme-contract.ts')
if(mainMote||direct||densityList)ownedSources.push('scripts/fixtures/goals-surface/project-links.ts')
if(densityList)ownedSources.push('scripts/fixtures/goals-surface/main-mote.ts')
if(links)ownedSources.push('scripts/fixtures/goals-surface/maturity.cjs','scripts/fixtures/goals-surface/project-links.ts','scripts/fixtures/goals-surface/project-links.cjs','src/renderer/src/components/SessionPane.tsx','src/renderer/src/components/ActivityView.tsx','../../packages/client-ui/src/components/ConversationMessage.tsx','../../packages/client-ui/src/components/ConversationReasoningTrace.tsx','../../packages/client-ui/src/components/ConversationView.tsx','../../packages/client-ui/src/styles/conversation-native-thread.css','src/renderer/src/lib/session-user-messages.ts','../../packages/client-ui/src/components/AgentMarkdown.tsx','src/renderer/src/components/WorkspaceWorkbench.tsx','src/renderer/src/lib/session-project-file-context.ts','src/renderer/src/lib/file-workbench-state.ts','../../packages/client-ui/src/lib/markdown-file-reference.ts','../../packages/client-ui/src/lib/terminal-path-link.ts','src/shared/space-addresses.ts','src/renderer/src/styles/activity.css','src/renderer/src/styles/service-notice.css')
if(links)ownedSources.push('src/renderer/src/App.tsx','src/renderer/src/components/StableWorkbenchView.tsx','src/renderer/src/components/FileSurfaceView.tsx','src/renderer/src/components/EditorPane.tsx','src/renderer/src/lib/workbench-presentation.ts','src/renderer/src/lib/workbench-resource-display.ts','src/renderer/src/lib/scratch-topic-layout.ts','src/renderer/src/lib/region-focus.ts')
if(mainMote)ownedSources.push('scripts/fixtures/goals-surface/main-mote.ts','scripts/fixtures/goals-surface/main-mote.cjs')
if(mainMote||direct)ownedSources.push('src/renderer/src/lib/api.ts','src/renderer/src/lib/session-state.ts','src/renderer/src/lib/session-user-messages.ts','src/renderer/src/lib/session-project-file-context.ts','src/renderer/src/components/SessionPane.tsx','src/renderer/src/components/ActivityView.tsx','../../packages/client-ui/src/components/ConversationView.tsx','../../packages/client-ui/src/components/ConversationMessage.tsx','../../packages/client-ui/src/components/AgentMarkdown.tsx','src/renderer/src/styles/activity.css','../../packages/client-ui/src/styles/conversation-native-thread.css','src/renderer/src/components/WorkspaceWorkbench.tsx')
if(planOnly||mainMote||direct||process.argv.includes('--common-actions')||process.argv.includes('--maturity'))ownedSources.push('src/renderer/src/lib/primary-mote-executor.ts','../host/src/mote-topic-model.ts','../../packages/core/package.json','../../packages/core/src/agent-outbound-message.ts','../../packages/core/dist/agent-outbound-message.js','../../packages/core/src/agentmux-cli-help.ts','../../packages/core/dist/agentmux-cli-help.js')
if(mainMote||direct)ownedSources.push('../../packages/core/src/agent-message-render.ts','../../packages/core/dist/agent-message-render.js','src/renderer/src/lib/conversation-speaker.ts','../../packages/client-ui/src/styles/conversation-message.css','../../packages/client-ui/src/styles/conversation-input-details.css','../../packages/client-ui/src/styles/conversation-avatar.css','src/renderer/src/styles/conversation-axis.css')
if(planOnly)ownedSources.push('scripts/fixtures/goals-surface/plan.ts','scripts/fixtures/goals-surface/plan.cjs','scripts/fixtures/goals-surface/scenario.md','src/renderer/src/components/GoalPlanGraph.tsx','src/renderer/src/components/GoalPlanThread.tsx','src/renderer/src/styles/goal-plan.css','../../packages/demand/src/goal-plan.ts','../../packages/demand/dist/src/goal-plan.js','../../packages/demand/src/responsibility.ts','../../packages/demand/dist/src/responsibility.js','../../packages/core/src/goal-responsibility.ts','../../packages/core/dist/goal-responsibility.js','../host/src/goal-projection.ts','../host/dist/goal-projection.js')
const sourceHashes = async () => Object.fromEntries(await Promise.all(ownedSources.map(async file => [file, hash(await readFile(join(desktop, file)))])))
// Default proof follows the current Goals entry acceptance; the broader detail workflow remains explicit.
const mode=planOnly?'plan':mainMote?'goal-main-mote':links?'project-links':direct?'direct-goal':density?'density':process.argv.includes('--maturity')?'maturity':process.argv.includes('--common-actions')?'common-actions':process.argv.includes('--full-workflow')?'full-workflow':'entry-controls'
const result={schema:'agentmux.goals-visual-capture.v1',captureOnly:true,fileDisplayOnly,readingOnly:directReading,aestheticReview:'not-performed',mode,...(densityList?{caseFilter:'mixed-and-project'}:{}),passed:false,userRunTouched:false}
try{
  await mkdir(evidence,{recursive:true});result.sourceCommit=process.env.AGENTMUX_GOALS_SOURCE_COMMIT||(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim()
  result.sourceBefore=await sourceHashes()
  if(density&&!process.argv.includes('--density-before-only')){const bytes=await readFile(densityBaseline),baseline=JSON.parse(bytes);result.densityBaseline={path:densityBaseline,sha256:hash(bytes),sourceCommit:baseline.sourceCommit,sourceBefore:baseline.sourceBefore};assert.ok(Object.keys(baseline.sourceBefore).length>0,'Measured prior layout has nonempty Source identity')}
  const outDir=join(privateRoot,'renderer')
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},worker:{format:'es'},build:{outDir,minify:false,sourcemap:!planOnly,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  if(planOnly||mainMote||direct||densityList||process.argv.includes('--workflow-only')) { await cp(outDir, join(evidence, 'compiled'), {recursive:true}); result.compiledDirectory=join(evidence,'compiled') }
  const compiled={};for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true})){if(entry.isFile()){const p=join(entry.parentPath,entry.name);compiled[p.slice(outDir.length+1)]=hash(await readFile(p))}}
  assert.ok(Object.keys(compiled).length>0);await writeFile(join(evidence,'compiled.json'),JSON.stringify(compiled,null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const log=[]
  result.outcome=await runProbeProcess(require('electron'),[join(fixture,['plan','maturity','density','direct-goal','project-links','goal-main-mote'].includes(mode)?'maturity.cjs':mode==='common-actions'?'common-actions.cjs':mode==='full-workflow'?'main.cjs':'controls.cjs'),join(outDir,'index.html'),privateRoot,evidence,...(planOnly?['plan-only']:process.argv.includes('--workflow-only')?['workflow-only']:mainMote?['goal-main-mote-only']:links?[fileDisplayOnly?'project-file-display-only':'project-links-only']:direct?[directReading?'direct-reading-only':'direct-goal-only']:density?[process.argv.includes('--density-before-only')?'density-before-only':densityList?'density-list-only':'density-only',densityBaseline]:process.argv.includes('--cohesion-only')?['cohesion-only']:process.argv.includes('--before-only')?['before-only']:process.argv.includes('--legibility-only')?['legibility-only']:process.argv.includes('--width-only')?['width-only']:process.argv.includes('--return-only')?['return-only']:process.argv.includes('--corrections-only')?['corrections-only']:process.argv.includes('--focus-only')?['focus-only']:[])],{temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:60000,onLine:line=>log.push(line)})
  await writeFile(join(evidence,'process.log'),log.join('\n'));
  if (process.argv.includes('--workflow-only') && result.outcome.exitCode === 0) {
    const restartRoot = join(privateRoot, 'workflow-restart')
    for (const phase of ['save', 'restore']) {
      const lines = []
      const receipt = await runProbeProcess(require('electron'), [join(fixture,'workflow-restart.cjs'), join(outDir,'index.html'), restartRoot, evidence, phase],
        { temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 60000, onLine: line => lines.push(line) })
      await writeFile(join(evidence, `workflow-restart-${phase}.log`), lines.join('\n'))
      assert.equal(receipt.exitCode, 0, `Private Electron workflow restart ${phase} succeeds`)
    }
    result.workflowRestart = JSON.parse(await readFile(join(evidence,'workflow-restart.json'),'utf8'))
  }
  if(captureMaturity && result.outcome.exitCode === 0) {
    const maturityEvidence=join(evidence,'maturity'), maturityRoot=join(privateRoot,'maturity-profile'), lines=[]
    await mkdir(maturityEvidence,{recursive:true})
    const supplemental={schema:'agentmux.goals-maturity-capture.v1',captureOnly:true,aestheticReview:'not-performed',passed:false,userRunTouched:false,
      sourceCommit:result.sourceCommit,sourceBefore:result.sourceBefore,compiledManifest:'../compiled.json'}
    try {
      supplemental.outcome=await runProbeProcess(require('electron'),[join(fixture,'maturity.cjs'),join(outDir,'index.html'),maturityRoot,maturityEvidence],
        {temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:60000,onLine:line=>lines.push(line)})
      supplemental.render=JSON.parse(await readFile(join(maturityEvidence,'render.json'),'utf8'))
      assert.equal(supplemental.outcome.exitCode,0,JSON.stringify(supplemental.render.failure));assert.equal(supplemental.render.passed,true)
      supplemental.passed=true
    }catch(error){supplemental.failure={name:error.name,message:error.message}}
    await writeFile(join(maturityEvidence,'process.log'),lines.join('\n'))
    await writeFile(join(maturityEvidence,'receipt.json'),JSON.stringify(supplemental,null,2))
    await writeFile(join(maturityEvidence,'review.md'),['# Goals maturity screenshots — independent review pending','',
      'Same private Renderer compilation as the plan capture; a separate private profile and Electron process. Preview facts do not prove native delivery or persistent Agent recovery.',
      '',...((supplemental.render?.frames??[]).map(frame=>`- ${frame.name}: [screenshot](${frame.file})`)),
      '',`Capture passed: ${supplemental.passed}. See [receipt.json](receipt.json) for the exact result and failure boundary.`,''].join('\n'))
    result.maturity={passed:supplemental.passed,receipt:join(maturityEvidence,'receipt.json'),review:join(maturityEvidence,'review.md'),failure:supplemental.failure}
  }
  const renderBytes=await readFile(join(evidence,'render.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error})
  assert.ok(renderBytes, `Private Renderer did not return a render receipt (exit=${result.outcome.exitCode}, timedOut=${result.outcome.timedOut}); inspect process.log and phase.json`)
  result.render=JSON.parse(renderBytes)
  assert.equal(result.outcome.exitCode,0,JSON.stringify(result.render.failure));assert.equal(result.render.passed,true);result.sourceAfter=await sourceHashes();assert.deepEqual(result.sourceAfter,result.sourceBefore,'Owned Goals sources remained identical through compilation and capture');result.passed=true
  if(process.argv.includes('--density-before-only')){await mkdir(resolve(densityBaseline,'..'),{recursive:true});await writeFile(densityBaseline,JSON.stringify({sourceCommit:result.sourceCommit,sourceBefore:result.sourceBefore,render:result.render,receipt:join(evidence,'receipt.json')},null,2))}
  await writeFile(join(evidence,'review.md'),['# Goals screenshots — independent review pending','',`Candidate HEAD: ${result.sourceCommit}. Actual private Renderer build: [compiled.json](compiled.json). Capture receipt does not prove aesthetic approval.`, '', 'Real App → Goals, product components and product CSS; preview data only. Native/CLI/Mote delivery is outside this capture. Workflow mode additionally checks actual Chromium workface persistence across two private Electron processes; it does not assert native Agent recovery. Original user App and Runs were not touched.','',...result.render.frames.map(frame=>`- ${frame.name}: [screenshot](${frame.file})`),'','Review the complete normal and narrow images against Goals SSOT. Record actual images seen, reading hierarchy, noise, controls, clipping and concrete revisions. Re-capture changed code before approving.',''].join('\n'))
}catch(error){result.failure={name:error.name,message:error.message}}
finally{await stopProbeProcesses(process.pid+1000000000,privateRoot);result.remaining=await listProbeProcesses(process.pid+1000000000,privateRoot);assert.deepEqual(result.remaining,[]);await rm(privateRoot,{recursive:true});await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))}
console.log(JSON.stringify({passed:result.passed,receipt:join(evidence,'receipt.json'),review:join(evidence,'review.md'),failure:result.failure}));if(!result.passed)process.exitCode=1
