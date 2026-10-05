const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData')); app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const receipt = { passed: false, frames: [], actions: [], boundary: 'Complete current Source App and original workbench/Region/Goal detail; static original preview transport and business facts. Actual Core input/restart belongs to separate product/native proof. User Run untouched.' }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const read = code => win.webContents.executeJavaScript(code)
  const until = async code => { const end = Date.now() + 15000; do { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < end); throw Error('UI did not settle: ' + code) }
  const settle = async () => { await read("Promise.all(document.getAnimations().filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))"); await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
  const click = async expression => {
    await settle()
    const point = await read(`(()=>{const element=${expression};if(!element)throw Error('Missing actual control');const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,label:element.getAttribute('aria-label')??element.textContent,matched:hit===element||element.contains(hit)}})()`)
    receipt.actions.push(point); assert.equal(point.matched, true, JSON.stringify(point))
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
  }
  const frame = async (width, theme, mode) => {
    await settle()
    const geometry = await read(`(()=>{const header=document.querySelector('.agent-region-header'),r=header?.getBoundingClientRect(),badge=document.querySelector('.region-current-demand'),menu=document.querySelector('.region-current-demand-menu');return {header:r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom}:null,badge:badge?.textContent??null,menu:menu?.textContent??null,bodyOverflow:document.body.scrollWidth-innerWidth,title:badge?.querySelector('button')?.getAttribute('title'),headerName:header?.querySelector('.agent-region-header__name')?.textContent,more:Boolean(header?.querySelector('.agent-region-header__more'))}})()`)
    assert.ok(geometry.bodyOverflow <= 1, JSON.stringify(geometry)); assert.equal(geometry.headerName, 'Original Agent'); assert.equal(geometry.more, true)
    if (!mode.includes('detail')) { assert.ok(geometry.header && geometry.header.left >= -1 && geometry.header.right <= width + 1); if (mode === 'history-only') assert.equal(geometry.badge, null); else assert.ok(geometry.badge) }
    const file = `${width}-${theme}-${mode}.png`; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); receipt.frames.push({ width, theme, mode, file, geometry })
  }
  try {
    await win.loadFile(html); await until('!!window.currentDemandProbe && !!document.querySelector(".agent-region-header")')
    for (const width of [1280, 420]) {
      win.setContentSize(width, 960)
      for (const theme of ['light', 'dark']) {
        await read(`window.currentDemandProbe.theme(${JSON.stringify(theme)})`)
        for (const mode of ['current', 'long', 'ambiguous', 'unknown', 'history-only']) {
          await read(`window.currentDemandProbe.seed(${JSON.stringify(mode)})`)
          await until(`!!document.querySelector('.agent-region-header') && ${mode === 'history-only' ? '!document.querySelector(".region-current-demand")' : '!!document.querySelector(".region-current-demand")'}`)
          await frame(width, theme, mode)
          if (mode === 'ambiguous' || mode === 'unknown') {
            await click("document.querySelector('.region-current-demand button')"); await until('!!document.querySelector(".region-current-demand-menu")'); await frame(width, theme, mode + '-menu')
            const before = await read('window.currentDemandProbe.facts()')
            await click("[...document.querySelectorAll('.region-current-demand-menu [role=menuitem]')].find(element=>element.textContent.includes('Keep the original work ready to continue'))")
            await until('!!document.querySelector(".goals-detail")'); const after = await read('window.currentDemandProbe.facts()')
            assert.equal(after.selected, 'links-goal'); for (const key of ['control', 'tabs', 'layouts', 'draft']) assert.deepEqual(after[key], before[key], key + ' must survive exact Goal focus')
            receipt.navigation ??= []; receipt.navigation.push({ width, theme, mode, before, after })
          }
        }
      }
    }
    assert.equal(receipt.frames.length, 28); receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack }; receipt.page = await read('document.body.innerText'); fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(receipt, null, 2) + '\n'); win.destroy(); app.exit(receipt.passed ? 0 : 1)
})
