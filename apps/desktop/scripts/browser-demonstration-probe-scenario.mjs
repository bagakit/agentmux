import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Scenario-only hooks into the existing product harness: no launch, Store seed or cleanup owner.
export const demonstrationFixture = '<button id="demo-click">Continue</button><label for="demo-input">Name</label><input id="demo-input" type="text"><button id="demo-duplicate">Repeat</button><button>Repeat</button><a id="demo-navigation" href="#destination">Next section</a><p id="destination">Destination</p><script>globalThis.demoTrusted={click:0,input:0};for(const type of ["click","input"])document.addEventListener(type,event=>{if(event.isTrusted)globalThis.demoTrusted[type]++},true)</script>'

async function native(ctx, selector, value) {
  const { probe, desktopRoot, pageUrl } = ctx
  const result = await probe.main.evaluate(`(async()=>{
    const {app,BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron');
    const window=BrowserWindow.getAllWindows()[0],views=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().split('#')[0]===${JSON.stringify(pageUrl)});
    if(views.length!==1)throw new Error('The actual private native Browser owner is not unique');
    const view=views[0],bounds=view.getBounds(),contents=view.webContents;
    if(!window.isVisible()||window.isMinimized()||!view.getVisible()||bounds.width<=0||bounds.height<=0)throw new Error('Native input requires a visible actual Browser');
    app.focus({steal:true});window.focus();contents.focus();const deadline=Date.now()+2000;
    while(!window.isFocused()&&Date.now()<deadline)await new Promise(done=>setTimeout(done,30));
    if(!window.isFocused())throw new Error('Native input requires the actual BrowserWindow focused');
    const before=await contents.executeJavaScript('({...globalThis.demoTrusted})');
    const point=await contents.executeJavaScript(${JSON.stringify(`(()=>{const matches=document.querySelectorAll(${JSON.stringify(selector)});if(matches.length!==1)throw new Error('Native fixture target must be unique');const r=matches[0].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)});
    if(point.x<0||point.y<0||point.x>=bounds.width||point.y>=bounds.height)throw new Error('Native fixture target is outside its actual page bounds');
    const types=[],listener=(_event,input)=>types.push(input.type);contents.on('input-event',listener);
    try{
      for(const type of ['mouseDown','mouseUp'])contents.sendInputEvent({type,button:'left',clickCount:1,...point});
      ${value === undefined ? '' : `for(const keyCode of ${JSON.stringify(value)})contents.sendInputEvent({type:'char',keyCode});`}
      await new Promise(done=>setTimeout(done,100));
      const after=await contents.executeJavaScript('({...globalThis.demoTrusted})');
      return {before,after,types,windowFocused:window.isFocused(),pageFocused:contents.isFocused(),bounds};
    }finally{contents.removeListener('input-event',listener)}
  })()`)
  assert.ok(result.after.click > result.before.click, 'Real native input must reach a trusted page click')
  assert.ok(result.types.includes('mouseUp'), 'Native Electron input must be observed by the actual owner')
  if (value !== undefined) {
    assert.ok(result.after.input > result.before.input, 'Native typing must reach the trusted input path')
    assert.ok(result.types.includes('char'))
  }
  return result
}
async function current(ctx) { return ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${JSON.stringify(ctx.browserId)})`) }
function owned(ctx, selector) {
  return `${ctx.selectors(selector)}.filter(element=>element.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${JSON.stringify(ctx.pageUrl)})`
}
async function open(ctx) {
  const { probe, click, selectors } = ctx
  if (!await probe.cdp.evaluate('Boolean(document.querySelector("[aria-label=\"Human demonstration draft\"]"))')) {
    await click(probe.cdp, owned(ctx, '[aria-label="More browser tools"]'))
    await click(probe.cdp, selectors('[aria-label="Open human demonstration draft"]'))
  }
}

