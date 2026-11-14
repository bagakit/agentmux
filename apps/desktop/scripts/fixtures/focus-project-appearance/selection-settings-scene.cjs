const assert = require('node:assert/strict')

module.exports = async function captureSelectionSettings({ win, read, click, frame, until, settle, result }) {
  const pane = '[data-settings-pane="focus"]'
  const field = label => `${pane} input[aria-label="${label}"]`
  const save = `${pane} [data-settings-save-bar] button`
  const selected = '.focus-context.is-selected[data-session-id="alpha-working"]'
  const snapshot = () => read(`(()=>{const preview=document.querySelector('.focus-settings-preview'),surface=document.querySelector('.global-focus-surface');
    const vars=e=>{const s=getComputedStyle(e);return{fill:s.getPropertyValue('--focus-selection-fill').trim(),edge:s.getPropertyValue('--focus-selection-border').trim(),ink:s.getPropertyValue('--focus-selection-ink').trim()}};
    return{saved:window.appearanceProof.selectionPreferences(),preview:vars(preview),actual:vars(surface),examples:[...preview.querySelectorAll('[data-example-agent]')].map(e=>({id:e.dataset.exampleAgent,selected:e.classList.contains('is-selected'),pressed:e.getAttribute('aria-pressed')}))}})()`)
  const visibleSelection = async label => {
    const observed = await read(`(()=>{const selected=document.querySelector('.focus-settings-preview [data-focus-agent-selected="true"]'),canvas=document.querySelector('.focus-settings-preview__canvas'),scroll=document.querySelector('${pane}'),bar=document.querySelector('${pane} [data-settings-save-bar]');const r=selected.getBoundingClientRect(),c=canvas.getBoundingClientRect(),p=scroll.getBoundingClientRect(),b=bar.getBoundingClientRect();return{id:selected.dataset.exampleCard,top:r.top,bottom:r.bottom,minTop:Math.max(c.top,p.top,0),maxBottom:Math.min(c.bottom,p.bottom,b.top,innerHeight),height:r.height,hit:selected.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
    result.scenarios.push({ label: 'Visible original selected example · ' + label, ...observed })
    assert.ok(observed.height > 0 && observed.hit && observed.top >= observed.minTop && observed.bottom <= observed.maxBottom,
      'Original selected example is completely visible above the save bar: ' + label)
  }
  const open = async () => {
    assert.equal(await read("window.appearanceProof.settings('focus')"), 'requested')
    await until('original App Focus settings route', () => read(`Boolean(document.querySelector('${pane}:not([hidden]) .focus-settings-selection'))`))
    await read(`document.querySelector('${pane} .focus-settings-selection').scrollIntoView({block:'center'})`); await settle()
  }
  const range = async (label, target) => {
    await click(field(label))
    const current = await read(`Number(document.querySelector(${JSON.stringify(field(label))}).value)`)
    const key = target > current ? 'ArrowRight' : 'ArrowLeft', code = target > current ? 39 : 37
    for (let n = 0; n < Math.abs(target - current); n++) for (const type of ['keyDown', 'keyUp'])
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code })
    await settle()
    assert.equal(await read(`Number(document.querySelector(${JSON.stringify(field(label))}).value)`), target)
    result.nativeInputs.push({ label, original: current, value: target, input: 'Original range with native arrow keys' })
  }
  result.nativeInputs ??= []
  await click('.focus-context[data-session-id="alpha-working"]')
  await until('original selected card', () => read(`Boolean(document.querySelector('${selected}'))`))
  await open()
  const defaults = await snapshot()
  assert.equal(defaults.preview.fill, '20%'); assert.equal(defaults.preview.edge, '35%')
  assert.equal(defaults.examples.filter(row => row.selected).length, 1)
  assert.ok(defaults.examples.some(row => !row.selected))
  await visibleSelection('default')
  await frame('dark-selection-settings-default-1440.png', 'Original Focus settings retain the accepted default and show one local selected example', 'settings')
  // A range click may choose a value at the pointer; native arrows then reach the exact authored target.
  await range('Background emphasis', 28); await range('Fine-edge emphasis', 50)
  await click(`${pane} input[name="focus-selection-accent"][value="blue"]`)
  const authored = await snapshot()
  assert.equal(authored.preview.fill, '28%'); assert.equal(authored.preview.edge, '50%')
  assert.deepEqual(authored.actual, defaults.actual, 'Draft preview does not publish to original Focus')
  assert.deepEqual(authored.saved, defaults.saved, 'Draft choices do not write config')
  result.scenarios.push({ label: 'Original draft only appearance', defaults, authored })
  await read('window.appearanceProof.failSave(true)'); await click(save)
  await until('original save failure', () => read(`Boolean(document.querySelector('${pane} [role="alert"]'))`))
  assert.deepEqual((await snapshot()).saved, defaults.saved)
  await visibleSelection('authored draft')
  await frame('dark-selection-settings-draft-failure-1440.png', 'The original failed save retains the authored appearance and useful preview', 'settings')
  await read('window.appearanceProof.failSave(false)')
  await click(save)
  await until('original confirmed selection appearance save', () => read("window.appearanceProof.selectionPreferences().selectionFillPercent===28 && window.appearanceProof.selectionPreferences().selectionBorderPercent===50 && window.appearanceProof.selectionPreferences().selectionAccent==='blue'"))
  assert.deepEqual((await snapshot()).saved.projects, defaults.saved.projects, 'Selection saves retain every original Project and Collection Pin')
  await click('[aria-label="Close settings"]')
  await until('original Focus returns', () => read(`Boolean(document.querySelector('${selected}'))&&!document.querySelector('[data-settings-page="focus"]:not([hidden])')`))
  await read("document.querySelector('.focus-context[data-session-id=alpha-working]').scrollIntoView({block:'center'})"); await settle()
  await frame('dark-selection-settings-saved-1440.png', 'The exact original selected Agent uses the confirmed appearance', 'selected')
  await read("window.appearanceProof.theme('light')"); await settle()
  await frame('light-selection-settings-saved-1440.png', 'The saved selected-card choice remains clear in the light theme', 'selected')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
  await settle()
  const forced = await read(`(()=>{const e=document.querySelector('${selected}').closest('[data-focus-card-key]');return{active:matchMedia('(forced-colors:active)').matches,outline:getComputedStyle(e).outlineStyle,width:getComputedStyle(e).outlineWidth}})()`)
  assert.equal(forced.active, true); assert.notEqual(forced.outline, 'none'); assert.ok(parseFloat(forced.width) >= 1)
  result.scenarios.push({ label: 'Original forced-color selection cue', ...forced })
  await frame('light-selection-settings-forced-1440.png', 'Original system selection cues remain present with custom appearance', 'selected')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
  win.setContentSize(760, 660); await open()
  await frame('light-selection-settings-narrow-760.png', 'The original narrow settings layout keeps selection controls readable', 'settings')
  win.setContentSize(760, 420); await settle()
  await read(`document.querySelector('${pane} [data-settings-preview-open="project-scanning"]').scrollIntoView({block:'center'})`); await settle()
  await click(`${pane} [data-settings-preview-open="project-scanning"]`)
  await visibleSelection('short preview')
  await frame('light-selection-settings-preview-short-760.png', 'The original preview navigation keeps selected and neighboring examples reachable in a short viewport', 'preview')
  await click('[aria-label="Close settings"]')
  const preservation = await read('window.appearanceProof.preservation()')
  for (const key of ['sameTabs', 'sameLayouts', 'sameDrafts', 'sameQueues', 'sameRuns']) assert.equal(preservation[key], true, key)
  assert.ok(Object.values(preservation.controls).every(value => value === 0))
  result.scenarios.push({ label: 'Selection appearance preserves the original workface', preservation })
}
