const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), { createHash } = require('node:crypto')
const fs = require('node:fs/promises'), path = require('node:path')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.product-quality-foundation-native-render.v1', passed: false, frames: [], interactions: [], consoleErrors: [],
  qualification: 'Actual production views/CSS/xterm in private Electron, synthetic API boundary; no real Core or installed App acceptance', userAppTouched: false }
let win
const evaluate = code => win.webContents.executeJavaScript(code)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(code) {
  for (let n = 0; n < 160; n++) { if (await evaluate(code)) return; await delay(25) }
  throw new Error('Timed out: ' + code + '; ' + JSON.stringify(await evaluate(`({text:document.body.innerText.slice(0,1000),terminal:qualityProbe.terminal()})`)))
}
async function key(key, code, virtual, text) {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual, ...(type === 'keyDown' && text ? { text } : {}) })
}
async function point(expression) {
  return evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Missing actual target');const r=e.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}}if(right<=left||bottom<=top)throw new Error('Actual target is clipped');return{x:(left+right)/2,y:(top+bottom)/2}})()`)
}
async function click(expression) {
  const p = await point(expression)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 })
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
}
async function wheel(expression, deltaY) {
  const p = await point(expression)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY })
  await delay(35)
}
async function painted() { await delay(80); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))') }
async function capture(name, facts) {
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); const bytes = (await win.webContents.capturePage()).toPNG()
  const png = name + '.png'; await fs.writeFile(path.join(evidence, png), bytes)
  const frame = { name, png, pngSha256: createHash('sha256').update(bytes).digest('hex'), ...facts }; result.frames.push(frame); return frame
}
const pane = `document.querySelector('[data-workbench-region-id="quality-target"] .agent-surface') ?? document.querySelector('.agent-surface')`
const terminal = `(${pane}).querySelector('.terminal-view__xterm')`
const details = `(${pane}).querySelector('.service-window__details')`
const summary = `${details}?.querySelector('summary')`
const measure = `(()=>{
  const pane=${pane};if(!pane)throw new Error('Actual SessionPane missing');
  const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
  const label=pane.querySelector('.continuous-progress-control__label'), lr=label&&document.createRange();if(lr)lr.selectNodeContents(label);
  const detail=pane.querySelector('.service-window__details');
  return {pane:rect(pane),terminal:rect(pane.querySelector('.terminal-view__xterm')),composer:rect(pane.querySelector('[data-agent-composer="true"]')),
    progress:label?{label:rect(label),rects:[...lr.getClientRects()].map(r=>({width:r.width,height:r.height})),font:getComputedStyle(label).fontSize,
      summary:pane.querySelector('.continuous-progress-control summary').innerText,summaryRect:rect(pane.querySelector('.continuous-progress-control summary')),open:pane.querySelector('.continuous-progress-control').open}:null,
    header:{name:pane.querySelector('.agent-region-header').getAttribute('aria-label'),more:rect(pane.querySelector('.agent-region-header__more')),readonly:!!pane.querySelector('.agent-region-header__mode')},
    notices:[...pane.querySelectorAll('.service-window')].map(n=>({step:n.querySelector('.service-window__step').innerText,mode:n.querySelector('.service-window__mode').innerText,
      restore:n.querySelector('.service-window__restore').innerText,rect:rect(n),aria:n.getAttribute('aria-live'),kind:n.dataset.kind,detail:!!n.querySelector('details')})),
    track:rect(pane.querySelector('.terminal-service-window')),xterm:qualityProbe.terminal(),draft:qualityProbe.facts().draft,
    screenshotCalls:qualityProbe.facts().screenshots,appearance:document.documentElement.dataset.appearance,
    reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
    history:!!pane.querySelector('.session-history:not(.session-history--inline)')}
})()`
async function seed(mode, width, height, windowMode = false, appearance = 'dark', reduced = false) {
  result.stage = { mode, width, height, windowMode, appearance, step: 'seed' }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
  await evaluate(`document.documentElement.dataset.appearance=${JSON.stringify(appearance)};qualityProbe.mode(${JSON.stringify(mode)},${windowMode})`)
  await waitFor(`Boolean(qualityProbe.terminal()) && !(${terminal}).classList.contains('terminal-view__xterm--hydrating')`)
  if (mode === 'list-rejected') await waitFor(`(${pane}).querySelector('.continuous-progress-control summary').innerText.includes('Unconfirmed')`)
  await painted()
}
async function keyboardReach(expression, backwards = false) {
  const trace = []
  for (let n = 0; n < 30; n++) {
    if (backwards) {
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
    } else await key('Tab', 'Tab', 9)
    if (await evaluate(`document.activeElement===(${expression})`)) return n + 1
    trace.push(await evaluate(`(()=>{const target=${expression};return{target:target?{label:target.innerText,disabled:target.disabled}:null,active:document.activeElement?.outerHTML.slice(0,180)}})()`))
  }
  throw new assert.AssertionError({ message: 'Actual trusted Tab traversal must reach ' + expression + '; ' + JSON.stringify(trace) })
}
async function detailsAndReadback(width, height) {
  await seed('concurrent', width, height)
  const before = await evaluate('qualityProbe.terminal()')
  assert.ok(before && before.rows >= 3, 'Concurrent notices must leave actual Terminal rows readable')
  await click(terminal)
  await key('i', 'KeyI', 73, 'i')
  await waitFor(`qualityProbe.facts().writes.some(args=>args[1]==='i')`)
  // Terminal owns literal Tab for the CLI. The existing writable Composer provides ordinary reverse Tab traversal.
  await click(`(${pane}).querySelector('.tiptap')`)
  const tabs = await keyboardReach(summary, true)
  assert.equal(await evaluate(`${details}.open`), false)
  await key(' ', 'Space', 32, ' ')
  await waitFor(`${details}.open`)
  const original = `${details}.querySelector('.service-window__original')`
  await key('Tab', 'Tab', 9)
  assert.equal(await evaluate(`document.activeElement===${original}`), true)
  const last = `${original}.lastElementChild`
  // Actual wheel, never scrollIntoView/scrollTop/Terminal.scrollTo*. Nested scroll chains are observed.
  for (let n = 0; n < 20; n++) {
    await wheel(original, 100)
    const lastVisible = await evaluate(`(()=>{const e=${last},r=document.createRange();r.selectNodeContents(e);const line=[...r.getClientRects()].at(-1),o=${original}.getBoundingClientRect(),t=(${pane}).querySelector('.terminal-service-window').getBoundingClientRect();return !!line&&line.bottom<=Math.min(o.bottom,t.bottom,innerHeight)+1&&line.top>=Math.max(o.top,t.top,0)-1})()`)
    if (lastVisible) break
  }
  const detailFacts = await evaluate(`(()=>{const e=${last},r=document.createRange();r.selectNodeContents(e);const last=[...r.getClientRects()].at(-1),o=${original}.getBoundingClientRect(),t=(${pane}).querySelector('.terminal-service-window').getBoundingClientRect();return {last:e.innerText,visible:!!last&&last.bottom<=Math.min(o.bottom,t.bottom,innerHeight)+1&&last.top>=Math.max(o.top,t.top,0)-1,selectable:getComputedStyle(${original}).userSelect}})()`)
  assert.equal(detailFacts.visible, true, 'Original restoration last line must be actually readable inside both scroll clips')
  assert.equal(detailFacts.selectable, 'text')
  const afterOpen = await evaluate('qualityProbe.terminal()')
  assert.equal(afterOpen.id, before.id, 'Details must retain the original actual xterm instance')
  assert.ok(afterOpen.rows >= 3)
  await capture(`${width}x${height}-concurrent-details`, { ...await evaluate(measure), detailFacts, tabs })
  // Shift+Tab back to native summary, then keyboard close; facts remain beside the original terminal.
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
  assert.equal(await evaluate(`document.activeElement===${summary}`), true)
  await key(' ', 'Space', 32, ' '); await waitFor(`!${details}.open`)
  await click(terminal)
  await key('j', 'KeyJ', 74, 'j'); await waitFor(`qualityProbe.facts().writes.some(args=>args[1]==='j')`)
  // Read first, middle and newest retained original bytes through trusted wheel and visible xterm rows.
  const reads = []
  for (let n = 0; n < 30; n++) { if ((await evaluate('qualityProbe.terminal()')).visibleLines.some(line => line.includes('OUTPUT 000 FIRST'))) break; await wheel(terminal, -1000) }
  await waitFor(`qualityProbe.terminal().visibleLines.some(line=>line.includes('OUTPUT 000 FIRST'))`)
  reads.push({ marker: 'first', ...await evaluate('qualityProbe.terminal()') })
  for (let n = 0; n < 120; n++) {
    const facts = await evaluate('qualityProbe.terminal()')
    if (facts.visibleLines.some(line => line.includes('OUTPUT 050 MIDDLE'))) break
    await wheel(terminal, facts.viewportY < 50 ? 16 : -16)
  }
  assert.ok((await evaluate('qualityProbe.terminal()')).visibleLines.some(line => line.includes('OUTPUT 050 MIDDLE')), 'Middle original output must be actually visible after trusted scrolling')
  reads.push({ marker: 'middle', ...await evaluate('qualityProbe.terminal()') })
  for (let n = 0; n < 30; n++) { if ((await evaluate('qualityProbe.terminal()')).visibleLines.some(line => line.includes('OUTPUT 099 LATEST'))) break; await wheel(terminal, 1000) }
  await waitFor(`qualityProbe.terminal().visibleLines.some(line=>line.includes('OUTPUT 099 LATEST'))`)
  reads.push({ marker: 'latest', ...await evaluate('qualityProbe.terminal()') })
  assert.equal(reads.length, 3); assert.ok(reads.every(read => read.id === before.id))
  const facts = await evaluate('qualityProbe.facts()')
  assert.equal(facts.draft, 'Preserved draft'); assert.equal(facts.screenshots, 0)
  assert.ok(facts.events.filter(event => event.type === 'wheel').length > 0)
  assert.ok(facts.events.filter(event => event.type === 'keydown').length > 0)
  assert.ok(facts.events.filter(event => event.type === 'wheel' || event.type === 'keydown').every(event => event.trusted))
  result.interactions.push({ width, height, before, afterOpen, detailFacts, reads, facts })
}
async function auxiliaryDetails() {
  await seed('normal', 320, 400)
  await click(terminal); await key('k', 'KeyK', 75, 'k')
  await waitFor(`qualityProbe.facts().writes.some(args=>args[1]==='k')`)
  const original = await evaluate('qualityProbe.terminal()')
  await evaluate('window.qualityOriginalFocus=document.activeElement;qualityProbe.arriveLifecycle()')
  await painted()
  assert.equal(await evaluate('document.activeElement===window.qualityOriginalFocus'), true, 'Notice arrival must retain actual Terminal input focus')
  assert.equal((await evaluate('qualityProbe.terminal()')).id, original.id)
  await capture('320x400-notice-arrival-focus', { ...await evaluate(measure), originalXterm: original.id, retainedFocus: true })
  await seed('unknown', 320, 400)
  const facts = await evaluate(measure)
  await capture('320x400-concurrent-aux-owning', facts)
  assert.ok(facts.terminal.height > 40 && facts.xterm.rows >= 3, 'Concurrent lifecycle notices must retain at least three readable original Terminal rows')
  assert.equal(facts.notices.length, 2)
  assert.ok(facts.notices.every(notice => notice.step && notice.mode && notice.restore))
  assert.ok(facts.notices.some(notice => notice.kind === 'indeterminate'))
  assert.equal(await evaluate(`(${pane}).querySelectorAll('.service-window__details').length`), 2)
  const before = await evaluate('qualityProbe.terminal()'), control = await evaluate('qualityProbe.facts().session')
  const witnesses = []
  async function fromHeader(expression) {
    await click(`(${pane}).querySelector('.agent-region-header__more')`)
    await waitFor(`Boolean(document.querySelector('.agent-region-menu'))`)
    await key('Escape', 'Escape', 27); await waitFor(`!document.querySelector('.agent-region-menu')`)
    return keyboardReach(expression)
  }
  for (let index = 0; index < 2; index++) {
    const detail = `(${pane}).querySelectorAll('.service-window__details')[${index}]`, summary = `${detail}.querySelector('summary')`, original = `${detail}.querySelector('.service-window__original')`
    await fromHeader(summary)
    await key(' ', 'Space', 32, ' '); await waitFor(`${detail}.open`)
    await key('Tab', 'Tab', 9); assert.equal(await evaluate(`document.activeElement===${original}`), true)
    const cause = index === 0 ? 'FINAL LAUNCH CAUSE' : 'FINAL LIFECYCLE CAUSE'
    const witness = needle => `(()=>{const o=${original},node=needle?o.querySelector(${index === 0 ? "'strong'" : "'span'"}):o.lastElementChild,range=document.createRange();if(needle){const text=node.firstChild,start=text.textContent.indexOf(needle);if(start<0)throw new Error('Original cause missing');range.setStart(text,start);range.setEnd(text,start+needle.length)}else range.selectNodeContents(node);const line=[...range.getClientRects()].at(-1),r=o.getBoundingClientRect(),p=o.closest('.agent-launch-notice').getBoundingClientRect();return {text:needle??node.innerText,visible:!!line&&line.top>=Math.max(r.top,p.top,0)-1&&line.bottom<=Math.min(r.bottom,p.bottom,innerHeight)+1,selectable:getComputedStyle(o).userSelect}})()`
    const saved = []
    for (const needle of [cause, null]) {
      let observed
      for (let n = 0; n < 30; n++) {
        observed = await evaluate(`(()=>{const needle=${JSON.stringify(needle)};return ${witness(needle)}})()`)
        if (observed.visible) break
        await wheel(original, 80)
      }
      assert.equal(observed.visible, true, 'Original full cause and restoration last line must be actually readable inside the local scroll clips')
      assert.equal(observed.selectable, 'text'); saved.push(observed)
    }
    witnesses.push({ index, cause, saved })
    await painted()
    assert.equal((await evaluate('qualityProbe.terminal()')).id, before.id)
    assert.ok((await evaluate('qualityProbe.terminal()')).rows >= 3)
    await capture(`320x400-aux-${index}-details-last-line`, { ...await evaluate(measure), witnesses: saved })
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
    assert.equal(await evaluate(`document.activeElement===${summary}`), true)
    await key(' ', 'Space', 32, ' '); await waitFor(`!${detail}.open`)
  }
  const check = `[...(${pane}).querySelectorAll('button')].find(b=>b.innerText.trim()==='Check again')`
  // Closing the second disclosure leaves its native summary focused. Reverse Tab reaches the first original action.
  await keyboardReach(check, true)
  const retry = `[...(${pane}).querySelectorAll('button')].find(b=>b.innerText.trim()==='Retry Resume')`
  await keyboardReach(retry)
  await key(' ', 'Space', 32, ' '); await waitFor('qualityProbe.facts().recoveries.length>0')
  const after = await evaluate('qualityProbe.facts()')
  assert.deepEqual(after.session, control); assert.equal(after.draft, 'Preserved draft'); assert.equal(after.screenshots, 0)
  assert.deepEqual(after.recoveries.at(-1)[0], control)
  assert.equal((await evaluate('qualityProbe.terminal()')).id, before.id)
  // The independently seeded Check again scene proves its callback without relying on post-Resume error ownership.
  await seed('unknown', 320, 400)
  const refreshBefore = await evaluate('qualityProbe.terminal()')
  const attachmentCount = await evaluate('qualityProbe.facts().attachmentRefreshes.length')
  await click(check); await waitFor(`qualityProbe.facts().attachmentRefreshes.length>${attachmentCount}`)
  const refreshed = await evaluate('qualityProbe.facts()')
  assert.deepEqual(refreshed.refreshes.at(-1)[0], control); assert.deepEqual(refreshed.session, control)
  assert.deepEqual(refreshed.attachmentRefreshes.at(-1)[0], control)
  assert.ok(refreshed.attachmentRefreshes.at(-1)[1], 'Original Check again must refresh the mounted attachment lease')
  assert.ok(refreshed.attachmentRefreshes.at(-1)[2] > 0, 'Original output cursor must accompany the observation callback')
  assert.equal(refreshed.draft, 'Preserved draft'); assert.equal((await evaluate('qualityProbe.terminal()')).id, refreshBefore.id)
  result.auxiliary = { before, after, witnesses, refreshBefore, refreshed,
    qualification: 'Actual SessionPane recovery actions reach the controlled public API target in two explicitly seeded scenes; no real Core recovery inferred' }
}
async function observationDetails() {
  // The two new facts are their own scene; the retained four-fact matrix remains unchanged.
  await seed('observation', 420, 600)
  const before = await evaluate('qualityProbe.terminal()'), control = await evaluate('qualityProbe.facts().session')
  const initial = await evaluate(measure)
  assert.equal(initial.notices.length, 1)
  assert.ok(initial.notices[0].step.includes('Reattaching'))
  assert.ok(initial.notices[0].mode.includes('unconfirmed') && initial.notices[0].restore.includes('Unknown Input is not replayed'))
  await capture('420x600-session-observation-owner', initial)
  const refresh = `[...(${pane}).querySelector('.terminal-service-window').querySelectorAll('button')].find(b=>b.innerText.trim()==='Refresh observation')`
  const count = await evaluate('qualityProbe.facts().attachmentRefreshes.length')
  await click(refresh)
  await waitFor(`qualityProbe.facts().attachmentRefreshes.length>${count} && Boolean((${pane}).querySelector('.service-window__details'))`)
  await painted()
  const failed = await evaluate(measure)
  assert.equal(failed.notices.length, 2, 'Only this Session observation and attachment failure belong to the new scene')
  assert.ok(failed.notices.every(notice => notice.step && notice.mode && notice.restore))
  assert.ok(failed.terminal.height > 40 && failed.xterm.rows >= 3)
  assert.equal(failed.xterm.id, before.id); assert.equal(failed.draft, 'Preserved draft')
  await capture('420x600-attachment-observation-refresh', failed)
  const detail = `(${pane}).querySelector('.terminal-service-window .service-window__details')`, summary = `${detail}.querySelector('summary')`, original = `${detail}.querySelector('.service-window__original')`
  await keyboardReach(summary, true)
  await key(' ', 'Space', 32, ' '); await waitFor(`${detail}.open`)
  await key('Tab', 'Tab', 9); assert.equal(await evaluate(`document.activeElement===${original}`), true)
  assert.ok(await evaluate(`${original}.innerText.includes('FINAL ATTACHMENT CAUSE')`))
  let last
  for (let n = 0; n < 30; n++) {
    last = await evaluate(`(()=>{const o=${original},e=o.lastElementChild,r=document.createRange();r.selectNodeContents(e);const line=[...r.getClientRects()].at(-1),b=o.getBoundingClientRect(),t=o.closest('.terminal-service-window').getBoundingClientRect();return {text:e.innerText,visible:!!line&&line.top>=Math.max(b.top,t.top,0)-1&&line.bottom<=Math.min(b.bottom,t.bottom,innerHeight)+1,selectable:getComputedStyle(o).userSelect}})()`)
    if (last.visible) break
    await wheel(original, 80)
  }
  assert.equal(last.visible, true, 'Original attachment restoration last line must be actually readable')
  assert.equal(last.selectable, 'text'); assert.ok(last.text.includes('Unknown Input is never replayed'))
  await painted()
  assert.equal((await evaluate('qualityProbe.terminal()')).id, before.id)
  assert.ok((await evaluate('qualityProbe.terminal()')).rows >= 3)
  await capture('420x600-attachment-details-last-line', { ...await evaluate(measure), last })
  await keyboardReach(summary, true)
  await key(' ', 'Space', 32, ' '); await waitFor(`!${detail}.open`)
  await keyboardReach(refresh)
  const retryCount = await evaluate('qualityProbe.facts().attachmentRefreshes.length')
  await key(' ', 'Space', 32, ' ')
  await waitFor(`qualityProbe.facts().attachmentRefreshes.length>${retryCount} && !(${pane}).querySelector('.terminal-service-window')`)
  await painted()
  const after = await evaluate('qualityProbe.facts()'), restored = await evaluate(measure)
  assert.deepEqual(after.session, control); assert.deepEqual(after.attachmentRefreshes.at(-1)[0], control)
  assert.equal(after.attachmentRefreshes.at(-1)[1], after.attachmentRefreshes[count][1], 'Refresh must retain the original output lease')
  assert.equal(after.draft, 'Preserved draft'); assert.equal(after.screenshots, 0)
  assert.equal(restored.xterm.id, before.id); assert.equal(restored.notices.length, 0)
  await capture('420x600-observation-restored-same-terminal', restored)
  result.observation = { before, control, failed, last, after, restored,
    qualification: 'Original SessionPane-bound Terminal refresh owner and exact preview attachment lease; controlled one-time failure, no real Core availability inferred' }
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false, sandbox: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') result.consoleErrors.push(details.message) })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.qualityProbe)')
    if (process.argv.includes('--aux-only')) { await auxiliaryDetails(); result.passed = true; return }
    if (process.argv.includes('--narrow-only')) {
      await seed('normal', 320, 400)
      const facts = await evaluate(measure)
      await capture('320x400-narrow-owning', facts)
      assert.equal(facts.pane.width, 320)
      assert.equal(facts.progress.rects.length, 1, 'No-loop actual progress caption must fit one line')
      assert.ok(facts.progress.label.x + facts.progress.label.width <= facts.progress.summaryRect.x + facts.progress.summaryRect.width + 1,
        'Actual narrow progress summary must contain its complete one-line caption')
      const send = await evaluate(`(()=>{const e=(${pane}).querySelector('.composer-send'),r=e.getBoundingClientRect();return {width:r.width,height:r.height,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.composer-send')===e}})()`)
      assert.ok(send.width > 0 && send.height > 0 && send.hit, 'Existing actual composer control must remain reachable')
      result.narrowControls = send; result.passed = true; return
    }
    for (const [width, height] of [[320, 400], [420, 600], [640, 600]]) {
      for (const mode of ['normal', 'single', 'concurrent', 'unknown', 'lifecycle', 'readonly', 'list-rejected', 'progress-unknown', 'progress-action', 'progress-busy', 'history']) {
        await seed(mode === 'history' ? 'normal' : mode, width, height)
        if (mode === 'progress-action' || mode === 'progress-busy') {
          const control = `(${pane}).querySelector('.continuous-progress-control')`
          await click(`${control}.querySelector('summary')`)
          await click(`${control}.querySelector('[aria-label="Pause continuous progress"]')`)
          if (mode === 'progress-action') {
            await waitFor(`${control}.innerText.includes('FINAL ACTION CAUSE')`)
            await click(`${control}.querySelector('summary')`)
          } else {
            await waitFor(`${control}.querySelector('[aria-label="Pause continuous progress"]').disabled`)
            assert.ok(await evaluate(`${control}.querySelector('[aria-label="Pause continuous progress"]').disabled`))
          }
        }
        if (mode === 'history') {
          await click(`(${pane}).querySelector('.agent-region-header__more')`)
          await waitFor(`Boolean(document.querySelector('.agent-region-menu'))`)
          await click(`[...document.querySelector('.agent-region-menu').querySelectorAll('[role="menuitem"]')].find(e=>e.innerText.trim()==='Conversation history')`)
          await waitFor(`Boolean((${pane}).querySelector('.session-history:not(.session-history--inline)'))`)
        }
        await painted()
        const facts = await evaluate(measure)
        assert.ok(facts.terminal.width > 200 && facts.terminal.height > 40, 'Actual terminal reading/input region must remain usable: ' + JSON.stringify(facts))
        assert.ok(facts.xterm.rows >= 3, 'Actual xterm needs readable rows: ' + JSON.stringify(facts))
        assert.equal(facts.screenshotCalls, 0); assert.equal(facts.draft, 'Preserved draft')
        assert.ok(facts.header.name.includes('Original Agent'))
        assert.equal(facts.pane.width, width, 'The actual constrained Region must match its requested width')
        assert.equal(facts.pane.height, height)
        if (mode !== 'history') assert.ok(facts.header.more.width === 22 && facts.header.more.height === 22)
        if (mode === 'normal') { assert.equal(facts.notices.length, 0); assert.equal(facts.progress.rects.length, 1, 'No-loop actual progress caption must fit one line') }
        if (mode === 'single') assert.equal(facts.notices.length, 1)
        if (mode === 'concurrent') assert.equal(facts.notices.length, 2)
        if (mode === 'unknown') { assert.ok(facts.notices.length >= 2); assert.ok(facts.notices.some(notice => notice.kind === 'indeterminate')); assert.ok(facts.notices.every(notice => notice.step && notice.mode && notice.restore)) }
        if (mode === 'list-rejected' || mode === 'progress-action' || mode === 'progress-unknown') assert.ok(facts.progress.summary.includes('Unconfirmed'))
        if (mode === 'readonly') { assert.equal(facts.composer, null); assert.equal(facts.header.readonly, true) }
        if (mode === 'history') assert.equal(facts.history, true)
        await capture(`${width}x${height}-${mode}`, facts)
      }
      await detailsAndReadback(width, height)
    }
    for (const [width, height] of [[1440, 900], [960, 400]]) for (const appearance of ['dark', 'light']) {
      await seed('concurrent', width, height, true, appearance, appearance === 'light')
      const facts = await evaluate(measure)
      assert.ok(facts.terminal.height > 40 && facts.xterm.rows >= 3)
      assert.equal(facts.appearance, appearance); assert.equal(facts.reducedMotion, appearance === 'light')
      const close = `document.querySelector('[data-workbench-region-id="quality-target"] .workbench-region__close')`
      const hits = await evaluate(`(()=>{const e=${close},r=e.getBoundingClientRect();return [[.5,.5],[.1,.1],[.9,.9]].map(([x,y])=>document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)?.closest('.workbench-region__close')===e)})()`)
      assert.equal(hits.length, 3); assert.ok(hits.every(Boolean), 'Original Region X must keep its target')
      await capture(`${width}x${height}-${appearance}-window`, { ...facts, closeHits: hits })
    }
    await auxiliaryDetails()
    await observationDetails()
    assert.equal(result.frames.length, 48)
    assert.equal(result.interactions.length, 3)
    assert.deepEqual(result.consoleErrors, [])
    result.passed = true
  } catch (error) {
    result.failure = { name: error?.name || typeof error, message: error?.message || String(error), stack: error.stack, stage: result.stage }
    if (win && !win.isDestroyed()) { try { await capture('failure-current-frame', { facts: await evaluate(measure) }) } catch {} }
  }
  finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
