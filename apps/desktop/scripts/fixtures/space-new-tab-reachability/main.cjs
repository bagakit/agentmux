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
      for (const runtime of ['same-runtime', 'foreign-runtime']) {
        await read(`window.spaceNewTabProof.prepare(${JSON.stringify(runtime)})`); await settle()
        const before = await read('window.spaceNewTabProof.facts()')
        const rect = await read(`(()=>{const b=document.querySelector('button[title="New tab"]'); const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        assert.ok(rect.x > 0 && rect.y > 0)
        for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...rect })
        await settle()
        const after = await read('window.spaceNewTabProof.facts()')
        assert.equal(after.tabIds.length, before.tabIds.length + 1, 'Space plus creates one Tab beside its Source projection')
        assert.equal(after.selected.zoneId, before.selected.zoneId)
        assert.equal(after.selected.groupId, before.selected.groupId)
        assert.equal(after.launcherVisible, true)
        for (const key of ['drafts', 'original', 'sessions']) assert.deepEqual(after[key], before[key], 'Kept original ' + key)
        receipt[runtime] = after
      }
      await fs.writeFile(path.join(output, 'before.json'), JSON.stringify(receipt['foreign-runtime']))
      await fs.writeFile(path.join(output, 'saved.json'), JSON.stringify(await read('window.spaceNewTabProof.save()')))
    }
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(output, phase + '.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1) }
})
