import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
const [html, privateRoot, evidence, counterOnly = 'false'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, frames: [], controls: [], interactions: [], boundary: 'Compiled real production Timeline/Settings/Store and public pure projector, with the original typed navigation transport. No new Reader/Writer, App restart, healthy Run or installation qualification.' }
let win
app.whenReady().then(async () => {
try {
  win = new BrowserWindow({ width: 1000, height: 720, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html); win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const evaluate = expression => win.webContents.executeJavaScript(expression)
  const until = async expression => { for (let i = 0; i < 200; i++) { const value = await evaluate(expression); if (value) return value; await new Promise(done => setTimeout(done, 20)) } throw new Error(`Did not settle: ${expression}`) }
  const state = () => evaluate('rulerSceneState()')
  const settle = () => evaluate('Promise.all([document.fonts.ready,...document.getAnimations().filter(a=>a.playState==="running" && (a.effect?.getComputedTiming().iterations ?? 1)!==Infinity).map(a=>a.finished.catch(()=>{}))]).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))')
  const point = selector => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing actual control '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const reveal = async selector => {
    for (let i = 0; i < 5; i++) {
      const geometry = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing actual control');const r=n.getBoundingClientRect(),c=n.closest('.recent-focus__controls')?.getBoundingClientRect();return{r:r.toJSON(),clip:c?.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button,select,input')===n}})()`)
      if (geometry.hit) return
      assert.ok(geometry.clip, 'An actual obstructed non-toolbar control is a product counter')
      const c = geometry.clip, r = geometry.r, deltaX = r.right > c.right ? r.right - c.right + 12 : r.left - c.left - 12
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (c.left + c.right) / 2, y: (c.top + c.bottom) / 2, deltaX, deltaY: 0 })
      await settle()
    }
    throw new Error('Actual control cannot be reached through the original horizontal toolbar scroll: ' + selector)
  }
  const click = async selector => { await reveal(selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...await point(selector), button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); actual.interactions.push({ kind: 'trusted-pointer', selector }) }
  const enter = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); for (const type of ['rawKeyDown', 'char', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'char' ? { text: '\r', unmodifiedText: '\r' } : {}) }); actual.interactions.push({ kind: 'trusted-keyboard-enter', selector }) }
  const change = async (selector, value) => { await reveal(selector); await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(n instanceof HTMLSelectElement && !Array.from(n.options).some(option=>option.value===${JSON.stringify(value)}))throw new Error('Fixture must choose an actual option: '+${JSON.stringify(value)});const prototype=n instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));return true})()`); actual.interactions.push({ kind: 'real-control-synthetic-input-change', selector, value }); await settle() }
  const settings = async (mode, values = {}, keyboard = true) => {
    await click('[aria-label="Focus timeline settings"]'); await until('!!document.querySelector(".focus-ruler-settings")')
    await click(`[name="focus-ruler-mode"][value="${mode}"]`)
    if (values.zone) await change('[aria-label="Focus timeline time zone"]', values.zone)
    if (values.interval !== undefined) await change('[aria-label="Time ruler interval in minutes"]', String(values.interval))
    if (values.phase !== undefined) await change('[aria-label="Time ruler clock offset"]', values.phase)
    if (keyboard) await enter('.focus-ruler-settings footer button:last-child'); else await click('.focus-ruler-settings footer button:last-child')
    await until(`!document.querySelector('.focus-ruler-settings') && rulerSceneState().mode===${JSON.stringify(mode)}`); await settle()
  }
  const preservation = async label => {
    const value = await evaluate(`({sameBody:window.originalRulerBody===document.querySelector('[data-input-preview-id]'),rangeCount:getSelection().rangeCount,sameRange:getSelection().rangeCount>0&&getSelection().getRangeAt(0)===window.originalRulerRange,selection:getSelection().toString(),original:window.originalRulerSelection,draft:document.querySelector('#original-draft').value})`)
    actual.preservation ??= []; actual.preservation.push({ label, ...value })
    assert.equal(value.sameBody, true, label + ': original body DOM'); assert.equal(value.sameRange, true, label + ': original nonempty Range'); assert.ok(value.selection.length > 0); assert.equal(value.selection, value.original); assert.equal(value.draft, 'Keep the original draft')
    const current = await state(); assert.deepEqual(current.counts, actual.initial.counts, label + ': original transport budget'); assert.deepEqual(current.rows.map(n => n.id), actual.initial.rows.map(n => n.id)); assert.deepEqual(current.controls, [])
  }
  const shot = async name => {
    await settle(); await win.webContents.capturePage(); await settle()
    const s = await state(), geometry = await evaluate(`(()=>{const h=document.querySelector('.recent-focus__header').getBoundingClientRect(),p=document.querySelector('.recent-focus__message-preview')?.getBoundingClientRect(),d=document.querySelector('.focus-ruler-settings')?.getBoundingClientRect();return{header:h.toJSON(),preview:p?.toJSON(),dialog:d?.toJSON()}})()`)
    assert.equal(geometry.header.height, 28)
    const labels = s.ticks.filter(t => t.labelRect).sort((a, b) => a.labelRect.left - b.labelRect.left)
    for (let i = 1; i < labels.length; i++) assert.ok(labels[i].labelRect.left >= labels[i - 1].labelRect.right - .5, 'Actual labels overlap')
    const image = name + '.png'; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG()); actual.frames.push({ image, width: await evaluate('innerWidth'), state: s, geometry })
  }
  await until('window.rulerSceneState && rulerSceneState().counts.catalog===1')
  await click('[aria-label="View input records"]'); await change('[aria-label="Input records Context"]', 'archive-ruler')
  await until('rulerSceneState().rows.filter(n=>n.source==="native").length===90')
  await click('[data-input-source="native"][data-input-message-id]'); await until('!!document.querySelector("[data-input-preview-id]")'); await settle()
  await evaluate(`(()=>{const node=document.querySelector('[data-input-preview-id]'),walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(text.textContent.includes('Original retained task'))break}if(!text)throw new Error('No actual original body text');const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);window.originalRulerBody=node;window.originalRulerRange=range;window.originalRulerSelection=getSelection().toString();return true})()`)
  actual.initial = await state(); assert.deepEqual(actual.initial.counts, { catalog: 1, page: 3, timeline: 1 }); assert.equal(actual.initial.rows.filter(n => n.source === 'native').length, 90)
  const originalRange = [actual.initial.start, actual.initial.end]
  await settings('free'); await preservation('fixed body → Settings → Free Apply with trusted Enter')
  assert.deepEqual([(await state()).start, (await state()).end], originalRange)
  assert.equal((await state()).ticks.length, 5)
  if (counterOnly === 'true') { actual.firstCounterPassed = true; actual.final = await state(); actual.passed = true; return }
  await settings('daily', { zone: 'UTC' }, false)
  await change('[aria-label="Focus window size"]', '24')
  await change('[aria-label="Focus history date and time"]', '2026-10-04T00:00')
  await until('rulerSceneState().date==="2026-10-04T00:00" && rulerSceneState().zone==="UTC"')
  const base = await state(), baseRange = [base.start, base.end]
  assert.deepEqual(baseRange, [Date.parse('2026-10-03T06:00Z'), Date.parse('2026-10-04T06:00Z')])
  assert.ok(base.ticks.length > 0)
  assert.deepEqual([...new Set(base.ticks.map(t => t.tier))].sort(), ['fine', 'major', 'short', 'shorter'])
  assert.equal(new Set(base.ticks.map(t => new Date(t.instant).toISOString().slice(0, 10))).size, 2)
  for (const tier of ['major', 'short', 'shorter', 'fine']) {
    const rows = base.ticks.filter(t => t.tier === tier); assert.ok(rows.length > 0)
    assert.ok(rows.every(t => t.height === ({ major: 15, short: 11, shorter: 8, fine: 5 })[tier]))
  }
  actual.dailyTwoDates = { range: baseRange, ticks: base.ticks }
  for (const width of [1000, 640]) {
    win.setContentSize(width, 720); await until(`innerWidth===${width}`); await settle()
    for (const mode of ['daily', 'uniform', 'free']) {
      await settings(mode, { zone: 'UTC' }, mode !== 'daily')
      const current = await state(); assert.deepEqual([current.start, current.end], baseRange)
      assert.equal(current.zone, 'UTC'); assert.equal(current.mode, mode)
      if (mode === 'uniform') {
        assert.equal(current.ruler.intervalMinutes, 120); assert.equal(current.ruler.phaseMinutes, 1380)
        assert.ok(current.ticks.length > 0); assert.ok(current.ticks.every(t => new Date(t.instant).getUTCMinutes() === 0 && new Date(t.instant).getUTCHours() % 2 === 1))
      }
      if (mode === 'free') assert.deepEqual(current.ticks.map(t => t.instant), Array.from({ length: 5 }, (_, i) => current.start + (current.end - current.start) * i / 4))
      await preservation(`${mode} actual settings ${width}`); await shot(`${mode}-${width}`)
    }
  }
  const changeDate = value => change('[aria-label="Focus history date and time"]', value)
  const gap = async (zone, value) => {
    await settings('daily', { zone }); const before = await state(); await changeDate(value)
    const after = await state(); assert.equal(after.invalidDate, 'true'); assert.ok(after.dateError.includes('does not exist'))
    assert.deepEqual([after.start, after.end], [before.start, before.end]); await preservation(`${zone} actual gap ${value}`)
    return { zone, value, before: [before.start, before.end], after: [after.start, after.end], invalidDate: after.invalidDate, notice: after.dateError }
  }
  actual.gaps = [await gap('America/New_York', '2026-03-08T02:30')]
  win.setContentSize(1000, 720); await until('innerWidth===1000'); await settle()
  await changeDate('2026-11-01T01:30'); await until('document.querySelectorAll(".focus-ruler-settings__dates button").length===2')
  const nyChoices = await evaluate('Array.from(document.querySelectorAll(".focus-ruler-settings__dates button"),n=>n.textContent)')
  assert.ok(nyChoices[0].startsWith('UTC−04:00')); assert.ok(nyChoices[1].startsWith('UTC−05:00'))
  await preservation('New York repeated clock keeps original reading before explicit selection'); await shot('new-york-fold-1000')
  await click('.focus-ruler-settings__dates button:nth-child(2)'); await until('!document.querySelector(".focus-ruler-settings")')
  const nySelected = await state(); assert.deepEqual([nySelected.start, nySelected.end], [Date.parse('2026-10-31T12:30Z'), Date.parse('2026-11-01T12:30Z')])
  const repeatedInstants = [Date.parse('2026-11-01T05:30Z'), Date.parse('2026-11-01T06:30Z')]
  assert.deepEqual(nySelected.ticks.filter(t => repeatedInstants.includes(t.instant)).map(t => t.instant), repeatedInstants)
  actual.newYorkFold = { choices: nyChoices, selected: nySelected, repeatedInstants }; await preservation('New York selected offset')
  actual.gaps.push(await gap('Australia/Lord_Howe', '2026-10-04T02:15'))
  win.setContentSize(640, 720); await until('innerWidth===640'); await settle()
  await changeDate('2026-04-05T01:45'); await until('document.querySelectorAll(".focus-ruler-settings__dates button").length===2')
  const lhChoices = await evaluate('Array.from(document.querySelectorAll(".focus-ruler-settings__dates button"),n=>n.textContent)')
  assert.ok(lhChoices[0].startsWith('UTC+11:00')); assert.ok(lhChoices[1].startsWith('UTC+10:30'))
  await preservation('Lord Howe repeated clock keeps original reading before explicit selection'); await shot('lord-howe-fold-640')
  await enter('.focus-ruler-settings__dates button:first-child'); await until('!document.querySelector(".focus-ruler-settings")')
  const lhSelected = await state(); assert.deepEqual([lhSelected.start, lhSelected.end], [Date.parse('2026-04-03T20:45Z'), Date.parse('2026-04-04T20:45Z')])
  actual.lordHoweFold = { choices: lhChoices, selected: lhSelected }; await preservation('Lord Howe selected half-hour offset')
  await settings('uniform', { zone: 'UTC', interval: 420, phase: '23:00' })
  await change('[aria-label="Focus window size"]', '48'); await changeDate('2026-10-05T00:00')
  const beforePan = await state(); assert.ok(beforePan.ticks.length > 0)
  const scale = beforePan.scale
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (scale.left + scale.right) / 2, y: (scale.top + scale.bottom) / 2, deltaX: scale.width * .375, deltaY: 0 })
  actual.interactions.push({ kind: 'trusted-horizontal-wheel', deltaX: scale.width * .375 })
  await until(`rulerSceneState().start>${beforePan.start}`); await settle()
  const afterPan = await state(), overlapStart = Math.max(beforePan.start, afterPan.start), overlapEnd = Math.min(beforePan.end, afterPan.end)
  assert.notEqual(new Date(beforePan.start).toISOString().slice(0, 10), new Date(afterPan.start).toISOString().slice(0, 10))
  const previous = beforePan.ticks.filter(t => t.instant >= overlapStart && t.instant <= overlapEnd).map(t => t.instant)
  const next = afterPan.ticks.filter(t => t.instant >= overlapStart && t.instant <= overlapEnd).map(t => t.instant)
  assert.ok(previous.length > 0); assert.deepEqual(next, previous)
  actual.nonDayDivisor = { before: beforePan, after: afterPan, overlap: previous }; await preservation('7h actual uniform cross-date pan')
  await settings('daily', { zone: 'UTC' }); await change('[aria-label="Focus window size"]', '0.5'); await changeDate('2026-10-04T00:30')
  const short = await state(); assert.deepEqual([short.start, short.end], [Date.parse('2026-10-04T00:07:30Z'), Date.parse('2026-10-04T00:37:30Z')]); assert.deepEqual(short.ticks, [])
  actual.honestShortEmptyGrid = short; await preservation('honest 30m aligned empty window')
  actual.final = await state(); actual.controls = actual.final.controls; assert.deepEqual(actual.controls, [])
  assert.equal(actual.frames.length, 8); actual.passed = true
} catch (error) {
  actual.failure = { name: error.name, message: error.message, stack: error.stack }
  if (win && !win.isDestroyed()) { actual.failedState = await win.webContents.executeJavaScript('window.rulerSceneState?.()').catch(() => null); await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
} finally { await fs.writeFile(path.join(evidence, 'scene.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
