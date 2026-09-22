import assert from 'node:assert/strict'
import { native } from './browser-demonstration-probe-scenario.mjs'

// A scenario in the sole existing private product harness, with genuine UI input.
export const browserToolsFixture = '<button id="tools-target">Review target</button><script>globalThis.demoTrusted={click:0,input:0};for(const type of ["click","input"])document.addEventListener(type,event=>{if(event.isTrusted){globalThis.demoTrusted[type]++;globalThis.demoTrusted.lastTarget=event.target.id}},true)</script>'

function panel(ctx, selector) { return `${ctx.selectors(selector)}.filter(element=>element.closest('.surface-tool-panel'))` }
async function type(ctx, selector, text) {
  await ctx.click(ctx.probe.cdp,ctx.selectors(selector))
  await ctx.probe.cdp.call('Input.insertText',{text})
}
async function config(ctx) { return ctx.probe.cdp.evaluate('window.agentmux.config.get()') }
async function profiles(ctx) { return ctx.probe.cdp.evaluate('window.agentmux.browser.listProfiles()') }
async function rows(ctx) {
  return ctx.probe.cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Browser annotations"] article')).map(element=>({text:element.textContent,stale:element.classList.contains('stale')}))`)
}
async function addAnnotation(ctx, note) {
  await ctx.click(ctx.probe.cdp,ctx.selectors('[aria-label="Select element"]'))
  await ctx.waitFor('actual element selection active',()=>ctx.probe.cdp.evaluate('Boolean(document.querySelector("[aria-label=\"Cancel element selection\"]"))'))
  const input = await native(ctx,'#tools-target')
  await ctx.waitFor('real selected element context',()=>ctx.probe.cdp.evaluate('Boolean(document.querySelector("[aria-label=\"Selected element context\"]"))'))
  await type(ctx,'[aria-label="Annotation note"]',note)
  await ctx.click(ctx.probe.cdp,`${ctx.selectors('button')}.filter(element=>element.textContent.trim()==='Add annotation')`)
  await ctx.waitFor('actual annotation projection after native selection',async()=>{const current=await rows(ctx);return current.some(row=>row.text.includes(note))?current:null})
  return input
}
async function captureTools(ctx,label) {
  const observed = await ctx.probe.cdp.evaluate(`(()=>{const dock=document.querySelector('.surface-tool-panel');if(!dock)throw new Error('Actual Browser Tools dock is required');return {text:dock.innerText,creates:Array.from(dock.querySelectorAll('[aria-label="New Browser"]')).filter(element=>element.getClientRects().length).length,profiles:dock.querySelectorAll('.browser-profiles__catalog article').length,annotations:dock.querySelectorAll('[aria-label="Browser annotations"] article').length,settingsOpen:dock.querySelector('details')?.open,active:document.activeElement?.getAttribute('aria-label')}})()`)
  assert.equal(observed.creates,1,'The actual tools dock has exactly one visible create action')
  assert.ok(observed.profiles>0&&observed.annotations>0,'Visual review must contain real nonempty Profile and annotation data')
  assert.doesNotMatch(observed.text,/Main-owned|Universal Pane|Open a browser tab/)
  ctx.receipt.browserTools.visual ??= []
  ctx.receipt.browserTools.visual.push({label,...observed})
  await ctx.capture(ctx.probe,label,'page')
}

