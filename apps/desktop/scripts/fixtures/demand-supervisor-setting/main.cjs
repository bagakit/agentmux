const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { passed: false, frames: [], boundary: 'Actual SettingsPanel and Goals pane with original preview API, platform UI adapter and shell styles; no installed application or user state.' }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1080, height: 880, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await win.loadFile(html)
    const read = code => win.webContents.executeJavaScript(code)
    const until = async code => { const end = Date.now() + 10000
      do { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < end)
      throw new Error('UI did not settle: ' + code)
    }
    const click = async expression => { const p = await read(`(() => { const n=${expression}; if (!n) throw new Error('Missing actual control'); const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p }) }
    await until('!!window.settingsProbe && !!document.querySelector("[data-settings-target=goals]")')
    await until('!!document.querySelector("[aria-label=\\"Use the requesting Agent as Supervisor\\"]")')
    for (const width of [1080, 420]) {
      win.setContentSize(width, 880)
      for (const theme of ['light', 'dark']) {
        await read(`window.settingsProbe.theme(${JSON.stringify(theme)})`)
        await until(`document.documentElement.dataset.appearance === ${JSON.stringify(theme)}`)
        await read(`document.querySelector('[aria-label="Use the requesting Agent as Supervisor"]').closest('section').scrollIntoView({block:'nearest'})`)
        await read('Promise.all(document.querySelector(".settings-page").getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations !== Infinity).map(a=>a.finished.catch(()=>{})))')
        await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const geometry = await read(`(() => { const c=document.querySelector('[aria-label="Use the requesting Agent as Supervisor"]'),r=c.getBoundingClientRect(),p=c.closest('[data-settings-pane]'),s=p.querySelector('[data-settings-save-bar]').getBoundingClientRect(); return {checked:c.checked,overflow:p.scrollWidth-p.clientWidth,checkboxHit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===c,saveBottom:s.bottom,footerTop:document.querySelector('.window-status-bar').getBoundingClientRect().top}; })()`)
        assert.equal(geometry.checked, true); assert.equal(geometry.checkboxHit, true); assert.ok(geometry.overflow <= 1); assert.ok(geometry.saveBottom <= geometry.footerTop+1)
        const file = `${width}-${theme}-goals.png`
        fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
        receipt.frames.push({ width, theme, file, geometry })
      }
    }
    await click('document.querySelector("[aria-label=\\"Use the requesting Agent as Supervisor\\"]")')
    await until('document.querySelector("[data-settings-pane=goals] [data-settings-save-bar]").textContent.includes("Unsaved changes")')
    await click('document.querySelector("[data-settings-pane=goals] [data-settings-save-bar] button")')
    await until('document.querySelector("[data-settings-pane=goals] [data-settings-save-bar]").textContent.includes("Changes saved")')
    assert.equal(await read('document.querySelector("[aria-label=\\"Use the requesting Agent as Supervisor\\"]").checked'), false)
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(receipt, null, 2)+'\n')
  win.destroy(); app.exit(receipt.passed ? 0 : 1)
})
