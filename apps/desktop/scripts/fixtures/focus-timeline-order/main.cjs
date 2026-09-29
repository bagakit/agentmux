const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, frames: [], controls: [], boundary: 'Compiled production Timeline/Store with isolated typed presentation I/O and trusted CDP. Not public Reader, actual Run, Runtime, App restart or installation.' }
let win
app.whenReady().then(async () => {
 try {
  win = new BrowserWindow({ width: 1200, height: 620, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html); win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const js = code => win.webContents.executeJavaScript(code)
  const until = async code => { for (let i = 0; i < 200; i++) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${code}`) }
  const point = selector => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===n}})()`)
  const click = async selector => { const p = await point(selector); assert.equal(p.hit, true, `Actual center hit: ${selector}`); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) }
  const wheel = async (deltaX, shift = false) => { const p = await point('.recent-focus__time-scale'); assert.equal(p.hit, true); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: shift ? 0 : deltaX, deltaY: shift ? deltaX : 0, modifiers: shift ? 8 : 0 }) }
  const state = () => js('orderSceneState()')
  const keys = value => value.projects.map(p => ({ key: p.key, tracks: p.tracks.map(t => t.id) }))
  const expected = [{ key: '["private","beta"]', tracks: ['d'] }, { key: '["private","alpha"]', tracks: ['b', 'c', 'a'] }]
  const shot = async (name, before) => { await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); const s = await state(); assert.deepEqual(keys(s), expected); assert.deepEqual(s.counts, before.counts); const image = `${name}.png`; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG()); actual.frames.push({ image, width: await js('innerWidth'), state: s }) }
  await until('window.orderSceneState && orderSceneState().counts.catalog===1')
  await click('[aria-label="View input records"]')
  await js(`(()=>{const s=document.querySelector('[aria-label="Input records Context"]');s.value='a';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until('orderSceneState().inputs===91'); await click('[data-input-message-id]')
  await until('!!document.querySelector("[data-input-preview-id]")')
  actual.initial = await state(); assert.deepEqual(actual.initial.counts, { catalog: 1, page: 3, timeline: 1 }); assert.deepEqual(keys(actual.initial), expected)
  actual.selection = await js(`(()=>{const n=document.querySelector('[data-input-preview-id]');window.originalOrderBody=n;const walker=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let t;while(t=walker.nextNode()){if(t.textContent.includes('Original retained task'))break}if(!t)throw new Error('No original text');const r=document.createRange();r.selectNodeContents(t);getSelection().removeAllRanges();getSelection().addRange(r);const v=document.querySelector('.recent-focus__viewport');v.scrollLeft=0;window.originalOrderSelection=getSelection().toString();return window.originalOrderSelection})()`)
  assert.ok(actual.selection.length > 0)
  for (const width of [1200, 360]) {
    win.setContentSize(width, 620); await until(`innerWidth===${width}`); await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    await shot(`${width}-before`, actual.initial)
    const before = await state(); await wheel(-20); await until(`orderSceneState().start<${before.start}`)
    await shot(`${width}-after`, actual.initial)
    await click('[aria-label="Return to current focus window"]')
  }
  for (let i = 0; i < 100; i++) { await wheel(i % 2 ? -2 : 2, i % 3 === 0); await click(`[aria-label="${i % 10 === 9 ? 'Return to current focus window' : i % 2 ? 'Zoom in Focus timeline' : 'Zoom out Focus timeline'}"]`) }
  actual.after200 = await state(); assert.deepEqual(actual.after200.counts, actual.initial.counts); assert.deepEqual(keys(actual.after200), expected)
  actual.preservation = await js(`({sameBody:window.originalOrderBody===document.querySelector('[data-input-preview-id]'),selection:getSelection().toString(),draft:document.querySelector('#original-draft').value})`)
  assert.equal(actual.preservation.sameBody, true); assert.equal(actual.preservation.selection, actual.selection); assert.equal(actual.preservation.draft, 'Keep the original draft')
  actual.controls = (await state()).controls; assert.deepEqual(actual.controls, []); actual.passed = true
 } catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
 finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
