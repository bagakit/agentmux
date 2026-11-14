import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

// The ordinary app, its original menu, preload and Browser owner; no Store seed or API replacement.
const survey = '[aria-label="Survey"]'
const native = desktopRoot => `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron')`
const owner = (desktopRoot, url) => `const {BrowserWindow,Menu,app}=${native(desktopRoot)};const win=BrowserWindow.getAllWindows()[0];
  const views=win.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===${JSON.stringify(url)});
  const page=views[0]?.webContents;`

async function inspect(context, url) {
  return context.probe.main.evaluate(`(()=>{${owner(context.desktopRoot, url)}if(views.length!==1)return null;return {id:page.id,url:page.getURL(),zoom:page.getZoomFactor(),visible:views[0].getVisible(),
    history:page.navigationHistory.getAllEntries().map(entry=>entry.url),index:page.navigationHistory.getActiveIndex(),loading:page.isLoading()}})()`)
}
async function waitZoom(context, url, expected) {
  return context.waitFor('original page zoom ' + expected, async () => {
    const actual = await inspect(context, url)
    context.receipt.zoom.lastObserved = actual
    return actual && actual.visible && !actual.loading && Math.abs(actual.zoom - expected) < 0.001 ? actual : null
  })
}
async function enter(context, text) {
  await context.probe.cdp.call('Input.insertText', { text })
  for (const type of ['keyDown', 'keyUp']) await context.probe.cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}