export async function reviewBrowserTools(ctx) {
  const { probe,click,waitFor,receipt }=ctx
  receipt.browserTools={physicalDeviceTested:false,nativeInput:[]}
  const original=await profiles(ctx)
  assert.ok(original.length>0)
  const primary=original.find(profile=>profile.isDefault)
  assert.ok(primary)
  assert.equal(await probe.cdp.evaluate(`document.querySelector(${JSON.stringify('[aria-label='+JSON.stringify('Delete '+primary.label)+']')}).disabled`),true)
  await type(ctx,'[aria-label="New Browser Profile name"]','Review profile')
  await click(probe.cdp,panel(ctx,'[aria-label="Create Browser Profile"]'))
  const created=await waitFor('real durable UI-created Profile',async()=>{const current=await profiles(ctx);return current.find(profile=>profile.label==='Review profile')})
  assert.ok(created.id)
  // Check the real two-stage dangerous deletion, then cancel and retain the Profile for restart.
  await click(probe.cdp,panel(ctx,'[aria-label="Delete Review profile"]'))
  assert.match(await probe.cdp.evaluate('document.querySelector(".browser-profiles__delete-impact").textContent'),/permanently removed/)
  await click(probe.cdp,`${ctx.selectors('.browser-profiles__delete-confirm button')}.filter(element=>element.textContent==='Cancel')`)
  assert.ok((await profiles(ctx)).some(profile=>profile.id===created.id))
  const before=await config(ctx)
  await click(probe.cdp,panel(ctx,'[aria-label="Browser bar settings"]'))
  const checkbox=`${ctx.selectors('.browser-tools-preferences label')}.filter(element=>element.textContent.trim()==='Screenshot').map(element=>element.querySelector('input'))`
  assert.equal(await probe.cdp.evaluate(`(${checkbox})[0].checked`),true)
  await click(probe.cdp,checkbox)
  assert.equal((await config(ctx)).browser.toolbar.screenshot,true,'Changing the draft must not silently save')
  await click(probe.cdp,`${ctx.selectors('.browser-tools-preferences button')}.filter(element=>element.textContent.trim()==='Save Browser bar')`)
  const saved=await waitFor('actual explicit Browser bar save',async()=>{const current=await config(ctx);return current.browser.toolbar.screenshot===false?current:null})
  receipt.browserTools.profile=created;receipt.browserTools.preference={before:before.browser.toolbar,after:saved.browser.toolbar}
  await click(probe.cdp,panel(ctx,'[aria-label="Browser bar settings"]'))
  receipt.browserTools.nativeInput.push(await addAnnotation(ctx,'Review this field'))
  const first=await rows(ctx);assert.equal(first.length,1);assert.equal(first[0].stale,false)
  assert.equal(await probe.cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Browser annotations"] button')).find(element=>element.textContent.includes('Add to Composer')).disabled`),true,'No actual eligible Agent means handoff remains honestly disabled')
  receipt.browserTools.noAgentHandoffDisabled=true
  for (const [size,width,height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]) {
    await ctx.resize(probe,width,height);await captureTools(ctx,`${size}-browser-tools`)
  }
  await ctx.resize(probe,1440,900)
  await click(probe.cdp,ctx.selectors('[aria-label="Delete annotation"]'))
  assert.deepEqual(await rows(ctx),[])
  receipt.browserTools.nativeInput.push(await addAnnotation(ctx,'Clear this field'))
  assert.equal((await rows(ctx)).length,1)
  await click(probe.cdp,`${ctx.selectors('[aria-label="Browser annotations"] button')}.filter(element=>element.textContent==='Clear all')`)
  assert.deepEqual(await rows(ctx),[])
  receipt.browserTools.annotationDeleteAndClear=true
  receipt.browserTools.nativePageAfterReview=await ctx.nativePageScript(probe,'document.title')
  assert.ok(receipt.browserTools.nativePageAfterReview)
}

export async function recoverBrowserTools(ctx) {
  const expected=ctx.receipt.browserTools
  assert.deepEqual((await config(ctx)).browser.toolbar,expected.preference.after)
  assert.ok((await profiles(ctx)).some(profile=>profile.id===expected.profile.id&&profile.label===expected.profile.label))
  await ctx.click(ctx.probe.cdp,ctx.selectors('button[aria-label="Browser Tools"]'))
  assert.equal(await ctx.probe.cdp.evaluate('Array.from(document.querySelectorAll("[aria-label=\"New Browser\"]")).filter(element=>element.getClientRects().length).length'),1)
  expected.preferenceRestored=true;expected.profileRestored=true;expected.complete=true
}
