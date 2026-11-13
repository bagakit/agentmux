import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

// A parked Survey page keeps its last-seen icon and native back history across an ordinary restart,
// and the Browser chords pressed inside a real page reach the Browser showing it. Every fact is read
// from the original Renderer, Main owner, native page or HTTP producer; nothing is seeded.
const iconPath = '/continuity-icon.png'
const pages = { first: '/survey-first', second: '/survey-second', other: '/survey-other' }
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0); body.copy(chunk, 4); chunk.writeUInt32BE(crc32(body), data.length + 8)
  return chunk
}
const iconRow = Buffer.concat([Buffer.from([0]), Buffer.alloc(16 * 3, Buffer.from([0x2f, 0x7d, 0xf6]))])
const icon = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', Buffer.from([0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0])),
  pngChunk('IDAT', deflateSync(Buffer.concat(Array(16).fill(iconRow)))), pngChunk('IEND', Buffer.alloc(0))])
const digest = value => createHash('sha256').update(value).digest('hex')
const primary = [process.platform === 'darwin' ? 'meta' : 'control']

export function handleContinuityRequest(request, response, receipt) {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  if (path === iconPath) {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': icon.length }); response.end(icon); return true
  }
  const name = Object.keys(pages).find(key => pages[key] === path)
  if (!name) return false
  receipt.continuity ??= {}; receipt.continuity.requests ??= {}
  receipt.continuity.requests[path] = (receipt.continuity.requests[path] ?? 0) + 1
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  response.end(`<!doctype html><html><head><title>Continuity ${name}</title><link rel="icon" href="${iconPath}"></head>` +
    `<body><h1>Continuity ${name}</h1><p>release one</p><p>release two</p><input aria-label="Page field"></body></html>`)
  return true
}

const electron = desktopRoot => `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron')`
const owners = (desktopRoot, url) => `const {app,BrowserWindow}=${electron(desktopRoot)};const window=BrowserWindow.getAllWindows()[0];
  const views=window.contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL()===${JSON.stringify(url)});`
const ownerCount = ({ probe, desktopRoot }, prefix) => probe.main.evaluate(`(()=>{const {BrowserWindow}=${electron(desktopRoot)};
  return BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL().startsWith(${JSON.stringify(prefix)})).length})()`)

function nativePage({ probe, desktopRoot, waitFor }, url, label) {
  return waitFor(label, () => probe.main.evaluate(`(()=>{${owners(desktopRoot, url)}
    if(views.length!==1||views[0].webContents.isLoading())return null;const contents=views[0].webContents,history=contents.navigationHistory;
    return {webContentsId:contents.id,title:contents.getTitle(),visible:views[0].getVisible(),focused:contents.isFocused(),
      index:history.getActiveIndex(),entries:history.getAllEntries().map(entry=>entry.url),canGoBack:history.canGoBack()}})()`))
}

/**
 * Electron's native input path into the page, so Main's before-input-event sees it as typed there.
 * Key-window status is the OS's to grant while a person uses another app; it is recorded, not required.
 * Text needs the document itself to hold focus, which the page reports even when its window is not key.
 */
function nativeKeys({ probe, desktopRoot }, url, keyCode, modifiers = primary, types = ['keyDown', 'keyUp'], documentFocus = false) {
  return probe.main.evaluate(`(async()=>{${owners(desktopRoot, url)}
    if(views.length!==1)throw new Error('Expected exactly one native owner of the page');const view=views[0];
    app.focus({steal:true});window.focus();view.webContents.focus();const deadline=Date.now()+2000;
    while(window.isFocused()&&!view.webContents.isFocused()&&Date.now()<deadline)await new Promise(done=>setTimeout(done,30));
    let documentFocused=null;
    if(${documentFocus})while(!(documentFocused=await view.webContents.executeJavaScript('document.hasFocus()'))&&Date.now()<deadline){view.webContents.focus();await new Promise(done=>setTimeout(done,30))}
    for(const type of ${JSON.stringify(types)})view.webContents.sendInputEvent({type,keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});
    return {windowFocused:window.isFocused(),pageFocused:view.webContents.isFocused(),documentFocused,keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}}})()`)
}

async function rendererKey(probe, key, code, windowsVirtualKeyCode, text) {
  await probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(text ? { text } : {}) })
  await probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
}

const lastSeen = (probe, browserId) => probe.cdp.evaluate(`window.agentmux.browser.getLastSeenFavicons([${JSON.stringify(browserId)}]).then(found=>found[${JSON.stringify(browserId)}]??null)`)
const survey = '[aria-label="Survey"]'

