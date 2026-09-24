import assert from 'node:assert/strict'
import { native } from './browser-demonstration-probe-scenario.mjs'

// A scenario in the sole existing private product harness, with genuine UI input.
export const browserToolsFixture = '<button id="tools-target">Review target</button><label for="tools-input">Review notes</label><input id="tools-input"><script>globalThis.demoTrusted={click:0,input:0};for(const type of ["click","input"])document.addEventListener(type,event=>{if(event.isTrusted){globalThis.demoTrusted[type]++;globalThis.demoTrusted.lastTarget=event.target.id}},true)</script>'

function panel(ctx, selector) { return `${ctx.selectors(selector)}.filter(element=>element.closest('.global-search-surface'))` }
async function durableUi(ctx) { return ctx.probe.cdp.evaluate("JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state") }
export async function enterSearch(ctx) {
  await ctx.click(ctx.probe.cdp,ctx.selectors('[aria-label="Search: search and manage browsers"]'))
  await ctx.waitFor('actual Search management surface',()=>ctx.probe.cdp.evaluate('Boolean(document.querySelector(".global-search-surface:not([hidden]):not([inert])"))'))
  await ctx.waitFor('durable Search selection',async()=>{const state=await durableUi(ctx);return state.mainSurface==='search'?state:null})
}
export async function returnToSpace(ctx) {
  await ctx.click(ctx.probe.cdp,`${ctx.selectors('.global-search-context button')}.filter(element=>element.textContent.trim()==='Return to Space')`)
  await ctx.nativeFrameReady(ctx.pageUrl)
  await ctx.waitFor('durable return to the original workspace',async()=>{const state=await durableUi(ctx);return state.mainSurface==='workbench'?state:null})
  const parked=await ctx.probe.cdp.evaluate(`(()=>{const search=document.querySelector('.global-search-surface');if(!search)return null;const bounds=search.getBoundingClientRect();return{hidden:search.hidden,inert:search.inert,ariaHidden:search.getAttribute('aria-hidden'),width:bounds.width,height:bounds.height,containsFocus:search.contains(document.activeElement)}})()`)
  assert.deepEqual(parked,{hidden:true,inert:true,ariaHidden:'true',width:0,height:0,containsFocus:false},'Visited Search keeps drafts without visible or interactive geometry')
  ;(ctx.receipt.browserTools.searchParking??=[]).push(parked)
}
async function enterSearchFromBrowser(ctx) {
  const before=await durableUi(ctx)
  const owned=`${ctx.selectors('[aria-label="More browser tools"]')}.filter(element=>element.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value===${JSON.stringify(ctx.pageUrl)})`
  await ctx.click(ctx.probe.cdp,owned)
  await ctx.click(ctx.probe.cdp,ctx.selectors('[aria-label="Browser tools in Search"]'))
  await ctx.waitFor('More reaches the same Search surface',()=>ctx.probe.cdp.evaluate('Boolean(document.querySelector(".global-search-surface:not([hidden]):not([inert])"))'))
  const after=await ctx.waitFor('More durably selects Search',async()=>{const state=await durableUi(ctx);return state.mainSurface==='search'?state:null})
  assert.equal(after.mainSurface,'search')
  assert.equal(after.activeWorkspaceId,before.activeWorkspaceId)
  assert.deepEqual(after.restoredWorkbench,before.restoredWorkbench,'More preserves the existing Tabs, Regions, focus and split')
  ctx.receipt.browserTools.moreRoutesSameWorkspace=true
}
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
  await returnToSpace(ctx)
  await ctx.click(ctx.probe.cdp,ctx.selectors('[aria-label="Select element"]'))
  await ctx.waitFor('actual element selection active',()=>ctx.probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify('[aria-label="Cancel element selection"]')}))`))
  const input = await native(ctx,'#tools-target')
  await ctx.waitFor('real selected element context',()=>ctx.probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify('[aria-label="Selected element context"]')}))`))
  await type(ctx,'[aria-label="Annotation note"]',note)
  await ctx.click(ctx.probe.cdp,`${ctx.selectors('button')}.filter(element=>element.textContent.trim()==='Add annotation')`)
  await enterSearch(ctx)
  await ctx.waitFor('actual annotation projection after native selection',async()=>{const current=await rows(ctx);return current.some(row=>row.text.includes(note))?current:null})
  return input
}
async function captureTools(ctx,label) {
  const observed = await ctx.probe.cdp.evaluate(`(()=>{const dock=document.querySelector('.global-search-surface');if(!dock)throw new Error('Actual Search management surface is required');return {text:dock.innerText,creates:Array.from(dock.querySelectorAll('[aria-label="New Browser"]')).filter(element=>element.getClientRects().length).length,profiles:dock.querySelectorAll('.browser-profiles__catalog article').length,annotations:dock.querySelectorAll('[aria-label="Browser annotations"] article').length,settingsOpen:dock.querySelector('details')?.open,active:document.activeElement?.getAttribute('aria-label')}})()`)
  assert.equal(observed.creates,1,'The actual Search surface has exactly one visible create action')
  assert.ok(observed.profiles>0&&observed.annotations>0,'Visual review must contain real nonempty Profile and annotation data')
  assert.doesNotMatch(observed.text,/Main-owned|Universal Pane|Open a browser tab/)
  ctx.receipt.browserTools.visual ??= []
  ctx.receipt.browserTools.visual.push({label,...observed})
  await ctx.capture(ctx.probe,label,'search-tools')
}

