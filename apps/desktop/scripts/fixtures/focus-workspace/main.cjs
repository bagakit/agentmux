const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, expectation] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, phase, pid: process.pid, boundary: 'Actual Focus, Workbench, SessionPane, xterm and stylesheet; public web-preview API; no user application or actual Core Run accessed.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadFile(html)
    const until = async expression => {
      const deadline = Date.now() + 8000
      do {
        if (await win.webContents.executeJavaScript(expression)) return
        await new Promise(resolve => setTimeout(resolve, 20))
      } while (Date.now() < deadline)
      throw new Error(`Focus condition did not settle: ${expression}`)
    }
    await until('window.focusProbeReady === true && !!document.querySelector("#focus-workspace-slot .workbench-region")')
    if (phase === 'restore') {
      const saved = JSON.parse(fs.readFileSync(path.join(privateRoot, 'durable.json'), 'utf8'))
      await win.webContents.executeJavaScript(`window.restoreFocusProbe(${JSON.stringify(saved)})`)
      await until('!!document.querySelector("#focus-workspace-slot [data-workbench-region-id=fixture-region]")')
      result.restored = await win.webContents.executeJavaScript('window.focusProbeState()')
      assert.deepEqual(result.restored, saved)
    }
    result.geometry = await win.webContents.executeJavaScript('window.focusProbeGeometry()')
    if (expectation === 'baseline') {
      assert.equal(result.geometry.leftHit, false)
      assert.ok(result.geometry.lanes.height < 1)
      assert.ok(result.geometry.body.height < 50)
    } else {
      assert.equal(result.geometry.leftHit, true)
      assert.equal(result.geometry.rightHit, true)
      assert.ok(result.geometry.lanes.height > 200)
      assert.ok(result.geometry.body.height > 600)
      assert.ok(result.geometry.tracks.height <= 220)
      assert.ok(result.geometry.tracks.scrollHeight > result.geometry.tracks.clientHeight)
      assert.ok(result.geometry.track.scrollWidth <= result.geometry.track.clientWidth)
      assert.equal(result.geometry.track.overflowX, 'hidden')
      assert.ok(result.geometry.timeline.top >= result.geometry.main.top + result.geometry.main.height)
      assert.ok(result.geometry.timeline.height <= 248)
      assert.deepEqual(result.geometry.regionIds, ['fixture-region'])
      assert.equal(result.geometry.toolbar.height, 36)
      assert.equal(result.geometry.toolbar.width, 1440)
      assert.ok(Math.abs(result.geometry.contextHeader.top + result.geometry.contextHeader.height / 2 - (result.geometry.toolbar.top + result.geometry.toolbar.height / 2)) <= 1)
      assert.equal(result.geometry.visibleRecovery, 0)
      assert.deepEqual(result.geometry.disconnectedToggles, ['Disconnected12', 'Disconnected12', 'Disconnected12'])
      for (const title of ['Planning', 'Focus design', 'Runtime recovery']) assert.ok(result.geometry.laneNames.includes(`Scratch${title}`))
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      for (const [selector, axis] of [['.recent-focus__viewport', 'vertical'], ['.focus-project-lanes__rows', 'vertical']]) {
        const point = await win.webContents.executeJavaScript(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + Math.min(30, rect.width / 2), y: rect.top + Math.min(30, rect.height / 2) } })()`)
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: axis === 'horizontal' ? 180 : 0, deltaY: axis === 'vertical' ? 180 : 0 })
        await until(`document.querySelector(${JSON.stringify(selector)}).${axis === 'horizontal' ? 'scrollLeft' : 'scrollTop'} > 0`)
      }
      result.wheels = await win.webContents.executeJavaScript('window.focusProbeWheels')
      assert.deepEqual(result.wheels.map(wheel => [wheel.trusted, wheel.tracks, wheel.lanes, wheel.deltaX, wheel.deltaY]), [[true, true, false, 0, 180], [true, false, true, 0, 180]])
      await win.webContents.executeJavaScript('document.querySelector(".recent-focus__viewport").scrollTop = 9999; document.querySelector(".focus-project-lanes__rows").scrollTop = 9999; document.querySelector(".focus-project-lanes__track").scrollLeft = 9999')
      result.scroll = await win.webContents.executeJavaScript('({ tracks: document.querySelector(".recent-focus__viewport").scrollTop, lanes: document.querySelector(".focus-project-lanes__rows").scrollTop, columns: document.querySelector(".focus-project-lanes__track").scrollLeft })')
      assert.ok(result.scroll.tracks > 0)
      assert.ok(result.scroll.lanes > 0)
      assert.equal(result.scroll.columns, 0)
      // Real trusted drag adjusts the Timeline without remounting the original workbench.
      const resizePoint = await win.webContents.executeJavaScript('(() => { const rect = document.querySelector(".recent-focus__resize").getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()')
      if (phase === 'seed') {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...resizePoint })
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: resizePoint.x, y: resizePoint.y - 112 })
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: resizePoint.x, y: resizePoint.y - 112 })
        await until('window.focusProbeState().focusTimelineHeight === 208')
      }
      result.resized = await win.webContents.executeJavaScript('window.focusProbeGeometry()')
      assert.equal(result.resized.timeline.height, 208)
      assert.ok(result.resized.body.height > 550)
      assert.deepEqual(result.resized.regionIds, ['fixture-region'])
      win.setContentSize(960, 400)
      await until('window.focusProbeGeometry().toolbar.width === 960 && window.focusProbeGeometry().timeline.height === 182')
      result.narrow = await win.webContents.executeJavaScript('window.focusProbeGeometry()')
      assert.ok(result.narrow.body.height >= 180)
      assert.equal(result.narrow.rightHit, true)
      assert.deepEqual(result.narrow.regionIds, ['fixture-region'])
      assert.equal((await win.webContents.executeJavaScript('window.focusProbeState()')).focusTimelineHeight, 208)
      win.setContentSize(1440, 868)
      await until('window.focusProbeGeometry().toolbar.width === 1440 && window.focusProbeGeometry().timeline.height === 208')
      // Show the first visible hierarchical lanes in the screenshot.
      await win.webContents.executeJavaScript('document.querySelector(".focus-project-lanes__rows").scrollTop = 0')
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(privateRoot, `${phase}-focus.png`), image.toPNG()))
      await until('!!document.querySelector("#focus-workspace-slot .xterm") && !document.querySelector("#focus-workspace-slot .terminal-view__xterm--hydrating")')
      result.loadedGeometry = await win.webContents.executeJavaScript('window.focusProbeGeometry()')
      const inputPoint = await win.webContents.executeJavaScript('(() => { const rect = document.querySelector("#focus-workspace-slot .xterm-screen").getBoundingClientRect(); return { x: rect.left + 30, y: rect.top + 30 } })()')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...inputPoint })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...inputPoint })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'f', unmodifiedText: 'f' })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 })
      await until('(async () => (await window.focusProbeInputReceipt()).content === "f")()')
      result.input = await win.webContents.executeJavaScript('window.focusProbeInputReceipt()')
      assert.equal(result.input.agentSessionId, 'session-codex')
      const focused = await win.webContents.executeJavaScript('window.focusProbeState()')
      assert.equal(focused.tabs['fixture-tab'].layout.activeRegionId, 'fixture-region')
      assert.equal(focused.layouts['workspace-demo'].activeGroupId, 'fixture-group')
      assert.equal(focused.agentFocus.execution.sessionId, 'session-codex')
      assert.equal(focused.sessions.find(session => session.id === 'session-codex').control.run.runId, 'run-codex')
    }
    if (phase === 'seed') fs.writeFileSync(path.join(privateRoot, 'durable.json'), JSON.stringify(await win.webContents.executeJavaScript('window.focusProbeState()')))
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    fs.writeFileSync(path.join(privateRoot, `${phase}-result.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
