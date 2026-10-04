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
      await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"nearest"})`)
      const rect = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) })
    }
    const capture = async name => {
      await read('Promise.all([...document.querySelectorAll("[data-host-upgrade] button")].flatMap(button=>button.getAnimations()).filter(animation=>animation.effect.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))')
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      await new Promise(done => setTimeout(done, 100))
      const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.capturePage()).toPNG())
      result.images.push({ path: file, width: await read('innerWidth'), height: await read('innerHeight') })
    }
    await until('window.remoteUpgradePreview?.ready && document.querySelector(".global-system-notices__trigger")')
    for (const width of [1440, 640]) {
      win.setContentSize(width, 950); win.showInactive(); win.webContents.focus()
      await until(`innerWidth === ${width}`)
      for (const mode of ['refusal', 'ready', 'unknown']) {
        await read(`window.remoteUpgradePreview.setMode(${JSON.stringify(mode)})`)
        const before = await read('window.remoteUpgradePreview.calls.filter(call=>call==="check").length')
        await click('.remote-core-upgrade-notices button')
        await until('document.querySelector("[data-resource-editor=build]")?.checkVisibility()')
        await until(`window.remoteUpgradePreview.calls.filter(call=>call==="check").length === ${before + 1}`)
        if (mode === 'refusal') await capture('checking-' + width)
        await read('window.remoteUpgradePreview.releaseCheck()')
        const status = mode === 'refusal' ? 'Automatic upgrade unavailable' : mode === 'ready' ? 'Ready to upgrade' : 'Upgrade result unconfirmed'
        await until(`document.querySelector("[data-host-upgrade]")?.innerText.includes(${JSON.stringify(status)})`)
        assert.equal(await read('document.querySelector(".host-upgrade__details").open'), false)
        assert.equal(await read('document.querySelector("[data-host-upgrade]").scrollWidth <= document.querySelector("[data-host-upgrade]").clientWidth + 1'), true)
        const buttonBefore = mode === 'ready' ? await read('(()=>{const button=document.querySelector("[data-upgrade-action]");const style=getComputedStyle(button);return {disabled:button.disabled,color:style.color,background:style.backgroundImage,opacity:style.opacity}})()') : undefined
        await capture(mode + '-collapsed-' + width)
        if (mode === 'ready') {
          const buttonAfter = await read('(()=>{const button=document.querySelector("[data-upgrade-action]");const style=getComputedStyle(button);return {disabled:button.disabled,color:style.color,background:style.backgroundImage,opacity:style.opacity,target:getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()}})()')
          assert.equal(buttonAfter.disabled, false)
          assert.equal(buttonAfter.opacity, '1')
          assert.equal(buttonAfter.color, 'rgb(12, 14, 18)')
          result.readyButtons ??= []; result.readyButtons.push({width,before:buttonBefore,settled:buttonAfter})
        }
        if (mode !== 'ready') {
          await click('.host-upgrade__details > summary')
          await until('document.querySelector(".host-upgrade__details").open')
          await read('document.querySelector(".host-upgrade__details").scrollIntoView({block:"end"})')
          const typography = await read(`(()=>{
            const message=document.querySelector('.host-upgrade__diagnostic-message'), title=document.querySelector('.host-upgrade__title > strong');
            return {messageFont:parseFloat(getComputedStyle(message).fontSize),titleFont:parseFloat(getComputedStyle(title).fontSize),
              fullSource:document.querySelector('.host-upgrade__facts code').textContent.length,
              pageOverflow:document.documentElement.scrollWidth>innerWidth,
              facts:[...document.querySelectorAll('.host-upgrade__facts dd')].map(el=>({width:el.clientWidth,scroll:el.scrollWidth}))}
          })()`)
          assert.equal(typography.fullSource, 40)
          assert(typography.messageFont <= typography.titleFont, 'Technical diagnosis regressed to oversized body typography')
          assert.equal(typography.pageOverflow, false)
          assert(typography.facts.every(item=>item.scroll<=item.width+1), 'Full technical identity overflowed its field')
          result.typography ??= []; result.typography.push({width,mode,...typography})
          await capture(mode + '-expanded-' + width)
          if (mode === 'refusal') {
            await click('[data-copy-upgrade-diagnostics]')
            await until('document.querySelector(".host-upgrade__copy-feedback")?.innerText.includes("Diagnostics copied")')
            assert.match(await read('window.remoteUpgradePreview.copied.at(-1)'), /Required Runtime protocol: 22/)
            assert.equal(await read('window.remoteUpgradePreview.calls.filter(call=>call==="check").length'), before + 1)
            await read('document.querySelector(".host-upgrade__details > summary").click()')
            await capture('diagnostics-copied-' + width)
          }
        }
        await click('[aria-label="Close settings"]')
        await until('!document.querySelector(".settings-page")')
      }
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
