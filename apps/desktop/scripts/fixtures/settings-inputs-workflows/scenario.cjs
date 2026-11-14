const assert = require('node:assert/strict')

async function run({ win, read, q, button, until, settle, click, type, scene, capture, result }) {
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

  function control(label) {
    return q(`[data-settings-pane]:not([hidden]) [aria-label="${label}"]`)
  }

  async function focus(field) {
    await read(`${field}.scrollIntoView({block:'center'}); ${field}.focus({preventScroll:true})`)
    await settle()
    assert.equal(await read(`document.activeElement===${field}`), true, 'The actual native field receives focus')
  }

  function key(keyCode) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }

  async function fieldState(field) {
    assert.ok(await read(`!!(${field})`), `A product control is mounted: ${field}`)
    return read(`(()=>{const field=${field}; const style=getComputedStyle(field)
      return { tag:field.tagName, type:field.type, value:field.value, checked:field.checked,
        disabled:field.disabled, readonly:field.readOnly, role:field.getAttribute('role'),
        invalid:field.getAttribute('aria-invalid'), focused:document.activeElement===field,
        opacity: style.opacity, outline:style.outlineStyle,
        description:field.getAttribute('aria-describedby')?.split(' ').map(id=>document.getElementById(id)?.textContent).join(' ')
      }
    })()`)
  }

  await scene(1280, 'dark')
  await open('profile')
  const displayName = q('#profile-display-name')
  const about = control('About you and how you work')
  const sharing = control('Share with new agents')
  assert.match((await fieldState(displayName)).description, /shown with your messages/i)
  const beforeEdits = result.saves.length
  await type(displayName, 'Alex Chen')
  await type(about, 'I review changes and preserve original working context.\nKeep concrete evidence beside the result.')
  await focus(sharing)
  const before = await fieldState(sharing)
  assert.deepEqual([before.tag, before.type, before.role, before.disabled], ['INPUT', 'checkbox', 'switch', false])
  key('Space')
  await until(`(${sharing}).checked===${!before.checked}`)
  assert.equal(result.saves.length, beforeEdits, 'Native editing does not write ahead of Save')
  await focus(about)
  await capture('profile-dark.png', 'Profile name, multiline About with keyboard focus, and the sharing switch')
  await click(q('[data-settings-pane="profile"] [data-settings-save-bar] button'))
  await until(`window.promptsProbe.config().then(config => config.profile?.displayName === 'Alex Chen' && config.profile?.shareWithAgents === ${!before.checked})`)
  assert.equal(result.commits.at(-1).profile.about, 'I review changes and preserve original working context.\nKeep concrete evidence beside the result.')

  await open('appearance')
  const editorSize = control('Editor font size in pixels')
  const inherit = control('Use App font size')
  assert.equal((await fieldState(editorSize)).disabled, true)
  await focus(inherit)
  await capture('appearance-disabled-dark.png', 'Appearance inheritance shows an on switch and its disabled native number field')
  await click(inherit)
  await until(`!${editorSize}.disabled`)
  assert.equal((await fieldState(editorSize)).type, 'number')

  await open('prompts')
  const promptQuery = control('Search prompts')
  const provider = control('Prompt Provider scope')
  const instruction = q('[data-settings-pane="prompts"] [data-prompt-editor] textarea')
  assert.equal((await fieldState(provider)).tag, 'SELECT')
  await type(instruction, ' ')
  assert.equal((await fieldState(instruction)).invalid, 'true')
  await type(promptQuery, 'review')
  assert.equal(await read('document.querySelectorAll("[data-prompt-id]").length'), 1)
  await click(control('Clear prompt search'))
  assert.equal((await fieldState(promptQuery)).focused, true)
  assert.equal((await fieldState(instruction)).value, ' ')
  await focus(instruction)
  await capture('prompts-error-dark.png', 'Prompt filter, plain native selection, and an invalid multiline draft still in focus')
  await type(instruction, 'Review the selected work and cite details.\n提出可验证的结论。')
  await click(q('[data-prompt-id="explain"]'))
  await scene(640, 'light')
  await focus(instruction)
  await capture('prompts-edit-light.png', 'Multiline draft remains editable at compact width after the rejected value is revised')

  await scene(1280, 'light')
  await open('toolkit')
  const toolQuery = control('Search tools')
  await type(toolQuery, 'performance')
  assert.equal((await fieldState(toolQuery)).type, 'search')
  assert.equal(await read('document.querySelectorAll(".toolkit-library__item").length'), 1)
  await click(control('Clear tool search'))
  assert.equal((await fieldState(toolQuery)).focused, true)
  await click(q('.toolkit-library__item[data-tool-id="performance"]'))
  const performance = q('[data-settings-pane="toolkit"] .toolkit-settings__toggle input')
  assert.equal((await fieldState(performance)).role, 'switch')
  await focus(performance)
  await capture('toolkit-light.png', 'Toolkit library search, built-in tool switch, and status bar display selection')

  await open('discord')
  const hosting = control('Connector hosting Host')
  const header = control('Show Discord in Agent header')
  assert.equal((await fieldState(hosting)).tag, 'SELECT')
  assert.equal((await fieldState(header)).role, 'switch')
  await focus(hosting)
  await capture('channels-light.png', 'A real channel page preserves its native Host selector, unknown read facts, and header switch')

  await open('space')
  const gitTime = control('Show commit time')
  assert.equal((await fieldState(gitTime)).role, 'switch')
  await focus(gitTime)
  await capture('space-light.png', 'Work preference page keeps native rail density choices and the commit-time switch')

  await open('notes')
  const noteSize = control('Notes body text size')
  await type(noteSize, '12.5')
  assert.equal((await fieldState(noteSize)).invalid, 'true')
  assert.match((await fieldState(noteSize)).description, /whole-number font size/)
  await capture('note-error-light.png', 'Invalid Note font size remains editable beside its original slider and reading preview')

  await open('automation')
  const minutes = control('Default progress interval')
  const originalMinutes = (await fieldState(minutes)).value
  await type(minutes, '2.5')
  assert.equal((await fieldState(minutes)).value, '2.5')
  assert.notEqual(originalMinutes, '2.5')
  await click(q('[data-settings-pane="automation"] [data-settings-field="progressPrompt"] > summary'))
  const taskPrompt = control('Default progress prompt')
  await type(taskPrompt, 'Continue on the original task.\nReport any blocker.')
  await focus(taskPrompt)
  await capture('automation-light.png', 'Automation keeps decimal text, units, and live multiline draft together')
  await click(button('Save task defaults'))
  await until('window.promptsProbe.config().then(config => config.automation?.progressIntervalMs === 150000)')
  assert.equal(result.commits.at(-1).automation.progressPrompt, 'Continue on the original task.\nReport any blocker.')

  result.workflowControls = { profile: true, appearance: true, prompts: true, toolkit: true, channels: true, space: true, notes: true, automation: true }
}

module.exports = { run }
