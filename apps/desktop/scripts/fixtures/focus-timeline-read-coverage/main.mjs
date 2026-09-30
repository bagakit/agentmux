import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, controls: [], frames: [], boundary: 'Single compiled production presentation, exact public-reader JSON transport, typed current semantic observations. No physical Run or ordinary App qualification.' }
let win
app.whenReady().then(async () => {
try {
  win = new BrowserWindow({ width: 1200, height: 640, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html); win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const js = expression => win.webContents.executeJavaScript(expression)
  const until = async expression => { for (let i = 0; i < 200; i++) { const value = await js(expression); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${expression}`) }
  const state = () => js('coverageSceneState()')
  const point = selector => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const click = async selector => {
    const position = await point(selector)
    const hit = await js(`!!document.elementFromPoint(${position.x},${position.y})?.closest(${JSON.stringify(selector)})`)
    assert.equal(hit, true, `Actual center hit: ${selector}`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...position, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
  }
  const key = async (key, code, windowsVirtualKeyCode) => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode }) }
  const wheel = async (selector, deltaX, deltaY = 0, modifiers = 0) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...await point(selector), deltaX, deltaY, modifiers })
  const settle = async () => {
    await until(`[...document.querySelectorAll('.recent-focus__message-preview,.recent-focus__legend-dialog')].every(n=>getComputedStyle(n).visibility==='visible'&&Number(getComputedStyle(n).opacity)>=.999&&!n.getAnimations().some(a=>a.playState==='running'))`)
    await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  }
  const shot = async name => {
    await settle()
    const header = await js(`(()=>{const n=document.querySelector('.recent-focus__header'),r=n.getBoundingClientRect();return{rect:r.toJSON(),height:r.height,legend:getComputedStyle(document.querySelector('.recent-focus__legend-key')).display}})()`)
    assert.equal(header.height, 28)
    const image = `${name}.png`; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
    actual.frames.push({ image, width: await js('innerWidth'), header, state: await state() })
  }
  const choose = async id => {
    await js(`(()=>{const n=document.querySelector('[aria-label="Input records Context"]');n.value=${JSON.stringify(id)};n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await until(`coverageSceneState().input===${JSON.stringify(id)}&&[...document.querySelectorAll('button')].some(n=>n.textContent==='Refresh source'&&!n.disabled)`)
  }
  await until('window.coverageSceneState&&coverageSceneState().read===1&&coverageSceneState().tracks.length===14')
  actual.initial = await state(); assert.equal(actual.initial.scroll.top, 0); assert.equal(actual.initial.tracks.includes('current-12'), true)
  await shot('wide-initial')
  const beforeLocate = await state(); await click('[aria-label="Locate current Context track"]')
  await until('coverageSceneState().scroll.top>0')
  const afterLocate = await state(); assert.deepEqual(afterLocate.counts, beforeLocate.counts); assert.deepEqual(afterLocate.tracks, beforeLocate.tracks); assert.equal(afterLocate.start, beforeLocate.start); assert.equal(afterLocate.end, beforeLocate.end)
  actual.locate = await js(`(()=>{const n=document.querySelector('[data-focus-current="true"]'),r=n.getBoundingClientRect(),v=document.querySelector('.recent-focus__viewport').getBoundingClientRect();return{track:r.toJSON(),viewport:v.toJSON(),visible:r.top>=v.top&&r.bottom<=v.bottom,scroll:coverageSceneState().scroll}})()`)
  assert.equal(actual.locate.visible, true); await shot('wide-current-track')
  await click('[aria-label="View input records"]'); await until('!!document.querySelector("[aria-label=\\"Input records Context\\"]")')
  await choose('archive-coverage-a'); await until('document.querySelectorAll("[data-input-message-id]").length===4')
  await settle()
  await click('[data-input-message-id="native:claude:native-archive-coverage-a:a-one"]')
  await until('!!document.querySelector("[data-input-preview-id]")')
  actual.pinBefore = await js(`(()=>{const n=document.querySelector('[data-input-preview-id]');window.coveragePinnedBody=n;const w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let t;while(t=w.nextNode()){if(t.textContent.includes('Keep both closed Contexts'))break}if(!t)throw new Error('Missing original message');const r=document.createRange();r.selectNodeContents(t);getSelection().removeAllRanges();getSelection().addRange(r);window.coverageSelection=getSelection().toString();return{id:n.dataset.inputPreviewId,selection:window.coverageSelection}})()`)
  await choose('archive-coverage-b'); await until('document.querySelectorAll("[data-input-message-id]").length===1&&coverageSceneState().read===3')
  actual.pinAfter = await js(`({sameNode:window.coveragePinnedBody===document.querySelector('[data-input-preview-id]'),selection:getSelection().toString(),body:document.querySelector('[data-input-preview-id]').textContent,id:document.querySelector('[data-input-preview-id]').dataset.inputPreviewId,reader:coverageSceneState().input,caption:document.querySelector('.recent-focus__message-caption').textContent})`)
  assert.equal(actual.pinAfter.sameNode, true); assert.equal(actual.pinAfter.selection, actual.pinBefore.selection); assert.equal(actual.pinAfter.id, actual.pinBefore.id); assert.equal(actual.pinAfter.reader, 'archive-coverage-b')
  assert.ok(actual.pinAfter.caption.includes('To Closed review A')); assert.equal(actual.pinAfter.caption.includes('Closed review B'), false)
  await shot('wide-pin-a-read-b')
  const expected = ['native:claude:native-archive-coverage-a:a-one', 'native:claude:native-archive-coverage-a:a-two', 'captured:captured-a', 'native:claude:native-archive-coverage-b:b-one']
  actual.retained = await state(); assert.deepEqual(actual.retained.markers.slice().sort(), expected.slice().sort()); assert.equal(actual.retained.native, 4); assert.equal(actual.retained.captured, 1)
  const costBefore = await state()
  for (let i = 0; i < 100; i++) { await wheel('.recent-focus__time-scale', i % 2 ? -2 : 2); await click(`[aria-label="Zoom ${i % 2 ? 'in' : 'out'} Focus timeline"]`) }
  const costAfter = await state(); assert.deepEqual(costAfter.counts, costBefore.counts); assert.deepEqual(costAfter.controls, []); assert.equal(costAfter.draft, 'Keep the original draft')
  assert.equal(await js('window.coveragePinnedBody===document.querySelector("[data-input-preview-id]")&&getSelection().toString()===window.coverageSelection'), true)
  actual.cost200 = { before: costBefore, after: costAfter, actualActions: 200, pointerOrKeyboardRunControls: 0 }
  await key('Escape', 'Escape', 27); await until('!document.querySelector(".recent-focus__message-preview")')
  const beforeVertical = await state(); await wheel('.recent-focus__time-scale', 0, 1000)
  await until('coverageSceneState().scroll.top+coverageSceneState().scroll.client>=coverageSceneState().scroll.height-1')
  actual.verticalScroll = { before: beforeVertical.scroll, after: (await state()).scroll }
  assert.ok(actual.verticalScroll.after.top > actual.verticalScroll.before.top)
  await wheel('.recent-focus__time-scale', 0, -1000); await until('coverageSceneState().scroll.top===0')
  await click('[aria-label="Collapse project Observed project"]')
  await until('document.querySelector("[aria-label=\\"Expand project Observed project\\"]")?.getAttribute("aria-expanded")==="false"')
  await shot('wide-both-read-sources')
  // Same physical pointer continues browsing when every visible track has left
  // the viewport. The absent gutter cannot turn blank identity space into time.
  const blankBefore = await state(), traceStart = await js('coverageSceneWheelTrace.length'), blankPoint = await js(`(()=>{const s=document.querySelector('.recent-focus__time-scale').getBoundingClientRect(),v=document.querySelector('.recent-focus__viewport').getBoundingClientRect();return{x:s.x+s.width/2,y:v.top+44,left:s.left,right:s.right,nameX:s.left/2}})()`)
  const blankWheel = async (deltaX, deltaY = 0, modifiers = 0, x = blankPoint.x) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y: blankPoint.y, deltaX, deltaY, modifiers })
  await blankWheel(-2200); await until('coverageSceneState().tracks.length===0')
  const blankStart = await state(), blankHit = await js(`({className:document.elementFromPoint(${blankPoint.x},${blankPoint.y})?.className,time:document.querySelector('.recent-focus__time-scale').getBoundingClientRect().toJSON()})`)
  await blankWheel(-100); await until(`coverageSceneState().start<${blankStart.start}`); const blankSame = await state()
  await blankWheel(100); await until(`coverageSceneState().start>${blankSame.start}`); const blankReverse = await state()
  await blankWheel(0, -100, 8); await until(`coverageSceneState().start<${blankReverse.start}`); const blankShift = await state()
  await blankWheel(-100, 0, 0, blankPoint.nameX); await settle(); const blankName = await state()
  assert.equal(blankName.start, blankShift.start); assert.deepEqual(blankName.counts, blankBefore.counts); assert.deepEqual(blankName.controls, [])
  const wheelEvents = await js(`coverageSceneWheelTrace.slice(${traceStart})`)
  assert.equal(wheelEvents.length, 5); assert.deepEqual(wheelEvents.map(event => event.prevented), [true, true, true, true, false])
  actual.blankPan = { pointer: blankPoint, actualHit: blankHit, wheelEvents, before: blankBefore, blankStart, sameDirection: blankSame, reverse: blankReverse, shift: blankShift, blankIdentity: blankName }
  await shot('wide-empty-window')
  await click('[aria-label="Return to current focus window"]'); await until('coverageSceneState().markers.length===4')
  const beforeHelp = await state(); await click('[aria-label="Timeline meaning and coverage"]'); await until('!!document.querySelector(".recent-focus__legend-dialog")')
  actual.meanings = await js(`({facts:[...document.querySelectorAll('.recent-focus__legend-dialog [data-focus-fact]')].map(n=>n.dataset.focusFact),text:document.querySelector('.recent-focus__legend-dialog').textContent})`)
  assert.deepEqual(actual.meanings.facts, ['now', 'working', 'focus', 'alive']); assert.ok(actual.meanings.text.includes('3 sources read')); assert.ok(actual.meanings.text.includes('Past working intervals were not continuously recorded'))
  actual.meanings.shapes = await js(`Object.fromEntries([...document.querySelectorAll('.recent-focus__legend-dialog i[data-focus-fact]')].map(n=>{const s=getComputedStyle(n);return[n.dataset.focusFact,{width:s.width,height:s.height,radius:s.borderRadius}]}))`)
  assert.equal(actual.meanings.shapes.now.width, '2px'); assert.equal(actual.meanings.shapes.now.height, '11px')
  assert.equal(actual.meanings.shapes.focus.height, '2px'); assert.equal(actual.meanings.shapes.alive.width, '7px'); assert.equal(actual.meanings.shapes.alive.height, '7px')
  assert.deepEqual((await state()).counts, beforeHelp.counts); await shot('wide-meaning-and-coverage')
  await key('Escape', 'Escape', 27); await until('!document.querySelector(".recent-focus__legend-dialog")')
  win.setContentSize(320, 640); await until('innerWidth===320'); await settle()
  await js('document.querySelector(".recent-focus__controls").scrollLeft=0')
  await shot('narrow-both-read-sources')
  await click('[aria-label="Timeline meaning and coverage"]'); await until('!!document.querySelector(".recent-focus__legend-dialog")')
  await shot('narrow-meaning-and-coverage')
  actual.narrow = await js(`(()=>{const n=document.querySelector('.recent-focus__legend-dialog'),r=n.getBoundingClientRect();return{rect:r.toJSON(),width:innerWidth,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,legend:getComputedStyle(document.querySelector('.recent-focus__legend-key')).display}})()`)
  assert.ok(actual.narrow.rect.left>=0&&actual.narrow.rect.right<=320); assert.equal(actual.narrow.legend, 'none')
  await key('Escape', 'Escape', 27); await until('!document.querySelector(".recent-focus__legend-dialog")')
  await click('[aria-label="View input records"]'); await choose('archive-coverage-a')
  await settle()
  await click('[data-input-message-id="native:claude:native-archive-coverage-a:a-unknown"]')
  await until('document.querySelector("[data-input-preview-id]")?.dataset.inputPreviewId==="native:claude:native-archive-coverage-a:a-unknown"')
  await settle()
  await js('document.querySelector(".recent-focus__message-preview").scrollTop=9999')
  await settle(); await shot('narrow-unknown-time-body')
  actual.unknownTime = await js(`({id:document.querySelector('[data-input-preview-id]').dataset.inputPreviewId,text:document.querySelector('[data-input-preview-id]').textContent,markers:coverageSceneState().markers})`)
  assert.ok(actual.unknownTime.text.includes('no recorded time')); assert.equal(actual.unknownTime.markers.includes(actual.unknownTime.id), false)
  actual.controls = (await state()).controls; assert.deepEqual(actual.controls, []); actual.passed = true
} catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'scene.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
