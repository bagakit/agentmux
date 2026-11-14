const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const [html, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'user-data'))
const result = { passed: false, cases: [], frames: [] }
let main, popup
app.whenReady().then(async () => {
  try {
    main = new BrowserWindow({ width: 790, height: 630, show: false, webPreferences: { backgroundThrottling: false } })
    main.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } }
    }))
    const popupReady = new Promise(resolve => main.webContents.once('did-create-window', resolve))
    const first = source => main.webContents.executeJavaScript(source)
    await main.loadFile(html)
    const delay = () => new Promise(resolve => setTimeout(resolve, 30))
    const wait = async (read, source, message = source) => {
      for (let tries = 0; tries < 120; tries++) {
        if (await read(source)) return
        await delay()
      }
      throw Error(message)
    }
    await wait(first, 'Boolean(window.overlayProof)')
    assert.equal(await first('overlayProof.open()'), true)
    popup = await popupReady
    assert.notEqual(popup.id, main.id, 'Use a second ordinary Electron window')
    let owner = popup
    const read = source => owner.webContents.executeJavaScript(source)
    async function prepareInput(window) {
      owner = window
      const connection = window.webContents.debugger
      connection.attach('1.3')
      await connection.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      return connection
    }
    let cdp = await prepareInput(popup)
    const button = 'document.querySelector("button[aria-label=\\\"Create Category\\\"]")'
    const modal = 'document.querySelector(".topic-dialog")'
    const scope = '[data-overlay-modal-scope]:not([hidden])'
    const key = async (name, code) => {
      for (const type of ['rawKeyDown', 'keyUp']) await cdp.sendCommand('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code })
    }
    const click = async (expression) => {
      const { hit, under, ...point } = await read(`(() => {
        const node=${expression}; const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
        const target=document.elementFromPoint(x,y);
        return {x,y,hit:node.contains(target),under:target?.outerHTML.slice(0, 180)}
      })()`)
      assert.ok(hit, 'The target must accept real pointer input: ' + expression + ' ' + JSON.stringify({ point, under }))
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      for (const type of ['mousePressed','mouseReleased']) await cdp.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    }
    const snapshot = async name => {
      await read('Promise.allSettled(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming()?.endTime)).map(a=>a.finished))')
      await fs.writeFile(path.join(evidence, name), (await owner.webContents.capturePage()).toPNG())
      result.frames.push(name)
    }
    const openCategory = async () => {
      await wait(read, `Boolean(${button}?.getClientRects().length)`)
      await click(button)
      await wait(read, `${modal}?.ownerDocument === document && ${modal}?.getAttribute('data-state') === 'open' &&
        ${modal}?.contains(document.activeElement)`, 'Category overlay and focus must belong to the original second document')
      assert.equal(await read(`${modal}.closest('[data-overlay-host]')?.ownerDocument === document`), true)
      if (owner === popup) assert.equal(await first('overlayProof.original().dialogs'), 0, 'No overlay opens in the original window')
    }
    const closeCategory = async () => {
      await wait(read, `!${modal} && document.activeElement === ${button}`, 'Closing the Category dialog restores its exact original trigger')
    }
    await wait(read, 'Boolean(document.getElementById("original-draft"))')
    await read('window.originalDraft = document.getElementById("original-draft"); originalDraft.setSelectionRange(3, 10)')
    await openCategory()
    assert.equal(await read(`(() => {
      const r=originalDraft.getBoundingClientRect()
      return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) !== originalDraft
    })()`), true, 'An active modal must intercept pointer input outside its scope')
    await snapshot('category-second-window.png')
    await key('Escape', 27)
    await closeCategory()
    assert.deepEqual(await read('[originalDraft.selectionStart,originalDraft.selectionEnd]'), [3, 10])
    result.cases.push('ordinary-second-window-escape')

    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await openCategory()
    await click('document.querySelector(".topic-dialog [aria-label=\\\"Close category editor\\\"]")')
    await closeCategory()
    await openCategory()
    await key('Escape', 27)
    await closeCategory()
    assert.equal(await read(`document.querySelectorAll(${JSON.stringify(scope)}).length`), 0)
    await click('document.getElementById("original-draft")')
    assert.equal(await read('document.activeElement === originalDraft && originalDraft.value === "Keep my original draft"'), true)
    result.cases.push('rapid-reopen-cancel-reduced-motion-releases-input')

    async function nestedCategory(primary = false) {
      await first(`overlayProof.render("nested", ${primary})`)
      await wait(read, 'Boolean(document.getElementById("nested-trigger"))')
      await click('document.getElementById("nested-trigger")')
      await openCategory()
      assert.equal(await read(`document.querySelectorAll(${JSON.stringify(scope)}).length`), 2)
      if (!primary) await snapshot('nested-category-second-window-reduced.png')
      await key('Escape', 27)
      await closeCategory()
      await key('Escape', 27)
      await wait(read, `!document.querySelector(${JSON.stringify(scope)}) && document.activeElement === document.getElementById("nested-trigger")`)
      result.cases.push(primary ? 'same-document-nested-escape' : 'embedded-category-closes-into-its-own-modal')
    }
    await nestedCategory()

    await first('overlayProof.render("plain")')
    await openCategory()
    await first('overlayProof.render("unmounted")')
    await wait(read, `!document.querySelector(${JSON.stringify(scope)}) && getComputedStyle(document.body).pointerEvents !== 'none'`)
    await click('document.getElementById("original-draft")')
    assert.equal(await read('document.activeElement === originalDraft'), true)
    assert.deepEqual(await first('overlayProof.original().requests'), [])
    result.cases.push('host-unmount-releases-original-draft')
    cdp = await prepareInput(main)
    await nestedCategory(true)
    result.passed = true
  } catch (error) {
    result.failure = error.message
    if (popup && !popup.isDestroyed()) {
      result.observed = await popup.webContents.executeJavaScript(`({
        active: document.activeElement?.outerHTML.slice(0, 350),
        dialogs: [...document.querySelectorAll('[data-overlay-modal-boundary]')].map(n => ({ title: n.querySelector('h2')?.textContent, state: n.dataset.state })),
        category: document.querySelector('.topic-dialog')?.getAttribute('data-state'),
        pointer: document.body.style.pointerEvents
      })`).catch(() => null)
    }
  }
  finally {
    await fs.writeFile(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2))
    popup?.destroy()
    main?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