async function openSurveyPage(context, url) {
  const { probe, rpc, click, selectors, waitFor } = context
  await click(probe.cdp, selectors('[aria-label="New webpage"]'))
  await waitFor('the new Survey page address', () => probe.cdp.evaluate(`document.activeElement?.getAttribute('aria-label')==='Search or enter a web address'&&Boolean(document.activeElement.closest(${JSON.stringify(survey)}))`))
  await probe.cdp.call('Input.insertText', { text: url })
  await rendererKey(probe, 'Enter', 'Enter', 13, '\r')
  const page = await nativePage(context, url, 'the new Survey page at its address')
  const item = await waitFor('the selected Survey item showing the page', async () => {
    const targets = (await rpc.call('browser.targets', {})).targets.filter(target => target.source === 'embedded' && target.url === url)
    const zones = await probe.cdp.evaluate(`Array.from(document.querySelectorAll('.survey-item-row[data-selected="true"]'),row=>row.dataset.surveyZoneId)`)
    return targets.length === 1 && zones.length === 1 ? { browserId: targets[0].id, zoneId: zones[0] } : null
  })
  return { ...item, webContentsId: page.webContentsId }
}

async function showWorkbench({ probe, click, selectors, waitFor }) {
  await click(probe.cdp, selectors('[aria-label="Space: show terminal and file workbench"]'))
  await waitFor('the original workbench shown again', () => probe.cdp.evaluate(`document.querySelector(${JSON.stringify(survey)})?.hidden===true`))
}

async function frame({ probe, receipt, desktopRoot }, label) {
  const file = join(receipt.visual.captureDirectory, `${label}.png`)
  const shot = await probe.main.evaluate(`(async()=>{const {BrowserWindow}=${electron(desktopRoot)};const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    if(image.isEmpty())throw new Error('Empty Renderer frame');const png=image.toPNG();process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(file)},png);
    return {size:image.getSize(),sha256:process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex')}})()`)
  receipt.visual.frames.push({ label, content: 'continuity', file, captureSource: 'renderer-webcontents', ...shot })
}

async function reviewContinuity(context) {
  const { probe, urls, receipt, click, selectors, waitFor, setPhase } = context
  const origin = new URL(urls[0]).origin, address = name => origin + pages[name]
  receipt.continuity ??= {}
  setPhase('continuity-first-survey-page')
  await click(probe.cdp, selectors('[aria-label="Survey: browse and explore"]'))
  const first = await openSurveyPage(context, address('first'))
  await waitFor('the first page remembered with its icon', async () => (await lastSeen(probe, first.browserId))?.url === address('first'))

  setPhase('continuity-address-chord-in-page')
  const addressChord = await nativeKeys(context, address('first'), 'L')
  const addressFocus = await waitFor('address focused and selected by the chord pressed in the page', () => probe.cdp.evaluate(`(()=>{const input=document.activeElement;
    return input?.getAttribute('aria-label')==='Browser address'&&input.closest(${JSON.stringify(survey)})&&input.value&&input.selectionStart===0&&input.selectionEnd===input.value.length?{value:input.value}:null})()`))
  await probe.cdp.call('Input.insertText', { text: address('second') })
  await rendererKey(probe, 'Enter', 'Enter', 13, '\r')
  await nativePage(context, address('second'), 'the second page in the same Browser')
  const remembered = await waitFor('the second page remembered with its icon', async () => {
    const value = await lastSeen(probe, first.browserId); return value?.url === address('second') ? value : null
  })
  const history = await nativePage(context, address('second'), 'native history behind the remembered page')
  assert.equal(history.entries[history.index - 1], address('first'), 'The remembered page has the first page behind it')
  assert.equal(history.canGoBack, true)

  setPhase('continuity-second-survey-item')
  const other = await openSurveyPage(context, address('other'))
  assert.notEqual(other.zoneId, first.zoneId, 'The second page is its own Survey item')
  await showWorkbench(context)
  receipt.continuity.first = { ...first, addressChord, addressFocus, history: { index: history.index, entries: history.entries },
    favicon: remembered.faviconDataUrl, faviconSha256: digest(remembered.faviconDataUrl) }
  receipt.continuity.other = other
}

