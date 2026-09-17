const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, boundary: 'Real SurfaceSwitch, Focus preview, store and CSS; preview API fixture, isolated Electron profile; no user App or Run operations.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1000, height: 600, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadFile(html)
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const deadline = Date.now() + 5000
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < deadline)
      throw new Error(`Preview did not settle: ${expression}`)
    }
    await until('!!document.querySelector(".surface-navigation__focus")')
    win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const hover = async () => {
      const { button } = await read('window.previewGeometry()')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x + button.width / 2, y: button.y + button.height / 2 })
      await until('!!document.querySelector("#surface-navigation-tooltip-focus")')
    }
    const bounded = geometry => {
      assert.equal(geometry.footer.height, 32)
      assert.ok(geometry.tooltip.x >= 8)
      assert.ok(geometry.tooltip.y >= 8)
      assert.ok(geometry.tooltip.right <= geometry.width - 8)
      assert.ok(geometry.tooltip.bottom <= geometry.footer.y)
      assert.deepEqual(geometry.rows, ['idle', 'attention', 'working'])
      assert.equal(geometry.interactive, 0)
      assert.equal(geometry.surface, 'workbench')
      assert.equal(geometry.selectedId, 'idle')
    }
    await hover()
    result.wide = await read('window.previewGeometry()'); bounded(result.wide)
    assert.deepEqual(result.wide.counts, { working: '1Working', attention: '1Attention', results: '1Results', idle: '1Idle' })
    const capture = async name => {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(privateRoot, name), image.toPNG()))
    }
    await capture('wide.png')
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 30 })
    await until('!document.querySelector("#surface-navigation-tooltip-focus")')
    win.setContentSize(360, 280)
    await until('innerWidth === 360 && innerHeight === 280')
    await hover()
    result.narrow = await read('window.previewGeometry()'); bounded(result.narrow)
    await capture('narrow.png')
    await read('window.updatePreview()')
    await until('document.querySelector("#surface-navigation-tooltip-focus").textContent.includes("Compiled successfully")')
    result.updated = await read('window.previewGeometry()')
    assert.equal(result.updated.counts.attention, '0Attention')
    assert.ok(result.updated.text.includes('Parser ready'))
    await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until('!document.querySelector("#surface-navigation-tooltip-focus")')
    const { button } = await read('window.previewGeometry()')
    for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x: button.x + button.width / 2, y: button.y + button.height / 2 })
    await until('window.previewGeometry().surface === "agents"')
    result.navigation = await read('window.previewGeometry()')
    assert.equal(result.navigation.selectedId, 'idle')
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally {
    fs.writeFileSync(path.join(privateRoot, 'native.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
