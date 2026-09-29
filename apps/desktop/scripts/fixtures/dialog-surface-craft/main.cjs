const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, root, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(root, 'user-data')); app.setPath('sessionData', path.join(root, 'session-data'))
let win
const report = { passed: false, frames: [], scenarios: [], userRunTouched: false }
const call = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(fn) { const end = Date.now() + 9000; while (Date.now() < end) { if (await call(fn)) return; await delay(30) }; assert.fail('Actual dialog fact absent: ' + fn.toString()) }
async function paint() { await call(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await delay(140) }
async function pointer(selector, hover = false, text = null) {
  const point = await call((selector, text) => { const e = [...document.querySelectorAll(selector)].find(e => text === null || e.textContent === text); if (!e) throw Error('Actual control missing'); const r = e.getBoundingClientRect(); return selector === '.dialog-scrim' ? {x:8,y:8} : { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, selector, text)
  for (const type of hover ? ['mouseMoved'] : ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: hover ? 'none' : 'left', clickCount: 1 })
  await paint()
}
async function key(key, code, vk) { for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && key === 'Enter' ? {text:'\r'} : {}) }); await paint() }
async function frame(name) {
  await call(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))); await paint()
  const file = name + '.png', bytes = (await win.webContents.capturePage()).toPNG(); assert.ok(bytes.length > 0)
  await fs.writeFile(path.join(evidence, file), bytes); report.frames.push({ name, file })
}
const closeX = '[data-workbench-tab-id="result-input-tab"] .workbench-tab__close'
const button = label => pointer('.confirmation-dialog button', false, label)
async function openOriginal() { await call(() => dialogCraft.seed()); await wait(() => !!document.querySelector('.workbench-tab__close')); await pointer(closeX); await wait(() => document.querySelector('.confirmation-dialog__title')?.textContent === 'Stop Agent Session?'); await paint() }
async function originalScenes() {
  report.stage = 'original-stop-caller'
  await openOriginal(); const before = await call(() => dialogCraft.facts())
  assert.equal(await call(() => document.activeElement.textContent), 'Cancel', 'The actual destructive dialog focuses Cancel')
  await frame('original-stop-agent-session'); report.enterFocus = await call(() => document.activeElement?.outerHTML); await key('Enter','Enter',13)
  assert.equal(await call(() => !!document.querySelector('.confirmation-dialog')), false, 'Initial Enter cancels')
  assert.deepEqual((await call(() => dialogCraft.facts())).stops, before.stops, 'Cancel never stops a Run')
  await openOriginal(); await button('Keep Session & Close'); await wait(() => !document.querySelector('.confirmation-dialog'))
  const kept = await call(() => dialogCraft.facts()); assert.deepEqual(kept.stops, before.stops, 'Keep leaves the Agent Run alive')
  assert.deepEqual(kept.drafts, before.drafts); assert.deepEqual(kept.sessions, before.sessions, 'Keep preserves original Sessions')
  await openOriginal()
  const actionSize = () => { const r = document.querySelector('.confirmation-dialog button[data-confirm-label]').getBoundingClientRect(); return { width:r.width,height:r.height } }
  const idleSize = await call(actionSize)
  await call(() => dialogCraft.busy(true)); await button('Stop & Close')
  await wait(() => document.querySelector('.confirmation-dialog')?.getAttribute('aria-busy') === 'true')
  assert.deepEqual(await call(actionSize), idleSize, 'Busy action keeps its original size')
  const during = await call(() => dialogCraft.facts()); assert.equal(during.stops.length, before.stops.length + 1, 'Explicit Stop reaches the original owner once')
  await key('Escape','Escape',27); assert.equal(await call(() => !!document.querySelector('.confirmation-dialog')), true, 'Busy Escape keeps the original dialog')
  await pointer('.dialog-scrim'); assert.equal(await call(() => !!document.querySelector('.confirmation-dialog')), true, 'Busy outside click keeps the original dialog')
  await frame('original-stop-busy'); await call(() => dialogCraft.busy(false)); await wait(() => !document.querySelector('.confirmation-dialog'))
  report.scenarios.push({ originalCaller: true, before, kept, during, passed: true })
}
async function galleryScenes() {
  await call(() => dialogCraft.show('confirm','dark',true)); await paint(); await key('Escape','Escape',27)
  assert.equal(await call(() => !!document.querySelector('.confirmation-dialog')),true,'Busy shared confirmation blocks dismissal')
  await call(() => dialogCraft.show('confirm','dark',false)); await key('Escape','Escape',27)
  for (const [kind,width,height,theme] of [['confirm',640,480,'dark'],['confirm',320,300,'light'],['icons',640,480,'dark'],['switch',640,480,'light'],['shortcuts',640,480,'dark'],['goal',640,600,'dark']]) {
    report.stage = { kind,width,height,theme }
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor: 1,mobile: false })
    await call((kind,theme) => dialogCraft.show(kind,theme), kind,theme); await paint()
    if (kind === 'goal') { await pointer('.goals-detail__menu summary'); await pointer('.goals-detail__menu button'); await wait(() => !!document.querySelector('.confirmation-dialog')); assert.equal(await call(() => dialogCraft.facts().actions.some(a => a.startsWith('delete:'))), false) }
    const facts = await call(() => { const e = document.querySelector('.dialog-surface'), r = e.getBoundingClientRect(), s = getComputedStyle(e); return { box: { x:r.x,y:r.y,width:r.width,height:r.height }, client:e.clientWidth,scroll:e.scrollWidth,border:s.borderTopWidth,background:s.backgroundColor,shadow:s.boxShadow } })
    assert.ok(facts.box.x >= -1 && facts.box.x + facts.box.width <= width + 1)
    assert.ok(facts.box.y >= -1 && facts.box.y + facts.box.height <= height + 1, 'The actual dialog stays within the short viewport')
    assert.equal(facts.client, facts.scroll, 'Dialog has no horizontal overflow'); assert.equal(facts.border,'0px'); assert.notEqual(facts.shadow,'none')
    if (kind === 'confirm') {
      const subject = await call(() => { const e = document.querySelector('.confirmation-dialog__subject'); return { client:e.clientWidth,scroll:e.scrollWidth,text:e.textContent } })
      assert.equal(subject.text, await call(() => dialogCraft.longSubject)); assert.equal(subject.client,subject.scroll,'The complete long subject wraps without truncation')
      const before = await call(() => { const e = [...document.querySelectorAll('.confirmation-dialog button')].find(e => e.textContent === 'Stop & Close'), r = e.getBoundingClientRect(); return { width:r.width,height:r.height } })
      await pointer('.confirmation-dialog button',true,'Stop & Close')
      assert.deepEqual(await call(() => { const e = [...document.querySelectorAll('.confirmation-dialog button')].find(e => e.textContent === 'Stop & Close'), r = e.getBoundingClientRect(); return { width:r.width,height:r.height } }),before,'Hover keeps action size stable')
      for (const label of ['Cancel','Keep Session & Close','Stop & Close']) {
        const hit = await call(label => { const e = [...document.querySelectorAll('.confirmation-dialog button')].find(e => e.textContent === label); e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return { top:r.top,bottom:r.bottom } },label)
        assert.ok(hit.top >= 0 && hit.bottom <= height + 1, 'Every action is reachable')
      }
    }
    await frame(kind + '-' + width + '-' + theme)
    if (kind === 'goal') {
      await button('Cancel'); assert.equal(await call(() => dialogCraft.facts().actions.some(a => a.startsWith('delete:'))),false,'Goal cancel keeps original object')
      await pointer('.goals-detail__menu button'); await wait(() => !!document.querySelector('.confirmation-dialog')); await button('Delete goal')
      assert.equal(await call(() => dialogCraft.facts().actions.filter(a => a === 'delete:dialog-craft-goal').length),1,'Goal confirms through original Store owner')
    } else await key('Escape','Escape',27)
    report.scenarios.push({ kind,width,height,theme,facts,passed:true })
  }
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence,{recursive:true}); win = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{backgroundThrottling:false,sandbox:false}})
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await wait(() => !!window.dialogCraft); await originalScenes(); await galleryScenes(); assert.ok(report.scenarios.length > 0); report.passed = true
  } catch(error) { report.failure = { name:error.name,message:error.message,stack:error.stack,stage:report.stage } }
  finally { await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(report,null,2)); win?.destroy(); app.exit(report.passed ? 0 : 1) }
})
