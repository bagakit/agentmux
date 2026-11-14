const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const [html, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'user-data'))
const result = { passed: false, frames: [], input: 'trusted CDP keyboard and mouse', transport: 'controlled original Session and API receipt' }
let window

app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ width: 760, height: 630, show: false, webPreferences: { backgroundThrottling: false } })
    await window.loadFile(html)
    const read = source => window.webContents.executeJavaScript(source)
    const cdp = window.webContents.debugger
    cdp.attach('1.3')
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const find = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
    const trigger = '[data-workbench-region-id="posture-region"] .composer-tool[aria-haspopup="menu"]'
    const menu = '.posture-menu[role="menu"]'
    const items = menu + ' [role="menuitem"]'
    const editor = '[data-workbench-region-id="posture-region"] [contenteditable="true"]'
    const wait = async (source, message = source) => {
      for (let index = 0; index < 85; index++) {
        if (await read(source)) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw Error(message)
    }
    const key = async (key, windowsVirtualKeyCode) => {
      for (const type of ['rawKeyDown', 'keyUp']) await cdp.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode })
    }
    const mouse = async (selector, click = false) => {
      const { hit, ...point } = await read(`(()=>{const n=${find(selector)};n.scrollIntoView({block:'nearest',inline:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:n.contains(document.elementFromPoint(x,y))}})()`)
      assert.ok(hit, 'Uncovered real mouse target required: ' + selector + ' ' + JSON.stringify(point))
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 0, pointerType: 'mouse', ...point })
      if (click) for (const type of ['mousePressed', 'mouseReleased']) await cdp.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    await wait('Boolean(window.postureProof)')
    const details = await read('postureProof.facts()')
    const postureTrigger = trigger + '[aria-label=' + JSON.stringify(details.declaration.label) + ']'
    await wait(`Boolean(${find(postureTrigger)})`)
    await read(`window.postureEditor=${find(editor)}; postureEditor.focus()`)
    window.webContents.insertText('Draft stays with this Agent')
    await wait('postureProof.facts().draft === "Draft stays with this Agent"')
    await mouse('[data-workbench-region-id="posture-region"] .composer-tool--mode', true)
    await wait(`${find(postureTrigger)}.getClientRects().length > 0`)
    await read('postureEditor.focus()')
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 0, pointerType: 'mouse', x: 12, y: 12 })
    await mouse(postureTrigger)
    await wait(`Boolean(${find(menu)})`)
    assert.ok(await read('document.activeElement === postureEditor'), 'Real hover leaves the draft focus where the user put it')
    await mouse(items + ':first-child', true)
    await wait(`!${find(menu)} && postureProof.facts().requests.length === 1`)
    assert.equal(await read('postureProof.facts().requests[0].modeId'), details.declaration.modes[0].id)

    for (const [appearance, width, motion] of [['dark', 760, 'no-preference'], ['light', 420, 'reduce']]) {
      window.setContentSize(width, 630)
      await read(`postureProof.appearance(${JSON.stringify(appearance)})`)
      await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] })
      await read(`${find(postureTrigger)}.focus()`)
      await key('ArrowDown', 40)
      await wait(`document.activeElement === ${find(items)}`)
      await key('ArrowDown', 40)
      await wait(`document.activeElement === ${find(items + ':nth-child(2)')}`)
      assert.ok(await read(`!${find(menu)}.querySelector('[aria-current],[aria-checked],[aria-selected]')`))
      assert.equal(await read('postureProof.facts().requests.length'), 1, 'Keyboard browsing must make zero requests')
      await read('Promise.allSettled(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished))')
      const frame = `posture-desktop-${appearance}-${motion}.png`
      await fs.writeFile(path.join(evidence, frame), (await window.webContents.capturePage()).toPNG())
      result.frames.push(frame)
      await key('Escape', 27)
      await wait(`!${find(menu)} && document.activeElement === ${find(postureTrigger)}`, 'Escape must return to the original Posture trigger')
    }
    await key('ArrowDown', 40)
    await wait(`document.activeElement === ${find(items)}`)
    await key('ArrowDown', 40)
    await wait(`document.activeElement === ${find(items + ':nth-child(2)')}`)
    await key('Enter', 13)
    await wait(`!${find(menu)} && postureProof.facts().requests.length === 2`)
    result.facts = await read('postureProof.facts()')
    assert.equal(result.facts.requests[1].modeId, details.declaration.modes[1].id)
    assert.deepEqual(result.facts.requests.map(value => value.control), [details.original, details.original])
    assert.equal(result.facts.draft, 'Draft stays with this Agent')
    assert.equal(await read(`${find(editor)} === postureEditor`), true)
    result.passed = true
  } catch (error) { result.failure = error.message }
  finally {
    await fs.writeFile(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2))
    window?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
