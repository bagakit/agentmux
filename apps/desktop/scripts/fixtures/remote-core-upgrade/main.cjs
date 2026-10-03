const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.setName('Owned remote upgrade preview')
app.whenReady().then(async () => {
  const result = { images: [], passed: false, boundary: 'Actual production Renderer components; controlled maintenance DTOs; no user App/SSH/Run qualification.' }
  let win
  try {
    win = new BrowserWindow({ width: 1440, height: 950, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const read = code => win.webContents.executeJavaScript(code)
    const until = async code => {
      const end = Date.now() + 10000
      do { if (await read(code)) return; await new Promise(done => setTimeout(done, 30)) } while (Date.now() < end)
      throw new Error('Renderer condition did not settle: ' + code)
    }
    const click = async selector => {
      await until(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`)
      const rect = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) })
    }
    const capture = async name => {
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.capturePage()).toPNG())
      result.images.push({ path: file, width: await read('innerWidth'), height: await read('innerHeight') })
    }
    await until('window.remoteUpgradePreview?.ready && document.querySelector(".global-system-notices__trigger")')
    for (const width of [1440, 640]) {
      win.setContentSize(width, 950); win.showInactive(); win.webContents.focus()
      await until(`innerWidth === ${width}`)
      await click('.global-system-notices__trigger')
      await until('document.querySelector(".global-system-notices__details")?.matches(":popover-open")')
      await capture('notice-' + width)
      await click('.global-system-notices__action')
      await until('document.querySelector("[data-resource-editor=build]")?.checkVisibility()')
      assert.equal(await read('document.querySelector("[data-resource-editor]").dataset.resourceEditor'), 'build')
      await capture('settings-' + width)
      if (await read('Boolean(document.querySelector("[data-host-upgrade] button"))')) {
        await click('[data-host-upgrade] button')
        await until('window.remoteUpgradePreview.calls.includes("check")')
        await capture('upgrade-ineligible-' + width)
      }
      await click('[aria-label="Close settings"]')
      await until('!document.querySelector(".settings-page")')
    }
    result.calls = await read('window.remoteUpgradePreview.calls'); result.passed = true
  } catch (error) {
    result.error = error.stack; process.exitCode = 1
    if (win && !win.isDestroyed()) {
      result.lastRead = await win.webContents.executeJavaScript('({text:document.body.innerText,calls:window.remoteUpgradePreview?.calls})')
      fs.writeFileSync(path.join(evidence, 'failed.png'), (await win.capturePage()).toPNG())
    }
  }
  finally {
    fs.writeFileSync(path.join(evidence, 'capture.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.quit()
  }
})