export async function reviewDemonstration(ctx) {
  const { probe, click, selectors, waitFor, nativePageScript, capture, resize, receipt, userData } = ctx
  const observed = { physicalDeviceTested: false, inputSource: 'Electron native sendInputEvent after real visible/focused owner checks; no page script is treated as human', native: [] }
  await open(ctx)
  const initial = await current(ctx)
  assert.equal(initial.draft, null)
  // Renderer .click has isTrusted=false and must not open a recording, even at a trusted origin.
  await probe.cdp.evaluate('document.querySelector("[aria-label=\"Start recording demonstration\"]").click()')
  assert.equal((await current(ctx)).draft, null)
  await click(probe.cdp, selectors('[aria-label="Start recording demonstration"]'))
  let started = await waitFor('actual toolbar-created recording', async () => { const state = await current(ctx); return state.draft?.status === 'recording' ? state : null })
  assert.ok(started.draft.id)
  await nativePageScript(probe, 'document.querySelector("#demo-click").click();null')
  assert.deepEqual((await current(ctx)).draft.steps, [])
  // Agent run takes the mature CDP owner synchronously and stops the explicit recording.
  const beforeAgent = started.draft
  const report = await probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(ctx.browserId)},'return await pageInfo();',{id:'private-demonstration-agent',name:'Private demonstration Agent'})`)
  assert.equal(report.outcome.kind, 'completed')
  const released = (await current(ctx)).draft
  assert.equal(released.id, beforeAgent.id); assert.equal(released.status, 'stopped'); assert.deepEqual(released.steps, [])
  observed.healthyAgentRun = report.runOperation; observed.agentReleasedRecording = released
  await click(probe.cdp, selectors('[aria-label="Start recording demonstration"]'))
  started = await waitFor('new explicit recording after healthy Agent run', async () => { const state = await current(ctx); return state.draft?.status === 'recording' && state.draft.id !== beforeAgent.id ? state : null })
  observed.native.push(await native(ctx, '#demo-click'))
  const clicked = await waitFor('actual native click draft with verified AX target', async () => { const state = await current(ctx); return state.draft.steps.length ? state : null })
  assert.deepEqual(clicked.draft.steps[0].target, { role: 'button', name: 'Continue', ordinal: 1, count: 1 })
  const beforeSynthetic = clicked.draft.steps.length
  await nativePageScript(probe, 'document.querySelector("#demo-click").click();document.querySelector("#demo-input").dispatchEvent(new Event("input",{bubbles:true}));null')
  await new Promise(done => setTimeout(done, 70))
  assert.equal((await current(ctx)).draft.steps.length, beforeSynthetic)
  observed.native.push(await native(ctx, '#demo-input', 'one-use-native-secret'))
  const filled = await waitFor('actual native fill parameter without a recorded value', async () => { const state = await current(ctx); return state.draft.steps.some(step => step.method === 'fillInput') ? state : null })
  const fill = filled.draft.steps.find(step => step.method === 'fillInput')
  assert.ok(fill.inputKey); assert.deepEqual(fill.args, []); assert.equal(fill.target.name, 'Name')
  observed.native.push(await native(ctx, '#demo-duplicate'))
  const blocked = await waitFor('actual ambiguous target remains blocked', async () => { const state = await current(ctx); return state.draft.steps.at(-1)?.target === undefined && state.draft.steps.at(-1)?.method === 'click' ? state : null })
  assert.match(blocked.draft.steps.at(-1).blockedReason, /could not be verified/)
  observed.native.push(await native(ctx, '#demo-navigation'))
  const navigated = await waitFor('actual page navigation retains uncertain provenance', async () => { const state = await current(ctx); return state.draft.steps.at(-1)?.method === 'gotoUrl' ? state : null })
  assert.equal(navigated.draft.steps.at(-1).source, 'navigation')
  assert.equal(navigated.draft.steps.at(-1).url, ctx.pageUrl)
  assert.match(navigated.draft.steps.at(-1).blockedReason, /Navigation|URL|destination/)
  for (const [size, width, height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]) {
    await resize(probe, width, height)
    await capture(probe, `${size}-demonstration-recorded-steps`)
  }
  await resize(probe,1440,900)
  await probe.cdp.evaluate('document.querySelector("[aria-label=\"Stop recording demonstration\"]").click()')
  assert.equal((await current(ctx)).draft.status, 'recording', 'Synthetic stop cannot impersonate the person')
  await click(probe.cdp, selectors('[aria-label="Stop recording demonstration"]'))
  const stopped = await waitFor('real toolbar stops the actual recorder', async () => { const state = await current(ctx); return state.draft.status === 'stopped' ? state : null })
  const disk = await readFile(join(userData, 'browser-demonstration-drafts.json'), 'utf8')
  assert.equal(disk.includes('one-use-native-secret'), false)
  observed.native.push(await native(ctx, '#demo-click'))
  assert.deepEqual((await current(ctx)).draft, stopped.draft, 'Stopped recording must not capture later native input')
  await click(probe.cdp, owned(ctx, '[aria-label="Back"]'))
  await waitFor('original Browser URL restored by its real toolbar', () => probe.cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Browser address"]')).some(input=>input.value===${JSON.stringify(ctx.pageUrl)})`))
  observed.stopped = stopped.draft
  observed.syntheticStartRejected = true; observed.syntheticStopRejected = true; observed.valueNotRetained = true
  receipt.demonstration = observed
}

export async function startInterruptedDemonstration(ctx) {
  await open(ctx)
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Start recording demonstration"]'))
  const state = await ctx.waitFor('actual active recording at ordinary quit', async () => { const state = await current(ctx); return state.draft?.status === 'recording' ? state : null })
  ctx.receipt.demonstration.activeAtQuit = state.draft
}

export async function recoverDemonstration(ctx) {
  const { receipt, probe, waitFor } = ctx
  const expected = receipt.demonstration.activeAtQuit
  const restored = await waitFor('actual interrupted recording after ordinary restart', async () => { const state = await current(ctx); return state.draft?.id === expected.id && state.draft.status === 'interrupted' ? state : null })
  assert.deepEqual(restored.draft.steps, expected.steps)
  assert.match(restored.draft.warning, /restart/)
  const document = JSON.parse(await readFile(join(ctx.userData, 'browser-demonstration-drafts.json'), 'utf8'))
  assert.deepEqual(document.drafts.find(draft => draft.id === receipt.demonstration.stopped.id), receipt.demonstration.stopped)
  const nativeState = await probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron');const views=BrowserWindow.getAllWindows()[0].contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===${JSON.stringify(ctx.pageUrl)});if(views.length!==1)throw new Error('Restored Browser owner must be unique');return {attached:views[0].webContents.debugger.isAttached(),visible:views[0].getVisible()}})()`)
  assert.equal(nativeState.attached, false); assert.equal(nativeState.visible, true)
  await native(ctx, '#demo-click')
  assert.deepEqual((await current(ctx)).draft, restored.draft, 'Restart must not automatically resume capture')
  await open(ctx)
  assert.ok(await probe.cdp.evaluate('document.querySelector("[aria-label=\"Human demonstration draft\"]").textContent.includes("Interrupted")'))
  receipt.demonstration.restored = restored.draft
  receipt.demonstration.nativeStateAfterRestart = nativeState
  receipt.demonstration.noAutomaticRecording = true
  receipt.demonstration.complete = true
}
