const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence, slice] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], operations: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
    const read = code => win.webContents.executeJavaScript(code)
    const settle = () => read('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
    const until = async code => {
      const end = Date.now() + 10_000
      while (!await read(code)) { assert.ok(Date.now() < end, 'Expected image state: ' + code); await new Promise(done => setTimeout(done, 20)) }
    }
    const click = async selector => {
      const point = await read(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing control'); e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) })
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) })
      await settle()
    }
    const control = label => `[aria-label="${label}"]`
    const close = async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await until('!document.querySelector(".md-conversation-image__lightbox")')
    }
    const frame = async file => { await settle(); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file }) }
    await win.loadURL(url); win.webContents.focus()
    await until('document.querySelectorAll(".md-conversation-image__thumb").length >= 5')
    await read('document.fonts.ready')
    for (const width of [1280, 390]) {
      win.setContentSize(width, 900); await settle()
      for (const mode of ['dark', 'light']) {
        if (await read('document.documentElement.dataset.appearance') !== mode) await click('nav button')
        await click('#message .md-conversation-image')
        await until('document.querySelector(".md-conversation-image__full")?.naturalWidth === 1440')
        const fit = await read('(() => {const v=document.querySelector(".md-conversation-image__viewport"), i=document.querySelector(".md-conversation-image__full");return{width:v.clientWidth,height:v.clientHeight,imageWidth:i.width,imageHeight:i.height};})()')
        assert.ok(fit.width > 100 && fit.imageWidth > 100 && fit.imageHeight <= fit.height)
        await click(control('Zoom in'))
        assert.equal(await read('document.querySelector(".md-conversation-image__zoom").textContent'), '125%')
        await click(control('Fit image'))
        assert.equal(await read('document.querySelector(".md-conversation-image__zoom").textContent'), '100%')
        if (slice === 'gallery') {
          await click(control('Next image'))
          await until('document.querySelector(".md-conversation-image__full")?.alt.endsWith("interface.png")')
          assert.equal(await read('document.querySelector(".md-conversation-image__position").textContent'), '2 / 2')
          await click(control('Previous image'))
        }
        await frame(`${slice}-${mode}-${width}.png`)
        await close(); await settle()
        assert.equal(await read('document.activeElement === document.querySelector("#message .md-conversation-image")'), true)
        result.operations.push({ consumer: 'ConversationMessage / AgentMarkdown', width, mode, fit, focusRestored: true })
      }
    }
    win.setContentSize(1280, 900); await settle()
    await click('#draft .md-conversation-image'); await until('!!document.querySelector(".md-conversation-image__full")')
    await click(control('Zoom in')); await close()
    assert.ok(await read('document.querySelector("#draft .tiptap").textContent.includes("Compare")'))
    await click('#native .md-conversation-image'); await until('document.querySelector(".md-conversation-image__title")?.textContent === "Recorded design"')
    await click(control('Zoom in')); await close()
    result.operations.push({ consumer: 'InlineComposer and ConversationView recorded image', zoomAndDismiss: true })
    // A trusted wheel and pointer drag exercise Chromium's real event and capture path.
    await click('#message .md-conversation-image')
    const center = await read('(() => {const r=document.querySelector(".md-conversation-image__viewport").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()')
    await read('document.querySelector(".md-conversation-image__viewport").addEventListener("wheel", e => { window.fixtureWheel = { ctrlKey:e.ctrlKey, deltaY:e.deltaY, clientX:e.clientX, clientY:e.clientY }; }, {once:true})')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...center })
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...center, deltaY: 160, deltaX: 0, modifiers: ['control'], canScroll: true })
    await settle()
    result.operations.push({ wheel: await read('window.fixtureWheel') })
    await until('Number.parseInt(document.querySelector(".md-conversation-image__zoom").textContent) > 100')
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...center })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: center.x + 60, y: center.y + 40 })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: center.x + 60, y: center.y + 40 })
    await settle()
    const transformed = await read('document.querySelector(".md-conversation-image__full").style.transform')
    assert.ok(!transformed.startsWith('translate(0px, 0px)'), transformed)
    result.operations.push({ consumer: 'trusted Chromium wheel and pointer drag', transformed })
    await close()
    assert.deepEqual(result.errors, [])
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
