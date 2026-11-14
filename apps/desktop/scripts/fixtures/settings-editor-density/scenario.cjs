const assert = require('node:assert/strict')

async function run({ win, read, q, button, until, settle, click, type, scene, capture, result }) {
  const prompt = q('[data-prompt-editor] textarea')
  const short = 'Review the changes and cite the relevant files.\n指出可验证的风险。'
  const long = Array.from({ length: 36 }, (_, index) => `Line ${index + 1}. Explain the relevant changes and how to check them.`).join('\n')
  const reduce = win.webContents.debugger
  result.editors = {}

  async function open(id) {
    const target = `[data-settings-target="${id}"]`
    const sidebar = q(`nav[aria-label="Settings sections"] ${target}`)
    if (await read(`${sidebar}?.checkVisibility()`)) await click(sidebar)
    else {
      await click(q('.settings-section-picker'))
      await until(`!!${q('.settings-section-menu ' + target)}`)
      await click(q('.settings-section-menu ' + target))
    }
    await until(`!!${q(`[data-settings-pane="${id}"]:not([hidden])`)}`)
  }

  async function measure(field) {
    return read(`(() => {
      const field = ${field}, parent = field.parentElement
      const css = getComputedStyle(field), outer = getComputedStyle(parent)
      return { height: field.offsetHeight, clientHeight: field.clientHeight, scrollHeight: field.scrollHeight,
        line: parseFloat(css.lineHeight), inset: parseFloat(css.paddingBlockStart) + parseFloat(css.paddingBlockEnd),
        border: parseFloat(css.borderBlockStartWidth) + parseFloat(css.borderBlockEndWidth),
        outline: css.outlineStyle, outlineWidth: css.outlineWidth, outlineColor: css.outlineColor,
        outerOutline: outer.outlineStyle, outerBorder: parseFloat(outer.borderBlockStartWidth), outerShadow: outer.boxShadow,
        overflow: css.overflowY, focused: document.activeElement === field, invalid: field.getAttribute('aria-invalid') }
    })()`)
  }

  function compactAndFocused(facts, name) {
    assert.deepEqual({
      compact: facts.height <= Math.ceil(2 * facts.line + facts.inset + facts.border),
      focus: facts.focused && facts.outline === 'solid' && facts.outlineWidth === '1px',
      openLabel: facts.outerOutline === 'none' && facts.outerBorder === 0 && facts.outerShadow === 'none'
    }, { compact: true, focus: true, openLabel: true }, `${name}: two written lines, one focus indicator`)
  }

  await scene(1480, 'dark')
  assert.equal(await read('document.querySelectorAll("[data-prompt-id]").length'), 17, 'The original list is filled enough to scroll')
  const beforeSave = result.saves.length
  await type(prompt, short)
  result.editors.wide = await measure(prompt)
  compactAndFocused(result.editors.wide, 'Prompt wide')
  await read(`window.proofPromptTextarea = ${prompt}`)
  await capture('prompt-two-lines-dark.png', 'Full Prompt workbench, long list and short focused text')

  await type(prompt, long)
  result.editors.long = await measure(prompt)
  assert.ok(result.editors.long.height > result.editors.wide.height * 2, 'Long Prompt expands past the short field')
  assert.ok(result.editors.long.scrollHeight > result.editors.long.clientHeight && result.editors.long.overflow === 'auto', 'Long Prompt scrolls in its own field')
  assert.ok(await read(`(()=>{const field=${prompt};field.scrollTop=field.scrollHeight;return field.scrollTop>0 && document.activeElement===field})()`))
  await capture('prompt-long-dark.png', 'Focused long text with an internal scroll and reachable library save bar')
  await type(prompt, short)
  assert.equal((await measure(prompt)).height, result.editors.wide.height, 'The same field gives unused space back after shortening')
  assert.ok(await read(`${prompt} === window.proofPromptTextarea`), 'Original textarea remains connected during edits')
  assert.equal(result.saves.length, beforeSave, 'Editing does not save before the original action')

  await scene(520, 'light')
  assert.ok(await read(`${prompt} === window.proofPromptTextarea && (${prompt}).checkVisibility()`), 'Narrowing a focused wide editor keeps the same draft visible')
  await reduce.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await type(prompt, short)
  result.editors.narrow = await measure(prompt)
  compactAndFocused(result.editors.narrow, 'Prompt narrow')
  await capture('prompt-two-lines-light.png', 'Single-column editor at narrow width with save and back available')
  await type(prompt, ' ')
  result.editors.invalid = await measure(prompt)
  compactAndFocused(result.editors.invalid, 'Prompt invalid')
  assert.equal(result.editors.invalid.invalid, 'true')
  assert.notEqual(result.editors.invalid.outlineColor, result.editors.narrow.outlineColor, 'The same boundary reflects the actual field error')
  assert.ok(await read(`document.getElementById((${prompt}).getAttribute('aria-describedby')).textContent.includes('Write the instruction')`))
  await capture('prompt-invalid-light.png', 'Error stays attached to the focused field without a second border')
  await type(prompt, short)
  await click(button('Save prompts'))
  await until(`window.promptsProbe.config().then(config=>config.composerShortcuts.find(item=>item.id==='explain').body===${JSON.stringify(short)})`)
  assert.equal(result.commits.at(-1).composerShortcuts.find(item => item.id === 'explain').body, short)

  await scene(1280, 'dark')
  await open('derived-actions')
  await click(button('Add action'))
  const instruction = q('[data-settings-pane="derived-actions"] .prompt-editor__instruction textarea')
  await type(instruction, short)
  result.editors.derived = await measure(instruction)
  compactAndFocused(result.editors.derived, 'Derived action')
  const nameProblem = `(() => {
    const editor = document.querySelector('[data-derived-editor]')
    return document.getElementById(editor.getAttribute('aria-describedby'))?.textContent
  })()`
  assert.match(await read(nameProblem), /needs a one-line name/)
  const instructionHint = await read(`document.getElementById((${instruction}).getAttribute('aria-describedby')).textContent`)
  assert.doesNotMatch(instructionHint, /one-line name/)
  const actionName = q('.derived-actions__name input')
  await click(actionName)
  await capture('derived-name-error-dark.png', 'The action reports its missing name above the form and keeps the instruction hint')
  await type(actionName, 'Review original changes')
  await click(instruction)
  assert.equal(await read(nameProblem), undefined)
  await capture('derived-action-dark.png', 'Derived action draft uses the same text density and original workbench')

  await open('profile')
  const about = q('#profile-about')
  await type(about, short)
  result.editors.profile = await measure(about)
  compactAndFocused(result.editors.profile, 'Profile About')
  await capture('profile-dark.png', 'Profile About ends close to the authored text and its counter')

  await open('automation')
  await click(q('[data-settings-pane="automation"] [data-settings-field="progressPrompt"] > summary'))
  const progress = q('[data-settings-pane="automation"] [aria-label="Default progress prompt"]')
  await type(progress, short)
  result.editors.automation = await measure(progress)
  compactAndFocused(result.editors.automation, 'Automation')
  await capture('automation-dark.png', 'Automation disclosure shows a compact two-line prompt')

  async function singleNativeFocus(field, name) {
    await read(`(${field}).scrollIntoView({block:'center'})`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await read(`(${field}).focus({preventScroll:true})`)
    await settle()
    const facts = await read(`(() => { const field=${field}, row=field.closest('label');return {
      focused:field===document.activeElement && field.matches(':focus-visible'),
      outline:getComputedStyle(field).outlineStyle, rowOutline:getComputedStyle(row).outlineStyle
    }})()`)
    assert.deepEqual(facts, { focused: true, outline: 'solid', rowOutline: 'none' }, `${name}: a visible native control owns keyboard focus`)
  }
  await open('inapp-conversation')
  await singleNativeFocus(q('.inapp-reading-choices input:checked'), 'InApp choice')
  await capture('inapp-focus-dark.png', 'Keyboard focus on a visible InApp radio choice')
  await singleNativeFocus(q('.inapp-receipt-toggle input'), 'InApp switch')
  await capture('inapp-switch-dark.png', 'The switch has a focus outline without a surrounding label outline')
  await open('mote')
  await singleNativeFocus(q('.mote-directory-settings input:checked'), 'Clubs choice')
  await capture('clubs-focus-dark.png', 'The selected card and the radio focus remain distinct')
}

module.exports = { run }
