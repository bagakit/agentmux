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
  const preservation = async (label, counts = actual.initial.counts, ids = actual.initial.rows.map(n => n.id)) => {
    const value = await evaluate(`({sameBody:window.originalRulerBody===document.querySelector('[data-input-preview-id]'),rangeCount:getSelection().rangeCount,sameRange:getSelection().rangeCount>0&&getSelection().getRangeAt(0)===window.originalRulerRange,selection:getSelection().toString(),original:window.originalRulerSelection,draft:document.querySelector('#original-draft').value})`)
    actual.preservation ??= []; actual.preservation.push({ label, ...value })
    assert.equal(value.sameBody, true, label + ': original body DOM'); assert.equal(value.sameRange, true, label + ': original nonempty Range'); assert.ok(value.selection.length > 0); assert.equal(value.selection, value.original); assert.equal(value.draft, 'Keep the original draft')
    const current = await state(); assert.deepEqual(current.counts, counts, label + ': original transport budget'); assert.deepEqual(current.rows.map(n => n.id), ids); assert.deepEqual(current.controls, [])
  }
  const shot = async name => {
    await settle(); await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}); await settle()
    const cameraBefore=await state(), s = cameraBefore, geometry = await evaluate(`(()=>{const h=document.querySelector('.recent-focus__header').getBoundingClientRect(),p=document.querySelector('.recent-focus__message-preview')?.getBoundingClientRect(),d=document.querySelector('.focus-ruler-settings')?.getBoundingClientRect();return{header:h.toJSON(),preview:p?.toJSON(),dialog:d?.toJSON()}})()`)
    assert.equal(geometry.header.height, 28)
    const labels = s.ticks.filter(t => t.labelRect).sort((a, b) => a.labelRect.left - b.labelRect.left)
    for (let i = 1; i < labels.length; i++) assert.ok(labels[i].labelRect.left >= labels[i - 1].labelRect.right - .5, 'Actual labels overlap')
    const image = name + '.png'; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()); const cameraAfter=await state();assert.deepEqual(cameraAfter,cameraBefore); actual.frames.push({ camera:{before:cameraBefore,after:cameraAfter}, image, width: await evaluate('innerWidth'), state: s, geometry })
  }
  await until('window.rulerSceneState && rulerSceneState().counts.catalog===1')
  await click('[aria-label="View input records"]'); await change('[aria-label="Input records Context"]', 'archive-ruler')
  await until('rulerSceneState().rows.filter(n=>n.source==="native").length===90')
  await click('[data-input-source="native"][data-input-message-id]'); await until('!!document.querySelector("[data-input-preview-id]")'); await settle()
  await evaluate(`(()=>{const node=document.querySelector('[data-input-preview-id]'),walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(text.textContent.includes('Original retained task'))break}if(!text)throw new Error('No actual original body text');const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);window.originalRulerBody=node;window.originalRulerRange=range;window.originalRulerSelection=getSelection().toString();return true})()`)
  await settings('daily',{zone:'UTC'},false)
  await change('[aria-label="Focus history date and time"]','2026-10-04T00:00')
  await evaluate(`(()=>{const v=document.querySelector('.recent-focus__viewport');v.scrollTop=37;return v.scrollTop})()`)
  actual.initial = await state()
  assert.deepEqual(Object.keys(actual.initial.counts).sort(),['catalog','page','projector','timeline'])
  assert.equal(actual.initial.counts.catalog,1);assert.equal(actual.initial.counts.page,3);assert.equal(actual.initial.counts.timeline,1);assert.ok(actual.initial.counts.projector>0)
  assert.equal(actual.initial.rows.filter(n=>n.source==='native').length,90);assert.ok(actual.initial.viewport.scrollTop>0)
  const originalScroll=actual.initial.viewport.scrollTop
  const sizes=['0.5','1','2','4','6','8','12','18','24','36','48']
  actual.presets=[];actual.widths=[]
  const resize=async desired=>{
    const before=await state(),point=await evaluate(`(()=>{const n=document.querySelector('[aria-label="Resize timeline names"]'),r=n.getBoundingClientRect();if(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)!==n)throw new Error('Name handle not actually hittable');return{x:r.x+r.width/2,y:r.y+r.height/2,value:Number(n.getAttribute('aria-valuenow'))}})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1})
    const x=point.x+desired-point.value
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:point.y,button:'left',buttons:1})
    await settle();const draft=await state();assert.equal(draft.renderedWidth,desired);assert.equal(draft.width,before.width)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:point.y,button:'left',buttons:0,clickCount:1})
    await until(`rulerSceneState().width===${desired}`);await settle();const after=await state();assert.equal(after.renderedWidth,desired);assert.deepEqual(after.ruler,before.ruler);assert.equal(after.hours,before.hours);actual.widths.push({before,draft,after});await preservation('actual name drag '+desired)
  }
  for(const width of [1200,360]){
    const savedWidth=(await state()).width;win.setContentSize(width,720);await until(`innerWidth===${width}`);await settle();assert.equal((await state()).width,savedWidth,'Geometry never commits preference')
    await resize(width===1200?244:140)
    for(const [mode,zone] of [['daily','UTC'],['uniform','America/New_York'],['free','Asia/Shanghai']]){
      await settings(mode,{zone},mode!=='daily');const current=await state();assert.equal(current.mode,mode);assert.equal(current.zone,zone)
      const saved=current.width,prefs=current.ruler
      for(const size of sizes){await change('[aria-label="Focus window size"]',size);const value=await state();assert.equal(value.hours,Number(size));assert.equal(value.end-value.start,Number(size)*3600000);assert.equal(value.width,saved);assert.deepEqual(value.ruler,prefs);assert.equal(value.viewport.scrollTop,originalScroll);await preservation(mode+' '+width+' '+size);actual.presets.push({width,mode,zone,hours:value.hours,window:[value.start,value.end],counts:value.counts})}
      assert.equal((await state()).rows.filter(n=>n.source==='native').length,90)
      await shot(`${mode}-${width}-joined`)
    }
  }
  const beforeEarlier=await state();assert.equal(beforeEarlier.hours,48);assert.deepEqual(beforeEarlier.counts,actual.initial.counts)
  const earlier=await evaluate(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent==='Read earlier records');if(!n||n.disabled)throw new Error('No actual explicit Earlier action');n.dataset.joinEarlier='true';return true})()`)
  assert.equal(earlier,true);await click('[data-join-earlier="true"]');await until('rulerSceneState().counts.page===5 && document.querySelector(".recent-focus__input-actions button")?.disabled===true');await settle()
  const afterEarlier=await state();assert.equal(afterEarlier.rows.filter(n=>n.source==='native').length,90);assert.equal(afterEarlier.counts.page,beforeEarlier.counts.page+2);assert.equal(afterEarlier.counts.catalog,beforeEarlier.counts.catalog);assert.equal(afterEarlier.counts.timeline,beforeEarlier.counts.timeline);assert.ok(afterEarlier.cursors[3]!==afterEarlier.cursors[2]);assert.notDeepEqual(afterEarlier.rows.map(n=>n.id),beforeEarlier.rows.map(n=>n.id))
  await preservation('explicit bounded Earlier retains original reading',afterEarlier.counts,afterEarlier.rows.map(n=>n.id))
  actual.explicitEarlier={before:beforeEarlier,after:afterEarlier,opaqueCursorAdvanced:true};actual.final=afterEarlier;actual.controls=afterEarlier.controls;assert.deepEqual(actual.controls,[]);assert.equal(actual.frames.length,6);assert.equal(actual.presets.length,66);actual.passed=true

} catch (error) {
  actual.failure = { name: error.name, message: error.message, stack: error.stack }
  if (win && !win.isDestroyed()) { actual.failedState = await win.webContents.executeJavaScript('window.rulerSceneState?.()').catch(() => null); await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()) }
} finally { await fs.writeFile(path.join(evidence, 'scene.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
