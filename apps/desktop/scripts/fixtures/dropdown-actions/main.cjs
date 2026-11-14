const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const [html, evidence] = process.argv.slice(2)
app.setPath('userData', join(evidence, 'user-data'))
const result = { passed: false, cases: [], frames: [] }
let primary, secondary
app.whenReady().then(async () => {
  try {
    primary = new BrowserWindow({ show: false })
    primary.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } }
    }))
    const opened = new Promise(resolve => primary.webContents.once('did-create-window', resolve))
    await primary.loadFile(html)
    const original = source => primary.webContents.executeJavaScript(source)
    await original('dropdownProof.open()')
    secondary = await opened
    assert.notEqual(secondary.id, primary.id)
    const read = source => secondary.webContents.executeJavaScript(source)
    const wait = async (source, message) => {
      for (let tries = 0; tries < 70; tries++) {
        if (await read(source)) return
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      assert.fail(message)
    }
    const cdp = secondary.webContents.debugger
    cdp.attach('1.3')
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const key = async (name, code) => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await cdp.sendCommand('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code })
      }
    }
    const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
    const trigger = query('[aria-label="Original file actions"]')
    const menu = query('.image-annotation-original-menu')
    const move = async target => {
      const point = await read(`(() => {
        const node = ${target}
        const { x, y, width, height } = node.getBoundingClientRect()
        const point = { x: x + width / 2, y: y + height / 2 }
        return { ...point, hit: node.contains(document.elementFromPoint(point.x, point.y)) }
      })()`)
      const { hit, ...position } = point
      assert.ok(hit, 'The original target is hit-testable')
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
      return position
    }
    const click = async target => {
      const point = await move(target)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
      }
    }

    const outerTrigger = query('[aria-haspopup="dialog"]')
    await wait(`Boolean(${outerTrigger}?.getClientRects().length)`, 'The secondary workface rendered')
    await click(outerTrigger)
    await wait(`Boolean(${trigger}?.getClientRects().length) && document.querySelector('img[alt="Captured image"]')?.naturalWidth > 0`,
      'The original modal presents the actual annotation editor and its image')
    await move(trigger)
    assert.ok(await read(`!${menu}`), 'Pointer movement keeps a click menu closed')
    await click(trigger)
    const openedInOriginal = `${menu}?.closest('[data-overlay-modal-slot]')?.ownerDocument === document`
    await wait(openedInOriginal, 'The file menu opens in the original second document and modal slot')
    assert.equal(await original('Boolean(document.querySelector("[role=menu]"))'), false)
    await read('Promise.allSettled(document.getAnimations().map(animation => animation.finished))')
    await writeFile(join(evidence, 'original-file-menu.png'), (await secondary.webContents.capturePage()).toPNG())
    result.frames.push('original-file-menu.png')
    await key('Escape', 27)
    await wait(`!${menu} && document.activeElement === ${trigger}`, 'Escape restores the exact Original trigger')
    assert.deepEqual(await original('dropdownProof.requests'), [])
    result.cases.push('click-and-escape-in-owning-modal')

    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await key('ArrowDown', 40)
    await wait(`${menu}?.contains(document.activeElement) && document.activeElement?.textContent === 'Open original…'`,
      'ArrowDown activates the click menu and focuses the first original action')
    const keyboardHighlight = await read(`(() => {
      const item = document.activeElement
      const next = item.nextElementSibling
      return item.hasAttribute('data-highlighted') && getComputedStyle(item).backgroundColor !== getComputedStyle(next).backgroundColor
    })()`)
    assert.equal(keyboardHighlight, true, 'The first action has a visible keyboard highlight')
    await writeFile(join(evidence, 'original-file-keyboard.png'), (await secondary.webContents.capturePage()).toPNG())
    result.frames.push('original-file-keyboard.png')
    const dimensions = await read(`(() => {
      const menu = ${menu}
      const style = getComputedStyle(menu)
      return [style.maxBlockSize, style.maxInlineSize, style.overscrollBehaviorY, style.animationDuration]
    })()`)
    assert.match(dimensions[0], /^\d+(?:\.\d+)?px$/, 'The original menu uses the collision-resolved height')
    assert.match(dimensions[1], /^\d+(?:\.\d+)?px$/, 'The original menu uses the collision-resolved width')
    assert.deepEqual(dimensions.slice(2), ['contain', '0s'])
    await key('ArrowDown', 40)
    await wait(`document.activeElement?.textContent === 'Save original…'`, 'Navigation follows the original physical menu')
    await key('Enter', 13)
    await wait(`!${menu}`, 'Selecting an original action closes only its menu')
    assert.deepEqual(await original('dropdownProof.requests'), ['save-original'])
    assert.equal(await read('Boolean(document.querySelector("[role=dialog]"))'), true)
    result.cases.push('keyboard-selects-the-exact-file-action-once')
    await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const tap = async target => {
      const touch = await read(`(() => {
        const r = ${target}.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`)
      await cdp.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] })
      await cdp.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await tap(trigger)
    await wait(openedInOriginal, 'A touch opens the original file menu')
    await tap(query('.image-annotation-original-menu [role="menuitem"]'))
    await wait(`!${menu}`, 'Touch selection closes only the menu')
    assert.deepEqual(await original('dropdownProof.requests'), ['save-original', 'open-original'])
    result.cases.push('touch-selects-the-exact-file-action-once')

    await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
    const primaryOutput = query('.image-annotation-editor button.agent-button.primary-button')
    await click(primaryOutput)
    assert.deepEqual(await original('dropdownProof.requests'), ['save-original', 'open-original', 'copy-processed'],
      'The shared primary button invokes its original output once')
    result.cases.push('primary-button-preserves-original-output')
    result.passed = true
  } catch (error) {
    result.failure = error.message
    result.observed = await secondary?.webContents.executeJavaScript(`({
      active: document.activeElement?.outerHTML.slice(0, 240),
      menu: Boolean(document.querySelector('[role="menu"]')),
      dialog: Boolean(document.querySelector('[role="dialog"]'))
    })`).catch(() => null)
  } finally {
    await writeFile(join(evidence, 'renderer.json'), JSON.stringify(result, null, 2) + '\n')
    secondary?.destroy()
    primary?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
