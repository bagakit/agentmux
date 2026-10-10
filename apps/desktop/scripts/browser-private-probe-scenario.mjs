import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = JSON.stringify
const electron = ctx => `process.getBuiltinModule('module').createRequire(${quote(join(ctx.desktopRoot, 'package.json'))})('electron')`

export function handlePrivateRequest(request, response, receipt) {
  const path = new URL(request.url, 'http://fixture.invalid').pathname
  if (path === '/private-cache') {
    receipt.privateCacheRequests ??= []
    const value = 'network-response-' + (receipt.privateCacheRequests.length + 1)
    receipt.privateCacheRequests.push({ value, cookie: request.headers.cookie ?? null })
    response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' }); response.end(value)
  } else if (path === '/private-sw.js') {
    response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache' })
    response.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));")
  } else {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Website session fixture</title><h1>Website session fixture</h1><p>Independent website storage in an actual Browser.</p>')
  }
  return true
}

async function cli(ctx, argv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  Object.assign(env, { HOME: ctx.privateHome, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(ctx.runtimeDirectory, 'control.sock'),
    AGENTMUX_RUNTIME_DIRECTORY: ctx.runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(ctx.runtimeDirectory, 'state') })
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(ctx.coreRoot, 'dist/agentmux.js'), ...argv], {
      cwd: ctx.workspacePath, env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = '', errors = '', expired = false, escalation
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { errors += bytes })
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000) }, 20_000)
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      try {
        assert.equal(expired, false, 'The exact Core CLI child must finish'); assert.equal(code, 0, errors); assert.equal(signal, null)
        const result = JSON.parse(output); assert.equal(result.ok, true, output); done(result)
      } catch (error) { reject(error) }
    })
  })
}

async function contents(ctx, url, expression) {
  return ctx.probe.main.evaluate(`(async()=>{const {webContents}=${electron(ctx)};const matches=webContents.getAllWebContents().filter(w=>!w.isDestroyed()&&w.getURL()===${quote(url)});
    if(matches.length!==1)throw new Error('Private fixture requires its exact current native page');const contents=matches[0];return (${expression});})()`)
}
const pageRead = `(async()=>{const db=await new Promise((done,fail)=>{const request=indexedDB.open('private-fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('values');request.onsuccess=()=>done(request.result);request.onerror=()=>fail(request.error)});
  const idb=await new Promise((done,fail)=>{const request=db.transaction('values').objectStore('values').get('value');request.onsuccess=()=>done(request.result??null);request.onerror=()=>fail(request.error)});db.close();
  const cache=await caches.open('private-fixture'),cached=await cache.match('/private-stored-response');
  return {cookie:document.cookie,local:localStorage.getItem('private-fixture'),idb,cache:cached?await cached.text():null,serviceWorkers:(await navigator.serviceWorker.getRegistrations()).length};})()`
const pageSeed = value => `(async()=>{const value=${quote(value)};document.cookie='private-fixture='+value+'; Max-Age=86400; SameSite=Lax';localStorage.setItem('private-fixture',value);
  const db=await new Promise((done,fail)=>{const request=indexedDB.open('private-fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('values');request.onsuccess=()=>done(request.result);request.onerror=()=>fail(request.error)});
  await new Promise((done,fail)=>{const transaction=db.transaction('values','readwrite');transaction.objectStore('values').put(value,'value');transaction.oncomplete=done;transaction.onerror=()=>fail(transaction.error)});db.close();
  const cache=await caches.open('private-fixture');await cache.put('/private-stored-response',new Response(value));
  await navigator.serviceWorker.register('/private-sw.js');await navigator.serviceWorker.ready;return ${pageRead};})()`
