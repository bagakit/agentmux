import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from './probe-process.mjs'
const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..'), fixture=join(desktop,'scripts/fixtures/goals-surface')
const require=createRequire(import.meta.url),exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const captureArgs = process.argv.slice(2), evidenceIndex = captureArgs.indexOf('--evidence')
let evidenceArgument
if (evidenceIndex !== -1) {
  evidenceArgument = captureArgs[evidenceIndex + 1]
  assert.ok(evidenceArgument && !evidenceArgument.startsWith('--'), '--evidence requires one exact output directory.')
  captureArgs.splice(evidenceIndex, 2)
}
const sourceIndex=captureArgs.indexOf('--source')
let realSourceArgument
if(sourceIndex!==-1){realSourceArgument=captureArgs[sourceIndex+1];assert.ok(realSourceArgument&&!realSourceArgument.startsWith('--'),'--source requires one explicit source manifest');realSourceArgument=resolve(realSourceArgument);captureArgs.splice(sourceIndex,2)}
const goalRealWorkFocus=captureArgs.includes('--goal-real-work-focus-only')
const goalRealWorkTeam=captureArgs.includes('--goal-real-work-team-only')
const goalRealWork=captureArgs.includes('--goal-real-work-only')||goalRealWorkFocus||goalRealWorkTeam
assert.equal(Boolean(realSourceArgument),goalRealWork,'Only the real-work scope consumes an explicit original source manifest')
assert.ok(captureArgs.every(flag=>['--goal-real-work-team-only','--goal-real-work-focus-only','--goal-real-work-only','--goal-hierarchy-cta-only','--goal-hierarchy-refresh-only','--goal-hierarchy-key-only','--goal-hierarchy-only','--goal-hierarchy-goals-only','--goal-hierarchy-settings-only','--goal-hierarchy-settings-wide-only','--goal-task-workbench-only','--goal-reading-outline-only','--goal-claim-workbench-only','--goal-space-only','--goal-space-layout-only','--goal-space-settings-only','--goal-space-wide-plan-only','--plan-request-only','--plan-only','--plan-and-maturity','--workflow-only','--cohesion-only','--common-actions','--full-workflow','--corrections-only','--focus-only','--maturity','--list-search-only','--before-only','--legibility-only','--width-only','--return-only','--density-only','--density-before-only','--density-list-only','--direct-goal-only','--direct-reading-only','--project-links-only','--project-file-display-only','--goal-main-mote-only'].includes(flag)),'Unknown Goals capture flag')
const listSearchOnly=captureArgs.includes('--list-search-only')
assert.ok(!listSearchOnly || captureArgs.includes('--maturity'), 'List search captures the original maturity renderer')
const goalTaskWorkbench = captureArgs.includes('--goal-task-workbench-only')
const goalReadingOutline = captureArgs.includes('--goal-reading-outline-only')
const goalClaimWorkbench = captureArgs.includes('--goal-claim-workbench-only')
const goalSpaceOnly=goalTaskWorkbench || goalReadingOutline || goalClaimWorkbench || captureArgs.includes('--goal-space-only')||captureArgs.includes('--goal-space-layout-only')||captureArgs.includes('--goal-space-settings-only')||captureArgs.includes('--goal-space-wide-plan-only')
const goalHierarchy = captureArgs.some(flag => flag.startsWith('--goal-hierarchy-'))
const goalSourceOnly = goalSpaceOnly || goalHierarchy || goalRealWork
const captureMaturity=captureArgs.includes('--plan-and-maturity')
const planRequestOnly=captureArgs.includes('--plan-request-only')
const planOnly=captureArgs.includes('--plan-only')||captureMaturity||planRequestOnly||goalSourceOnly
assert.ok(!planOnly || captureArgs.length === 1, 'Plan capture is one explicit bounded mode')
const directReading=captureArgs.includes('--direct-reading-only')
const direct=captureArgs.includes('--direct-goal-only')||directReading
const mainMote=captureArgs.includes('--goal-main-mote-only')
assert.ok(!mainMote || captureArgs.length === 1, 'Main Mote capture is one explicit bounded mode')
const fileDisplayOnly=captureArgs.includes('--project-file-display-only')
const links=captureArgs.includes('--project-links-only')||fileDisplayOnly
assert.ok(!links || captureArgs.length === 1, 'Project links capture is one explicit bounded mode')
assert.ok(!direct || captureArgs.length === 1, 'Direct Goal capture is one explicit bounded mode')
const density=captureArgs.includes('--density-only')||captureArgs.includes('--density-before-only')
const densityList=captureArgs.includes('--density-list-only')
assert.ok(!densityList || captureArgs.includes('--maturity') && captureArgs.includes('--density-only') && captureArgs.length===3, 'Density list capture requires exactly --maturity --density-only --density-list-only')
assert.ok(!density||captureArgs.includes('--maturity'),'Density uses the actual maturity Renderer fixture')
const evidencePath=evidenceArgument||process.env.AGENTMUX_GOALS_EVIDENCE_ROOT
assert.ok(evidencePath,'Supply --evidence DIR for Goals capture output')
const evidenceRoot=resolve(evidencePath)
const privateRoot=await mkdtemp(_hygiene_fixturePath("tmp/amx-goals-visual-")), evidence=join(evidenceRoot,("attempt-" + (globalThis.crypto.randomUUID()) + ""))
const densityBaseline=process.env.AGENTMUX_GOALS_DENSITY_BASELINE||join(evidenceRoot,'density-baseline.json')
const ownedSources = ['scripts/verify-goals-surface.mjs', 'src/renderer/src/lib/goals-entry-actions.ts', 'src/renderer/src/lib/goals-direct-pmo.ts', '../host/src/goal-project-context.ts', 'src/renderer/src/lib/workbench-tabs.ts', 'src/renderer/src/components/NewTabSurface.tsx', 'src/renderer/src/store.ts', 'src/renderer/src/components/GlobalBoardSurface.tsx', 'src/renderer/src/components/GoalsCollection.tsx', 'src/renderer/src/components/GoalDetail.tsx', 'src/renderer/src/components/GoalIntent.tsx', 'src/renderer/src/components/GoalActivity.tsx', 'src/renderer/src/components/GoalAlignment.tsx', 'src/renderer/src/components/GoalProperties.tsx', 'src/renderer/src/components/GoalExecution.tsx', 'src/renderer/src/lib/goal-presentation.ts', 'src/renderer/src/styles/goals.css', 'src/renderer/src/styles/tokens.css', '../../packages/client-ui/src/styles/palette.css', 'src/renderer/src/styles/index.css', 'scripts/fixtures/goals-surface/entry.tsx', 'scripts/fixtures/goals-surface/main.cjs', 'scripts/fixtures/goals-surface/controls.cjs']
if(listSearchOnly)ownedSources.push('../../packages/client-ui/src/input/SearchInput.tsx','../../packages/client-ui/src/input/input.css','src/renderer/src/components/SurfaceState.tsx','src/renderer/src/styles/surface-state.css')
if(planOnly)ownedSources.push('src/renderer/src/lib/goal-discussion-request.ts','src/renderer/src/lib/goal-discussion-recipient.ts')
if(planOnly||mainMote||direct||captureArgs.includes('--common-actions')||captureArgs.includes('--maturity'))ownedSources.push('src/renderer/src/components/GoalsCommonActions.tsx','src/renderer/src/lib/goals-common-actions.ts','src/renderer/src/lib/goals-common-actions-config.ts','src/shared/contracts.ts','src/shared/composer-shortcut-library.ts','src/shared/config-edit.ts','scripts/fixtures/goals-surface/common-actions.cjs','../../packages/client-ui/brand/heroes/origin-banner.avif')
if(captureArgs.includes('--cohesion-only'))ownedSources.push('scripts/fixtures/goals-surface/cohesion.cjs','src/renderer/src/components/SelectionField.tsx','src/renderer/src/components/SurfaceModeSwitch.tsx','src/renderer/src/styles/surface-mode-switch.css')
if(captureArgs.includes('--workflow-only')) ownedSources.push('scripts/fixtures/goals-surface/workflow-restart.cjs','scripts/fixtures/goals-surface/workflow.cjs','src/renderer/src/components/GoalEvidence.tsx','src/renderer/src/components/GoalFiniteStartControl.tsx','src/renderer/src/lib/goal-finite-start.ts','src/renderer/src/lib/goal-discussion-recipient.ts','src/renderer/src/styles/goal-finite-start.css','../../packages/demand/src/goals.ts','../../packages/demand/src/evidence.ts','../../packages/core/src/goal-evidence.ts')
if(planOnly||mainMote||direct||captureArgs.includes('--maturity'))ownedSources.push('scripts/fixtures/goals-surface/maturity.cjs','src/renderer/src/lib/session-presentation.ts','src/renderer/src/lib/workspace-projects.ts')
if(planOnly||mainMote||density||direct||links)ownedSources.push('src/renderer/src/App.tsx')
if(mainMote||direct)ownedSources.push('src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx','src/renderer/src/lib/pmo-teams-topic-floating.ts','src/renderer/src/styles/pmo-teams-topic.css','src/renderer/src/styles/launcher.css','src/renderer/src/lib/app-appearance.ts','src/renderer/src/lib/theme-contract.ts')
if(mainMote||direct||densityList)ownedSources.push('scripts/fixtures/goals-surface/project-links.ts')
if(densityList)ownedSources.push('scripts/fixtures/goals-surface/main-mote.ts')
if(links)ownedSources.push('scripts/fixtures/goals-surface/maturity.cjs','scripts/fixtures/goals-surface/project-links.ts','scripts/fixtures/goals-surface/project-links.cjs','src/renderer/src/components/SessionPane.tsx','src/renderer/src/components/ActivityView.tsx','../../packages/client-ui/src/components/ConversationMessage.tsx','../../packages/client-ui/src/components/ConversationReasoningTrace.tsx','../../packages/client-ui/src/components/ConversationView.tsx','../../packages/client-ui/src/styles/conversation-native-thread.css','src/renderer/src/lib/session-user-messages.ts','../../packages/client-ui/src/components/AgentMarkdown.tsx','src/renderer/src/components/WorkspaceWorkbench.tsx','src/renderer/src/lib/session-project-file-context.ts','src/renderer/src/lib/file-workbench-state.ts','../../packages/client-ui/src/lib/markdown-file-reference.ts','../../packages/client-ui/src/lib/terminal-path-link.ts','src/shared/space-addresses.ts','src/renderer/src/styles/activity.css','src/renderer/src/styles/service-notice.css')
if(links)ownedSources.push('src/renderer/src/App.tsx','src/renderer/src/components/StableWorkbenchView.tsx','src/renderer/src/components/FileSurfaceView.tsx','src/renderer/src/components/EditorPane.tsx','src/renderer/src/lib/workbench-presentation.ts','src/renderer/src/lib/workbench-resource-display.ts','src/renderer/src/lib/scratch-topic-layout.ts','src/renderer/src/lib/region-focus.ts')
if(mainMote)ownedSources.push('scripts/fixtures/goals-surface/main-mote.ts','scripts/fixtures/goals-surface/main-mote.cjs')
if(mainMote||direct)ownedSources.push('src/renderer/src/lib/api.ts','src/renderer/src/lib/session-state.ts','src/renderer/src/lib/session-user-messages.ts','src/renderer/src/lib/session-project-file-context.ts','src/renderer/src/components/SessionPane.tsx','src/renderer/src/components/ActivityView.tsx','../../packages/client-ui/src/components/ConversationView.tsx','../../packages/client-ui/src/components/ConversationMessage.tsx','../../packages/client-ui/src/components/AgentMarkdown.tsx','src/renderer/src/styles/activity.css','../../packages/client-ui/src/styles/conversation-native-thread.css','src/renderer/src/components/WorkspaceWorkbench.tsx')
if(planOnly||mainMote||direct||captureArgs.includes('--common-actions')||captureArgs.includes('--maturity'))ownedSources.push('src/renderer/src/lib/primary-mote-executor.ts','../host/src/mote-topic-model.ts','../../packages/core/package.json','../../packages/core/src/agent-outbound-message.ts','../../packages/core/dist/agent-outbound-message.js','../../packages/core/src/agentmux-cli-help.ts','../../packages/core/dist/agentmux-cli-help.js')
if(mainMote||direct)ownedSources.push('../../packages/core/src/agent-message-render.ts','../../packages/core/dist/agent-message-render.js','src/renderer/src/lib/conversation-speaker.ts','../../packages/client-ui/src/styles/conversation-message.css','../../packages/client-ui/src/styles/conversation-input-details.css','../../packages/client-ui/src/styles/conversation-avatar.css','src/renderer/src/styles/conversation-axis.css')
if(planRequestOnly)ownedSources.push('src/renderer/src/components/GoalPlanRequest.tsx','scripts/fixtures/goals-surface/plan-request.cjs')
if(planOnly)ownedSources.push('src/renderer/src/components/GoalDelegationWork.tsx','src/renderer/src/lib/goal-delegation-presentation.ts','scripts/fixtures/goals-surface/plan.ts','scripts/fixtures/goals-surface/plan.cjs','scripts/fixtures/goals-surface/scenario.md','src/renderer/src/components/GoalPlanGraph.tsx','src/renderer/src/components/GoalPlanThread.tsx','src/renderer/src/styles/goal-plan.css','../../packages/demand/src/goal-plan.ts','../../packages/demand/dist/src/goal-plan.js','../../packages/demand/src/responsibility.ts','../../packages/demand/dist/src/responsibility.js','../../packages/core/src/goal-responsibility.ts','../../packages/core/dist/goal-responsibility.js','../host/src/goal-projection.ts','../host/dist/goal-projection.js')
if(goalSourceOnly)ownedSources.push('../../packages/core/src/control.ts','../../packages/core/src/browser-profile-bookmarks.ts','scripts/fixtures/goals-surface/space.ts','scripts/fixtures/goals-surface/space.cjs','src/renderer/src/components/settings/GoalsSettingsPane.tsx','src/renderer/src/components/settings/GoalsCommonActionsSettings.tsx','src/renderer/src/components/settings/settings-goals-common-actions.css','src/renderer/src/components/settings/ShortcutSettingsPane.tsx','src/renderer/src/components/SettingsPanel.tsx')
if(goalTaskWorkbench)ownedSources.push('scripts/fixtures/goals-surface/task-workbench.cjs','scripts/fixtures/goals-surface/edge-geometry.cjs','src/renderer/src/components/useGoalPlanPath.ts',
  'src/renderer/src/components/GoalPlanAssignment.tsx','src/renderer/src/components/GoalPlanReadingPlacement.tsx',
  'src/renderer/src/lib/goal-plan-routing.ts','src/renderer/src/lib/move-reading-host.ts')
