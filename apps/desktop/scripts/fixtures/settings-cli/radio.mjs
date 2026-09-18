import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { activate, click } from './desktop.mjs'

const pane = '[data-settings-pane="appearance"]:not([hidden])'
const groups = [
  { label: 'Application appearance', key: 'appearance.appAppearance', selected: '.settings-appearance-choice--selected' },
  { label: 'Terminal palette', key: 'appearance.terminalTheme', selected: '.terminal-theme-choice--selected' }
]
const group = label => `${pane} [role="radiogroup"][aria-label=${JSON.stringify(label)}]`
const input = (label, index) => `${group(label)} label:nth-child(${index + 1}) input[type="radio"]`
const checked = label => `${group(label)} input[type="radio"]:checked`

/** The browser owns navigation. This fixture observes its real default actions and the React draft. */
export async function verifyRadioKeyboard({ probe, section, command, saved, waitFor, evidence }) {
  const { cdp } = probe, facts = { groups: [], tabs: [] }
  await section(probe, 'Appearance', 'appearance')
  await cdp.evaluate(`(() => {
    window.__settingsRadioEvents=[];
    for(const type of ['keydown','keyup','change','click']) document.addEventListener(type,event=>{
      if(event.target instanceof Element && event.target.closest(${JSON.stringify(pane)}))
        window.__settingsRadioEvents.push({type,trusted:event.isTrusted,key:event.key??null});
    },true);
  })()`)
  async function key(name, shift = false) {
    const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Tab: 9, ' ': 32 }
    const parameters = { key: name, code: name === ' ' ? 'Space' : name,
      windowsVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0 }
    for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, ...parameters })
  }
  async function focus(selector) {
    assert.equal(await cdp.evaluate(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});
      if(!node?.isConnected || !node.getClientRects().length || getComputedStyle(node).visibility==='hidden') throw new Error('Missing visible connected control');
      const card=node.closest('label');if(card && !card.getClientRects().length) throw new Error('Radio label is not visible');
      node.scrollIntoView({block:'nearest'});node.focus();return document.activeElement===node;
    })()`), true)
  }
  async function state(definition) {
    const result = await cdp.evaluate(`(() => {
      const group=document.querySelector(${JSON.stringify(group(definition.label))});
      const inputs=Array.from(group.querySelectorAll('input[type="radio"]'));
      return {values:inputs.map(node=>node.value),names:inputs.map(node=>node.name),focus:inputs.indexOf(document.activeElement),
        checked:inputs.flatMap((node,index)=>node.checked?[index]:[]),
        draft:inputs.flatMap((node,index)=>node.closest('label').matches(${JSON.stringify(definition.selected)})?[index]:[])};
    })()`)
    assert.ok(result.values.length > 1)
    assert.equal(new Set(result.names).size, 1); assert.ok(result.names[0])
    assert.equal(result.checked.length, 1); assert.deepEqual(result.draft, result.checked)
    return result
  }
  for (const definition of groups) {
    const baseline = (await command(['settings', 'get', definition.key])).result.entries
    assert.equal(baseline.length, 1)
    const before = await state(definition), original = before.values.indexOf(baseline[0].value)
    assert.ok(original >= 0); assert.deepEqual(before.checked, [original])
    await click(cdp, `${group(definition.label)} label:nth-child(${original + 1})`)
    let index = original
    const arrows = []
    for (const name of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      index = (index + (['ArrowRight', 'ArrowDown'].includes(name) ? 1 : -1) + before.values.length) % before.values.length
      await key(name)
      const current = await state(definition)
      assert.equal(current.focus, index); assert.deepEqual(current.checked, [index])
      arrows.push({ key: name, expected: index, current })
    }
    for (const name of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      const forward = ['ArrowRight', 'ArrowDown'].includes(name), edge = forward ? before.values.length - 1 : 0
      await click(cdp, `${group(definition.label)} label:nth-child(${edge + 1})`)
      await key(name)
      const current = await state(definition), expected = forward ? 0 : before.values.length - 1
      assert.equal(current.focus, expected); assert.deepEqual(current.checked, [expected])
      arrows.push({ key: name, edge, expected, current })
    }
    const desired = (original + 1) % before.values.length, other = (desired + 1) % before.values.length
    await click(cdp, `${group(definition.label)} label:nth-child(${other + 1})`)
    await focus(input(definition.label, desired))
    const spaceBefore = await state(definition)
    assert.equal(spaceBefore.focus, desired); assert.deepEqual(spaceBefore.checked, [other])
    await key(' ')
    const spaceAfter = await state(definition)
    assert.equal(spaceAfter.focus, desired); assert.deepEqual(spaceAfter.checked, [desired]); assert.deepEqual(spaceAfter.draft, [desired])
    assert.equal((await command(['settings', 'get', definition.key])).result.entries[0].value, baseline[0].value, 'Keyboard edits remain uncommitted drafts')
    facts.groups.push({ ...definition, before, arrows, spaceBefore, spaceAfter, expectedValue: before.values[desired], baselineValue: baseline[0].value })
  }
  async function tab(from, to, shift = false) {
    await focus(from); await key('Tab', shift)
    const exact = await cdp.evaluate(`(() => {
      const node=document.querySelector(${JSON.stringify(to)});
      if(!node?.isConnected || !node.getClientRects().length || getComputedStyle(node).visibility==='hidden') return false;
      return document.activeElement===node && (!node.closest('label') || node.closest('label').getClientRects().length>0);
    })()`)
    assert.equal(exact, true, `Native ${shift ? 'Shift+Tab' : 'Tab'} must reach the exact adjacent control`)
    facts.tabs.push({ from, to, shift, exact })
  }
  const application = checked(groups[0].label), terminal = checked(groups[1].label), close = '.settings-content__close', font = `${pane} input[type="range"]`
  await tab(close, application); await tab(application, close, true)
  await tab(application, terminal); await tab(terminal, application, true)
  await tab(terminal, font); await tab(font, terminal, true)
  await activate(cdp, `Array.from(document.querySelectorAll(${JSON.stringify(pane + ' button')})).filter(node=>node.textContent.trim()==='Save appearance')`)
  await saved(probe)
  for (const definition of facts.groups) {
    const entry = (await command(['settings', 'get', definition.key])).result.entries
    assert.equal(entry.length, 1); assert.equal(entry[0].value, definition.expectedValue)
  }
  await waitFor('clean appearance after actual radio Save', () => cdp.evaluate(`document.querySelector(${JSON.stringify(pane + ' .settings-pane-actions button')}).disabled`))
  // This isolated interaction proof returns through the same UI owner to the ordinary matrix's
  // baseline. Its subsequent 13-value/restart assertions remain exactly as strong as before.
  for (const definition of facts.groups) {
    const original = definition.before.values.indexOf(definition.baselineValue)
    await click(cdp, `${group(definition.label)} label:nth-child(${original + 1})`)
  }
  await activate(cdp, `Array.from(document.querySelectorAll(${JSON.stringify(pane + ' button')})).filter(node=>node.textContent.trim()==='Save appearance')`)
  await saved(probe)
  for (const definition of facts.groups) {
    const entry = (await command(['settings', 'get', definition.key])).result.entries
    assert.equal(entry.length, 1); assert.equal(entry[0].value, definition.baselineValue)
  }
  facts.restoredThroughUi = true
  // Emulate only this private Renderer viewport; actual DOM focus, paint and hit testing remain
  // Chromium's. The owning OS window and the user's App are never resized or operated.
  facts.frames = []
  try {
    for (const width of [1480, 420, 320]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false })
      for (const appearance of ['light', 'dark']) {
        await command(['settings', 'set', groups[0].key, appearance])
        await waitFor('actual appearance frame', () => cdp.evaluate(`document.documentElement.dataset.appearance===${JSON.stringify(appearance)}`))
        await focus(close); await key('Tab')
        const frame = await cdp.evaluate(`(() => {
          const radio=document.querySelector(${JSON.stringify(application)}), label=radio.closest('label');
          label.scrollIntoView({block:'nearest'});
          const css=getComputedStyle(label), rect=label.getBoundingClientRect(), bar=document.querySelector('.window-status-bar');
          const button=bar.querySelector('button[aria-label="Settings"]'), br=button.getBoundingClientRect(), status=bar.getBoundingClientRect();
          const points=[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>({x:br.left+br.width*x,y:br.top+br.height*y}));
          return {width:innerWidth,height:innerHeight,appearance:document.documentElement.dataset.appearance,
            focused:document.activeElement===radio,focusVisible:radio.matches(':focus-visible'),checked:radio.checked,
            selected:label.classList.contains('settings-appearance-choice--selected'),outline:{width:css.outlineWidth,style:css.outlineStyle,color:css.outlineColor},
            card:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
            status:{height:status.height,bottom:status.bottom},points:points.map(point=>({...point,hit:button.contains(document.elementFromPoint(point.x,point.y))}))};
        })()`)
        assert.equal(frame.width, width); assert.equal(frame.appearance, appearance)
        assert.equal(frame.focused, true); assert.equal(frame.focusVisible, true)
        assert.equal(frame.checked, true); assert.equal(frame.selected, true)
        assert.equal(frame.outline.width, '2px'); assert.equal(frame.outline.style, 'solid')
        assert.notEqual(frame.outline.color, 'rgba(0, 0, 0, 0)')
        assert.ok(frame.card.left >= 0 && frame.card.right <= width, 'Focused card is inside the viewport')
        assert.equal(frame.status.height, 32); assert.equal(frame.status.bottom, frame.height)
        assert.equal(frame.points.length, 5); assert.deepEqual(frame.points.map(point=>point.hit), [true,true,true,true,true])
        const { data } = await cdp.call('Page.captureScreenshot'), bytes = Buffer.from(data, 'base64')
        frame.screenshot = `radio-${width}-${appearance}.png`
        frame.screenshotSha256 = createHash('sha256').update(bytes).digest('hex')
        await writeFile(join(evidence, frame.screenshot), bytes)
        const next = await cdp.evaluate(`(() => {const nodes=Array.from(document.querySelector(${JSON.stringify(group(groups[0].label))}).querySelectorAll('input[type="radio"]'));return (nodes.findIndex(node=>node.checked)+1)%nodes.length})()`)
        await focus(input(groups[0].label, next))
        frame.unselectedFocus = await cdp.evaluate(`(() => {
          const radio=document.querySelector(${JSON.stringify(input(groups[0].label, next))}),label=radio.closest('label'),css=getComputedStyle(label);
          return {focused:document.activeElement===radio,focusVisible:radio.matches(':focus-visible'),checked:radio.checked,
            selected:label.classList.contains('settings-appearance-choice--selected'),outlineWidth:css.outlineWidth,outlineColor:css.outlineColor};
        })()`)
        assert.equal(frame.unselectedFocus.focused, true); assert.equal(frame.unselectedFocus.focusVisible, true)
        assert.equal(frame.unselectedFocus.checked, false); assert.equal(frame.unselectedFocus.selected, false)
        assert.equal(frame.unselectedFocus.outlineWidth, '2px'); assert.equal(frame.unselectedFocus.outlineColor, frame.outline.color)
        const unselected = Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64')
        frame.unselectedFocus.screenshot = `radio-${width}-${appearance}-unselected.png`
        frame.unselectedFocus.screenshotSha256 = createHash('sha256').update(unselected).digest('hex')
        await writeFile(join(evidence, frame.unselectedFocus.screenshot), unselected)
        facts.frames.push(frame)
      }
    }
  } finally {
    await cdp.call('Emulation.clearDeviceMetricsOverride')
    await command(['settings', 'set', groups[0].key, facts.groups[0].baselineValue])
    await waitFor('restored ordinary appearance baseline', () => cdp.evaluate(`document.querySelector(${JSON.stringify(application)})?.value===${JSON.stringify(facts.groups[0].baselineValue)}`))
  }
  assert.equal(facts.frames.length, 6)
  facts.events = await cdp.evaluate('window.__settingsRadioEvents')
  assert.ok(facts.events.length > 0); assert.equal(facts.events.filter(event => !event.trusted).length, 0)
  assert.equal(facts.groups.length, 2); assert.equal(facts.tabs.length, 6)
  return facts
}
