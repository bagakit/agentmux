const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, profile, output] = process.argv.slice(2)
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let window
const receipt = { frames: [], checks: [], console: [], boundary: 'Isolated real Renderer with controlled external API facts.' }
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ show: false, width: 1180, height: 850,
      webPreferences: { backgroundThrottling: false, sandbox: false } })
    window.webContents.on('console-message', (_event, _level, message) => receipt.console.push(message.slice(0, 600)))
    const evaluate = async code => { receipt.lastEvaluation = code; return window.webContents.executeJavaScript(code, true) }
    const wait = async expression => {
      for (let i = 0; i < 250; i++) { if (await evaluate(expression)) return; await delay(40) }
      throw Error('Renderer condition absent: ' + expression)
    }
    const paint = async () => { await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); await delay(180) }
    const click = async selector => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`); await paint()
      const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await paint()
    }
    const escape = async () => {
      for (const type of ['keyDown','keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await paint()
    }
    const frame = async name => {
      await evaluate('document.fonts.ready.then(() => true)'); await paint()
      const file = name + '.png'
      await fs.writeFile(path.join(output, file), (await window.webContents.capturePage()).toPNG()); receipt.frames.push(file)
    }
    const viewport = async (width, height) => {
      await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false}); await paint()
    }
    await window.loadFile(html)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait('Boolean(window.spaceLauncher && document.querySelector(".launch-surface"))')
    await evaluate('spaceLauncher.clearPrompt()'); await paint()
    const original = await evaluate('launchpad.facts()')
    for (const [name, width, height, theme] of [['wide-dark',1180,850,'dark'],['wide-light',1180,850,'light'],['narrow-dark',460,760,'dark'],['short-dark',840,430,'dark']]) {
      await viewport(width,height); await evaluate(`launchpad.scene({theme:${JSON.stringify(theme)}});spaceLauncher.theme(${JSON.stringify(theme)})`); await paint(); await evaluate('document.querySelector(".launch-surface").scrollTop = 0'); await paint()
      const geometry = await evaluate(`(()=>{const s=document.querySelector('.launch-surface'),c=s.querySelector('.launcher-composer'),b=s.querySelector('.launcher-launch-button');return{width:s.clientWidth,scrollWidth:s.scrollWidth,composer:c.getBoundingClientRect().toJSON(),body:s.querySelector('.surface-state__body').getBoundingClientRect().toJSON(),live:c.closest('[role="status"],[aria-live]')!==null,button:b.getBoundingClientRect().toJSON(),choices:s.querySelectorAll('.agent-pick[data-executor-id]').length}})()`)
      assert.equal(geometry.width,geometry.scrollWidth,'No horizontal overflow')
      assert.ok(geometry.composer.width > geometry.body.width * .9, 'Composer retains a usable full-width input')
      assert.equal(geometry.live,false,'Editing is outside live status announcements'); assert.equal(geometry.choices,6)
      receipt.checks.push({name,geometry}); await frame(name)
      if (name === 'narrow-dark' || name === 'short-dark') {
        await evaluate(`document.querySelector('[aria-label="Expand Note"]').scrollIntoView({block:'nearest'})`); await frame(name+'-tools')
      }
    }
    await viewport(840,650); await evaluate('spaceLauncher.theme("dark");launchpad.scene()'); await paint()
    await click('[aria-label="Agent prompt"]')
    await window.webContents.debugger.sendCommand('Input.insertText',{text:'Keep the original work and make the next step clear.'}); await paint()
    const draft = await evaluate('launchpad.facts().sourceDraft'); assert.match(draft,/Keep the original work/)
    assert.equal(await evaluate('document.querySelector(".launcher-mote__create").textContent.trim()'),'Create with Mote')
    await click('[aria-label="Launch options"]'); await wait('Boolean(document.querySelector(".launch-refine__panel"))'); await frame('options-dark'); await click('.launch-refine__names input:last-of-type'); await frame('options-names'); await escape()
    assert.equal(await evaluate('launchpad.facts().sourceDraft'),draft)
    await click('[aria-label="Expand Browser"]'); await click('[aria-label="Browser address or search"]')
    await window.webContents.debugger.sendCommand('Input.insertText',{text:'local workbench'}); await paint()
    await click('[aria-label="Collapse Browser"]'); await wait(`!document.querySelector('[aria-label="Browser address or search"]')`)
    await click('[aria-label="Expand Browser"]')
    assert.equal(await evaluate(`document.querySelector('[aria-label="Browser address or search"]').value`),'local workbench')
    await click('[aria-label="Expand Note"]'); await evaluate('launchpad.editNote("A note kept beside the task.")'); await paint()
    await frame('tools-with-drafts')
    await click('[aria-label="Collapse Terminal"]'); await click('[aria-label="Expand Terminal"]')
    const current = await evaluate('launchpad.facts()')
    assert.equal(current.warmRun,original.warmRun); assert.equal(current.calls.stops.length,0)
    assert.equal(current.sourceDraft,draft); receipt.checks.push({name:'options and utilities preserve drafts and original Run',passed:true})
    await evaluate('launchpad.motes()'); await paint(); await click('[aria-label^="Choose Mote:"]'); await frame('mote-targets'); await escape()
    await viewport(360,520); await evaluate('launchpad.scene({long:true,theme:"light"});spaceLauncher.theme("light")'); await paint()
    await click('[aria-label="Runtime environment"]'); await frame('narrow-environment'); await escape()
    await viewport(1180,850); await evaluate('launchpad.settings()'); await paint(); await frame('settings-reference')
    receipt.passed = true
  } catch (error) {
    receipt.failure = {message:error.message,stack:error.stack}
    if (window) await fs.writeFile(path.join(output,'failure.png'),(await window.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(output,'ui-receipt.json'),JSON.stringify(receipt,null,2))
    window?.destroy(); app.exit(receipt.passed ? 0 : 1)
  }
})
