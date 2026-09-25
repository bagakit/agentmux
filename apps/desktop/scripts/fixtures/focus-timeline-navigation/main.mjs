import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
const [html, privateRoot, evidence, variant = 'known'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, controls: [], variant, frames: [], boundary: 'Compiled production Timeline/API/Store with isolated typed I/O. No Runtime, public Reader qualification, ordinary App restart or installation.' }
let win
// Use the existing Electron fixture lifecycle: do not hold ESM module
// evaluation open while waiting for the application's ready event.
app.whenReady().then(async () => {
try {
  win = new BrowserWindow({ width: 1440, height: 540, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html, { query: { variant } }); win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const until = async expression => { for (let i = 0; i < 200; i++) { const result = await win.webContents.executeJavaScript(expression); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${expression}`) }
  const state = () => win.webContents.executeJavaScript('navigationSceneState()')
  const point = selector => win.webContents.executeJavaScript(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing actual target');const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const click = async selector => { const position = await point(selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...position, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) }
  const wheel = async (deltaX, deltaY = 0, modifiers = 0) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...await point('.recent-focus__time-scale'), deltaX, deltaY, modifiers })
  const shot = async name => {
    await win.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const header = await win.webContents.executeJavaScript(`(()=>{const h=document.querySelector('.recent-focus__header'),r=h.getBoundingClientRect(),v=document.querySelector('.recent-focus__viewport').getBoundingClientRect();const controls=[...h.querySelectorAll('button,select,input')].map(n=>({name:n.getAttribute('aria-label'),r:n.getBoundingClientRect().toJSON()}));return{height:r.height,viewportHeight:v.height,controls}})()`)
    assert.equal(header.height, 28); assert.ok(header.viewportHeight >= 66)
    const image = `${variant}-${name}.png`; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
    actual.frames.push({ image, width: await win.webContents.executeJavaScript('innerWidth'), header, state: await state() })
  }
  await until('window.navigationSceneState && navigationSceneState().counts.catalog===1')
  await click('[aria-label="View input records"]')
  await win.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Input records Context"]');select.value='archive-navigation';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await until('navigationSceneState().inputs===91')
  actual.initial = await state(); assert.deepEqual(actual.initial.counts, { catalog: 1, page: 3, timeline: 1 })
  await click('[data-input-message-id]'); await until('!!document.querySelector("[data-input-preview-id]")')
  actual.preview = await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[data-input-preview-id]');window.navigationPreview=node;const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(text.textContent.includes('Original retained task'))break}if(!text)throw new Error('No real retained task text');const range=document.createRange();range.selectNodeContents(text);window.getSelection().removeAllRanges();window.getSelection().addRange(range);return{selection:window.getSelection().toString()}})()`)
  for (let i = 0; i < 100; i++) { await wheel(i % 2 ? -2 : 2); await click(`[aria-label="Zoom ${i % 2 ? 'in' : 'out'} Focus timeline"]`) }
  actual.after200 = await state(); assert.deepEqual(actual.after200.counts, actual.initial.counts)
  actual.preservation = await win.webContents.executeJavaScript(`({samePreview:window.navigationPreview===document.querySelector('[data-input-preview-id]'),selection:window.getSelection().toString(),draft:document.querySelector('#original-draft').value})`)
  assert.equal(actual.preservation.samePreview, true); assert.equal(actual.preservation.selection, actual.preview.selection); assert.equal(actual.preservation.draft, 'Keep the original draft')
  // Trusted Escape and native horizontal/Shift wheel remain independent of the reader.
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until('!document.querySelector(".recent-focus__message-preview")')
  const before = await state(); await wheel(100); await until(`navigationSceneState().start>${before.start}`)
  const after = await state(); await wheel(0, -100, 8); await until(`navigationSceneState().start<${after.start}`)
  actual.pan = { before, after, afterShift: await state(), trusted: true }
  await click('[aria-label="Return to current focus window"]')
  const keyboardZoom = async direction => {
    const target = await win.webContents.executeJavaScript(`(()=>{const button=document.querySelector('[aria-label="Zoom ${direction} Focus timeline"]');button.focus();return{active:document.activeElement===button,disabled:button.disabled}})()`)
    assert.equal(target.active, true); assert.equal(target.disabled, false)
    // Enter's native sequence includes the character event; a bare CDP keyDown
    // without text does not exercise the browser's button activation default.
    for (const type of ['rawKeyDown', 'char', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'char' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  }
  await keyboardZoom('in'); await until('navigationSceneState().hours===1')
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("[aria-label=\\"Zoom in Focus timeline\\"]").disabled'), true)
  await keyboardZoom('out'); await until('navigationSceneState().hours===4')
  actual.keyboard = { trustedEnter: true, zoomInHours: 1, zoomOutHours: 4 }
  await shot('wide')
  win.setContentSize(640, 360); await until('innerWidth===640'); await shot('narrow')
  actual.controls = (await state()).controls; assert.deepEqual(actual.controls, [])
  actual.passed = true
} catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, `${variant}-failure.png`), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, `${variant}-scene.json`), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