async function page(ctx, url, code) { return contents(ctx, url, `await contents.executeJavaScript(${quote(code)})`) }
async function actualPage(ctx, url) {
  await ctx.waitFor('exact loaded website session', () => ctx.probe.main.evaluate(`(()=>{const {webContents}=${electron(ctx)};return webContents.getAllWebContents().filter(w=>!w.isDestroyed()&&!w.isLoading()&&w.getURL()===${quote(url)}).length===1})()`))
}
function expectEmpty(value) {
  assert.equal(value.cookie, ''); assert.equal(value.local, null); assert.equal(value.idb, null); assert.equal(value.cache, null); assert.equal(value.serviceWorkers, 0)
}
function expectSeeded(value, expected) {
  assert.equal(value.cookie, 'private-fixture=' + expected); assert.equal(value.local, expected); assert.equal(value.idb, expected); assert.equal(value.cache, expected); assert.equal(value.serviceWorkers, 1)
}
async function storage(ctx, url) {
  return contents(ctx, url, `({webContentsId:contents.id,persistent:contents.session.isPersistent(),storagePath:contents.session.storagePath})`)
}
async function saved(ctx, browserIds = []) {
  return ctx.waitFor('actual saved workface', async () => {
    const value = await ctx.probe.cdp.evaluate('window.agentmux.spatial.read()')
    return value?.graph?.tabs.length && browserIds.every(id => value.graph.regions.some(region => value.graph.resources['region:' + region.regionId]?.browserId === id)) ? value : null
  })
}
async function privateFrame(ctx, label) {
  const folder = join(ctx.repositoryRoot, '.local/browser-private/visual'); await mkdir(folder, { recursive: true })
  const file = join(folder, label + '.png')
  const result = await ctx.probe.main.evaluate(`(async()=>{const {BrowserWindow}=${electron(ctx)};const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));
    const native=win.contentView.children.filter(v=>v.webContents&&v.webContents!==win.webContents&&v.getVisible()&&v.getBounds().width>0&&v.getBounds().height>0);
    if(native.length)throw new Error('A Renderer-only private start-page frame cannot omit any visible native surface');
    const image=await win.webContents.capturePage();if(image.isEmpty())throw new Error('Private UI frame is empty');const png=image.toPNG();process.getBuiltinModule('fs').writeFileSync(${quote(file)},png);
    return {size:image.getSize(),sha256:process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex'),visibleNative:native.map(v=>({url:v.webContents.getURL(),bounds:v.getBounds()}))};})()`)
  const text = await ctx.probe.cdp.evaluate(`(()=>{return {body:document.body.innerText,badges:${ctx.selectors('.browser-private-badge')}.map(e=>e.textContent),notice:${ctx.selectors('.browser-private-notice,.browser-empty')}.filter(e=>e.textContent.includes('network identity')).map(e=>({text:e.textContent,bounds:e.getBoundingClientRect().toJSON()})),noticeOwners:[...document.querySelectorAll('.browser-private-notice,.browser-empty')].map(e=>({className:e.className,visibility:getComputedStyle(e).visibility,regionId:e.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id'),bounds:e.getBoundingClientRect().toJSON()}))}})()`)
  assert.ok(text.badges.includes('Private')); assert.equal(text.notice.length, 1, JSON.stringify(text))
  assert.deepEqual(sha(await readFile(file)), result.sha256)
  ctx.receipt.privateVisual ??= []; ctx.receipt.privateVisual.push({ label, file, ...result, text,
    provenance: 'Actual product Renderer capture; the exact native page is blank. No visible website or overlay pixels are omitted or composited.', aestheticReview: 'pending-independent-review' })
}

