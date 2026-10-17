const { app, BrowserWindow } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const directory = process.env.BROWSER_USE_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(done => setTimeout(done, ms))
const stage = value => writeFileSync(join(directory, 'stage.json'), JSON.stringify({ stage: value, pid: process.pid }))
stage('bootstrap')
let win
const receipt = { captureOnly: true, aestheticReview: 'not-performed', realSettingsComponents: true, fixtureConfigOnly: true, userDataTouched: false, screenshots: [] }
app.whenReady().then(async () => {
  stage('app-ready')
  win = new BrowserWindow({ width: 1250, height: 940, show: false, title: 'Browser use · private settings review', webPreferences: { contextIsolation: true, nodeIntegration: false } })
  stage('window-created')
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer:', details.message) })
  win.webContents.debugger.attach('1.3')
  const evaluate = async expression => { const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  const ready = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100) } throw new Error('Private visual document not ready: ' + expression) }
  stage('loading-document')
  await win.loadFile(process.env.BROWSER_USE_VISUAL_HTML)
  stage('document-loaded')
  await ready('Boolean(window.browserUseVisual && document.querySelector(".browser-agent-preview__effects")?.shadowRoot?.querySelector(".amux-browser-agent-glow"))')
  stage('renderer-ready')
  win.showInactive()
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing real control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    await wait(80)
  }
  const capture = async (name, width, height) => {
    win.setContentSize(width, height); await wait(250)
    const image = await win.webContents.capturePage()
    await writeFile(join(directory, name + '.png'), image.toPNG())
    const facts = await evaluate(`(()=>{const stage=document.querySelector('.browser-agent-preview__stage'),root=document.querySelector('.browser-agent-preview__effects').shadowRoot;return{width:innerWidth,height:innerHeight,stage:stage.getBoundingClientRect().toJSON(),glow:getComputedStyle(root.querySelector('.amux-browser-agent-glow')).boxShadow,overflow:document.documentElement.scrollWidth>innerWidth,save:document.querySelector('[data-settings-save-bar]').textContent}})()`)
    assert.equal(facts.overflow, false, 'Settings fits its actual viewport')
    receipt.screenshots.push({ name, file: name + '.png', ...facts })
  }
  const select = async (label, value) => {
    await evaluate(`(()=>{const e=document.querySelector('[aria-label="${label}"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await wait(100)
  }
  const edgePixel = async () => {
    const rect = await evaluate(`(()=>{const r=document.querySelector('.browser-agent-preview__stage').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+32),width:1,height:1}})()`)
    return [...(await win.webContents.capturePage(rect)).getBitmap().subarray(0,4)]
  }
  if (!process.env.BROWSER_USE_VISUAL_HANDOFF_ONLY) {
  await capture('wide-default', 1250, 900)
  const normal = await edgePixel()
  await select('Glow blend', 'screen'); const screen = await edgePixel()
  assert.notDeepEqual(normal, screen, 'Blend changes actual page-edge pixels, beyond an enum/CSS declaration')
  receipt.blend = { normal, screen, changedActualPixels: true }
  await select('Glow blend', 'normal')
  await click('[data-settings-field="showDiscussion"] input')
  await click('.browser-agent-preview__playback button:nth-child(2)')
  await capture('wide-discussion-draft', 1250, 900)
  await evaluate('browserUseVisual.appearance("light")')
  await capture('light-draft', 1250, 900)
  await evaluate('browserUseVisual.appearance("dark")')
  await select('Simulation page', 'dark'); await capture('dark-page', 1250, 900)
  await select('Simulation page', 'light')
  await capture('narrow-draft', 560, 850)
  await evaluate(`document.querySelector('[data-settings-field="glowWidth"]').scrollIntoView({block:'end'})`)
  await evaluate(`(()=>{const field=document.querySelector('[data-settings-field="glowWidth"]'),pane=document.querySelector('.settings-content__scroll:not([hidden])'),bar=document.querySelector('[data-settings-save-bar]');pane.scrollTop+=Math.max(0,field.getBoundingClientRect().bottom-bar.getBoundingClientRect().top+12)})()`)
  await capture('narrow-scrolled', 560, 850)
  const pinned = await evaluate(`(()=>{const p=document.querySelector('.browser-agent-preview').getBoundingClientRect(),f=document.querySelector('[data-settings-field="glowWidth"]').getBoundingClientRect();return{previewBottom:p.bottom,fieldBottom:f.bottom,fieldTop:f.top,previewTop:p.top}})()`)
  assert.ok(pinned.fieldTop >= pinned.previewBottom && pinned.fieldBottom < 800, 'Narrow adjustment and pinned preview remain visible together')
  await evaluate(`document.querySelector('[data-settings-pane="browser-agent-control"]').scrollIntoView({block:'start'})`)
  await capture('short-draft', 950, 580)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await capture('reduced-motion', 1250, 900)
  }
  const phases = process.env.BROWSER_USE_VISUAL_HANDOFF_ONLY ? ['completed', 'human'] : ['observing', 'script', 'navigating', 'waiting', 'completed', 'human']
  for (const phase of phases) {
    await select('Simulation state', phase)
    const state = await evaluate(`(()=>{const root=document.querySelector('.browser-agent-preview__effects').shadowRoot;return{
      cue:document.querySelector('.browser-agent-preview .browser-operation-status__cue')?.textContent,
      boundary:!!document.querySelector('.browser-agent-preview [data-browser-control-boundary]'),
      pointer:!!root.querySelector('.amux-browser-agent-pointer'),ripple:!!root.querySelector('.amux-browser-agent-ripple')}})()`)
    assert.equal(state.boundary, !['completed', 'human'].includes(phase), 'The simulation projects the exact control state')
    assert.equal(state.pointer, false, 'No invented target while reading, navigating, waiting or after handoff')
    assert.equal(state.ripple, false, 'No invented click while reading, navigating, waiting or after handoff')
    receipt.states ??= []
    receipt.states.push({ scenario: phase, state })
    await capture('state-' + phase, phase === 'waiting' ? 560 : 1250, phase === 'waiting' ? 850 : 900)
  }
  receipt.pid = process.pid; receipt.windowId = win.id; receipt.complete = true
}).catch(error => { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2)); if (win && !win.isDestroyed()) win.destroy(); app.quit()
})