async function newPage(context, url) {
  await context.click(context.probe.cdp, context.selectors('[aria-label="New webpage"]'))
  await context.waitFor('Survey new address focus', () => context.probe.cdp.evaluate(`document.activeElement?.getAttribute('aria-label')==='Search or enter a web address'`))
  await enter(context, url)
  await waitZoom(context, url, 0.9)
  return context.waitFor('exact public Browser target', async () => {
    const targets = (await context.rpc.call('browser.targets', {})).targets.filter(target => target.source === 'embedded' && target.url === url)
    const rows = await context.probe.cdp.evaluate(`Array.from(document.querySelectorAll('.survey-item-row[data-selected="true"]'),row=>row.dataset.surveyZoneId)`)
    if(targets.length!==1||rows.length!==1)return null
    const catalog=(await context.rpc.call('space.ls',{target:{}})).catalog
    const region=catalog.regions.find(region=>region.kind==='browser'&&region.browserId===targets[0].id)
    return region ? { browserId: targets[0].id, zoneId: rows[0], tabId: region.tabId, regionId: region.regionId } : null
  })
}
async function menu(context, url, step, pageFocus = true) {
  return context.probe.main.evaluate(`(async()=>{${owner(context.desktopRoot, url)}
    if(views.length!==1)throw new Error('Expected one original native page');
    if(${pageFocus}){win.show();app.focus({steal:true});win.focus();page.focus()}
    const expected=${pageFocus}?page:win.webContents,focusDeadline=Date.now()+2000;
    while(${native(context.desktopRoot)}.webContents.getFocusedWebContents()!==expected&&Date.now()<focusDeadline){expected.focus();await new Promise(done=>setTimeout(done,30))}
    const label=${JSON.stringify({ in: 'Zoom In', out: 'Zoom Out', reset: 'Actual Size' }[step])};
    const item=Menu.getApplicationMenu().items.find(item=>item.label==='View').submenu.items.find(item=>item.label===label);
    if(!item)throw new Error('Missing original menu item');const focused=${native(context.desktopRoot)}.webContents.getFocusedWebContents();
    item.click();return {pageId:page.id,focusedId:focused?.id??null,accelerator:item.accelerator}})()`)
}
async function capture(context, label) {
  await context.probe.cdp.evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const file = join(context.receipt.visual.captureDirectory, label + '.png')
  const size = await context.probe.main.evaluate(`(async()=>{const {BrowserWindow}=${native(context.desktopRoot)};
    const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage();if(image.isEmpty())throw new Error('Empty toolbar frame');
    process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(file)},image.toPNG());return image.getSize()})()`)
  context.receipt.visual.frames.push({ label, file, captureSource: 'renderer-webcontents', size })
}
async function indicator(context, text) {
  return context.waitFor('real toolbar zoom ' + text, () => context.probe.cdp.evaluate(`(()=>{
    const buttons=Array.from(document.querySelectorAll(${JSON.stringify(`${survey} .browser-zoom`)})).filter(button=>button.getClientRects().length);
    return buttons.length===1&&buttons[0].textContent.trim()===${JSON.stringify(text)}?{label:buttons[0].getAttribute('aria-label'),title:buttons[0].title}:null})()`))
}
async function select(context, target) {
  await context.click(context.probe.cdp, context.selectors(`.survey-item-row[data-survey-zone-id="${target.zoneId}"] button.survey-item`))
  const tab=`.survey-tab-column[data-survey-tab-id="${target.tabId}"]`
  if(await context.probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(tab)}))`))await context.click(context.probe.cdp,context.selectors(tab))
}
async function pageMemory(context,browserId) {
  const directory=join(context.userData,'browser-recovery-previews')
  try {
    for(const file of await readdir(directory,{recursive:true}))if(file.endsWith('.page.json')){
      const value=JSON.parse(await readFile(join(directory,file),'utf8'))
      if(value.memory.scope.browserId===browserId)return value
    }
    return null
  }catch(error){return {unavailable:error.message}}
}

export async function runZoom(context) {
  const { receipt, click, selectors, waitFor } = context
  const firstUrl = new URL('/zoom-first', context.urls[0]).href, secondUrl = new URL('/zoom-second', context.urls[0]).href
  receipt.zoom = { boundary: 'Original product menu invoked with actual native or toolbar focus; physical OS key equivalents are not synthesized.' }
  context.setPhase('zoom-create-survey-page')
  await click(context.probe.cdp, selectors('[aria-label="Survey: browse and explore"]'))
  const original = await newPage(context, firstUrl)
  const before = await inspect(context, firstUrl)
  await context.nativePageScript(context.probe, 'document.body.insertAdjacentHTML("beforeend",\'<input aria-label="Retained draft">\');document.querySelector("input").value="kept draft";null', firstUrl)
  receipt.zoom.nativeMenu = [await menu(context, firstUrl, 'in')]
  assert.equal(receipt.zoom.nativeMenu[0].pageId, receipt.zoom.nativeMenu[0].focusedId, 'Native menu has the original page focus')
  await waitZoom(context, firstUrl, 1)
  await indicator(context, '100%')
  // The menu also follows focus inside the real Browser address field, through Main -> preload -> Renderer -> IPC.
  await click(context.probe.cdp, selectors(`${survey} [aria-label="Browser address"]`))
  receipt.zoom.toolbarMenu = await menu(context, firstUrl, 'in', false)
  await waitZoom(context, firstUrl, 1.1)
  await indicator(context, '110%')
  const after = await inspect(context, firstUrl)
  assert.deepEqual({id:after.id,url:after.url,history:after.history,index:after.index}, {id:before.id,url:before.url,history:before.history,index:before.index})
  assert.equal(await context.nativePageScript(context.probe, 'document.querySelector("input").value', firstUrl), 'kept draft')
  await capture(context, 'zoom-survey-wide-dark')
  await context.probe.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();await window.agentmux.config.save({...expected,appearance:{...expected.appearance,appAppearance:'light'}},expected)})()`)
  await waitFor('light appearance applied',()=>context.probe.cdp.evaluate('document.documentElement.dataset.appearance==="light"'))
  await context.resize(context.probe, 1100, 760)
  await capture(context, 'zoom-survey-wide-light')
  await click(context.probe.cdp, selectors(`${survey} .browser-zoom`))
  await waitZoom(context, firstUrl, 0.9)
  await waitFor('indicator absent at the product default', () => context.probe.cdp.evaluate(`!Array.from(document.querySelectorAll(${JSON.stringify(`${survey} .browser-zoom`)})).some(button=>button.getClientRects().length)`))
  await menu(context, firstUrl, 'in'); await menu(context, firstUrl, 'in')
  await waitZoom(context, firstUrl, 1.1)
  await click(context.probe.cdp, selectors(`${survey} [aria-label="Browser address"]`))
  await context.probe.cdp.evaluate(`document.activeElement.select()`)
  await enter(context, secondUrl)
  await waitZoom(context, secondUrl, 1.1)
  await click(context.probe.cdp, selectors(`${survey} [aria-label="Reload"]`))
  await waitZoom(context, secondUrl, 1.1)
  const history = await inspect(context, secondUrl)
  receipt.zoom.original = { ...original, before, after, history }
  context.setPhase('zoom-private-page')
  await click(context.probe.cdp, selectors(`${survey} [aria-label="More browser tools"]`))
  await click(context.probe.cdp, selectors('[aria-label="New private page"]'))
  await waitFor('private page address', () => context.probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${survey} .browser-private-badge`)}))`))
  // A different path identifies the private WebContents while keeping the same site's zoom semantics.
  const privateUrl = new URL('/zoom-private', firstUrl).href
  await click(context.probe.cdp, selectors(`${survey} [aria-label="Search or enter a web address"]`))
  await enter(context, privateUrl)
  await waitZoom(context, privateUrl, 0.9)
  await menu(context, privateUrl, 'in'); await menu(context, privateUrl, 'in'); await menu(context, privateUrl, 'in')
  receipt.zoom.privateBefore = await waitZoom(context, privateUrl, 1.25)
  assert.equal((await inspect(context, secondUrl)).zoom, 1.1, 'Private zoom does not affect the persistent Profile')
  await select(context, original)
  await waitZoom(context, secondUrl, 1.1)
  receipt.zoom.beforeRestart = await inspect(context, secondUrl)
  receipt.zoom.memoryBeforeQuit = await pageMemory(context,original.browserId)
  receipt.firstExit = await context.normalQuit(context.probe)
  receipt.zoom.memoryAfterQuit = await pageMemory(context,original.browserId)
  const next = await context.launch('second'); context.retainSecond(next)
  context = { ...context, probe: next }
  context.setPhase('zoom-restored-survey-workface')
  await click(next.cdp, selectors('[aria-label="Survey: browse and explore"]'))
  await select(context, original)
  receipt.zoom.afterRestart = await waitZoom(context, secondUrl, 1.1)
  receipt.zoom.afterRestart=await waitFor('the original native back history restored',async()=>{
    const actual=await inspect(context,secondUrl);receipt.zoom.lastObserved=actual
    return actual&&JSON.stringify({history:actual.history,index:actual.index})===JSON.stringify({history:receipt.zoom.beforeRestart.history,index:receipt.zoom.beforeRestart.index})?actual:null
  })
  await indicator(context, '110%')
  await capture(context, 'zoom-survey-restored')
  await menu(context, secondUrl, 'reset')
  receipt.zoom.reset = await waitZoom(context, secondUrl, 0.9)
  await click(next.cdp, selectors(`${survey} [aria-label="More browser tools"]`))
  await click(next.cdp, selectors('[aria-label="New private page"]'))
  await waitFor('a fresh private page after restart', () => next.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${survey} .browser-private-badge`)}))`))
  const freshPrivateUrl = new URL('/zoom-private-after-restart', firstUrl).href
  await click(next.cdp, selectors(`${survey} [aria-label="Search or enter a web address"]`))
  await enter(context, freshPrivateUrl)
  receipt.zoom.privateAfterRestart = await waitZoom(context, freshPrivateUrl, 0.9)
  await select(context,original)
  await waitZoom(context,secondUrl,0.9)
  await menu(context,secondUrl,'in');await menu(context,secondUrl,'in')
  await waitZoom(context,secondUrl,1.1)
  receipt.zoom.sibling=await context.openBrowser(new URL('/zoom-sibling',firstUrl).href,{kind:'split',direction:'right',region:{kind:'region',regionId:original.regionId}})
  await context.resize(next,980,650)
  receipt.zoom.narrowPane=await waitFor('real split Browser pane',()=>next.cdp.evaluate(`(()=>{const e=document.querySelector('[data-browser-surface="${original.browserId}"]');if(!e)return null;const r=e.getBoundingClientRect();return r.width>150&&r.width<500?{width:r.width,height:r.height}:null})()`))
  await capture(context,'zoom-survey-narrow-light')
  await next.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();await window.agentmux.config.save({...expected,appearance:{...expected.appearance,appAppearance:'dark'}},expected)})()`)
  await waitFor('dark appearance applied',()=>next.cdp.evaluate('document.documentElement.dataset.appearance==="dark"'))
  await capture(context,'zoom-survey-narrow-dark')
  receipt.secondExit = await context.normalQuit(next)
}
