const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http')
const { app, BrowserWindow } = require('electron')
const { pages, html: pageHtml } = require('./pages.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
// This isolated process creates several capture windows; only the final receipt exits it.
app.on('window-all-closed', () => {})
const receipt = { schema: 'agentmux.browser-start-page-refresh-actual.v1', passed: false, pid: process.pid, frames: [], operations: [], nativePreviewSources: [], userAppRunRuntimeControlled: false,
  boundary: 'Actual App/Survey/Workbench/BrowserPane/BrowserStartPage and complete source CSS. Typed preview API only; four historical image pixels come from this process capturing its own HTTP fixture pages. No production Main history durability, user Session/Runtime, installed application or ordinary restart is certified.' }
const pause = ms => new Promise(done => setTimeout(done, ms))
let window, previewWindow, server
app.whenReady().then(async () => {
  try {
    server = http.createServer((request, response) => {
      const page = pages.find(item => request.url === '/' + item.slug)
      response.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(page ? pageHtml(page) : 'Fixture page not found')
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const origin = 'http://127.0.0.1:' + server.address().port, capturedAt = Date.now(), previews = []
    previewWindow = new BrowserWindow({ width: 1200, height: 750, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    for (const page of pages) {
      const url = origin + '/' + page.slug
      await previewWindow.loadURL(url)
      await previewWindow.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))')
      const image = await previewWindow.webContents.capturePage()
      assert.equal(image.isEmpty(), false)
      const thumbnail = image.resize({ width: 480, height: 300, quality: 'good' }), bytes = thumbnail.toJPEG(55)
      assert.ok(bytes.length < 64 * 1024)
      const sourceUrl = previewWindow.webContents.getURL(), title = previewWindow.webContents.getTitle()
      assert.equal(sourceUrl, url); assert.equal(title, page.title)
      const filename = `preview-${page.slug}.jpg`
      await fs.writeFile(path.join(evidence, filename), bytes)
      receipt.nativePreviewSources.push({ url: sourceUrl, title, capturedAt, filename, bytes: bytes.length, width: 480, height: 300 })
      previews.push({ url: sourceUrl, title, capturedAt, image: { width: 480, height: 300, dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') } })
    }
    previewWindow.destroy(); previewWindow = undefined
    await fs.writeFile(path.join(path.dirname(html), 'fixture-data.js'), 'window.startPageFixtureInput=' + JSON.stringify({ previews, capturedAt }) + ';')
    window = new BrowserWindow({ width: 1440, height: 950, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    window.webContents.on('console-message', details => { if (details.level === 'error') process.stderr.write('renderer-error: ' + details.message + '\n') })
    const read = code => window.webContents.executeJavaScript(code), facts = () => read('window.startPageProof.facts()')
    const until = async (label, predicate) => {
      const end = Date.now() + 15000
      do { if (await predicate()) return; await pause(40) } while (Date.now() < end)
      throw new Error('Start-page scene did not settle: ' + label)
    }
    const pointer = async selector => {
      const box = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
      assert.ok(box && box.width > 0 && box.height > 0 && box.hit, 'Actual clickable geometry ' + selector)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
      receipt.operations.push({ action: 'pointer', selector, box }); await pause(60)
    }
    const key = async (key, modifiers = 0) => {
      const mapping = { Enter: ['Enter', 13], Escape: ['Escape', 27], a: ['KeyA', 65], Tab: ['Tab', 9] }[key]
      for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, modifiers,
        ...(mapping ? { code: mapping[0], windowsVirtualKeyCode: mapping[1] } : {}),
        ...(type === 'keyDown' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
        ...(type === 'keyDown' && key === 'a' && modifiers === 4 ? { commands: ['selectAll'] } : {}) })
      receipt.operations.push({ action: 'key', key, modifiers }); await pause(90)
    }
    const type = async (selector, text) => { await pointer(selector); await key('a', 4); await window.webContents.debugger.sendCommand('Input.insertText', { text }); receipt.operations.push({ action: 'type', selector, text }); await pause(120) }
    const preserved = fact => {
      assert.equal(fact.sameSessions, true); assert.equal(fact.sameDrafts, true)
      assert.equal(fact.originalDraft, 'Original research draft remains untouched')
      assert.equal(fact.region.browserId, fact.originalBrowserId); assert.equal(fact.region.profileId, fact.scope.profileId); assert.equal(fact.region.workspaceId, fact.scope.workspaceId)
      assert.deepEqual(fact.calls.agent, [])
      if (fact.pane) assert.ok(fact.pane.scrollWidth <= fact.pane.clientWidth + 1, 'The page has no horizontal overflow')
    }
    const shot = async (file, movePointer = true) => {
      const [width, height] = window.getContentSize()
      if (movePointer) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 8, y: height / 2 })
      await pause(220); await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      const fact = await facts(); preserved(fact)
      const image = await window.webContents.capturePage(); assert.equal(image.isEmpty(), false)
      await fs.writeFile(path.join(evidence, file), image.toPNG())
      receipt.frames.push({ file, width, height, facts: fact })
    }
    await window.loadFile(html); window.showInactive(); window.webContents.debugger.attach('1.3')
    await until('initial history and toolbar', () => read('window.startPageProof?.ready && document.querySelectorAll(".browser-start-history__card").length===12 && Boolean(document.querySelector(".browser-toolbar input"))'))
    await until('four real preview images decoded', () => read('(()=>{const images=[...document.querySelectorAll(".browser-start-history__card img")];return images.length===4&&images.every(image=>image.complete&&image.naturalWidth>0)})()'))
    receipt.initial = await facts(); preserved(receipt.initial)
    await shot('01-normal-dark.png')
    window.setContentSize(1920, 1080); await pause(250); await shot('02-large-dark.png')
    window.setContentSize(1440, 950); await pause(200)
    const central = 'input[aria-label="Search or enter a web address"]', toolbar = 'input[aria-label="Browser address"]'
    await type(central, 'durable browser interfaces')
    await until('central draft mirrored in toolbar', async () => (await facts()).toolbar?.value === 'durable browser interfaces')
    await shot('03-central-draft.png', false); await key('Escape')
    const toolbarAddress = 'https://research.example.test/new-study'
    await type(toolbar, toolbarAddress)
    await until('toolbar draft mirrored in center', async () => (await facts()).central?.value === toolbarAddress)
    await shot('04-toolbar-draft.png', false); await key('Enter')
    await until('toolbar Enter submitted once', async () => (await facts()).calls.navigate.length === 1)
    assert.deepEqual((await facts()).calls.navigate, [{ id: receipt.initial.originalBrowserId, text: toolbarAddress }])
    await read('window.startPageProof.reset()')
    await until('same Browser returned to blank fixture', () => read('document.querySelectorAll(".browser-start-history__card").length===12'))
    await type(central, 'browser research protocol'); await key('Enter')
    await until('central Enter submitted once', async () => (await facts()).calls.navigate.length === 2)
    assert.deepEqual((await facts()).calls.navigate[1], { id: receipt.initial.originalBrowserId, text: 'browser research protocol' })
    await read('window.startPageProof.reset()')
    await until('blank before history', () => read('document.querySelectorAll(".browser-start-history__card").length===12'))
    await pointer('.browser-start-history__more')
    await until('all actual entries expanded', () => read('document.querySelectorAll(".browser-start-history__card").length===18'))
    assert.equal(await read('document.querySelector(".browser-start-history__more").getAttribute("aria-expanded")'), 'true')
    await shot('05-expanded-dark.png')
    await pointer('.browser-start-history__more')
    await until('history collapsed', () => read('document.querySelectorAll(".browser-start-history__card").length===12'))
    window.setContentSize(740, 860); await pause(240)
    await read('document.querySelector(".browser-start-page").scrollTop=0')
    await shot('06-narrow-dark.png')
    const scrollPoint = await read('(()=>{const r=document.querySelector(".browser-start-page").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scrollPoint, deltaX: 0, deltaY: 2200 })
    receipt.operations.push({ action: 'scroll', deltaY: 2200, ...scrollPoint })
    await until('narrow history end readable', () => read('(()=>{const p=document.querySelector(".browser-start-page"),m=document.querySelector(".browser-start-history__more").getBoundingClientRect(),r=p.getBoundingClientRect();return p.scrollTop>0&&m.top>=r.top&&m.bottom<=r.bottom})()'))
    await shot('06b-narrow-history-end.png')
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scrollPoint, deltaX: 0, deltaY: -2200 })
    receipt.operations.push({ action: 'scroll', deltaY: -2200, ...scrollPoint })
    await until('narrow top restored', () => read('document.querySelector(".browser-start-page").scrollTop===0'))
    await pointer(central); await key('Escape'); await shot('07-narrow-focus.png', false)
    window.setContentSize(1440, 950); await pause(180); await read('window.startPageProof.theme("light")'); await pause(220)
    await shot('08-normal-light.png')
    const imageCount = (await facts()).images.length
    assert.equal(imageCount, 4)
    await read('document.querySelector(".browser-start-history__cover img").src="data:image/jpeg;base64,broken"')
    await until('failed image falls back without disabling navigation', async () => (await facts()).images.length === imageCount - 1)
    await shot('09-image-fallback-light.png')
    await pointer('.browser-start-history__card')
    await until('original history text submitted', async () => (await facts()).calls.navigate.length === 3)
    assert.deepEqual((await facts()).calls.navigate[2], { id: receipt.initial.originalBrowserId, text: await read('window.startPageProof.firstHistory') })
    receipt.final = await facts(); preserved(receipt.final)
    assert.equal(receipt.final.calls.record.length, 3)
    assert.deepEqual(receipt.final.calls.record.map(item => item.text), receipt.final.calls.navigate.map(item => item.text))
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    if (window && !window.isDestroyed()) {
      await fs.writeFile(path.join(evidence, 'failure.png'), (await window.webContents.capturePage()).toPNG())
      try { receipt.failure.facts = await window.webContents.executeJavaScript('window.startPageProof?.facts()') } catch {}
    }
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(receipt, null, 2) + '\n')
    if (window && !window.isDestroyed() && window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy()
    server?.close()
    app.exit(receipt.passed ? 0 : 1)
  }
})
