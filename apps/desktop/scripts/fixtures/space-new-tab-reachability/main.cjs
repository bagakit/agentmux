const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, output, phase] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, phase))
app.disableHardwareAcceleration()
const receipt = { passed: false, phase, pid: process.pid, scope: 'Real Workbench/Store/projection and Chromium input; preview transport and isolated Agent painting leaf. No user Runtime or authentication.' }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1150, height: 760, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const read = code => win.webContents.executeJavaScript(code)
  const settle = () => read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  try {
    await win.loadFile(html)
    const deadline = Date.now() + 15000
    while (!await read('!!window.spaceNewTabProof')) {
      if (Date.now() > deadline) throw new Error('Scene did not initialize')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (phase === 'restart') {
      const saved = JSON.parse(await fs.readFile(path.join(output, 'saved.json'), 'utf8'))
      await read(`window.spaceNewTabProof.restore(${JSON.stringify(saved)})`); await settle()
      const before = JSON.parse(await fs.readFile(path.join(output, 'before.json'), 'utf8'))
      const after = await read('window.spaceNewTabProof.facts()')
      for (const key of ['tabIds', 'selected', 'layouts', 'drafts', 'original', 'sessions']) assert.deepEqual(after[key], before[key], 'Restored original ' + key)
      assert.equal(after.launcherVisible, true, 'Original selected Launcher visible after process restart')
      receipt.restored = after
    } else {
      const button = '[data-pane-group-id="original-group"] button[aria-label="New Tab"]'
      const headerGeometry = () => read(`(() => {
        const plus = document.querySelector(${JSON.stringify(button)});
        const bar = plus.closest('header');
        const center = node => {
          const r = node.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        };
        const rect = bar.getBoundingClientRect();
        return { top: rect.top, height: rect.height, plus: center(plus), tab: center(bar.querySelector('.workbench-tab--active')) };
      })()`)
      for (const [runtime, projected] of [['same-runtime', false], ['foreign-runtime', false], ['foreign-runtime', true]]) {
        await read(`window.spaceNewTabProof.prepare(${JSON.stringify(runtime)}, ${projected})`); await settle()
        const before = await read('window.spaceNewTabProof.facts()')
        const header = await headerGeometry()
        const rect = header.plus
        assert.ok(rect.x > 0 && rect.y > 0)
        if (projected) await fs.writeFile(path.join(output, 'projected-before.png'), (await win.webContents.capturePage()).toPNG())
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect })
        await settle()
        const pressed = await read('window.spaceNewTabProof.facts()')
        assert.equal(pressed.projectionSelections, 0, 'Pressing the plus does not select the previous Tab')
        assert.deepEqual(pressed.selected, before.selected)
        assert.deepEqual(await headerGeometry(), header)
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect })
        await settle()
        const after = await read('window.spaceNewTabProof.facts()')
        assert.equal(after.tabIds.length, before.tabIds.length + 1, 'Space plus creates one Tab beside its Source projection')
        assert.equal(after.selected.zoneId, before.selected.zoneId)
        assert.equal(after.selected.groupId, before.selected.groupId)
        assert.ok(!before.tabIds.includes(after.selected.tabId), 'Space selects the new Launcher through the current owner')
        assert.equal(after.launcherVisible, true)
        const afterHeader = await headerGeometry()
        assert.equal(afterHeader.height, header.height, 'Space title bar height stays fixed')
        assert.equal(afterHeader.top, header.top, 'Space title bar stays on its original row')
        assert.ok(Math.abs(afterHeader.plus.y - afterHeader.tab.y) <= 1, 'Space plus and selected Tab share one title row')
        for (const key of ['drafts', 'original', 'sessions']) assert.deepEqual(after[key], before[key], 'Kept original ' + key)
        receipt[projected ? 'projected' : runtime] = after
        if (projected) await fs.writeFile(path.join(output, 'projected-after.png'), (await win.webContents.capturePage()).toPNG())
      }
      await fs.writeFile(path.join(output, 'before.json'), JSON.stringify(receipt.projected))
      await fs.writeFile(path.join(output, 'saved.json'), JSON.stringify(await read('window.spaceNewTabProof.save()')))
    }
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(output, phase + '.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1) }
})