export async function reviewPrivate(ctx) {
  ctx.setPhase('private-public-entrypoints')
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Survey: browse and explore"]'))
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="New browser options"]'))
  await ctx.click(ctx.probe.cdp, ctx.selectors('[role="menuitem"]').concat('.filter(e=>e.textContent.trim()===\'New private page\')'))
  const guiTarget = await ctx.waitFor('actual GUI-created private Browser', async () => {
    const result = await ctx.rpc.call('browser.targets', {}), privateTargets = result.targets.filter(target => target.source === 'embedded' && target.mode === 'private')
    return privateTargets.length === 1 ? privateTargets[0] : null
  })
  const guiState = await saved(ctx, [guiTarget.id]), guiFact = guiState.graph.regions.find(region => guiState.graph.resources['region:' + region.regionId]?.browserId === guiTarget.id)
  const guiRegion = { ...guiFact, ...guiState.graph.resources['region:' + guiFact.regionId] }
  assert.ok(guiRegion); assert.equal(guiRegion.mode, 'private'); assert.equal(guiRegion.url, 'about:blank')
  ctx.receipt.privateGui = { target: guiTarget, region: guiRegion, input: 'Trusted original Renderer CDP pointer input before any website surface exists; this is not physical OS input.' }
  if (ctx.privateVisual) {
    await ctx.resize(ctx.probe, 1440, 900); await privateFrame(ctx, 'private-new-normal')
    await ctx.resize(ctx.probe, 980, 700); await privateFrame(ctx, 'private-new-narrow')
    await ctx.resize(ctx.probe, 1440, 900)
  }
  // The actual GUI-created Tab is already acknowledged by Core. Public new-tab placement
  // uses that original identity, then crosses Renderer createControlBrowser and Main.
  const base = new URL(ctx.pageUrl).origin, normalUrl = base + '/normal-owner', firstUrl = base + '/private-owner-first', retainedUrl = base + '/private-owner-retained'
  const normalDestination = { kind: 'new-tab', after: { kind: 'tab', tabId: guiRegion.tabId } }
  const normal = await ctx.rpc.call('browser.open', { url: normalUrl, destination: normalDestination })
  const workspaceId = normal.region.workspaceId
  assert.equal(workspaceId, guiRegion.workspaceId, 'Public placement must preserve the original GUI Tab workspace')
  const first = await ctx.rpc.call('browser.open', { url: firstUrl, mode: 'private', destination: { kind: 'split', region: { kind: 'region', regionId: normal.region.regionId }, direction: 'right' } })
  const cliOpened = await cli(ctx, ['browser', 'open', '--url', retainedUrl, '--tab', normal.region.tabId, '--new-tab', '--private'])
  const retained = cliOpened.result.region
  assert.equal(normal.region.mode, 'normal'); assert.equal(first.region.mode, 'private'); assert.equal(retained.mode, 'private')
  for (const region of [first.region, retained]) assert.equal(region.workspaceId, workspaceId)
  assert.equal(cliOpened.operation, 'browser.open')
  const placed = await saved(ctx, [guiTarget.id, normal.region.browserId, first.region.browserId, retained.browserId])
  assert.deepEqual(placed.graph.regions.find(region => region.regionId === guiRegion.regionId), guiFact, 'Public creation must retain the original GUI Region')
  assert.deepEqual(placed.graph.resources['region:' + guiRegion.regionId], guiState.graph.resources['region:' + guiRegion.regionId])
  const targets = await ctx.rpc.call('browser.targets', {})
  for (const region of [normal.region, first.region, retained]) {
    const target = targets.targets.find(target => target.id === region.browserId)
    assert.equal(target?.mode, region.mode); assert.equal(target?.source, 'embedded'); assert.ok(!('partition' in target))
  }
  for (const url of [normalUrl, firstUrl, retainedUrl]) await actualPage(ctx, url)
  const observations = await Promise.all([normalUrl, firstUrl, retainedUrl].map(url => storage(ctx, url)))
  assert.equal(observations[0].persistent, true); assert.ok(observations[0].storagePath.startsWith(ctx.userData))
  for (const observation of observations.slice(1)) { assert.equal(observation.persistent, false, 'actual private Session must be in memory'); assert.equal(observation.storagePath, null) }
  const different = await ctx.probe.main.evaluate(`(()=>{const {webContents}=${electron(ctx)},find=url=>webContents.getAllWebContents().find(w=>w.getURL()===url).session;const sessions=${quote([normalUrl,firstUrl,retainedUrl])}.map(find);return new Set(sessions).size===3})()`)
  assert.equal(different, true, 'Normal and both private Browsers must own separate actual Sessions')
  ctx.receipt.privatePublic = { normalDestination, sdk: [normal, first], cli: cliOpened, targets, sessions: observations, distinctSessions: different }
  const script = await ctx.runBrowser(retained.browserId, 'await pageInfo(); await snapshot({scope:"page",maxNodes:20}); return "private page consumer";')
  assert.equal(script.outcome.kind, 'completed'); assert.equal(script.runOperation.browserId, retained.browserId)
  ctx.receipt.privatePublic.privateProgram = script

  ctx.setPhase('private-website-storage-and-cache')
  for (const url of [normalUrl, firstUrl, retainedUrl]) expectEmpty(await page(ctx, url, pageRead))
  const values = ['normal-persistent-login', 'private-first-login', 'private-retained-login']
  for (const [index,url] of [normalUrl, firstUrl, retainedUrl].entries()) expectSeeded(await page(ctx, url, pageSeed(values[index])), values[index])
  const network = []
  for (const url of [normalUrl, firstUrl, retainedUrl]) {
    const firstResponse = await page(ctx, url, "fetch('/private-cache').then(r=>r.text())")
    assert.equal(await page(ctx, url, "fetch('/private-cache').then(r=>r.text())"), firstResponse, 'Actual per-session HTTP cache must serve the repeated resource')
    network.push(firstResponse)
  }
  assert.equal(new Set(network).size, 3, 'Private sessions must not share the ordinary or each other HTTP cache')
  for (const [index,url] of [normalUrl, firstUrl, retainedUrl].entries()) expectSeeded(await page(ctx, url, pageRead), values[index])
  ctx.receipt.privateWebsite = { beforeRelease: values, cacheResponses: network, cacheRequests: [...ctx.receipt.privateCacheRequests] }

  ctx.setPhase('private-release-close-and-late-incarnation')
  await ctx.rpc.call('space.focus', { target: { kind: 'space', regionId: retained.regionId } })
  await contents(ctx, firstUrl, '(globalThis.__privateRetiredSession=contents.session,true)')
  await ctx.probe.cdp.evaluate(`window.agentmux.browser.release(${quote(first.region.browserId)})`)
  await ctx.probe.cdp.evaluate(`window.agentmux.browser.restore(${quote(first.region.browserId)},{workspaceId:${quote(workspaceId)},profileId:null,mode:'private'})`)
  await actualPage(ctx, firstUrl)
  assert.equal(await contents(ctx, firstUrl, 'contents.session===globalThis.__privateRetiredSession'), true)
  expectSeeded(await page(ctx, firstUrl, pageRead), values[1])
  assert.equal(await page(ctx, firstUrl, "fetch('/private-cache').then(r=>r.text())"), network[1])
  const popupUrl = base + '/private-popup'
  assert.equal(await page(ctx, firstUrl, `Boolean(window.open(${quote(popupUrl)},'_blank'))`), true)
  await actualPage(ctx, popupUrl)
  assert.equal(await contents(ctx, popupUrl, 'contents.session===globalThis.__privateRetiredSession'), true, 'Native popup must inherit its actual private opener session')
  await ctx.probe.cdp.evaluate(`window.agentmux.browser.close(${quote(first.region.browserId)})`)
  assert.equal(await ctx.probe.main.evaluate(`(()=>{const {webContents}=${electron(ctx)};return webContents.getAllWebContents().some(w=>!w.isDestroyed()&&w.getURL()===${quote(popupUrl)})})()`), false)
  assert.deepEqual(await ctx.probe.main.evaluate('globalThis.__privateRetiredSession.cookies.get({})'), [])
  const newUrl = base + '/private-new-incarnation'
  await ctx.probe.cdp.evaluate(`window.agentmux.browser.create(${quote(first.region.browserId)},${quote(newUrl)},${quote(workspaceId)},undefined,'private')`)
  await actualPage(ctx, newUrl)
  assert.equal(await contents(ctx, newUrl, 'contents.session===globalThis.__privateRetiredSession'), false, 'closed private Session must never be reused')
  // A late consumer retained by the test can write only the retired Session, never the new owner.
  await ctx.probe.main.evaluate(`globalThis.__privateRetiredSession.cookies.set({url:${quote(base)},name:'late-retired',value:'old'})`)
  expectEmpty(await page(ctx, newUrl, pageRead))
  assert.notEqual(await page(ctx, newUrl, "fetch('/private-cache').then(r=>r.text())"), network[1])
  await ctx.probe.cdp.evaluate(`window.agentmux.browser.close(${quote(first.region.browserId)})`)
  expectSeeded(await page(ctx, normalUrl, pageRead), values[0]); expectSeeded(await page(ctx, retainedUrl, pageRead), values[2])
  const input = await ctx.probe.cdp.evaluate(`window.agentmux.browser.recordInputHistory({kind:'browser',browserId:${quote(retained.browserId)},profileId:null},'private-address-input-never-persisted')`)
  assert.equal(input.outcome, 'private'); assert.deepEqual(input.entries, [])
  ctx.receipt.privateLifecycle = { releaseRetainedSameSession: true, popupInheritedAndClosed: true, closedCookies: [], newIncarnationDistinct: true, lateRetiredWriteIsolated: true, input }

  ctx.setPhase('private-real-persistence-and-exit')
  const before = await saved(ctx, [normal.region.browserId, retained.browserId]), bytes = await ctx.probe.cdp.evaluate("localStorage.getItem('agentmux-workbench-v1')")
  for (const secret of [firstUrl, retainedUrl, newUrl, 'private-address-input-never-persisted']) assert.ok(!bytes.includes(secret), 'Actual persisted Workbench must omit the private address and input')
  const privateSurface = before.graph.resources['region:' + retained.regionId]
  assert.equal(privateSurface.mode, 'private'); assert.equal(privateSurface.url, 'about:blank'); assert.equal(privateSurface.title, 'Private page')
  assert.ok(!('profileId' in privateSurface)); assert.ok(!('faviconDataUrl' in privateSurface)); assert.ok(!('bookmarkOrigin' in privateSurface))
  ctx.receipt.privateRestart = { before, localStorageSha256: sha(bytes), exitKind: ctx.privateCrash ? 'crash' : 'ordinary' }
  ctx.receipt.firstExit = ctx.privateCrash ? await ctx.crash(ctx.probe) : await ctx.normalQuit(ctx.probe)
  const spatialPath = join(ctx.runtimeDirectory, 'state/spatial-state.json'), spatialBytes = await readFile(spatialPath)
  const onDisk = JSON.parse(spatialBytes)
  for (const secret of [firstUrl, retainedUrl, newUrl, 'private-address-input-never-persisted']) assert.equal(spatialBytes.includes(Buffer.from(secret)), false, 'Actual Core spatial storage must omit private addresses and input')
  assert.deepEqual(onDisk.graph.resources['region:' + retained.regionId], privateSurface)
  ctx.receipt.privateRestart.physicalSpatial = { bytes: spatialBytes.length, sha256: sha(spatialBytes), state: onDisk }
  const diskFiles = await readdir(join(ctx.userData, 'Local Storage/leveldb'))
  const physical = []
  for (const name of diskFiles.filter(name => /\.(?:ldb|log)$/.test(name))) {
    const data = await readFile(join(ctx.userData, 'Local Storage/leveldb', name))
    for (const secret of [firstUrl, retainedUrl, newUrl, 'private-address-input-never-persisted']) assert.equal(data.includes(Buffer.from(secret)), false, 'Actual Workbench LevelDB bytes must not contain private addresses')
    physical.push({ name, bytes: data.length, sha256: sha(data) })
  }
  assert.ok(physical.length > 0, 'Persisted Workbench proof must read actual on-disk LevelDB files')
  ctx.receipt.privateRestart.physicalWorkbench = physical

  const next = await ctx.launch('second'); ctx.retainSecond(next)
  const restarted = { ...ctx, probe: next }
  ctx.setPhase('private-actual-second-process')
  const after = await saved(restarted, [normal.region.browserId, retained.browserId])
  assert.deepEqual(after.graph.tabs, before.graph.tabs, 'Cold restart must preserve all actual Tab identities')
  assert.deepEqual(after.graph.regions, before.graph.regions, 'Cold restart must preserve all actual Region identities')
  assert.deepEqual(after.graph.tabLayouts, before.graph.tabLayouts, 'Cold restart must preserve the original mixed Region topology')
  assert.deepEqual(after.graph.layouts, before.graph.layouts, 'Cold restart must preserve the original Tab Group topology')
  assert.deepEqual(after.graph.resources['region:' + retained.regionId], privateSurface, 'The original private Region stays empty in the actual Core descriptor')
  await ctx.rpc.call('space.focus', { target: { kind: 'space', regionId: retained.regionId } })
  await ctx.waitFor('actual private restart notice', () => next.cdp.evaluate(`${ctx.selectors(`[data-workbench-region-id="${retained.regionId}"] .browser-private-notice,[data-workbench-region-id="${retained.regionId}"] .browser-empty`)}.some(e=>e.textContent.includes('Temporary data has ended'))`))
  if (ctx.privateVisual) {
    await ctx.resize(next, 1440, 900); await privateFrame(restarted, 'private-restarted-normal')
    await ctx.resize(next, 980, 700); await privateFrame(restarted, 'private-restarted-narrow')
  }
  await actualPage(restarted, normalUrl)
  expectSeeded(await page(restarted, normalUrl, pageRead), values[0])
  assert.equal(await page(restarted, normalUrl, "fetch('/private-cache').then(r=>r.text())"), network[0], 'Ordinary persistent Profile HTTP cache must survive the real process restart')
  // The original private Region is new and blank. Only this explicit post-restart navigation
  // visits the test origin; no saved private address or login is restored.
  await next.cdp.evaluate(`window.agentmux.browser.navigate(${quote(retained.browserId)},${quote(retainedUrl)})`)
  await actualPage(restarted, retainedUrl); expectEmpty(await page(restarted, retainedUrl, pageRead))
  const afterCache = await page(restarted, retainedUrl, "fetch('/private-cache').then(r=>r.text())")
  assert.notEqual(afterCache, network[2], 'The private HTTP cache must end with its original process')
  ctx.receipt.privateRestart.after = after; ctx.receipt.privateRestart.ordinaryLoginAndCacheRetained = true
  ctx.receipt.privateRestart.privateWebsiteEmpty = true; ctx.receipt.privateRestart.privateCacheResponse = afterCache
  ctx.receipt.secondExit = await ctx.normalQuit(next)
}
