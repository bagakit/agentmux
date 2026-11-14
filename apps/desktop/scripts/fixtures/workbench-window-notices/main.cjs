const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, mode] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.disableHardwareAcceleration()
let win
const receipt = { passed: false, frames: [], console: [], boundary: 'Compiled actual App, WorkbenchWindowNotices, shared disclosure, original production CSS. Controlled API receipt only; no user profile or real Session/Run controlled.' }
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1360, height: 820, useContentSize: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, _level, message) => receipt.console.push(message.slice(0,1200)))
    const read = code => win.webContents.executeJavaScript(code)
    await win.loadFile(html)
    const wait = async expression => {
      const end = Date.now() + 10000
      do { if (await read(expression)) return; await new Promise(r => setTimeout(r, 30)) } while (Date.now() < end)
      throw new Error('Window notice proof did not settle: ' + expression)
    }
    const settle = () => read('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await wait('window.windowNoticeProof && document.querySelector(".window-status-bar")')
    await settle()
    const baseline = await read('windowNoticeProof.facts()')
    await read('windowNoticeProof.fail()'); await settle()
    const failed = await read('windowNoticeProof.facts()')
    assert.deepEqual(failed.shell, baseline.shell, 'Window warning must preserve the complete original App geometry')
    assert.deepEqual(failed.footer, baseline.footer, 'Window warning stays inside the original status bar')
    assert.ok(failed.trigger?.height > 0, 'Window action remains discoverable in the existing status bar')
    assert.equal(failed.panelOpen, false, 'Window diagnostics open only after deliberate disclosure')
    assert.equal(failed.tabsKept, true); assert.equal(failed.draftsKept, true); assert.equal(failed.layoutsKept, true); assert.deepEqual(failed.calls, [])
    await read('windowNoticeProof.confirm(true)'); await settle()
    assert.ok((await read('windowNoticeProof.facts()')).trigger?.height>0, 'An unrelated success cannot settle the original window action')
    const capture = async file => {
      await read('Promise.all([document.fonts.ready,...document.getAnimations().filter(a=>Number.isFinite(a.effect.getTiming().iterations)).map(a=>a.finished.catch(()=>{}))])')
      await settle()
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); receipt.frames.push(file)
    }
    const click = async selector => {
      const r = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...r }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...r }); await settle()
    }
    if (mode === 'mutation') { receipt.passed = true; return }
    await capture('wide-collapsed-dark.png')
    await click('.workbench-window-notice .service-disclosure__trigger')
    await wait('document.querySelector(".workbench-window-notice .service-disclosure__details").matches(":popover-open")')
    const opened = await read('windowNoticeProof.facts()')
    assert.ok(opened.panel.x+opened.panel.width>=opened.trigger.x,'Window-level details stay horizontally anchored to their trigger')
    await capture('wide-open-dark.png')
    await click('.workbench-window-notice__technical > summary')
    await capture('wide-diagnostics-dark.png')
    for (const [width,height,theme] of [[640,520,'dark'],[640,520,'light'],[1100,700,'light']]) {
      win.setContentSize(width,height); await read(`windowNoticeProof.theme(${JSON.stringify(theme)})`); await settle()
      const facts = await read('windowNoticeProof.facts()')
      assert.equal(facts.shell.y,0); assert.equal(facts.shell.height,height)
      assert.ok(facts.footer.bottom<=height+1, 'Footer remains inside the viewport')
      assert.ok(facts.panel.x>=0 && facts.panel.bottom<=height && facts.panel.width<=width,'Open details fit the actual viewport')
      assert.ok(facts.panel.height<=Math.min(height*.7,576)+1,'Available height preserves the shared bounded reading limit')
      assert.equal(facts.scrollable,true,'Long original diagnostics use the bounded disclosure scroll owner')
      await capture(`${width}-diagnostics-${theme}.png`)
    }
    await click('.workbench-window-notice .service-disclosure__heading .service-disclosure__close')
    const collapsed = await read('windowNoticeProof.facts()')
    assert.equal(collapsed.panelOpen,false); assert.ok(collapsed.trigger.width>0, 'Read warning remains inspectable')
    assert.equal(collapsed.tabsKept,true); assert.equal(collapsed.draftsKept,true); assert.deepEqual(collapsed.calls,[])
    await capture('read-collapsed-light.png')
    await read('windowNoticeProof.confirm()'); await settle()
    const confirmed = await read('windowNoticeProof.facts()')
    assert.equal(confirmed.trigger,null,'Exact original confirmation retires its own warning')
    assert.deepEqual(confirmed.shell,collapsed.shell)
    await read('windowNoticeProof.staleCall()'); await settle()
    assert.equal((await read('windowNoticeProof.facts()')).trigger,null,'A stale call response cannot revive its newer confirmed receipt')
    await read('windowNoticeProof.fail()'); await settle()
    await read('windowNoticeProof.holdInspect(); document.querySelector(".workbench-window-notice__technical button").click()')
    await read('windowNoticeProof.completeInspect()'); await settle()
    assert.equal((await read('windowNoticeProof.facts()')).trigger,null,'A stale Inspect response cannot revive its newer confirmed receipt')
    receipt.geometry = {baseline,failed,collapsed}
    receipt.passed = true
  } catch(error) {
    receipt.failure = {message:error.message,stack:error.stack}
    if(win&&!win.isDestroyed()) await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence,'ui-receipt.json'),JSON.stringify(receipt,null,2)); app.exit(receipt.passed?0:1)
  }
})
