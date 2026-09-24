import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reviewDemonstration } from './browser-demonstration-probe-scenario.mjs'
import { publicFacts } from './browser-outcome-probe-scenario.mjs'

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
async function verifyTaskEvidence(ctx, expected) {
  const before = await run(ctx)
  assert.ok(before.operationIds.length > 0, 'Completion consumes a nonempty actual producer identity')
  await ctx.click(ctx.probe.cdp, button(ctx, 'Verify task evidence'))
  await ctx.waitFor('actual task completion projection', () => ctx.probe.cdp.evaluate(`document.querySelector('[data-task-completion]')?.dataset.taskCompletion===${quoted(expected)}`))
  const document = JSON.parse(await readFile(join(ctx.userData, 'browser-operation-journal.json'), 'utf8'))
  const original = document.operations.find(item => item.id === before.operationIds[0])
  assert.equal(original.outcome.evaluation.status, expected)
  assert.deepEqual(original.outcome.registration.assetRun, { runId: before.id, assetId: before.assetId, version: before.version })
  assert.deepEqual(original.outcome.evaluation.conditions.map(item => item.status), [expected])
  const facts = await publicFacts(ctx, original)
  assert.deepEqual(await run(ctx), before, 'Read-only verification cannot advance or replay the task')
  ;(ctx.receipt.taskAssets.completionChecks ??= []).push({ expected, operationId: original.id, evaluation: original.outcome.evaluation, public: facts })
}
async function selectVersion(ctx, version) {
  const selector = taskSurface + ' [aria-label="Task asset version"]'
  const read = () => ctx.probe.cdp.evaluate(`(()=>{const select=document.querySelector(${quoted(selector)});if(!select)throw new Error('The actual task version control is missing');const events=globalThis.__privateTaskVersionEvents??[];return {value:select.value,focused:document.activeElement===select,documentFocused:document.hasFocus(),options:Array.from(select.options).map(option=>({value:option.value,label:option.label.trimStart(),disabled:option.disabled})),events,changes:events.filter(event=>event.type==='change')}})()`)
  const evidence = { focusInput: 'trusted Tab navigation and actual option-label keyboard typeahead; no popup-opening input, DOM focus/value assignment or product callback', keys: [], inputs: [] }
  ctx.receipt.taskAssets.versionSelection = evidence
  const send = async input => {
    evidence.inputs.push({ ...input })
    await ctx.probe.cdp.call('Input.dispatchKeyEvent', input)
  }
  await ctx.probe.cdp.evaluate(`(()=>{globalThis.__privateTaskVersionCleanup?.();globalThis.__privateTaskVersionEvents=[];const select=document.querySelector(${quoted(selector)});const types=['keydown','keypress','input','change'];const record=event=>{const events=globalThis.__privateTaskVersionEvents;if(events.length<256)events.push({type:event.type,key:event.key??null,trusted:event.isTrusted,value:select.value})};for(const type of types)select.addEventListener(type,record);globalThis.__privateTaskVersionCleanup=()=>{for(const type of types)select.removeEventListener(type,record);delete globalThis.__privateTaskVersionCleanup};return true})()`)
  try {
    let observation = await read()
    evidence.before = observation
    for (let count = 0; !observation.focused && count < 80; count++) {
      for (const type of ['keyDown', 'keyUp']) await send({ type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      evidence.keys.push('Tab')
      observation = await read()
      evidence.after = observation
    }
    assert.equal(observation.focused, true, 'Real keyboard navigation must reach the actual version control')
    assert.ok(observation.options.length > 0, 'Actual version options must be nonempty')
    const target = observation.options.find(option => option.value === String(version) && !option.disabled)
    assert.ok(target, 'The requested real enabled version option must exist')
    if (observation.value === String(version)) { evidence.after = observation; return }
    // Native selects support printable keypress prefix matching. On macOS, arrows
    // open a native popup instead of committing a closed select's value.
    let prefix = ''
    for (let length = 1; length <= Math.min(64, target.label.length); length++) {
      const candidate = target.label.slice(0, length)
      if (!/^[ -~]+$/.test(candidate)) break
      const matches = observation.options.filter(option => !option.disabled && option.label.toLowerCase().startsWith(candidate.toLowerCase()))
      if (matches.length === 1) { prefix = candidate; break }
    }
    assert.ok(prefix, 'The actual option label needs a unique bounded printable prefix')
    evidence.prefix = prefix
    evidence.selectionStartedAt = Date.now()
    for (const character of prefix) {
      await send({ type: 'rawKeyDown', key: character })
      await send({ type: 'char', key: character, text: character, unmodifiedText: character })
      await send({ type: 'keyUp', key: character })
      evidence.keys.push(character)
    }
    observation = await ctx.waitFor('actual version value and trusted selection change', async () => {
      const next = await read()
      evidence.after = next
      return next.value === String(version) && next.changes.some(event => event.trusted && event.value === String(version)) ? next : null
    })
    evidence.selectionElapsedMs = Date.now() - evidence.selectionStartedAt
    assert.equal(observation.value, String(version), 'Real label keyboard input must change the actual selected version')
    assert.ok(observation.changes.length > 0, 'Selection must produce a real change')
    assert.ok(observation.changes.some(event => event.trusted && event.value === String(version)), 'The actual target selection change must be trusted')
  } finally {
    await ctx.probe.cdp.evaluate('globalThis.__privateTaskVersionCleanup?.(); true')
  }
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
  await ctx.click(probe.cdp, `${ctx.selectors(taskSurface + ' summary')}.filter(e=>e.textContent.startsWith('Completion conditions'))`)
  await ctx.click(probe.cdp, ctx.selectors(`${taskSurface} [aria-label^="Require checkpoint "]`))
  await ctx.click(probe.cdp, `${ctx.selectors(taskSurface + ' summary')}.filter(e=>e.textContent.startsWith('Completion conditions'))`)
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
  assert.deepEqual(version.completion.criteria, [{ kind: 'human-checkpoint', checkpointId: version.steps[1].id }])
  await verifyTaskEvidence(ctx, 'not-met')
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
  // Editing a later version explicitly removes its condition; the executing v1 keeps its declaration.
  await ctx.click(probe.cdp, `${ctx.selectors(taskSurface + ' summary')}.filter(e=>e.textContent.startsWith('Completion conditions'))`)
  await ctx.click(probe.cdp, ctx.selectors(`${taskSurface} [aria-label^="Require checkpoint "]`))
  await ctx.click(probe.cdp, `${ctx.selectors(taskSurface + ' summary')}.filter(e=>e.textContent.startsWith('Completion conditions'))`)
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
  await verifyTaskEvidence(ctx, 'not-met')
  assert.equal(await probe.cdp.evaluate(`document.querySelector(${quoted(taskSurface + ' [aria-label="Task parameter Fresh name"]')}).value`), '')
  const secret = 'fresh-native-asset-"one-use\\value'
  await type(ctx, 'Task parameter Fresh name', secret)
  await probe.cdp.evaluate(`Array.from(document.querySelectorAll(${quoted(taskSurface + ' button')})).find(e=>e.textContent.trim()==='Return control and continue').click()`)
  assert.deepEqual(await run(ctx), receipt.taskAssets.waiting, 'Synthetic continuation cannot confirm the checkpoint')
  await type(ctx, 'Task parameter Fresh name', secret)
  await probe.cdp.evaluate(`globalThis.__privateTaskCleanupSurface=document.querySelector(${quoted(taskSurface)});true`)
  await ctx.click(probe.cdp, button(ctx, 'Return control and continue'))
  const completed = await waitFor('same version continues only after the real human action', async () => { const item = await run(ctx); return item?.status === 'completed' ? item : null })
  assert.equal(completed.version, 1); assert.equal(completed.nextStep, 3); assert.equal(completed.operationIds.length, 2)
  assert.equal(completed.operationIds[0], receipt.taskAssets.waiting.operationIds[0])
  assert.equal(await pageCount(ctx), 0, 'Completed steps must not be replayed after restart')
  assert.equal(await ctx.nativePageScript(probe, 'document.querySelector("#demo-input").value'), secret)
  receipt.taskAssets.syntheticContinueRejected = true
  receipt.taskAssets.completed = completed
  await verifyTaskEvidence(ctx, 'passed')
  ctx.setPhase('task-assets-temporary-secret-disposal')
  try {
    const hidden = await waitFor('completed version projects its first segment without the later parameter', () => probe.cdp.evaluate(`(()=>{const surface=document.querySelector(${quoted(taskSurface)}),progress=surface?.querySelector('.browser-task-asset__progress');if(progress?.dataset.runStatus!=='completed')return null;return{sameEditorSurface:surface===globalThis.__privateTaskCleanupSurface,assetId:surface.dataset.taskAssetId,selectedVersion:surface.querySelector('[aria-label="Task asset version"]')?.value,inputPresent:!!surface.querySelector('[aria-label="Task parameter Fresh name"]')}})()`))
    receipt.taskAssets.completedParameterVisibility = hidden
    assert.equal(hidden.sameEditorSurface, true)
    assert.equal(hidden.assetId, receipt.taskAssets.assetId)
    assert.equal(hidden.selectedVersion, '1')
    assert.equal(hidden.inputPresent, false, 'Completed v1 does not ask for a parameter beyond its first checkpoint; absence alone does not prove clearing')
    const before = await asset(ctx)
    assert.deepEqual(before, receipt.taskAssets.savedBeforeRestart)
    assert.deepEqual(before.draft.steps.map(step => step.kind), ['checkpoint', 'fill'])
    assert.equal(before.draft.parameters[0].secret, false)
    // This real draft edit reveals the same key without executing anything or
    // using selectVersion/onReview, whose handlers would independently reset values.
    await ctx.click(probe.cdp, ctx.selectors(`${taskSurface} [aria-label="Delete task step 1"]`))
    await ctx.click(probe.cdp, button(ctx, 'Save version'))
    const revised = await waitFor('same asset saves a third version with only its reviewed fill', async () => {
      const item = await asset(ctx)
      return item?.versions.length === 3 ? item : null
    })
    assert.equal(revised.id, before.id)
    assert.ok(revised.revision > before.revision)
    assert.deepEqual(revised.versions.slice(0, 2), before.versions)
    assert.deepEqual(revised.versions[2].steps.map(step => step.kind), ['fill'])
    assert.equal(revised.versions[2].parameters[0].key, 'freshName')
    const revealed = await waitFor('same mounted Editor reveals the fresh parameter for the saved draft version', () => probe.cdp.evaluate(`(()=>{const surface=document.querySelector(${quoted(taskSurface)}),input=surface?.querySelector('[aria-label="Task parameter Fresh name"]');const save=Array.from(surface?.querySelectorAll('button')??[]).find(button=>button.textContent.trim()==='Save version');if(!input||!save||save.disabled||surface.querySelector('[aria-label="Task asset version"]')?.value!=='3')return null;return{sameEditorSurface:surface===globalThis.__privateTaskCleanupSurface,assetId:surface.dataset.taskAssetId,selectedVersion:'3',saveDisabled:save.disabled,input:{present:true,visible:input.checkVisibility(),empty:input.value==='',type:input.type},runButtons:Array.from(surface.querySelectorAll('button')).filter(button=>['Run version','Run next step'].includes(button.textContent.trim())).map(button=>({label:button.textContent.trim(),disabled:button.disabled}))}})()`))
    receipt.taskAssets.secretDisposal = { revealed, savedVersion: revised.versions[2] }
    assert.equal(revealed.sameEditorSurface, true)
    assert.equal(revealed.assetId, before.id)
    assert.equal(revealed.saveDisabled, false, 'Busy state cannot substitute for the missing-parameter action guard')
    assert.deepEqual(revealed.input, { present: true, visible: true, empty: true, type: 'text' }, 'The actual same-key field must be visible and empty, not absent or reset by a version-selection handler')
    assert.deepEqual(revealed.runButtons, [{ label: 'Run next step', disabled: true }, { label: 'Run version', disabled: true }], 'Both real actions require fresh input; v3 is never executed')
    assert.deepEqual(await run(ctx), completed, 'Saving the inspection draft cannot change the completed v1 cursor or its operation ids')
    assert.equal(await pageCount(ctx), 0)
    assert.equal(await ctx.nativePageScript(probe, 'document.querySelector("#demo-input").value'), secret)
    receipt.taskAssets.secretAbsentFrom = await persistent(ctx, secret)
  } finally {
    await probe.cdp.evaluate('delete globalThis.__privateTaskCleanupSurface;true')
  }
  receipt.taskAssets.complete = true
  await ctx.capture(probe, 'normal-task-asset-completed-after-restart', 'task-assets')
}