export async function reviewBrowserTools(ctx) {
  const { probe,click,waitFor,receipt }=ctx
  receipt.browserTools={...receipt.browserTools,physicalDeviceTested:false,nativeInput:[]}
  await enterSearchFromBrowser(ctx)
  assert.equal(await probe.cdp.evaluate('document.querySelectorAll(".surface-tool-panel [aria-label=\"Browser Tools\"]").length'),0)
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
    await ctx.resize(probe,width,height);await captureTools(ctx,`${size}-search-browser-tools`)
    await click(probe.cdp,panel(ctx,'[aria-label="Browser bar settings"]'))
    await captureTools(ctx,`${size}-search-browser-settings`)
    await click(probe.cdp,panel(ctx,'[aria-label="Browser bar settings"]'))
  }
  await ctx.resize(probe,1440,900)
  await click(probe.cdp,ctx.selectors('[aria-label="Delete annotation"]'))
  assert.deepEqual(await rows(ctx),[])
  receipt.browserTools.nativeInput.push(await addAnnotation(ctx,'Clear this field'))
  assert.equal((await rows(ctx)).length,1)
  await click(probe.cdp,`${ctx.selectors('[aria-label="Browser annotations"] button')}.filter(element=>element.textContent==='Clear all')`)
  assert.deepEqual(await rows(ctx),[])
  receipt.browserTools.annotationDeleteAndClear=true
  await returnToSpace(ctx)
  receipt.browserTools.nativeInput.push(await native(ctx,'#tools-input','after-search'))
  await ctx.capture(probe,'normal-browser-after-search','page')
  receipt.browserTools.nativePageAfterReview=await ctx.nativePageScript(probe,'document.title')
  assert.ok(receipt.browserTools.nativePageAfterReview)
}

export async function recoverBrowserTools(ctx) {
  const expected=ctx.receipt.browserTools
  assert.deepEqual((await config(ctx)).browser.toolbar,expected.preference.after)
  assert.ok((await profiles(ctx)).some(profile=>profile.id===expected.profile.id&&profile.label===expected.profile.label))
  await enterSearch(ctx)
  assert.equal(await ctx.probe.cdp.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify('[aria-label="New Browser"]')})).filter(element=>element.getClientRects().length).length`),1)
  expected.preferenceRestored=true;expected.profileRestored=true;expected.complete=true
}


export async function prepareSearchRestart(ctx) {
  await enterSearch(ctx)
  const before=await durableUi(ctx)
  assert.equal(before.mainSurface,'search')
  assert.equal(Object.values(before.restoredWorkbench.tabs).flatMap(tab=>Object.values(tab.regions)).filter(region=>region.kind==='browser').length,2)
  ctx.receipt.browserTools.searchBeforeQuit={mainSurface:before.mainSurface,activeWorkspaceId:before.activeWorkspaceId,workbench:before.restoredWorkbench}
}

export async function restoreSearchRestart(ctx) {
  await ctx.waitFor('ordinary startup restores the Search management surface',()=>ctx.probe.cdp.evaluate('Boolean(document.querySelector(".global-search-surface:not([hidden]):not([inert])"))'))
  const after=await durableUi(ctx),before=ctx.receipt.browserTools.searchBeforeQuit
  assert.equal(after.mainSurface,before.mainSurface)
  assert.equal(after.activeWorkspaceId,before.activeWorkspaceId)
  assert.deepEqual(after.restoredWorkbench,before.workbench,'Ordinary startup retains all Browser Tabs, Regions, focus and split descriptors')
  await ctx.waitFor('restored Search has nonempty real Profiles',()=>ctx.probe.cdp.evaluate('document.querySelectorAll(".browser-profiles__catalog article").length>0'))
  ctx.receipt.browserTools.searchSurfaceRestored=true
  await returnToSpace(ctx)
  ctx.receipt.browserTools.nativeInput.push(await native(ctx,'#tools-input','after-restart'))
  await ctx.capture(ctx.probe,'normal-browser-after-search-restart','page')
}
