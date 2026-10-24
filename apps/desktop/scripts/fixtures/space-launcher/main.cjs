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
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}))`), true, 'Native click hits the intended target: '+selector)
      for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await paint()
    }
    const wheel = async (deltaY) => {
      const point = await evaluate(`(()=>{const r=document.querySelector('.agent-catalog').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseWheel',...point,deltaY,deltaX:0})
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
      await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',x:width-10,y:10}); await paint()
    }
    await window.loadFile(html)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait('Boolean(window.spaceLauncher && document.querySelector(".launch-surface"))')
    await evaluate('launchpad.motes()'); await evaluate('spaceLauncher.clearPrompt()'); await paint()
    const original = await evaluate('launchpad.facts()')
    for (const [name, width, height, theme] of [['wide-dark',1180,850,'dark'],['wide-light',1180,850,'light'],['narrow-dark',460,760,'dark'],['short-dark',840,430,'dark']]) {
      await viewport(width,height); await evaluate(`launchpad.scene({theme:${JSON.stringify(theme)}});spaceLauncher.theme(${JSON.stringify(theme)})`); await paint(); await evaluate('document.querySelector(".launch-surface").scrollTop = 0'); await paint()
      const geometry = await evaluate(`(()=>{const s=document.querySelector('.launch-surface'),c=s.querySelector('.launcher-composer'),b=s.querySelector('.launcher-launch-button');return{width:s.clientWidth,scrollWidth:s.scrollWidth,composer:c.getBoundingClientRect().toJSON(),body:s.querySelector('.surface-state__body').getBoundingClientRect().toJSON(),live:c.closest('[role="status"],[aria-live]')!==null,button:b.getBoundingClientRect().toJSON(),choices:s.querySelectorAll('.agent-pick[data-executor-id]').length}})()`)
      assert.equal(geometry.width,geometry.scrollWidth,'No horizontal overflow')
      assert.ok(geometry.composer.width > geometry.body.width * .9, 'Composer retains a usable full-width input')
      assert.equal(geometry.live,false,'Editing is outside live status announcements'); assert.equal(geometry.choices,6)
      assert.equal(await evaluate('Boolean(document.querySelector(".agent-catalog__scroll"))'), false, 'No extra scrolling action row')
      assert.equal(await evaluate('document.querySelector(".agent-catalog").dataset.overflowAfter'), 'false', 'Fitting choices have no false continuation')
      const actions = await evaluate(`(()=>{const m=document.querySelector('.launcher-mote__actions').getBoundingClientRect(),f=document.querySelector('.launch-surface__footer').getBoundingClientRect();return{left:m.left,footerLeft:f.left}})()`)
      assert.ok(Math.abs(actions.left-actions.footerLeft)<1, 'Mote discussion entry stays on the left')
      assert.equal(await evaluate('document.querySelector(".launcher-mote__create").textContent.trim()'), 'Discuss with')
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".launcher-mote__actions")).borderTopWidth'), '1px', 'The whole Mote action has a visible button boundary')
      receipt.checks.push({name,geometry}); await frame(name)
      if (name === 'narrow-dark' || name === 'short-dark') {
        await evaluate(`document.querySelector('[aria-label="Expand Note"]').scrollIntoView({block:'nearest'})`); await frame(name+'-tools')
      }
    }
    await viewport(840,650); await evaluate('spaceLauncher.theme("dark");launchpad.scene()'); await paint()
    await click('[aria-label="Agent prompt"]')
    await window.webContents.debugger.sendCommand('Input.insertText',{text:'Keep the original work and make the next step clear.'}); await paint()
    const draft = await evaluate('launchpad.facts().sourceDraft'); assert.match(draft,/Keep the original work/)
    assert.equal(await evaluate('document.querySelector(".launcher-mote__create").textContent.trim()'),'Discuss with')
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
    await click('[aria-label^="Choose Mote:"]')
    await click('[role="menuitem"]:nth-child(2)')
    const selectedMote = await evaluate('document.querySelector(".launcher-mote__target").textContent.trim()')
    assert.ok(selectedMote.includes('long readable name'))
    for (const [name,width,height,theme] of [['catalog-16-dark',1180,850,'dark'],['catalog-16-light',1180,850,'light'],['catalog-16-narrow',460,760,'dark'],['catalog-16-short',840,430,'dark']]) {
      await viewport(width,height); await evaluate(`launchpad.scene({executorCount:16,theme:${JSON.stringify(theme)}});spaceLauncher.theme(${JSON.stringify(theme)})`); await paint()
      await click('.agent-pick'); assert.equal(await evaluate('document.querySelector(".agent-pick").getAttribute("aria-pressed")'), 'true')
      await evaluate('document.querySelector(".launch-surface").scrollTop=0;document.querySelector(".agent-catalog").scrollTop=0'); await paint()
      const overflowing = await evaluate('document.querySelector(".agent-catalog").scrollHeight > document.querySelector(".agent-catalog").clientHeight + 1')
      assert.equal(await evaluate('document.querySelector(".agent-catalog").dataset.overflowAfter'), String(overflowing), 'Continuation is visible before scrolling')
      assert.equal(await evaluate('document.querySelector(".agent-catalog").dataset.overflowBefore'), 'false')
      const fade = await evaluate('parseFloat(getComputedStyle(document.querySelector(".agent-catalog")).getPropertyValue("--catalog-fade-bottom"))')
      assert.equal(fade > 0, overflowing, 'The actual edge fade follows the scroll boundary')
      await frame(name+'-start')
      if (overflowing) {
        for (let page = 0; page < 20; page++) {
          if (await evaluate('document.querySelector(".agent-catalog").dataset.overflowAfter === "false"')) break
          const before = await evaluate('document.querySelector(".agent-catalog").scrollTop')
          await wheel(await evaluate('document.querySelector(".agent-catalog").clientHeight'))
          assert.ok(await evaluate(`document.querySelector('.agent-catalog').scrollTop > ${before}`), 'Native wheel reaches hidden Agents')
        }
        assert.equal(await evaluate('document.querySelector(".agent-catalog").dataset.overflowAfter'), 'false')
        assert.equal(await evaluate('document.querySelector(".agent-catalog").dataset.overflowBefore'), 'true')
        assert.equal(await evaluate('parseFloat(getComputedStyle(document.querySelector(".agent-catalog")).getPropertyValue("--catalog-fade-bottom"))'), 0, 'The final row is not faded')
      }
      const facts = await evaluate(`(()=>{const s=document.querySelector('.launch-surface'),c=s.querySelector('.agent-catalog'),p=s.querySelector('.launcher-composer'),last=c.querySelector('.agent-pick:last-child');return{count:c.querySelectorAll('.agent-pick[data-executor-id]').length,gap:p.getBoundingClientRect().top-c.getBoundingClientRect().bottom,lastBottom:last.getBoundingClientRect().bottom,catalogBottom:c.getBoundingClientRect().bottom,scrollTop:c.scrollTop,scrollHeight:c.scrollHeight,clientHeight:c.clientHeight,width:s.clientWidth,scrollWidth:s.scrollWidth,background:getComputedStyle(s).backgroundImage,target:s.querySelector('.launcher-mote__target').textContent.trim(),warmRun:launchpad.facts().warmRun,originalWarmRun:launchpad.facts().originalWarmRun}})()`)
      assert.equal(facts.count,16); assert.equal(facts.width,facts.scrollWidth); assert.ok(facts.gap>=8,'Catalog scroll ends before the input gap'); assert.ok(facts.lastBottom<=facts.catalogBottom+1,'The last candidate remains readable at scroll end'); assert.equal(facts.warmRun,facts.originalWarmRun); assert.equal(facts.target,selectedMote); assert.ok(facts.background.includes('url('),'The original banner is consumed by the product surface')
      receipt.checks.push({name,facts}); await frame(name)
      await click('.agent-pick:last-child')
      assert.equal(await evaluate('document.querySelector(".agent-pick:last-child").getAttribute("aria-pressed")'), 'true', 'The last Agent remains selectable')
      assert.equal(await evaluate('launchpad.facts().sourceDraft'),draft, 'Browsing and choosing preserve the original prompt')
      if (overflowing) {
        await wheel(-10000)
        assert.equal(await evaluate('document.querySelector(".agent-catalog").scrollTop'), 0, 'Native wheel returns to the first choices')
      }
      await evaluate('document.querySelector(".agent-pick").focus()')
      for (let index=1; index<16; index++) {
        for (const type of ['keyDown','keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      }
      await paint()
      assert.equal(await evaluate('document.activeElement === document.querySelector(".agent-pick:last-child")'), true, 'Keyboard reaches the final Agent without an extra scrolling control')
      const keyboard = await evaluate(`(()=>{const c=document.querySelector('.agent-catalog').getBoundingClientRect(),a=document.activeElement.getBoundingClientRect();return{top:a.top,bottom:a.bottom,catalogTop:c.top,catalogBottom:c.bottom}})()`)
      assert.ok(keyboard.top>=keyboard.catalogTop && keyboard.bottom<=keyboard.catalogBottom+1, 'Keyboard focus reveals the complete final choice')
    }
    await viewport(1180,850); await evaluate('launchpad.scene({executorCount:16});spaceLauncher.theme("dark")'); await paint()
    assert.equal(await evaluate('document.querySelector(".agent-catalog").dataset.overflowAfter'), 'false', 'All choices fit after expanding the Region')
    assert.equal(await evaluate('document.activeElement.matches(".agent-pick[aria-pressed=true]")'), true, 'Resizing preserves focus on the original choice')
    await frame('catalog-expanded-keyboard-focus')
    await evaluate('document.querySelector(".launcher-mote__target").focus()')
    for (const expected of ['launcher-resume-trigger','launcher-launch-button']) {
      for (const type of ['keyDown','keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      assert.equal(await evaluate(`document.activeElement.classList.contains(${JSON.stringify(expected)})`),true,'Keyboard follows the visible action sequence')
    }
    await frame('actions-keyboard-focus')
    await evaluate('spaceLauncher.failAvailability()'); await paint()
    assert.equal(await evaluate('document.querySelector(".launcher-launch-button").disabled'),false)
    assert.ok(await evaluate('document.querySelector(".launch-surface").innerText.includes("Check again")'))
    await frame('availability-failed')
    receipt.checks.push({name:'Selected Mote, actions keyboard sequence and failed observation preserve original draft',draft:await evaluate('launchpad.facts().sourceDraft'),selectedMote})
    await viewport(360,520); await evaluate('launchpad.scene({long:true,theme:"light"});spaceLauncher.theme("light")'); await paint()
    await click('[aria-label="Runtime environment"]'); await frame('narrow-environment'); await escape()
    await viewport(1180,850); await evaluate('launchpad.settings()'); await paint(); await frame('settings-reference')
    receipt.passed = true
  } catch (error) {
    receipt.failure = {message:error.message,stack:error.stack}
    if (window) await fs.writeFile(path.join(output,'failure.png'),(await window.webContents.capturePage()).toPNG())
  } finally {
    let exitCode = receipt.passed ? 0 : 1
    try { await fs.writeFile(path.join(output,'ui-receipt.json'),JSON.stringify(receipt,null,2)) }
    catch (error) { console.error(error); exitCode = 1 }
    finally { window?.destroy(); app.exit(exitCode) }
  }
})