if(goalReadingOutline)ownedSources.push('src/renderer/src/components/GoalReadingOutline.tsx','src/renderer/src/components/useGoalPlanPath.ts','scripts/fixtures/goals-surface/workflow-restart.cjs','src/renderer/src/styles/goal-reading.css','scripts/fixtures/goals-surface/reading-outline.cjs')
if(goalClaimWorkbench)ownedSources.push('src/renderer/src/components/GoalWorkArea.tsx','scripts/fixtures/goals-surface/claim-workbench.cjs','src/renderer/src/components/GoalSupervisorRail.tsx','src/renderer/src/components/GoalPatrolControl.tsx','src/renderer/src/components/GoalExecutionTimeline.tsx','src/renderer/src/styles/goal-reading.css','src/renderer/src/styles/goal-supervisor-rail.css')
if(goalHierarchy)ownedSources.push('scripts/fixtures/goals-surface/hierarchy.ts','scripts/fixtures/goals-surface/hierarchy.cjs','src/renderer/src/lib/goal-team.ts','src/renderer/src/lib/goal-agent-selection.ts','src/renderer/src/components/GoalContinuationControl.tsx','src/renderer/src/styles/goal-team.css','src/renderer/src/components/FocusContextCardBody.tsx','src/renderer/src/components/settings/GoalsPromptDrafts.tsx','src/renderer/src/components/settings/SettingsSaveBar.tsx','src/renderer/src/components/settings/modules/goals.tsx','src/renderer/src/components/settings/modules/prompts.tsx','src/renderer/src/components/settings/use-resource-drafts.ts','src/renderer/src/components/settings/use-setting-draft.ts','src/renderer/src/lib/focus-context.ts','src/renderer/src/lib/focus-context-identity.ts','src/renderer/src/styles/focus-context.css','src/renderer/src/components/FocusContextRow.tsx','src/renderer/src/components/AgentContextContent.tsx','src/renderer/src/components/FocusContextMenu.tsx','src/renderer/src/components/AgentInformationPreview.tsx','src/renderer/src/styles/focus.css')
if(goalRealWork)ownedSources.push('scripts/fixtures/goals-surface/index.html','scripts/fixtures/goals-surface/real-work.ts','scripts/fixtures/goals-surface/real-work.cjs','scripts/fixtures/goals-surface/real-work-native.cjs','src/renderer/src/components/GoalWorkArea.tsx','src/renderer/src/lib/goal-start-presentation.ts','src/renderer/src/lib/goal-delegation-work.ts','src/renderer/src/components/GoalFiniteStartControl.tsx','src/renderer/src/lib/goal-team.ts','src/renderer/src/styles/goal-team.css')
const sourceHashes = async () => Object.fromEntries(await Promise.all(ownedSources.map(async file => [file, hash(await readFile(join(desktop, file)))])))
// Default proof follows the current Goals entry acceptance; the broader detail workflow remains explicit.
const mode=goalRealWork?'goal-real-work':planOnly?'plan':mainMote?'goal-main-mote':links?'project-links':direct?'direct-goal':density?'density':captureArgs.includes('--maturity')?'maturity':captureArgs.includes('--common-actions')?'common-actions':captureArgs.includes('--full-workflow')?'full-workflow':'entry-controls'
const result={schema:'agentmux.goals-visual-capture.v1',captureOnly:true,fileDisplayOnly,readingOnly:directReading,aestheticReview:'not-performed',mode,...(densityList?{caseFilter:'mixed-and-project'}:{}),passed:false,userRunTouched:false,...(goalHierarchy||goalRealWork?{privateRoot}: {}),...(goalRealWork?{realSourceManifest:realSourceArgument}: {})}
try{
  await mkdir(evidence,{recursive:true});result.sourceCommit=process.env.AGENTMUX_GOALS_SOURCE_COMMIT||(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim()
  result.sourceBefore=await sourceHashes()
  if(density&&!captureArgs.includes('--density-before-only')){const bytes=await readFile(densityBaseline),baseline=JSON.parse(bytes);result.densityBaseline={path:densityBaseline,sha256:hash(bytes),sourceCommit:baseline.sourceCommit,sourceBefore:baseline.sourceBefore};assert.ok(Object.keys(baseline.sourceBefore).length>0,'Measured prior layout has nonempty Source identity')}
  const outDir=join(privateRoot,'renderer')
  const loadedCoreSources={}, loadedCandidateSources={}
  await build({configFile:false,...(goalSourceOnly?{resolve:{alias:[{find:/^@agentmux\/core\/control$/u,replacement:join(repository,'packages/core/src/control.ts')}]},plugins:[{name:'goal-space-public-core-source',enforce:'pre',async transform(code,id){const file=id.split('?')[0];if(file.startsWith(join(repository,'packages/core/src/')))loadedCoreSources[file.slice(repository.length+1)]={transformInputSHA256:hash(code)};if(goalRealWork&&file.startsWith(repository+'/')&&!file.includes('/node_modules/')&&!file.endsWith('.html'))loadedCandidateSources[file.slice(repository.length+1)]=hash(await readFile(file));if(goalRealWork&&['store.ts','desktop-user-state.ts','launcher-state.ts'].some(name=>file.endsWith('/'+name)))return code.replaceAll('__AGENTMUX_WEB_PREVIEW__',"(typeof window === 'undefined' || !('goalEditNative' in window))")}}]}:{}),root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},worker:{format:'es'},build:{outDir,minify:false,sourcemap:!planOnly&&!listSearchOnly,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  if(goalSourceOnly){result.coreBase={commit:result.sourceCommit,scope:'working-tree public control source; no shared dist rebuild',sources:loadedCoreSources};await writeFile(join(evidence,'core-source-inputs.json'),JSON.stringify(result.coreBase,null,2))}
  if(planOnly||mainMote||direct||densityList||goalRealWork||captureArgs.includes('--workflow-only')) { await cp(outDir, join(evidence, 'compiled'), {recursive:true}); result.compiledDirectory=join(evidence,'compiled') }
  const compiled={};for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true})){if(entry.isFile()){const p=join(entry.parentPath,entry.name);compiled[p.slice(outDir.length+1)]=hash(await readFile(p))}}
  assert.ok(Object.keys(compiled).length>0);await writeFile(join(evidence,'compiled.json'),JSON.stringify(compiled,null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const log=[]
  result.outcome=await runProbeProcess(require('electron'),[join(fixture,goalRealWork?'real-work.cjs':['plan','maturity','density','direct-goal','project-links','goal-main-mote'].includes(mode)?'maturity.cjs':mode==='common-actions'?'common-actions.cjs':mode==='full-workflow'?'main.cjs':'controls.cjs'),join(outDir,'index.html'),privateRoot,evidence,...(goalRealWork?[realSourceArgument,...(goalRealWorkFocus?['matrix:fresh,pending,current-result,stale,gap,ack']:goalRealWorkTeam?['real-a-team']:[])]:planOnly?[goalHierarchy?captureArgs[0].slice(2):goalSpaceOnly?captureArgs[0].slice(2):planRequestOnly?'plan-request-only':'plan-only']:captureArgs.includes('--workflow-only')?['workflow-only']:mainMote?['goal-main-mote-only']:links?[fileDisplayOnly?'project-file-display-only':'project-links-only']:direct?[directReading?'direct-reading-only':'direct-goal-only']:density?[captureArgs.includes('--density-before-only')?'density-before-only':densityList?'density-list-only':'density-only',densityBaseline]:captureArgs.includes('--cohesion-only')?['cohesion-only']:listSearchOnly?['list-search-only']:captureArgs.includes('--before-only')?['before-only']:captureArgs.includes('--legibility-only')?['legibility-only']:captureArgs.includes('--width-only')?['width-only']:captureArgs.includes('--return-only')?['return-only']:captureArgs.includes('--corrections-only')?['corrections-only']:captureArgs.includes('--focus-only')?['focus-only']:[])],{temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:60000,onLine:line=>log.push(line)})
  await writeFile(join(evidence,'process.log'),log.join('\n'));
  if ((captureArgs.includes('--workflow-only') || goalClaimWorkbench || goalReadingOutline || goalTaskWorkbench) && result.outcome.exitCode === 0) {
    const restartRoot = join(privateRoot, 'workflow-restart')
    await symlink(join(repository, 'packages/core/node_modules'), join(privateRoot, 'node_modules'), 'dir')
    const spatialOwner = join(privateRoot, 'spatial-owner.mjs')
    await createRequire(require.resolve('vite/package.json'))('esbuild').build({ entryPoints: [join(repository, 'packages/core/src/spatial-state.ts')], outfile: spatialOwner, platform: 'node', target: 'node24', format: 'esm', bundle: true, banner: { js: `import { createRequire as __goalsSpatialRequireFactory } from 'node:module'; const require = __goalsSpatialRequireFactory(${JSON.stringify(join(repository, 'packages/core/package.json'))});` }, logLevel: 'silent' })
    for (const phase of ['save', 'restore']) {
      const lines = []
      const receipt = await runProbeProcess(require('electron'), [join(fixture,'workflow-restart.cjs'), join(outDir,'index.html'), restartRoot, evidence, phase, spatialOwner],
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
  assert.equal(result.outcome.exitCode,0,JSON.stringify(result.render.failure));assert.equal(result.render.passed,true);result.sourceAfter=await sourceHashes();assert.deepEqual(result.sourceAfter,result.sourceBefore,'Owned Goals sources remained identical through compilation and capture');if(goalRealWork){result.loadedCandidateSources=loadedCandidateSources;assert.ok(Object.keys(loadedCandidateSources).length>0,'Real-work candidate source set is nonempty');for(const [file,sha]of Object.entries(loadedCandidateSources))assert.equal(hash(await readFile(join(repository,file))),sha,'Loaded candidate input remained stable: '+file);const source=JSON.parse(await readFile(realSourceArgument));const actualSource=result.render.source??{manifestSHA256:hash(await readFile(realSourceArgument)),inputs:Object.fromEntries(Object.entries(source.inputs).map(([name,ref])=>[name,ref.sha256]))};assert.equal(hash(await readFile(realSourceArgument)),actualSource.manifestSHA256,'The exact runtime source manifest stayed intact');for(const [name,sha]of Object.entries(actualSource.inputs))assert.equal(hash(await readFile(resolve(realSourceArgument,'..',source.inputs[name].path))),sha,'Original real-work source stayed intact: '+name)}result.passed=true
  if(captureArgs.includes('--density-before-only')){await mkdir(resolve(densityBaseline,'..'),{recursive:true});await writeFile(densityBaseline,JSON.stringify({sourceCommit:result.sourceCommit,sourceBefore:result.sourceBefore,render:result.render,receipt:join(evidence,'receipt.json')},null,2))}
  await writeFile(join(evidence,'review.md'),['# Goals screenshots — independent review pending','',`Candidate HEAD: ${result.sourceCommit}. Actual private Renderer build: [compiled.json](compiled.json). Capture receipt does not prove aesthetic approval.`, '', 'Real App → Goals, product components and product CSS; preview data only. Native/CLI/Mote delivery is outside this capture. Workflow mode additionally checks actual Chromium workface persistence across two private Electron processes; it does not assert native Agent recovery. Original user App and Runs were not touched.','',...result.render.frames.map(frame=>`- ${frame.name}: [screenshot](${frame.file})`),'','Review the complete normal and narrow images against Goals SSOT. Record actual images seen, reading hierarchy, noise, controls, clipping and concrete revisions. Re-capture changed code before approving.',''].join('\n'))
}catch(error){result.failure={name:error.name,message:error.message}}
finally{await stopProbeProcesses(process.pid+1000000000,privateRoot);result.remaining=await listProbeProcesses(process.pid+1000000000,privateRoot);assert.deepEqual(result.remaining,[]);await rm(privateRoot,{recursive:true});if(goalHierarchy||goalRealWork)result.privateRootRemoved=true;await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))}
console.log(JSON.stringify({passed:result.passed,receipt:join(evidence,'receipt.json'),review:join(evidence,'review.md'),failure:result.failure}));if(!result.passed)process.exitCode=1
