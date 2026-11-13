const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.whenReady().then(async () => {
  const result = { images: [], passed: false, boundary: 'Production SettingsPanel, HostSettingsPane and install view; controlled DTOs, no SSH or user Run changes.' }
  let win
  try {
    win = new BrowserWindow({ width: 1280, height: 1000, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const read = code => win.webContents.executeJavaScript(code)
    const until = async code => { const end = Date.now() + 15000; do { if (await read(code)) return; await new Promise(done => setTimeout(done, 40)) } while (Date.now() < end); throw Error(code) }
    const click = async selector => {
      await until('document.querySelector(' + JSON.stringify(selector) + ')?.checkVisibility()')
      await read('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"nearest"})')
      const r = await read('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
      for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(r.x),y:Math.round(r.y)})
    }
    const capture = async name => {
      await read('document.querySelector("[data-host-install]").scrollIntoView({block:"end"})')
      await new Promise(done => setTimeout(done, 250))
      const overflow = await read('document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".host-install *")].some(el=>el.scrollWidth>el.clientWidth+2 && getComputedStyle(el).display!=="inline")')
      assert.equal(overflow, false, 'Installation surface overflows')
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file),(await win.capturePage()).toPNG()); result.images.push({path:file})
    }
    await until('window.installPreview?.ready')
    for (const width of [1280, 640]) {
      win.setContentSize(width,1000); win.showInactive()
      for (const mode of ['ready','unknown']) {
        await read('window.installPreview.setMode(' + JSON.stringify(mode) + ')')
        await click('[data-install-check]')
        await until('document.querySelector("[data-install-confirm]")')
        await capture('review-' + mode + '-' + width)
        await click('input[value="systemd"]')
        await capture('user-service-' + mode + '-' + width)
        await click('[data-install-confirm]')
        if (mode === 'ready') {
          await until('document.querySelector(".host-install__operation")')
          await new Promise(done => setTimeout(done, 1800))
          await capture('installing-' + width)
          await read('window.installPreview.finish()')
          await until('document.querySelector(".host-install__operation h4")?.textContent==="Core installed"')
          await capture('completed-' + width)
        } else {
          await until('document.querySelector(".host-install__operation h4")?.textContent==="Original install needs checking"')
          await capture('unknown-' + width)
        }
      }
    }
    result.passed = true
  } catch(error) { result.error = error.stack ?? String(error) }
  finally { if(win) win.destroy(); fs.writeFileSync(path.join(evidence,'capture.json'),JSON.stringify(result,null,2)); app.exit(result.passed?0:1) }
})
