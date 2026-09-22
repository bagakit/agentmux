import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reviewDemonstration } from './browser-demonstration-probe-scenario.mjs'

// Product scenario only. The existing recovery harness owns launch, workspace, native views and cleanup.
const taskSurface = '[aria-label="Editable Browser task asset"]'
const quoted = JSON.stringify
const current = ctx => ctx.probe.cdp.evaluate(`window.agentmux.browser.getTaskAssets(${quoted(ctx.browserId)})`)
const button = (ctx, label) => `${ctx.selectors(taskSurface + ' button')}.filter(e=>e.textContent.trim()===${quoted(label)})`
const field = (ctx, label) => ctx.selectors(`${taskSurface} [aria-label=${quoted(label)}]`)

async function type(ctx, label, value) {
  await ctx.click(ctx.probe.cdp, field(ctx, label))
  await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
  await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
  await ctx.probe.cdp.call('Input.insertText', { text: value })
  assert.equal(await ctx.probe.cdp.evaluate(`document.querySelector(${quoted(taskSurface + ' [aria-label=' + quoted(label) + ']')}).value`), value)
}
async function asset(ctx) { return (await current(ctx)).assets.find(item => item.id === ctx.receipt.taskAssets.assetId) }
async function run(ctx) { return (await current(ctx)).runs.find(item => item.id === ctx.receipt.taskAssets.runId) }
async function selectVersion(ctx, version) {
  const selector=taskSurface+' [aria-label="Task asset version"]'
  const read=()=>ctx.probe.cdp.evaluate(`(()=>{const select=document.querySelector(${quoted(selector)});if(!select)throw new Error('The actual task version control is missing');return {value:select.value,focused:document.activeElement===select,options:Array.from(select.options).map(option=>option.value),changes:globalThis.__privateTaskVersionChanges??[]}})()`)
  const key=async(key,code,windowsVirtualKeyCode)=>{for(const type of ['keyDown','keyUp'])await ctx.probe.cdp.call('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode})}
  await ctx.probe.cdp.evaluate(`(()=>{globalThis.__privateTaskVersionChanges=[];const select=document.querySelector(${quoted(selector)});select.addEventListener('change',event=>{globalThis.__privateTaskVersionChanges.push({trusted:event.isTrusted,value:select.value});},{once:true});return true})()`)
  let observation=await read()
  const evidence={before:observation,focusInput:'trusted Tab navigation to closed native select; no mouse popup or DOM focus/value assignment',keys:[]}
  ctx.receipt.taskAssets.versionSelection=evidence
  for(let count=0;!observation.focused&&count<80;count++){await key('Tab','Tab',9);evidence.keys.push('Tab');observation=await read()}
  assert.equal(observation.focused,true,'Real keyboard navigation must reach the actual version control')
  const wanted=observation.options.indexOf(String(version))
  assert.ok(wanted>=0,'The requested real version option must exist')
  for(let count=0;observation.value!==String(version)&&count<observation.options.length;count++){
    const direction=observation.options.indexOf(observation.value)>wanted?'ArrowUp':'ArrowDown'
    await key(direction,direction,direction==='ArrowUp'?38:40);evidence.keys.push(direction);observation=await read()
  }
  evidence.after=observation
  assert.equal(observation.value,String(version),'Closed-select real arrow input must change the actual selected version')
  if(evidence.before.value!==String(version)){assert.ok(observation.changes.length>0,'Selection must produce a real change');assert.equal(observation.changes[0].trusted,true,'Native selection change must be trusted')}
}
async function pageCount(ctx) { return ctx.nativePageScript(ctx.probe, 'globalThis.assetButtonCount') }
async function persistent(ctx, secret) {
  const files = ['browser-task-assets.json', 'browser-operation-journal.json', 'browser-demonstration-drafts.json']
  for (const name of files) {
    const text = await readFile(join(ctx.userData, name), 'utf8')
    assert.ok(text.length > 0)
    for (const spelling of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert.equal(text.includes(spelling), false, `${name} retained a temporary parameter`)
  }
  return files
}

async function observeWaiting(ctx, waiting, selectedVersion) {
  ctx.setPhase('task-assets-current-checkpoint-projection')
  const statusSelector=`.browser-operation-status[data-task-run-id="${waiting.id}"]`
  const observation=await ctx.waitFor('current waiting task projected into its actual top status and editor',()=>ctx.probe.cdp.evaluate(`(()=>{const surface=document.querySelector(${quoted(taskSurface)}),status=document.querySelector(${quoted(statusSelector)}),progress=surface?.querySelector('.browser-task-asset__progress'),raw=document.querySelector('.browser-demonstration__steps');if(!surface||!status||!progress||!raw||surface.querySelector('[aria-label="Task asset version"]')?.value!==${quoted(String(selectedVersion))})return null;const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return {phase:status.dataset.phase,runId:status.dataset.taskRunId,version:status.dataset.taskVersion,aria:status.querySelector('button')?.getAttribute('aria-label'),insideToolbar:!!status.closest('.browser-toolbar'),statusBounds:rect(status),progress:{runId:progress.dataset.runId,status:progress.dataset.runStatus,version:progress.dataset.runVersion,text:progress.textContent,bounds:rect(progress),beforeName:!!(progress.compareDocumentPosition(surface.querySelector('[aria-label="Task asset name"]'))&Node.DOCUMENT_POSITION_FOLLOWING)},selectedVersion:surface.querySelector('[aria-label="Task asset version"]')?.value,raw:{open:raw.open,count:raw.querySelectorAll('[data-sequence]').length,visibleSteps:Array.from(raw.querySelectorAll('[data-sequence]')).filter(element=>element.checkVisibility()).length,checks:Array.from(raw.querySelectorAll('[data-sequence]')).map(element=>({sequence:element.dataset.sequence,visible:element.checkVisibility(),layoutBoxes:element.getClientRects().length})),innerText:raw.innerText,summary:raw.querySelector('summary')?.getAttribute('aria-label')},recordOutside:!document.querySelector('[aria-label="Start recording demonstration"]')?.closest('.browser-demonstration__steps')}})()`))
  ctx.receipt.taskAssets.lastWaitingObservation=observation
  try {
  assert.equal(observation.phase,'human','A completed step cannot label a waiting task completed')
  assert.equal(observation.runId,waiting.id);assert.equal(observation.version,String(waiting.version));assert.equal(observation.insideToolbar,true)
  assert.match(observation.aria,/Waiting for human checkpoint/);assert.ok(observation.aria.includes(`v${waiting.version}`))
  assert.ok(observation.statusBounds.width>0&&observation.statusBounds.height>0)
  assert.equal(observation.progress.runId,waiting.id);assert.equal(observation.progress.status,'waiting-human')
  assert.equal(observation.progress.version,String(waiting.version));assert.equal(observation.progress.beforeName,true)
  assert.equal(observation.selectedVersion,String(selectedVersion),'The editor selection and actual running version are separate explicit facts')
  assert.equal(observation.raw.open,false);assert.equal(observation.raw.visibleSteps,0)
  assert.equal(observation.raw.count,ctx.receipt.demonstration.stopped.steps.length,'Collapsing the recorded draft does not discard its steps')
  assert.equal(observation.raw.summary,'Recorded demonstration steps');assert.equal(observation.recordOutside,true)
  } catch(error) {
    try {await ctx.capture(ctx.probe,'failed-checkpoint-projection','task-assets')}
    catch(captureError) {ctx.receipt.taskAssets.failedCheckpointCaptureError=captureError.message}
    throw error
  }
  return observation
}

export async function reviewTaskAssets(ctx) {
  await reviewDemonstration(ctx)
  const { probe, waitFor, receipt } = ctx
  assert.deepEqual((await current(ctx)).assets, [])
  await probe.cdp.evaluate(`Array.from(document.querySelectorAll(${quoted(taskSurface + ' button')})).find(e=>e.textContent.trim()==='Edit demonstration').click()`)
  assert.deepEqual((await current(ctx)).assets, [], 'A script click cannot impersonate the person importing a task')
  await ctx.click(probe.cdp, button(ctx, 'Edit demonstration'))
  const imported = await waitFor('actual recorded task imported through its UI', async () => (await current(ctx)).assets[0] ?? null)
  assert.equal(imported.sourceRecordingId, receipt.demonstration.stopped.id)
  assert.ok(imported.draft.steps.length > 2)
  const first = imported.draft.steps.find(step => step.kind === 'click' && step.target?.name === 'Continue')
  const fill = imported.draft.steps.find(step => step.kind === 'fill' && step.target?.name === 'Name')
  assert.ok(first && fill)
  assert.ok(imported.draft.steps.some(step => !step.target && step.kind !== 'navigate'), 'The real ambiguous recording remains blocked')
  receipt.taskAssets = { assetId: imported.id, imported, physicalDeviceTested: false, syntheticImportRejected: true }
  const retained = new Set([first.id, fill.id])
  for (let index = imported.draft.steps.length - 1; index >= 0; index--) if (!retained.has(imported.draft.steps[index].id)) {
    await ctx.click(probe.cdp, ctx.selectors(`${taskSurface} [aria-label="Delete task step ${index + 1}"]`))
  }
  for (const index of [1, 2]) await ctx.click(probe.cdp, field(ctx, `Review task step ${index}`))
  await type(ctx, 'Task asset name', 'Reviewed native demonstration')
  await ctx.click(probe.cdp, ctx.selectors(`${taskSurface} [aria-label="Insert checkpoint after task step 1"]`))
  await type(ctx, 'Checkpoint 2 label', 'Inspect the page before the fresh input')
  await ctx.click(probe.cdp, `${ctx.selectors(taskSurface + ' summary')}.filter(e=>e.textContent.startsWith('Parameter definitions'))`)
  await type(ctx, 'Parameter 1 key', 'freshName')
  await type(ctx, 'Parameter 1 label', 'Fresh name')
  await ctx.click(probe.cdp, button(ctx, 'Save version'))
  const saved = await waitFor('actual edited immutable task version', async () => { const item = await asset(ctx); return item?.versions.length === 1 ? item : null })
  const version = saved.versions[0]
  assert.deepEqual(version.steps.map(step => step.kind), ['click', 'checkpoint', 'fill'])
  assert.deepEqual(version.steps.filter(step => step.kind !== 'checkpoint').map(step => step.id), [first.id, fill.id])
  assert.deepEqual(version.parameters, [{ key: 'freshName', label: 'Fresh name', secret: true }])
  assert.equal(version.steps[2].parameterKey, 'freshName')
  await ctx.click(probe.cdp, `${ctx.selectors(taskSurface + ' summary')}.filter(e=>e.textContent.startsWith('Preview v1'))`)
  assert.equal(await probe.cdp.evaluate(`Array.from(document.querySelectorAll(${quoted(taskSurface + ' details')})).find(e=>e.querySelector('summary')?.textContent.startsWith('Preview v1')).querySelectorAll('li').length`), 3)
  await ctx.click(probe.cdp, `${ctx.selectors(taskSurface + ' summary')}.filter(e=>e.textContent.startsWith('Preview v1'))`)
  assert.equal(await probe.cdp.evaluate(`document.querySelector(${quoted(taskSurface + ' [aria-label="Task parameter Fresh name"]')})===null`), true, 'A later checkpoint segment is not demanded before the first action')
  await ctx.nativePageScript(probe, 'globalThis.assetButtonCount=0;document.querySelector("#demo-click").addEventListener("click",()=>globalThis.assetButtonCount++);null')
  await probe.cdp.evaluate(`Array.from(document.querySelectorAll(${quoted(taskSurface + ' button')})).find(e=>e.textContent.trim()==='Run version').click()`)
  assert.deepEqual((await current(ctx)).runs, [], 'A script click cannot start the saved task')
  await ctx.click(probe.cdp, button(ctx, 'Run next step'))
  const singleStep = await waitFor('actual single step exposes its retained cursor', async () => (await current(ctx)).runs.find(item => item.assetId === imported.id && item.status === 'ready' && item.nextStep === 1) ?? null)
  assert.equal(singleStep.operationIds.length, 1); assert.equal(await pageCount(ctx), 1)
  await ctx.click(probe.cdp, button(ctx, 'Return control and continue'))
  const waiting = await waitFor('actual task yields at its human checkpoint', async () => (await current(ctx)).runs.find(item => item.id === singleStep.id && item.status === 'waiting-human') ?? null)
  assert.equal(waiting.version, 1); assert.equal(waiting.nextStep, 2); assert.equal(waiting.operationIds.length, 1)
  assert.equal(await pageCount(ctx), 1)
  receipt.taskAssets.runId = waiting.id; receipt.taskAssets.version = version; receipt.taskAssets.waiting = waiting
  receipt.taskAssets.singleStep = singleStep
  receipt.taskAssets.syntheticRunRejected = true
  for (const [label, width, height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]) {
    await ctx.resize(probe, width, height)
    receipt.taskAssets.waitingProjection??=[]
    receipt.taskAssets.waitingProjection.push({label,...await observeWaiting(ctx,waiting,1)})
    await ctx.capture(probe, `${label}-task-asset-human-checkpoint`, 'task-assets')
  }
  await ctx.resize(probe,1440,900)
  // Deleting and saving a later draft is a real UI edit. It cannot alter the version already running.
  await type(ctx, 'Task asset name', 'Later draft with the first step deleted')
  await ctx.click(probe.cdp, ctx.selectors(`${taskSurface} [aria-label="Delete task step 1"]`))
  await ctx.click(probe.cdp, ctx.selectors(`${taskSurface} .browser-task-asset__parameters input[type="checkbox"]`))
  await ctx.click(probe.cdp, button(ctx, 'Save version'))
  const edited = await waitFor('second immutable version after the UI deletion', async () => { const item = await asset(ctx); return item?.versions.length === 2 ? item : null })
  assert.deepEqual(edited.versions[0], version)
  assert.deepEqual(edited.versions[1].steps.map(step => step.kind), ['checkpoint', 'fill'])
  assert.equal(edited.versions[1].parameters[0].secret, false)
  assert.deepEqual((await run(ctx)), waiting)
  receipt.taskAssets.savedBeforeRestart = edited
  receipt.taskAssets.deletedStepStayedDeleted = true
  receipt.taskAssets.immutableVersionPreserved = true
  receipt.taskAssets.editingV2WhileWaitingV1=await observeWaiting(ctx,waiting,2)
  await ctx.capture(probe,'normal-task-asset-v2-editing-v1-waiting','task-assets')
  await ctx.click(probe.cdp,ctx.selectors('.browser-operation-status__trigger'))
  await ctx.click(probe.cdp,ctx.selectors('[aria-label="Review and continue task v1"]'))
  await waitFor('view-only task entry selects the real waiting version',()=>probe.cdp.evaluate(`document.querySelector(${quoted(taskSurface+' [aria-label="Task asset version"]')})?.value==='1'`))
  assert.deepEqual(await run(ctx),waiting,'Reviewing a checkpoint cannot approve or execute it')
  assert.equal(await pageCount(ctx),1)
  assert.deepEqual(await asset(ctx),edited,'A view-only entry cannot rewrite immutable versions or the editable draft')
  receipt.taskAssets.viewOnlyCheckpointEntry=true
}

export async function recoverTaskAssets(ctx) {
  const { probe, waitFor, receipt } = ctx
  const restored = await waitFor('task asset and waiting cursor restored after ordinary restart', async () => { const state = await current(ctx); return state.assets.find(item => item.id === receipt.taskAssets.assetId) && state.runs.find(item => item.id === receipt.taskAssets.runId)?.status === 'waiting-human' ? state : null })
  assert.deepEqual(restored.assets.find(item => item.id === receipt.taskAssets.assetId), receipt.taskAssets.savedBeforeRestart)
  assert.deepEqual(restored.runs.find(item => item.id === receipt.taskAssets.runId), receipt.taskAssets.waiting)
  await ctx.nativePageScript(probe, 'globalThis.assetButtonCount=0;document.querySelector("#demo-click").addEventListener("click",()=>globalThis.assetButtonCount++);null')
  await ctx.click(probe.cdp, `${ctx.selectors('[aria-label="More browser tools"]')}.filter(e=>e.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value===${quoted(ctx.pageUrl)})`)
  await ctx.click(probe.cdp, ctx.selectors('[aria-label="Open human demonstration draft"]'))
  receipt.taskAssets.restoredWaitingProjection=await observeWaiting(ctx,receipt.taskAssets.waiting,2)
  await selectVersion(ctx, 1)
  assert.equal(await probe.cdp.evaluate(`document.querySelector(${quoted(taskSurface + ' [aria-label="Task parameter Fresh name"]')}).value`), '')
  const secret = 'fresh-native-asset-"one-use\\value'
  await type(ctx, 'Task parameter Fresh name', secret)
  await probe.cdp.evaluate(`Array.from(document.querySelectorAll(${quoted(taskSurface + ' button')})).find(e=>e.textContent.trim()==='Return control and continue').click()`)
  assert.deepEqual(await run(ctx), receipt.taskAssets.waiting, 'Synthetic continuation cannot confirm the checkpoint')
  await type(ctx, 'Task parameter Fresh name', secret)
  await ctx.click(probe.cdp, button(ctx, 'Return control and continue'))
  const completed = await waitFor('same version continues only after the real human action', async () => { const item = await run(ctx); return item?.status === 'completed' ? item : null })
  assert.equal(completed.version, 1); assert.equal(completed.nextStep, 3); assert.equal(completed.operationIds.length, 2)
  assert.equal(completed.operationIds[0], receipt.taskAssets.waiting.operationIds[0])
  assert.equal(await pageCount(ctx), 0, 'Completed steps must not be replayed after restart')
  assert.equal(await ctx.nativePageScript(probe, 'document.querySelector("#demo-input").value'), secret)
  await waitFor('temporary secret cleared from the real Editor', () => probe.cdp.evaluate(`document.querySelector(${quoted(taskSurface + ' [aria-label="Task parameter Fresh name"]')}).value===''`))
  receipt.taskAssets.secretAbsentFrom = await persistent(ctx, secret)
  receipt.taskAssets.syntheticContinueRejected = true
  receipt.taskAssets.completed = completed
  receipt.taskAssets.complete = true
  await ctx.capture(probe, 'normal-task-asset-completed-after-restart', 'task-assets')
}
