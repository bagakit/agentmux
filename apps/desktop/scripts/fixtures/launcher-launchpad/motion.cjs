const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')

// Native pointer/keyboard actions and naturally advancing Renderer frames. No
// animation seeking, pausing, duration override, or screenshot hold is used.
module.exports = async function captureMotion({ win, evaluate, element, delay, wait, paint, viewport, click, escape, type, frame, assertGeometry, report, profile, evidence }) {
  const command = (method, params) => win.webContents.debugger.sendCommand(method, params)
  async function rawClick(expression) {
    const point = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing actual target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  }
  async function key(key, code = key, windowsVirtualKeyCode = key === 'Tab' ? 9 : 27, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers })
  }
  async function arm(name, selector) {
    await evaluate(`(()=>{window.motionTrace?.stop();const samples=[];let running=true,raf;const started=performance.now();const tick=()=>{if(!running)return;const e=document.querySelector(${JSON.stringify(selector)});if(e){const r=e.getBoundingClientRect(),s=getComputedStyle(e);samples.push({at:performance.now()-started,x:r.x,y:r.y,width:r.width,height:r.height,opacity:Number(s.opacity),transform:s.transform,state:e.dataset.state,paused:e.dataset.liquidPaused,animations:e.getAnimations().map(a=>({name:a.animationName??null,time:a.currentTime,duration:a.effect.getComputedTiming().duration,playState:a.playState}))})}raf=requestAnimationFrame(tick)};window.motionTrace={name:${JSON.stringify(name)},samples,stop(){running=false;cancelAnimationFrame(raf)}};tick()})()`)
  }
  async function middle(name) {
    await delay(24)
    const file = `${name}-middle.png`
    await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    report.frames.push({ name: `${name}-middle`, file, naturalIntermediateFrame: true })
  }
  async function trace(name, selector, action, { intermediate = true } = {}) {
    await arm(name, selector)
    await action()
    if (intermediate) await middle(name)
    await delay(500)
    const samples = await evaluate('(()=>{motionTrace.stop();return motionTrace.samples})()')
    assert.ok(samples.length > 1, `${name}: actual nonempty Renderer time series`)
    const expectedAnimation = /^motion-(host|options)-/.test(name) ? (name.endsWith('-enter') ? 'launcher-panel-in' : 'launcher-panel-out')
      : name.startsWith('motion-browser-') ? (name.endsWith('-enter') ? 'launcher-browser-open' : 'launcher-browser-close')
      : name === 'motion-agent-enter' ? 'settings-pane-in' : null
    assert.ok(samples.some(sample => sample.animations.some(animation => animation.name === expectedAnimation && Number(animation.time) > 0 && Number(animation.time) < Number(animation.duration))), `${name}: actual finite motion has an intermediate time`)
    report.motion.push({ name, selector, expectedAnimation, samples, naturallyAdvanced: true })
  }
  const lens = '[data-workbench-region-id="launchpad-input"] .agent-picks [data-liquid-selection]'
  report.motion = []
  await viewport(1180, 820)
  await wait(`Boolean(${element('.launch-terminal__body .xterm')})`)
  const original = await evaluate('launchpad.facts()')
  await frame('motion-default-terminal')

  for (let count = 0; count < 30 && await evaluate('document.activeElement.getAttribute("aria-label")!=="Runtime environment"'); count++) await key('Tab')
  const focus = await evaluate('(()=>{const e=document.activeElement,s=getComputedStyle(e);return{label:e.getAttribute("aria-label"),width:s.outlineWidth,style:s.outlineStyle}})()')
  assert.deepEqual(focus, { label: 'Runtime environment', width: '2px', style: 'solid' }, 'Native keyboard navigation gives the custom control an independent visible focus')
  await frame('motion-keyboard-focus')
  const pointer = await evaluate(`(()=>{const r=${element('[aria-label="Runtime environment"]')}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointer })
  await delay(150)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer, button: 'left', clickCount: 1 })
  const pressed = await evaluate(`getComputedStyle(${element('[aria-label="Runtime environment"]')}).boxShadow`)
  assert.ok(pressed.includes('inset'), 'A native press has a local material response')
  await middle('motion-native-press')
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pointer, button: 'left', clickCount: 1 })
  await delay(180); await escape()

  await trace('motion-host-enter', '.launcher-environment__panel', () => rawClick(element('[aria-label="Runtime environment"]')))
  await frame('motion-host-open')
  await trace('motion-host-exit', '.launcher-environment__panel', () => key('Escape'), { intermediate: true })
  assert.equal(await evaluate('Boolean(document.querySelector(".launcher-environment__panel"))'), false, 'Finite Host exit really unmounts')
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Runtime environment', 'Escape immediately returns to the trigger')

  await click(element('[aria-label="Collapse Agents"]'))
  await trace('motion-agent-enter', '[data-workbench-region-id="launchpad-input"] .launcher-composer', () => rawClick(element('[aria-label="Expand Agents"]')))
  const picks = await evaluate(`${element('.agent-picks')} && [...${element('.agent-picks')}.querySelectorAll(':scope > button[data-executor-id]')].map(e=>({id:e.dataset.executorId,selected:e.getAttribute('aria-pressed')}))`)
  assert.ok(picks.length > 2, 'Actual catalog has alternative targets')
  const target = picks.find(pick => pick.selected !== 'true').id
  await trace('motion-agent-selection', lens, () => rawClick(element(`.agent-picks > button[data-executor-id="${target}"]`)))
  assert.equal(await evaluate(`${element(`.agent-picks > button[data-executor-id="${target}"]`)}.getAttribute('aria-pressed')`), 'true')
  const editor = await evaluate('(()=>{window.motionOriginalEditor='+element('.launcher-composer .tiptap')+';return Boolean(motionOriginalEditor)})()')
  assert.ok(editor)
  await frame('motion-agent-selected')

  // Two further genuine choices during a running shared selection animation.
  const next = picks.find(pick => pick.id !== target).id, last = picks.find(pick => pick.id !== target && pick.id !== next).id
  await arm('rapid-selection', lens)
  await rawClick(element(`.agent-picks > button[data-executor-id="${next}"]`)); await delay(45)
  await rawClick(element(`.agent-picks > button[data-executor-id="${last}"]`)); await middle('motion-rapid-selection')
  assert.equal(await evaluate(`${element(`.agent-picks > button[data-executor-id="${last}"]`)}.getAttribute('aria-pressed')`), 'true', 'The original selection owner changes before the animation finishes')
  await delay(500)
  const rapid = await evaluate('(()=>{motionTrace.stop();return motionTrace.samples})()')
  assert.ok(rapid.length > 2); assert.equal(await evaluate(`${element('.agent-picks [data-liquid-selection]')}.dataset.liquidSelection`), last)
  assert.equal(await evaluate('motionOriginalEditor === '+element('.launcher-composer .tiptap')), true, 'Selection does not remount the real editor')
  report.motion.push({ name: 'rapid-selection', selector: lens, samples: rapid, naturallyAdvanced: true })

  await trace('motion-options-enter', '.launch-refine__panel', () => rawClick(element('[aria-label="Launch options"]')))
  await frame('motion-options-open')
  await arm('motion-options-exit', '.launch-refine__panel')
  await key('Escape')
  const exiting = await evaluate('(()=>{const p=document.querySelector(".launch-refine__panel");return{present:!!p,state:p?.dataset.state,inert:p?.inert,focus:document.activeElement.getAttribute("aria-label")}})()')
  assert.deepEqual(exiting, { present: true, state: 'closed', inert: true, focus: 'Launch options' }, 'Closed content is immediately inert while the finite exit remains visible')
  await key('Tab', 'Tab', 9, 8)
  await evaluate('window.motionTransferredFocus=document.activeElement')
  await middle('motion-options-exit')
  await delay(250)
  assert.equal(await evaluate('document.activeElement === motionTransferredFocus'), true, 'The old exit cannot steal a subsequent keyboard focus')
  assert.equal(await evaluate('Boolean(document.querySelector(".launch-refine__panel"))'), false, 'Finite Options exit really unmounts')
  const optionsExit = await evaluate('(()=>{motionTrace.stop();return motionTrace.samples})()')
  assert.ok(optionsExit.length > 1 && optionsExit.some(sample => sample.animations.some(animation => animation.name === 'launcher-panel-out' && Number(animation.time) > 0 && Number(animation.time) < Number(animation.duration))), 'Options exit has a real nonempty finite intermediate process')
  report.motion.push({ name: 'motion-options-exit', selector: '.launch-refine__panel', samples: optionsExit, naturallyAdvanced: true })

  await rawClick(element('[aria-label="Launch options"]')); await delay(25)
  await key('Escape'); await rawClick(element('[aria-label="Launch options"]')); await delay(250)
  assert.equal(await evaluate('document.querySelector(".launch-refine__panel")?.dataset.state'), 'open', 'A rapid reopen survives the old exit')
  await escape()

  await trace('motion-browser-enter', '[data-workbench-region-id="launchpad-input"] .launcher-browser-input', () => rawClick(element('[aria-label="Expand Browser"]')))
  await type(element('[aria-label="Browser address or search"]'), 'continuous launch motion')
  await escape(); await frame('motion-browser-open')
  await trace('motion-browser-close', '[data-workbench-region-id="launchpad-input"] .launcher-browser-input', () => rawClick(element('[aria-label="Collapse Browser"]')), { intermediate: true })
  assert.equal((await evaluate('launchpad.facts()')).sections.browser, 'collapsed')
  await click(element('[aria-label="Expand Browser"]'))

  await viewport(780, 710); await evaluate('launchpad.scene({split:true,long:true,theme:"light"})'); await paint()
  const wrapped = await evaluate(`${element('.agent-picks')} && [...${element('.agent-picks')}.querySelectorAll(':scope > button[data-executor-id]')].map(e=>({id:e.dataset.executorId,y:e.getBoundingClientRect().y,selected:e.getAttribute('aria-pressed')}))`)
  assert.ok(wrapped.length > 2)
  const selected = wrapped.find(item => item.selected === 'true'), across = wrapped.find(item => item.y !== selected.y)
  assert.ok(across, 'Narrow catalog actually wraps to a second row')
  await trace('motion-agent-wrapped-selection', lens, () => rawClick(element(`.agent-picks > button[data-executor-id="${across.id}"]`)))
  await assertGeometry(); await frame('motion-narrow-light')

  // The fixture's preceding split changes the layout owner. Establish the
  // retained-visibility identity after that separate layout action.
  await evaluate('window.motionRetainedEditor='+element('.launcher-composer .tiptap'))
  await rawClick(element('[aria-label="Runtime environment"]')); await delay(30)
  await evaluate('launchpad.visibility(false)'); await paint()
  assert.equal(await evaluate('Boolean(document.querySelector(".launcher-environment__panel"))'), false, 'A retained hidden Workbench releases its portal')
  assert.equal(await evaluate(`${element('.agent-picks [data-liquid-selection]')}.getAnimations().length`), 0)
  assert.equal(await evaluate(`${element('.agent-picks [data-liquid-selection]')}.dataset.liquidPaused`), 'true')
  await evaluate('launchpad.visibility(true)'); await paint()
  assert.equal(await evaluate('motionRetainedEditor === '+element('.launcher-composer .tiptap')), true, 'Retained visibility preserves the original input node')
  await evaluate('launchpad.documentVisibility(true)'); await paint()
  assert.equal(await evaluate(`${element('.agent-picks [data-liquid-selection]')}.getAnimations().length`), 0)
  await evaluate('launchpad.documentVisibility(false)'); await paint()

  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await rawClick(element(`.agent-picks > button[data-executor-id="${last}"]`)); await paint()
  assert.equal(await evaluate(`${element('.agent-picks [data-liquid-selection]')}.getAnimations().length`), 0)
  await rawClick(element('[aria-label="Runtime environment"]')); await paint()
  assert.equal(await evaluate('document.querySelector(".launcher-environment__panel").getAnimations().length'), 0)
  await key('Escape'); await paint()
  assert.equal(await evaluate('Boolean(document.querySelector(".launcher-environment__panel"))'), false)
  await command('Emulation.setEmulatedMedia', { features: [] })

  const final = await evaluate('launchpad.facts()')
  assert.equal(final.originalWarmRun, original.originalWarmRun); assert.equal(final.warmRun, original.warmRun)
  assert.deepEqual(final.calls.stops, []); assert.deepEqual(final.calls.launches, []); assert.equal(final.sourceDraft, original.sourceDraft)
  await evaluate('launchpad.settings()'); await wait('Boolean(document.querySelector(".settings-page"))'); await frame('settings-motion-reference')
  await evaluate('launchpad.scene({split:true,theme:"dark"})'); await paint()
  await click(element('[aria-label="Close Terminal"]')); await click(element('[aria-label="Expand Note"]'))
  await evaluate(`launchpad.editNote(${JSON.stringify('## Motion review\nPreserve this actual note draft across restart.')})`); await click(element('[aria-label="Close Note"]'))
  const durable = await evaluate('launchpad.facts()')
  report.expectedDurable = { sections: durable.sections, drafts: durable.drafts, tab: durable.tab, layout: durable.layout, sourceDraft: durable.sourceDraft, activeWorkspaceId: durable.activeWorkspaceId }
  report.scenarios.push({ name: 'Settings-family interaction and natural intermediate motion', passed: true, original, final, rapidSelection: true, rapidReopen: true, immediateKeyboardTransfer: true, inactivePortalReleased: true, reducedMotion: true, controlledDocumentVisibility: true, terminalNotAnimated: true })
  await fs.writeFile(path.join(evidence, 'expected-durable.json'), JSON.stringify(report.expectedDurable, null, 2))
  await fs.writeFile(path.join(profile, 'boot.json'), JSON.stringify(await evaluate('launchpad.bootFacts()')))
}
