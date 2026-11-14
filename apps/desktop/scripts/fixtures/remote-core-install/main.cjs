const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.whenReady().then(async () => {
  const result = { images: [], keyboardFocus: [], passed: false, boundary: 'Production SettingsPanel, HostSettingsPane and install view; controlled DTOs, no SSH or user Run changes.' }
  let win
  try {
    win = new BrowserWindow({ width: 1280, height: 1000, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const read = code => win.webContents.executeJavaScript(code)
    const until = async code => { const end = Date.now() + 15000; do { if (await read(code)) return; await new Promise(done => setTimeout(done, 40)) } while (Date.now() < end); throw Error(code) }
    const click = async selector => {
      await until('document.querySelector(' + JSON.stringify(selector) + ')?.checkVisibility()')
      await read('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"nearest"})')
      const r = await read('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
      for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(r.x),y:Math.round(r.y)})
    }
    const key = async keyCode => {
      for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode})
      await new Promise(done => setTimeout(done, 25))
    }
    const assertRadioFocus = async (value, width) => {
      const state = await read(`(() => {
        const radio=document.activeElement, label=radio.closest('.host-install__choice')
        if (!label || !radio.matches('input[type="radio"]')) return null
        const controlStyle=getComputedStyle(radio), labelStyle=getComputedStyle(label)
        return {value:radio.value,checked:radio.checked,focusVisible:radio.matches(':focus-visible'),selected:label.dataset.selected,
          outline:[controlStyle.outlineStyle,controlStyle.outlineWidth,controlStyle.outlineOffset],
          shadows:[controlStyle.boxShadow,labelStyle.boxShadow],labelOutline:labelStyle.outlineStyle}
      })()`)
      assert.ok(state?.value===value && state.checked && state.focusVisible && state.selected==='true',
        'Keyboard focuses the selected native installation radio: '+JSON.stringify(state))
      assert.deepEqual(state.outline,['solid','2px','2px'],'The installation radio has one native focus outline')
      assert.equal(state.labelOutline,'none','The installation card does not add a second keyboard focus outline')
      assert.deepEqual(state.shadows,['none','none'])
      result.keyboardFocus.push({width,...state})
    }
    const capture = async name => {
      await read('document.querySelector("[data-host-install]").scrollIntoView({block:"end"})')
      await new Promise(done => setTimeout(done, 250))
      const overflow = await read('document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".host-install *")].some(el=>el.scrollWidth>el.clientWidth+2 && getComputedStyle(el).display!=="inline")')
      assert.equal(overflow, false, 'Installation surface overflows')
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG()); result.images.push({path:file})
    }
    await until('window.installPreview?.ready')
    for (const width of [1280, 640]) {
      win.setContentSize(width,1000)
      await until(`innerWidth===${width}&&innerHeight===1000`)
      for (const mode of ['ready','unknown']) {
        const revision = await read('window.installPreview.setMode(' + JSON.stringify(mode) + ')')
        await until(`window.installPreview.revision===${revision}`)
        await click('[data-upgrade-action]')
        await until('document.querySelector("[data-install-confirm]")?.disabled===false')
        await capture('review-' + mode + '-' + width)
        if (mode === 'ready') {
          for (let step=0;step<60&&!await read('document.activeElement.matches(".host-install__choice input:focus-visible")');step++) await key('Tab')
          await assertRadioFocus('start-script', width)
          await capture('review-keyboard-focus-' + width)
          await key('Right')
          await assertRadioFocus('systemd', width)
        } else await click('input[value="systemd"]')
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
    assert.equal(result.keyboardFocus.length,4,'Both native radio options are keyboard verified at both viewport widths')
    result.passed = true
  } catch(error) { result.error = error.stack ?? String(error) }
  finally { if(win) win.destroy(); fs.writeFileSync(path.join(evidence,'capture.json'),JSON.stringify(result,null,2)); app.exit(result.passed?0:1) }
})