async function recoverContinuity(context) {
  const { probe, urls, receipt, click, selectors, waitFor, nativePageScript, setPhase } = context
  const before = receipt.continuity, origin = new URL(urls[0]).origin, address = name => origin + pages[name]
  assert.ok(before?.first?.favicon, 'The first process remembered the page before the restart')
  setPhase('continuity-parked-after-restart')
  assert.equal(await ownerCount(context, origin + '/survey-'), 0, 'Survey pages stay parked until Survey shows them')
  await click(probe.cdp, selectors('[aria-label="Survey: browse and explore"]'))
  const row = `.survey-item-row[data-survey-zone-id="${before.first.zoneId}"]`
  const parked = await waitFor('the parked page showing its remembered icon', () => probe.cdp.evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(row)});
    const image=row?.querySelector('.survey-page-favicon img');if(!image||image.hidden||!image.complete||!image.naturalWidth)return null;
    const activity=row.querySelector('.survey-item-activity');
    return {src:image.getAttribute('src'),naturalWidth:image.naturalWidth,selected:row.dataset.selected,activityText:activity?.textContent??'',activityIcons:activity?.querySelectorAll('svg').length??0}})()`))
  assert.equal(parked.src, before.first.favicon, 'Survey shows the icon remembered before the restart')
  assert.equal(parked.selected, 'false')
  assert.equal(parked.activityIcons, 0, 'A parked page carries no unknown status icon')
  assert.equal(await ownerCount(context, address('second')), 0, 'The remembered icon is shown without loading the parked page')
  await frame(context, 'continuity-survey-parked')

  setPhase('continuity-restored-history')
  await click(probe.cdp, selectors(`${row} button.survey-item`))
  const restored = await nativePage(context, address('second'), 'the parked page created at its remembered entry')
  assert.deepEqual({ index: restored.index, entries: restored.entries }, before.first.history, 'The restored page keeps its native back history')
  await waitFor('Back enabled for the restored page', () => probe.cdp.evaluate(`(()=>{const buttons=Array.from(document.querySelectorAll(${JSON.stringify(`${survey} .browser-toolbar__navigation[aria-label="Back"]`)})).filter(button=>button.getClientRects().length);
    return buttons.length===1&&!buttons[0].disabled})()`))

  setPhase('continuity-find-chord-in-page')
  const findChord = await nativeKeys(context, address('second'), 'F')
  await waitFor('find row opened by the chord pressed in the page', () => probe.cdp.evaluate(`Boolean(document.activeElement?.matches('.browser-find input')&&document.activeElement.closest(${JSON.stringify(survey)}))`))
  await probe.cdp.call('Input.insertText', { text: 'release' })
  const count = await waitFor('the result count reported by the page', () => probe.cdp.evaluate(`(()=>{const text=document.querySelector(${JSON.stringify(`${survey} .browser-find__count`)})?.textContent??'';return /^[12]\\/2$/.test(text)?text:null})()`))
  await rendererKey(probe, 'Escape', 'Escape', 27)
  await waitFor('find closed', async () => !(await probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${survey} .browser-find`)}))`)))
  const afterFind = await nativePage(context, address('second'), 'the page after find')
  if (findChord.windowFocused) assert.equal(afterFind.focused, true, 'Closing find returns focus to the page')
  const focusReturn = findChord.windowFocused ? 'page-focused' : 'not-observable-window-not-key'

  setPhase('continuity-reload-chord-in-page')
  const requested = before.requests[pages.second]
  const reloadChord = await nativeKeys(context, address('second'), 'R')
  await waitFor('the page requested again from its producer', () => receipt.continuity.requests[pages.second] > requested)
  const reloaded = await nativePage(context, address('second'), 'the reloaded page')
  assert.deepEqual({ index: reloaded.index, entries: reloaded.entries }, before.first.history, 'Reload keeps the restored history')

  setPhase('continuity-plain-key-in-page')
  await nativePageScript(probe, 'window.amxKeys=[];addEventListener("keydown",e=>amxKeys.push(e.key),true);document.querySelector("input").focus();null', address('second'))
  const plainKey = await nativeKeys(context, address('second'), 'f', [], ['keyDown', 'char', 'keyUp'], true)
  assert.equal(plainKey.documentFocused, true, 'The page holds focus before a person types into it')
  let typed
  try {
    typed = await waitFor('an unreserved key typed into the page', async () => {
      const value = await nativePageScript(probe, 'document.querySelector("input").value', address('second')); return value ? value : null
    })
  } catch (error) {
    const seen = await nativePageScript(probe, 'JSON.stringify({keys:amxKeys,active:document.activeElement?.tagName,focused:document.hasFocus()})', address('second'))
    throw new Error(`${error.message}; the page saw ${seen}`)
  }
  assert.equal(typed, 'f')

  setPhase('continuity-back-to-remembered-entry')
  await click(probe.cdp, selectors(`${survey} .browser-toolbar__navigation[aria-label="Back"]`))
  const back = await nativePage(context, address('first'), 'Back returns to the page remembered behind it')
  await showWorkbench(context)
  receipt.continuity.restored = { parked, restored, findChord, count, focusReturn, reloadChord, reloaded, plainKey, typed, back,
    requests: { ...receipt.continuity.requests } }
}

export async function runContinuity(context) {
  await reviewContinuity(context)
  context.receipt.firstExit = await context.normalQuit(context.probe)
  const next = await context.launch('second'); context.retainSecond(next)
  await recoverContinuity({ ...context, probe: next })
  context.receipt.secondExit = await context.normalQuit(next)
}
