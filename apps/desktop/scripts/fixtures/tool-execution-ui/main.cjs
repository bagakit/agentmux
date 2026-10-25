const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, profile, output, phase = 'capture'] = process.argv.slice(2)
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let window
const receipt = { phase, pid: process.pid, frames: [], checks: [], console: [], boundary: 'Isolated real Renderer with controlled external API facts.' }
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ show: false, width: 1180, height: 850,
      webPreferences: { backgroundThrottling: false, sandbox: false, preload: path.join(__dirname, 'preload.cjs'), additionalArguments: phase === 'restart' ? ['--launchpad-boot=' + path.join(profile, 'boot.json')] : [] } })
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
    await window.loadFile(html, { query: { phase } })
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait('Boolean(window.toolExecutionUI && document.querySelector(".launch-surface"))')
    if (phase === 'restart') {
      const expected = JSON.parse(await fs.readFile(path.join(output, 'expected-durable.json'), 'utf8'))
      const before = await evaluate('launchpad.readBeforeFixtureSetup')
      assert.deepEqual(before.tabs[expected.tabId].regions[expected.regionId], expected.surface, 'Production initialization restores the exact original Launcher and dual selection')
      assert.equal(before.sourceDraft, expected.draft, 'Original draft survives actual process restart')
      assert.deepEqual(before.layouts[expected.workspaceId], expected.layout, 'Original display topology and focus survive actual process restart')
      await wait(`document.querySelector('[data-executor-id="codex"][aria-pressed="true"]') !== null`)
      assert.equal(await evaluate(`document.querySelector('.launcher-launch-button').disabled`), false, 'The same Host inventory remains usable after restart')
      assert.match(await evaluate(`document.querySelector('[data-executor-id="codex"]').textContent`), /Codex · research/u)
      await frame('restarted-original-launcher'); receipt.checks.push({ restart: true, expected, before }); receipt.passed = true; return
    }
    const original = await evaluate('toolExecutionUI.facts()')
    await click('[aria-label="Runtime environment"]'); await frame('ordinary-project-picker')
    await click('.launcher-execution-mode input'); await escape()
    await click('[aria-label="Agent runtime environment"]')
    await evaluate(`(()=>{const select=document.querySelector('[aria-label="Machine for new session"]');select.value='agent-server';select.dispatchEvent(new Event('change',{bubbles:true}))})()`); await paint()
    await frame('agent-runtime-picker'); await click('[data-workspace-id="agent-home"]')
    await wait(`document.querySelector('[data-executor-id="codex"][aria-pressed="true"]') !== null`)
    const selected=await evaluate('toolExecutionUI.facts()'); assert.equal(selected.surface.workspaceId,original.surface.workspaceId);assert.equal(selected.surface.agentWorkspaceId,'agent-home');assert.equal(selected.draft,original.draft);assert.deepEqual(selected.warm,original.warm)
    await evaluate('launchpad.flush()')
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(path.join(profile, 'boot.json'), JSON.stringify(await evaluate('launchpad.bootFacts()')))
    await fs.writeFile(path.join(output, 'expected-durable.json'), JSON.stringify({ ...selected, tabId: await evaluate('launchpad.tabId'), regionId: await evaluate('launchpad.regionId'), workspaceId: await evaluate('launchpad.workspaceId'), layout: await evaluate('launchpad.facts().layout') }))
    for (const [name,width,height] of [['split-wide',1180,850],['split-narrow',460,760],['split-short',840,430]]) {
      await viewport(width,height); await evaluate(`document.querySelector('.launch-surface').scrollTop=0`);await paint()
      assert.equal(await evaluate(`document.querySelector('.launch-surface').scrollWidth > document.querySelector('.launch-surface').clientWidth`),false,'No horizontal overflow')
      assert.equal(await evaluate(`(()=>{const button=document.querySelector('.launcher-launch-button').getBoundingClientRect(),surface=document.querySelector('.launch-surface').getBoundingClientRect();return button.bottom <= surface.bottom && button.top >= surface.top})()`),true,'The complete primary action fits the initial viewport')
      await frame(name)
    }
    await viewport(1180,850); await evaluate('toolExecutionUI.discoveryFailure()');await paint();await frame('discovery-unavailable')
    assert.equal(await evaluate(`document.querySelector('.launcher-launch-button').disabled`),false,'Read failure does not disable a retained exact Agent configuration')
    await evaluate('toolExecutionUI.notice()');await wait(`document.querySelector('[aria-label="View service notice: Tool execution"]') !== null`)
    await frame('connected-capability-notices');await click('[aria-label="View service notice: Tool execution"]');await frame('capability-details-wide')
    await escape();await viewport(460,760);await click('[aria-label="View service notice: Tool execution"]');await frame('capability-details-narrow')
    await escape();await evaluate('toolExecutionUI.unknown()');await paint();await frame('observation-unavailable');await click('[aria-label="View service notice: Tool execution"]');await frame('observation-unavailable-details')
    receipt.passed=true
  } catch(error) { receipt.failure={message:error.message,stack:error.stack};process.exitCode=1 }
  finally { await fs.writeFile(path.join(output,phase === 'restart' ? 'restart-receipt.json' : 'ui-receipt.json'),JSON.stringify(receipt,null,2));if(window&&!window.isDestroyed()){window.webContents.session.flushStorageData();window.destroy();}app.exit(receipt.passed?0:1) }
})
