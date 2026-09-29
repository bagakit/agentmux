const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Reuses the existing actual App + private ConfigOwner transport. The only
// sampling loop belongs to this bounded observation, never to product code.
exports.run = async function run(p) {
  const { win, read, q, button, until, settle, click, field, type, scene, capture, section, owner, result, evidence, mode } = p
  const task = mode === 'liquid-settings' ? 'settings' : 'prompts'
  const host = task === 'settings' ? 'nav[aria-label="Settings sections"]' : '.prompt-library__items'
  const lens = `${host} [data-liquid-selection]`
  const targetAttribute = task === 'settings' ? 'data-settings-target' : 'data-prompt-id'
  const target = id => `${host} [${targetAttribute}=${JSON.stringify(id)}]`
  const snap = () => read(`(()=>{const n=${q(lens)},h=${q(host)};if(!n||!h)return null;const id=n.dataset.liquidSelection,t=[...h.querySelectorAll('[${targetAttribute}]')].find(t=>t.getAttribute('${targetAttribute}')===id);return{connected:n.isConnected,id,paused:n.dataset.liquidPaused,hidden:n.hidden,visibility:document.visibilityState,rect:n.getBoundingClientRect().toJSON(),target:t?.getBoundingClientRect().toJSON(),running:n.getAnimations({subtree:true}).filter(a=>a.playState==='running'||a.playState==='pending').length,pointerX:n.style.getPropertyValue('--liquid-pointer-x'),pointerY:n.style.getPropertyValue('--liquid-pointer-y'),nativeSelected:t?.getAttribute('${task === 'settings' ? 'aria-current' : 'aria-pressed'}'),contentTransforms:t?[...t.querySelectorAll('span,strong,svg')].map(c=>getComputedStyle(c).transform):[],activeElement:document.activeElement?.getAttribute('${targetAttribute}')}})()`)
  const docked = async id => {
    const state = await snap()
    assert.ok(state?.connected && state.target, 'Selected surface and native target are connected')
    assert.equal(state.id, id, 'Actual selection owns the surface identity')
    assert.equal(state.nativeSelected, task === 'settings' ? 'page' : 'true')
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(state.rect[key] - state.target[key]) < 1, `Surface ${key} docks on its own selected target`)
    assert.ok(state.contentTransforms.length > 0, 'The native label/icon subtree is not empty')
    assert.deepEqual([...new Set(state.contentTransforms)], ['none'], 'Flow never scales the original text or icon')
    return state
  }
  const trusted = async selector => {
    const hit = await read(`(()=>{const n=${q(selector)};if(!n||!n.checkVisibility())throw Error('Missing visible native target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,reachable:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
    assert.ok(hit.reachable, 'Natural motion uses a reachable actual button')
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: hit.x, y: hit.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: hit.x, y: hit.y })
    result.actions.push({ nativeClick: selector, ...hit })
  }
  const record = async duration => {
    await read(`(()=>{const node=${q(lens)};if(!node)throw Error('No connected selection surface');const started=performance.now();window.liquidTrace={node,samples:[],done:false};function sample(){const h=${q(host)},id=node.dataset.liquidSelection,t=[...h.querySelectorAll('[${targetAttribute}]')].find(t=>t.getAttribute('${targetAttribute}')===id);window.liquidTrace.samples.push({at:performance.now()-started,id,connected:node.isConnected,sameNode:node===${q(lens)},rect:node.getBoundingClientRect().toJSON(),target:t?.getBoundingClientRect().toJSON(),running:node.getAnimations().filter(a=>a.playState==='running').length});if(performance.now()-started<${duration})requestAnimationFrame(sample);else window.liquidTrace.done=true}sample()})()`)
  }
  const trace = async () => {
    await until('window.liquidTrace?.done')
    const samples = await read('window.liquidTrace.samples')
    assert.ok(samples.length > 5, 'Actual Renderer motion sequence is nonempty')
    assert.deepEqual([...new Set(samples.map(s => s.connected && s.sameNode))], [true], 'One connected surface survives the whole flow')
    result.motion ??= []
    return samples
  }
  const frame = async (file, scenario) => {
    const state = await snap()
    assert.ok(state?.connected, 'Intermediate PNG belongs to the connected product surface')
    fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    result.frames.push({ file, scenario, naturalState: state })
  }
  const flow = async (from, to) => {
    await click(q(target(from))); await delay(460)
    const start = await docked(from)
    await capture(`${task}-start.png`, 'Full actual work surface at the selection origin')
    await record(650); await trusted(target(to))
    await delay(55); await frame(`${task}-middle-early.png`, 'Naturally occurring early moving shape; no animation time/keyframe override')
    await delay(45); await frame(`${task}-middle.png`, 'Naturally occurring later moving shape; no animation time/keyframe override')
    const samples = await trace(), end = await docked(to)
    const middle = samples.filter(s => Math.hypot(s.rect.x - start.rect.x, s.rect.y - start.rect.y) > 1 && Math.hypot(s.rect.x - end.rect.x, s.rect.y - end.rect.y) > 1)
    assert.ok(middle.length > 1, 'Movement reaches at least two natural intermediate frames outside origin and destination')
    assert.ok(new Set(middle.map(s => `${s.rect.x.toFixed(1)}:${s.rect.y.toFixed(1)}`)).size > 1, 'Intermediate positions actually differ')
    assert.ok(middle.some(s => Math.abs(s.rect.width - end.rect.width) > 1 || Math.abs(s.rect.height - end.rect.height) > 1), 'Natural movement includes visible finite shape change')
    assert.equal(end.running, 0, 'Finite selection animation settles without a persistent loop')
    result.motion.push({ scenario: 'natural-flow', from, to, samples })
    await capture(`${task}-end.png`, 'Full actual work surface after docking on the latest selected object')
  }
  const rapid = async (from, first, last) => {
    await click(q(target(from))); await delay(460)
    const start = await docked(from)
    await record(700); await trusted(target(first)); await delay(110)
    const before = await snap()
    assert.ok(Math.hypot(before.rect.x - start.rect.x, before.rect.y - start.rect.y) > 4, 'Rapid retarget starts during an actual in-flight move')
    await trusted(target(last)); await until(`${q(lens)}?.dataset.liquidSelection===${JSON.stringify(last)}`)
    const after = await snap()
    const jump = Math.hypot(after.rect.x - before.rect.x, after.rect.y - before.rect.y)
    const oldDestinationDistance = Math.hypot(before.target.x - before.rect.x, before.target.y - before.rect.y)
    assert.ok(jump < Math.max(12, oldDestinationDistance * 0.5), 'Rapid retarget continues from the current visible shape instead of the cancelled inline endpoint')
    const samples = await trace()
    result.motion.push({ scenario: 'rapid-retarget', from, first, last, before, after, samples })
    await docked(last)
  }
  const runningMove = async (from, to) => {
    await click(q(target(from))); await delay(460)
    await trusted(target(to)); await delay(55)
    const state = await snap()
    assert.equal(state.paused, 'false', 'Stop checks start from the genuinely active visible consumer')
    assert.ok(state.running > 0, 'Stop checks interrupt an owned product animation before its natural end')
  }
  const paused = async reason => {
    const state = await snap()
    assert.equal(state.paused, 'true', `${reason}: product marks its paused state`)
    assert.equal(state.running, 0, `${reason}: owned animation is cancelled before 420ms expiry`)
    assert.equal(state.pointerX, '', `${reason}: owned pointer feedback is cleared`)
    assert.equal(state.pointerY, '')
    result.actions.push({ stopped: reason, state })
  }

  win.showInactive()
  await until('document.visibilityState==="visible"')
  assert.equal(win.isVisible(), true, 'This private window is genuinely visible')
  await scene(1480, 'light')
  if (task === 'settings') await section('general')
  assert.equal(await read(`${q(host)}.querySelectorAll('[data-liquid-selection]').length`), 1)
  assert.equal(await read(`getComputedStyle(${q(lens)}).pointerEvents`), 'none')
  assert.equal(await read(`${q(lens)}.getAttribute('aria-hidden')`), 'true')
  const from = task === 'settings' ? 'general' : 'explain'
  const to = task === 'settings' ? 'prompts' : 'continue'
  const last = task === 'settings' ? 'appearance' : 'review'
  await flow(from, to)
  await rapid(from, to, last)

  // Pointer feedback changes only the decoration; native selection and labels remain still.
  const state = await docked(last)
  for (const fraction of [0.2, 0.8]) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: state.rect.x + state.rect.width * fraction, y: state.rect.y + state.rect.height * 0.5 })
    await delay(25)
    const lit = await snap()
    assert.ok(lit.pointerX, 'Local native pointer move changes the surface light')
    assert.equal(lit.id, last, 'Light feedback never selects a category or Prompt')
    result.actions.push({ pointerFraction: fraction, state: lit })
  }
  const pointerStates = result.actions.filter(a => a.pointerFraction !== undefined)
  assert.equal(pointerStates.length, 2)
  assert.notEqual(pointerStates[0].state.pointerX, pointerStates[1].state.pointerX)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1450, y: 850 }); await delay(25)
  assert.equal((await snap()).pointerX, '', 'Leaving the region clears its light')

  await runningMove(from, to)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await until('matchMedia("(prefers-reduced-motion: reduce)").matches'); await delay(20)
  await paused('dynamic reduced motion')
  await trusted(target(last)); await settle(); await docked(last)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); await settle()

  await runningMove(from, to)
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
  win.hide(); await until('document.visibilityState==="hidden"')
  assert.equal(win.isVisible(), false, 'Real BrowserWindow.hide owns visibility, not a patched document getter')
  await paused('real hidden window')
  win.showInactive(); await until('document.visibilityState==="visible"'); await settle(); await docked(to)
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })

  if (task === 'settings') {
    // Native keyboard activation on connected controls, not HTMLElement.click as a substitute.
    const keyboardOrder = await read(`(()=>{const nodes=[...${q(host)}.querySelectorAll('[data-settings-target]')].filter(n=>n.isConnected&&n.checkVisibility());const ids=nodes.map(n=>n.getAttribute('data-settings-target'));return{ids,next:ids[ids.indexOf('general')+1]}})()`)
    assert.ok(keyboardOrder.ids.length > 1, 'Native keyboard order comes from a nonempty actual connected visible navigation')
    assert.ok(keyboardOrder.ids.includes('general') && keyboardOrder.next, 'General has an actual next category in the current product DOM order')
    await read(`(()=>{window.liquidKeyboardTrace=[];const events=['keydown','keypress','keyup'];const observer=e=>{if(window.liquidKeyboardTrace.length>=24)return;const n=document.activeElement,entry={type:e.type,key:e.key,code:e.code,keyCode:e.keyCode,isTrusted:e.isTrusted,focus:n?.getAttribute('data-settings-target'),connected:n?.isConnected,defaultPrevented:e.defaultPrevented};window.liquidKeyboardTrace.push(entry);queueMicrotask(()=>entry.defaultPrevented=e.defaultPrevented)};for(const type of events)document.addEventListener(type,observer,{capture:true,passive:true});window.liquidKeyboardStop=()=>{for(const type of events)document.removeEventListener(type,observer,{capture:true})}})()`)
    await read(`${q(target('general'))}.focus()`)
    const key = async keyCode => {
      const start = await read('window.liquidKeyboardTrace.length')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (keyCode === 'Enter' || keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      await settle()
      const events = await read(`window.liquidKeyboardTrace.slice(${start})`)
      result.actions.push({ nativeKey: keyCode, events })
      assert.ok(events.length > 1, 'Native keyboard activation produces a nonempty actual event sequence')
      assert.deepEqual([...new Set(events.map(event => event.isTrusted))], [true], 'Electron input produces genuine Renderer keyboard events')
      assert.ok(events.some(event => event.type === 'keydown') && events.some(event => event.type === 'keyup'), 'The actual input sequence includes native down and up')
      if (keyCode !== 'Tab') assert.ok(events.some(event => event.type === 'keypress'), 'Activation includes the actual character event needed for native button defaults')
    }
    const keyboard = () => read(`(()=>{const n=document.activeElement;return{connected:n.isConnected,visible:n.checkVisibility(),id:n.getAttribute('data-settings-target'),selected:n.getAttribute('aria-current'),page:document.querySelector('.settings-page').dataset.settingsPage}})()`)
    await key('Tab')
    const tabbed = await keyboard()
    assert.ok(tabbed.connected && tabbed.visible, 'Tab reaches an actual connected visible category')
    assert.equal(tabbed.id, keyboardOrder.next)
    assert.notEqual(tabbed.selected, 'page', 'Enter starts from an unselected actual category')
    await key('Enter')
    const entered = await keyboard()
    assert.equal(entered.id, keyboardOrder.next); assert.equal(entered.page, keyboardOrder.next); assert.equal(entered.selected, 'page')
    await read(`${q(target('prompts'))}.focus()`)
    assert.notEqual((await keyboard()).selected, 'page', 'Space starts from a different unselected category')
    await key('Space')
    const spaced = await keyboard()
    assert.ok(spaced.connected && spaced.visible); assert.equal(spaced.id, 'prompts'); assert.equal(spaced.page, 'prompts'); assert.equal(spaced.selected, 'page')
    result.actions.push({ keyboard: { order: keyboardOrder, tabbed, entered, spaced } })
    await read('window.liquidKeyboardStop()')
    await type(q('[aria-label="Search settings"]'), 'no-match-liquid-proof')
    assert.equal(await read(`${q(host)}.querySelectorAll('[data-settings-target]').length`), 0)
    assert.equal((await snap()).hidden, true, 'No visible target never means attach to a neighbouring category')
    await click(q('[aria-label="Clear settings search"]'))
    await settle()
    const id = await read("document.querySelector('.settings-page').dataset.settingsPage")
    await docked(id)
    await click(q(target('appearance'))); await delay(460); await docked('appearance')
    win.setContentSize(1480, 420); await until('innerHeight===420'); await settle()
    const scroll = await read(`(()=>{const n=${q(host)};const before=n.scrollTop;n.scrollTop=n.scrollHeight;return{before,after:n.scrollTop,height:n.clientHeight,total:n.scrollHeight,rect:n.getBoundingClientRect().toJSON()}})()`)
    assert.ok(scroll.total > scroll.height && scroll.height > 0, 'The private short window creates a real nonempty scrollable category viewport')
    assert.ok(scroll.after > scroll.before, 'Category scroll actually changes the owning viewport')
    await settle()
    const scrolled = await snap()
    assert.equal(scrolled.id, 'appearance'); assert.equal(scrolled.nativeSelected, 'page')
    if (scrolled.target.bottom <= scroll.rect.top || scrolled.target.top >= scroll.rect.bottom) assert.equal(scrolled.hidden, true, 'An offscreen selected target hides the lens instead of borrowing another row')
    else await docked('appearance')
    result.actions.push({ scrolling: { scroll, scrolled } })
    await read(`${q(host)}.scrollTop=0`)
    win.setContentSize(1480, 900); await until('innerHeight===900'); await settle(); await docked('appearance')
    await scene(940, 'light')
    assert.equal(await read(`${q(host)}.checkVisibility()`), true, 'Resize proof retains a visible actual category viewport')
    await docked('appearance')
    await capture('settings-940-light.png', 'Resized actual category viewport docks on the same selected fact')
    await scene(320, 'dark')
    assert.equal(await read(`${q(host)}.checkVisibility()`), false, 'The narrow original category viewport is genuinely hidden')
    await paused('narrow hidden category viewport')
    assert.equal((await snap()).hidden, true)
    await section('prompts'); await capture('settings-320-dark.png', 'Narrow original category menu and clear title, actual full window')
    await scene(1480, 'dark'); await docked('prompts')
    await section('general'); await delay(460); await docked('general')
    await capture('settings-1480-dark.png', 'Dark actual Settings with restrained local selection surface')
  } else {
    await promptsChecks(p, { host, lens, target, snap, docked, paused, runningMove })
  }
  const commitsBeforeClose = owner.current
  await click(q('[aria-label="Close settings"]'))
  assert.equal(await read('document.querySelectorAll("[data-liquid-selection]").length'), 0, 'Closing Settings removes its own motion consumers')
  assert.deepEqual(owner.current, commitsBeforeClose, 'Closing Settings never writes a config merely to stop motion')
  await click(q('.window-status-bar [aria-label="Settings"]')); await section(task === 'settings' ? 'general' : 'prompts')
}

async function promptsChecks(p, helpers) {
  // T2 is filled against its owning product slice after T1 qualification.
  throw new Error('Prompt liquid scenario is not yet qualified')
}
