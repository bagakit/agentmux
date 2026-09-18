import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { activate, click } from './desktop.mjs'

export const fontInput = '[data-settings-pane="appearance"]:not([hidden]) input[aria-label="Terminal font size in pixels"]'

/** Native focus, select-all, deletion and individual key presses; no DOM value/selection mutation. */
export async function replaceFontText(cdp, selector, text) {
  await click(cdp, selector)
  assert.equal(await cdp.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true)
  const dispatch = async parameters => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...parameters })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: parameters.key, code: parameters.code,
      modifiers: parameters.modifiers, windowsVirtualKeyCode: parameters.windowsVirtualKeyCode })
  }
  await dispatch({ key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
  await dispatch({ key: 'Backspace', code: 'Backspace', modifiers: 0, windowsVirtualKeyCode: 8 })
  const raw = () => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`)
  const states = [await raw()]
  assert.equal(states[0], '', 'Native Backspace must leave an empty editable draft')
  for (const character of String(text)) {
    assert.match(character, /^[\d.]$/, 'The private numeric fixture types only numeric characters')
    await dispatch({ key: character, code: character === '.' ? 'Period' : `Digit${character}`, modifiers: 0,
      windowsVirtualKeyCode: character === '.' ? 190 : character.charCodeAt(0), text: character, unmodifiedText: character })
    states.push(await raw())
  }
  assert.equal(states.at(-1), String(text), 'The final native text must remain exactly editable')
  return states
}

export async function verifyFontDraft({ probe, entries, command, section, saved, waitFor, configPath, facts }) {
  await section(probe, 'Appearance', 'appearance')
  const supported = await entries('appearance.terminalFontSize')
  assert.equal(supported.length, 1); assert.equal(supported[0].kind, 'number')
  const sizes = supported[0].enum
  assert.ok(sizes.length > 1 && sizes.includes(14))
  const min = Math.min(...sizes), max = Math.max(...sizes)
  const state = () => probe.cdp.evaluate(`(() => {
    const input=document.querySelector(${JSON.stringify(fontInput)}), pane=input.closest('[data-settings-pane]'), button=pane.querySelector('.settings-pane-actions button')
    return {raw:input.value,range:pane.querySelector('[aria-label="Terminal font size"]').value,
      alert:pane.querySelector('[role="alert"]')?.textContent??'',saveDisabled:button.disabled,saveText:button.textContent.trim()}
  })()`)
  const publications = () => probe.cdp.evaluate('window.__settingsCliProof.configEvents.length')
  const cliValue = async () => {
    const result = await command(['settings', 'get', 'appearance.terminalFontSize'])
    assert.equal(result.result.entries.length, 1)
    const entry = result.result.entries[0]
    assert.equal(entry.key, 'appearance.terminalFontSize'); assert.equal(entry.kind, 'number'); assert.equal(typeof entry.value, 'number')
    return entry.value
  }
  const save = async () => {
    await activate(probe.cdp, `Array.from(document.querySelectorAll('[data-settings-pane="appearance"]:not([hidden]) button')).filter(e=>e.textContent.trim()==='Save appearance')`)
  }
  const legalSave = async value => {
    await save(); await saved(probe)
    assert.equal(await cliValue(), value)
    const committed = await state()
    assert.equal(committed.raw, String(value)); assert.equal(committed.saveDisabled, true)
    assert.equal(committed.saveText, 'Save appearance'); assert.equal(committed.alert, '')
    return committed
  }
  await probe.cdp.evaluate(`(() => {
    const selector=${JSON.stringify(fontInput)}, events=[]
    const listener=event=>{if(event.target.matches?.(selector))events.push({type:event.type,key:event.key,meta:event.metaKey,inputType:event.inputType,raw:event.target.value,trusted:event.isTrusted})}
    const types=['pointerdown','click','keydown','beforeinput','input']
    for(const type of types)document.addEventListener(type,listener)
    window.__settingsFontDraftProof={events,detach:()=>{for(const type of types)document.removeEventListener(type,listener)}}
  })()`)
  facts.invalid = []
  try {
    facts.states = await replaceFontText(probe.cdp, fontInput, '14')
    assert.deepEqual(facts.states, ['', '1', '14'])
    facts.editEvents = await probe.cdp.evaluate('window.__settingsFontDraftProof.events')
    assert.deepEqual(facts.editEvents.filter(event => event.type === 'keydown').map(event => event.key), ['a', 'Backspace', '1', '4'])
    facts.legal = { value: 14, kind: 'number', ui: await legalSave(14) }
    for (const raw of ['', '14.5', String(max + 1)]) {
      assert.equal((await state()).alert, '', 'Each invalid Save starts without a previous error')
      const baseline = await cliValue(), bytes = await readFile(configPath), count = await publications()
      const states = await replaceFontText(probe.cdp, fontInput, raw)
      assert.equal((await state()).saveDisabled, false)
      await save()
      await waitFor('named font validation error after native Save', async () => {
        const current = await state()
        return /Terminal font size/i.test(current.alert) && /whole number/i.test(current.alert)
          && current.alert.includes(String(min)) && current.alert.includes(String(max)) && current.saveText === 'Save appearance'
      })
      const rejected = await state()
      assert.equal(rejected.raw, raw); assert.equal(rejected.saveDisabled, false)
      assert.equal(rejected.range, String(baseline), 'Incomplete or invalid text projects the original legal expectation')
      assert.deepEqual(await readFile(configPath), bytes, 'Invalid native Save preserves actual committed bytes')
      assert.equal(await publications(), count, 'Invalid native Save publishes nothing')
      assert.equal(await cliValue(), baseline)
      facts.invalid.push({ raw, states, rejected, committedValue: baseline, configUnchanged: true, publicationsBefore: count, publicationsAfter: await publications() })
      // A real successful save clears the error before the next case; an old alert cannot make it pass.
      const recovery = baseline === 14 ? sizes.find(value => value !== 14) : 14
      await replaceFontText(probe.cdp, fontInput, String(recovery)); await legalSave(recovery)
    }
    if (await cliValue() !== 14) { await replaceFontText(probe.cdp, fontInput, '14'); await legalSave(14) }
    facts.final = { value: await cliValue(), ui: await state() }
  } finally {
    facts.events = await probe.cdp.evaluate('window.__settingsFontDraftProof.events')
    await probe.cdp.evaluate('window.__settingsFontDraftProof.detach()')
  }
  assert.ok(facts.events.length > 0)
  assert.ok(facts.events.every(event => event.trusted))
  assert.ok(facts.events.filter(event => event.type === 'input').length > 0)
  assert.ok(facts.events.some(event => event.type === 'keydown' && event.key === 'a' && event.meta))
  assert.ok(facts.events.some(event => event.type === 'keydown' && event.key === 'Backspace'))
}
