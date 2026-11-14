const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { createServer } = require('node:http'), { pathToFileURL } = require('node:url'), { createHash, randomBytes } = require('node:crypto')
const configPath = process.argv[2]
const config = JSON.parse(require('node:fs').readFileSync(configPath, 'utf8'))
app.setPath('userData', path.join(config.privateRoot, 'profile'))
app.disableHardwareAcceleration()
let win, server
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, pid: process.pid, frames: [], checks: [], requests: [], websocketAttempts: 0, externalRequests: 0,
  boundary: 'Actual standard main/Root/App and HTTP asset owner. Controlled held/rejected resource responses only; no preview Store or business client. Late HTTP release after real AbortSignal cancellation does not claim an ignored-signal JavaScript callback ran.' }
const pending = new Set()
const stage = name => { receipt.stage = name; console.log('mobile-startup: ' + name) }

async function run() {
  await app.whenReady()
  stage('private-app-ready')
  const { MobileAssetsOwner } = await import(pathToFileURL(path.join(config.root, 'apps/host/dist/mobile-assets-owner.js')).href)
  const owner = new MobileAssetsOwner('startup-private-host')
  await owner.initialize(config.dist)
  stage('original-dist-initialized')
  let mode = 'held', origin, productPath, productCSSPaths = [], sequence = 0
  const metadataPath = '/.well-known/agentmux/connection', heldMetadata = []
  let productRequested = false
  const reply = (res, status, body, headers = {}) => {
    if (res.destroyed || res.writableEnded) return false
    res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', ...headers }); res.end(body); return true
  }
  server = createServer((req, res) => {
    const url = new URL(req.url, origin ?? 'http://127.0.0.1')
    const record = { sequence: ++sequence, mode, method: req.method, path: url.pathname, observedAt: performance.now(),
      headers: { acceptEncoding: req.headers['accept-encoding'] ?? null }, closed: false, finished: false }
    receipt.requests.push(record)
    res.on('finish', () => { record.finished = true; record.status = res.statusCode; record.cacheControl = res.getHeader('cache-control') ?? null })
    res.on('close', () => { record.closed = true })
    if (url.pathname === metadataPath) {
      if (mode === 'held') {
        const held = { req, res, record }; heldMetadata.push(held); pending.add(res)
        res.once('close', () => pending.delete(res)); return
      }
      reply(res, 503, JSON.stringify({ error: 'Controlled private metadata unavailable' })); return
    }
    if ((url.pathname === productPath || productCSSPaths.includes(url.pathname)) && mode !== 'normal') {
      if (url.pathname === productPath) productRequested = true
      record.controlledResource = url.pathname === productPath ? 'product-javascript' : 'product-css'
      if (mode === 'held') { pending.add(res); res.once('close', () => pending.delete(res)); return }
      reply(res, 503, 'Controlled product module unavailable', { 'Content-Type': url.pathname === productPath ? 'text/javascript' : 'text/css' }); return
    }
    owner.route(req, res)
  })
  server.on('upgrade', (_req, socket) => { receipt.websocketAttempts++; socket.destroy() })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = 'http://127.0.0.1:' + server.address().port
  stage('private-listener-ready')
  // Consume the installed owner's real entry, including older retained namespace formats.
  // The fixture must not invent an HTTP alias that this compiled owner does not provide.
  const entryResponse = await fetch(origin, { method: 'HEAD', redirect: 'manual' })
  assert.equal(entryResponse.status, 302, 'Original asset owner chooses its canonical document')
  const documentUrl = new URL(entryResponse.headers.get('location'), origin)
  assert.equal(documentUrl.origin, origin)
  const prefix = new URL('.', documentUrl).pathname
  productPath = new URL(config.appDynamicChunk, origin + prefix).pathname
  productCSSPaths = config.productCSS.map(file => new URL(file, origin + prefix).pathname)
  const initialCSSPaths = config.initialCSS.map(file => new URL(file, origin + prefix).pathname)
  assert.ok(productCSSPaths.every(file => !initialCSSPaths.includes(file)), 'Shared initial styles are never held')
  const fakePublicKey = randomBytes(32), pin = Buffer.concat([Buffer.from([4]), fakePublicKey]).toString('base64url')
  receipt.http = { origin, documentPath: documentUrl.pathname, prefix, productPath, productCSSPaths, initialCSSPaths, metadataPath, release: config.release, keyKind: 'Random complete public pin with no registered device or Host secret' }
  win = new BrowserWindow({ show: false, width: 430, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } })
  stage('private-window-created')
  await win.loadURL('about:blank')
  stage('private-blank-target-ready')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + '/') || /^(data|blob):/.test(details.url)
    if (!allowed) receipt.externalRequests++
    callback({ cancel: !allowed })
  })
  win.webContents.debugger.attach('1.3')
  stage('debugger-attached')
  await win.webContents.debugger.sendCommand('Runtime.enable')
  await win.webContents.debugger.sendCommand('Network.enable')
  await win.webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })
  const read = async code => {
    const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error('Original Renderer evaluation failed: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    return result.result.value
  }
  stage('debugger-ready')
  const wait = async expression => {
    for (let count = 0; count < 250; count++) { if (await read(expression)) return; await pause(30) }
    throw Error('Original product condition was not reached: ' + expression)
  }
  const waitServer = async (predicate, label) => {
    for (let count = 0; count < 250; count++) { if (predicate()) return; await pause(30) }
    throw Error('Original private HTTP condition was not reached: ' + label)
  }
  const viewport = async (width, height) => {
    win.setContentSize(width, height)
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true })
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  }
  const named = label => `([...document.querySelectorAll('button')].find(n=>n.getClientRects().length&&n.textContent.trim()===${JSON.stringify(label)}))`
  const click = async label => {
    await wait(`Boolean(${named(label)})`)
    const point = await read(`(()=>{const n=${named(label)};n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,enabled:!n.disabled,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
    assert.equal(point.enabled, true); assert.equal(point.hit, true, 'Actual named recovery control is reachable: ' + label)
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1, id: 1 }] })
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  const capture = async name => {
    await read('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    await pause(80)
    const facts = await read(`(()=>{const root=document.querySelector('main')||document.querySelector('.mobile-app');return {viewport:{width:innerWidth,height:innerHeight},text:root?.innerText,bodyWidth:document.body.scrollWidth,hasRealApp:!!document.querySelector('.mobile-app'),hasStartup:!!document.querySelector('.mobile-startup'),controls:[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length).map(n=>({text:n.textContent.trim(),name:n.getAttribute('aria-label'),rect:n.getBoundingClientRect().toJSON()})),record:localStorage.getItem('agentmux-mobile-workface-v1'),savedOffer:localStorage.getItem('agentmux.connection-offer.v2')}})()`)
    facts.styles = await read(`(()=>{const n=document.querySelector('.mobile-startup'),s=n?getComputedStyle(n):null,b=getComputedStyle(document.body);return{startup:s?{color:s.color,backgroundColor:s.backgroundColor,font:s.font,padding:s.padding}:null,body:{color:b.color,backgroundColor:b.backgroundColor}}})()`)
    facts.loadingAppCSS = await read(`(${JSON.stringify(productCSSPaths)}).map(path=>{const link=[...document.querySelectorAll('link[rel=stylesheet]')].find(n=>new URL(n.href).pathname===path);return{path,linkPresent:!!link,sheetReady:!!link?.sheet,resource:performance.getEntriesByType('resource').filter(n=>new URL(n.name).pathname===path).map(n=>({responseEnd:n.responseEnd,transferSize:n.transferSize}))}})`)
    facts.productRequests = structuredClone(receipt.requests.filter(request => request.mode === mode && (request.path === productPath || productCSSPaths.includes(request.path))))
    if (mode === 'held') {
      assert.ok(facts.loadingAppCSS.every(item => !item.sheetReady), 'Startup remains readable without the actual App stylesheet')
      assert.ok(productCSSPaths.every(file => receipt.requests.some(request => request.mode === mode && request.path === file && !request.finished)), 'The exact product CSS is still held')
    }
    assert.ok(facts.bodyWidth <= facts.viewport.width + 1, 'Startup surface fits its actual viewport')
    assert.equal(facts.savedOffer, null, 'Failed private metadata cannot replace a saved connection')
    delete facts.savedOffer
    // Preserve only an identity/hash if the actual product owner has written a record.
    const recordBytes = facts.record; delete facts.record
    facts.recordSHA256 = recordBytes === null ? null : digest(recordBytes)
    const image = await win.webContents.capturePage(); facts.imageSize = image.getSize()
    facts.imagePixelRatio = facts.imageSize.width / facts.viewport.width
    assert.ok(Number.isInteger(facts.imagePixelRatio) && facts.imagePixelRatio > 0, 'Original native backing scale is recorded without image resizing')
    assert.equal(facts.imageSize.height, facts.viewport.height * facts.imagePixelRatio, 'Complete screenshot covers both viewport dimensions at the same native backing scale')
    const file = name + '.png'; await fs.writeFile(path.join(config.evidence, file), image.toPNG())
    receipt.frames.push(file); receipt.checks.push({ action: 'capture', file, facts, observedAt: performance.now() })
    return facts
  }
  const navigate = async url => {
    const committed = new Promise((resolve, reject) => {
      const onCommit = (_event, actual) => { win.webContents.removeListener('did-fail-load', onFail); actual === url ? resolve() : reject(Error('Unexpected private page navigation')) }
      const onFail = (_event, code, description, _url, mainFrame) => { if (mainFrame) { win.webContents.removeListener('did-navigate', onCommit); reject(Error('Private main document failed: ' + code + ' ' + description)) } }
      win.webContents.once('did-navigate', onCommit); win.webContents.on('did-fail-load', onFail)
    })
    void win.loadURL(url).catch(error => { receipt.navigationFailure = { message: error.message } })
    await committed
    await wait('document.readyState!=="loading"&&!!document.querySelector("main")')
  }
  await viewport(390, 844)
  stage('held-product-navigation')
  await navigate(documentUrl.href + '#' + pin)
  await wait(`document.querySelector('.mobile-startup')?.textContent.includes('正在读取连接')`)
  await waitServer(() => heldMetadata.length === 1 && productCSSPaths.every(file => receipt.requests.some(request => request.path === file)), 'Original metadata and exact product CSS requests both entered')
  assert.equal(heldMetadata.length, 1, 'Original metadata starts while the actual App dynamic chunk is held')
  receipt.checks.push({ action: 'held-product-loading', javascriptRequested: productRequested, stylesheetRequests: productCSSPaths,
    boundary: 'Vite may await preloaded product CSS before requesting the dynamic JavaScript; both actual product resources are controlled, never fabricated.' })
  assert.equal(await read('Boolean(document.querySelector(".mobile-app"))'), false)
  const originalRecord = await read('localStorage.getItem("agentmux-mobile-workface-v1")')
  await capture('startup-held-390-light')
  stage('held-phone-captured')
  await viewport(667, 375); await capture('startup-held-667-short-light')
  await viewport(390, 844)
  await click('取消本次读取')
  stage('original-metadata-cancelled')
  await wait('document.body.textContent.includes("本次连接读取已取消")')
  const afterCancel = heldMetadata.length
  await read('window.dispatchEvent(new Event("online"));document.dispatchEvent(new Event("visibilitychange"));true')
  await pause(80); assert.equal(heldMetadata.length, afterCancel, 'Foreground does not reissue a cancelled observation')
  await click('重新检查连接')
  await wait(`document.querySelector('.mobile-startup-observation')?.textContent.includes('正在读取连接')`)
  await waitServer(() => heldMetadata.length === 2, 'New explicit metadata request entered')
  assert.equal(heldMetadata.length, 2, 'A second GET requires the new explicit retry')
  const first = heldMetadata[0], fakeOffer = { v: 2, serverId: 'unregistered-private-host', daemonPublicKeyB64: fakePublicKey.toString('base64'), relay: { endpoint: new URL(origin).host, useTls: false } }
  const delivered = reply(first.res, 200, JSON.stringify(fakeOffer))
  receipt.checks.push({ action: 'old-metadata-late-release', originalSequence: first.record.sequence, originalClosed: first.res.destroyed, delivered,
    boundary: 'Real fetch cancellation may already close this response; this proves HTTP observation cancellation, not an ignored-signal callback.' })
  await pause(100)
  assert.equal(await read('Boolean(document.querySelector(".mobile-startup-observation")?.textContent.includes("正在读取连接"))'), true, 'The old HTTP release does not clear the new explicit pending read')
  assert.equal(await read('localStorage.getItem("agentmux-mobile-workface-v1")'), originalRecord)
  assert.equal(receipt.websocketAttempts, 0, 'No old observation starts an encrypted connection')
  await capture('startup-retry-held-390-light')
  stage('explicit-retry-captured')
  reply(heldMetadata[1].res, 503, JSON.stringify({ error: 'Controlled retry metadata failure' }))
  await wait('document.body.textContent.includes("连接尚未确认")')
  for (const res of pending) res.destroy(); pending.clear()

  mode = 'reject'
  stage('product-failure-navigation')
  await navigate(documentUrl.href + '?probe=chunk-rejected')
  await wait('document.querySelector(".mobile-startup")?.textContent.includes("工作面暂时无法打开")&&Boolean([...document.querySelectorAll("button")].find(n=>n.textContent.trim()==="保全并重新打开网页"))')
  assert.equal(await read('Boolean(document.querySelector(".mobile-app"))'), false)
  await capture('startup-module-failure-390-light')

  mode = 'normal'
  stage('actual-app-navigation')
  await navigate(documentUrl.href + '?probe=ordinary-unpaired')
  await wait('Boolean(document.querySelector(".mobile-app .mobile-connect-page[data-connect-state=unpaired]"))')
  const normal = await capture('startup-actual-app-unpaired-390-light')
  assert.equal(normal.hasRealApp, true)
  assert.equal(await read('Boolean(document.querySelector(".mobile-startup"))'), false)
  assert.equal(await read('localStorage.getItem("agentmux-mobile-workface-v1")'), originalRecord)
  assert.equal(receipt.websocketAttempts, 0); assert.equal(receipt.externalRequests, 0)
  assert.equal(receipt.requests.filter(request => request.path === metadataPath).length, 2)
  receipt.passed = true
  stage('all-five-scenes-complete')
}

run().catch(error => { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 })
  .finally(async () => {
    try {
      for (const res of pending) res.destroy()
      if (win && !win.isDestroyed()) { win.destroy(); receipt.windowDestroyed = true }
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); receipt.listenerClosed = true }
      if (config) {
        const destination = path.join(config.evidence, 'renderer.json'), temporary = destination + '.writing'
        require('node:fs').writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n')
        require('node:fs').renameSync(temporary, destination)
      }
    } finally { app.exit(receipt.passed ? 0 : 1) }
  })
