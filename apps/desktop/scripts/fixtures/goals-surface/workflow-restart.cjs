const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const [html, privateRoot, evidence, phase] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: false, backgroundThrottling: false } })
    await win.loadFile(html)
    const evaluate = expression => win.webContents.executeJavaScript(expression)
    for (let attempt = 0; !await evaluate('Boolean(window.goalsVisual)'); attempt++) {
      assert.ok(attempt < 150, 'Original compiled App finishes initialization')
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    if (phase === 'save') {
      await evaluate('goalsVisual.seedWorkflow("finite")')
      const original = await evaluate('goalsVisual.saveWorkflowRestart()')
      assert.equal(original.intents['goal:visual-0'].operationId, 'workflow-original-request')
      assert.ok(original.tabs['workflow-discussion'])
      await win.webContents.session.flushStorageData()
      await fs.writeFile(path.join(evidence, 'workflow-before-restart.json'), JSON.stringify({ pid: process.pid, original }, null, 2))
    } else {
      assert.equal(phase, 'restore')
      const first = JSON.parse(await fs.readFile(path.join(evidence, 'workflow-before-restart.json'), 'utf8'))
      assert.notEqual(first.pid, process.pid, 'A new Electron process owns the recovered workface')
      const restored = await evaluate('goalsVisual.restoredWorkflow()')
      for (const field of ['intents', 'discussions', 'drafts', 'selected', 'surface']) assert.deepEqual(restored[field], first.original[field], 'Original ' + field + ' survived actual Chromium disk persistence')
      assert.deepEqual(restored.tabs['workflow-discussion'], first.original.tabs['workflow-discussion'], 'Original Tab, Region and Session binding remain')
      for (const [workspaceId, layout] of Object.entries(first.original.layouts)) assert.deepEqual(restored.layouts[workspaceId], layout, 'Original groups, focus and splits remain for ' + workspaceId)
      await fs.writeFile(path.join(evidence, 'workflow-restart.json'), JSON.stringify({ passed: true, pid: process.pid, firstPid: first.pid, restored,
        boundary: 'Two separate Electron processes, actual Chromium profile and actual Store initialize. App uses private preview Host/Runtime ports; native Agent recovery is not asserted.' }, null, 2))
    }
    win.close(); app.quit()
  } catch (error) {
    await fs.writeFile(path.join(evidence, 'workflow-restart-failure.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2))
    console.error(error); app.exit(1)
  }
})
