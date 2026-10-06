const assert = require('node:assert/strict')

exports.run = async ({ read, q, until, settle, click, field, type, scene, capture, owner, result }) => {
  async function section(id) {
    const nav = q(`nav[aria-label="Settings sections"] [data-settings-target="${id}"]`)
    const title = await read(`${nav}?.textContent.trim()`)
    assert.ok(title, 'Read the actual registered section title before navigating')
    if (await read(nav + '.checkVisibility()')) await click(nav)
    else {
      await click(q('.settings-section-picker'))
      await until('!!document.querySelector(".settings-section-menu[role=menu]")')
      await click(`[...document.querySelectorAll('.settings-section-menu [role=menuitemradio]')].find(n=>n.textContent.trim()===${JSON.stringify(title)})`)
    }
    await until(`document.querySelector('.settings-page')?.dataset.settingsPage===${JSON.stringify(id)}`)
    await settle()
  }
  const originalPrompts = structuredClone(owner.current.composerShortcuts)
  await type(field('Prompt'), 'Unsaved original Prompt 中文')
  await read(`window.messageToolPromptNode=${field('Prompt')}`)
  await section('message-tool')
  const declared = await read('window.promptsProbe.shortcuts().bindings.filter(binding=>binding.scope==="message-tool")')
  assert.equal(declared.length, 7, 'The real shared registry has the seven Message Tool gestures')
  async function assertRows() {
    const rows = await read(`(()=>{const pane=document.querySelector('[data-settings-pane="message-tool"]');return [...pane.querySelectorAll('[data-binding-id]')].map(n=>({id:n.dataset.bindingId,keys:[...n.querySelectorAll('kbd')].map(k=>k.textContent)}))})()`)
    assert.deepEqual(rows.map(row=>row.id), declared.map(binding=>binding.id), 'The actual local settings consumer shows the shared registry subset')
    for (const row of rows) assert.deepEqual(row.keys, declared.find(binding=>binding.id===row.id).keys)
  }
  await assertRows()
  await click(q('[data-message-tool-settings] input[value="two-line"]'))
  await section('general')
  assert.equal(await read('document.querySelectorAll("[data-settings-pane=general] input[type=radio]").length'), 0, 'General no longer contains a second layout editor')
  await section('message-tool')
  assert.equal(await read('document.querySelector("[data-message-tool-settings] input[value=two-line]").checked'), true, 'Navigation preserves the original dirty layout choice')
  await click(q('[data-message-tool-settings] [data-settings-save-bar] button'))
  await until('document.querySelector("[data-message-tool-settings] [data-settings-save-bar]").textContent.includes("Changes saved")')
  assert.equal(owner.current.messageToolInitialLayout, 'two-line')
  assert.deepEqual(owner.current.composerShortcuts, originalPrompts, 'Saving layout does not persist or replace the Prompt draft')

  for (const [width, appearance] of [[1480, 'dark'], [780, 'light'], [520, 'dark']]) {
    await scene(width, appearance)
    await section('message-tool')
    await read('document.querySelector("[data-settings-pane=message-tool]").scrollTo({top:0,behavior:"instant"})')
    await capture(`${width}-${appearance}-input.png`, 'Actual Message Tool group, saved layout, per-Agent Mailbox and the shared shortcut subset')
    await read('document.querySelector("[data-settings-pane=message-tool]").scrollTo({top:10000,behavior:"instant"})')
    await capture(`${width}-${appearance}-keys.png`, 'Actual scroll reveals all remaining editing keys and the original save bar without horizontal overflow')
    await section('prompts')
    assert.equal(await read(`(${field('Prompt')})===window.messageToolPromptNode && (${field('Prompt')}).value==='Unsaved original Prompt 中文'`), true, 'The original Prompt editor and dirty draft remain mounted')
    await capture(`${width}-${appearance}-prompts.png`, 'Original reusable Prompt editor under the Message Tool group, including retained unsaved draft')
  }
  await scene(1480, 'dark')
  await section('overview')
  assert.equal(await read('document.querySelectorAll("[data-settings-section=message-tool]").length'), 1, 'Overview exposes the real new module once')
  await capture('1480-dark-overview.png', 'Settings Overview derives Message Tool and Prompts from the same registered group')
  await read('document.querySelector("[data-settings-section=message-tool]").scrollIntoView({block:"center",behavior:"instant"})')
  await capture('1480-dark-overview-entries.png', 'The complete Message Tool group and both real entry summaries remain readable in Overview')
  await section('keyboard-shortcuts')
  await click(q('[data-settings-pane="keyboard-shortcuts"] [data-shortcut-group="message-tool"]'))
  await capture('1480-dark-global-keys.png', 'The original global shortcut manual also contains the same Message Tool bindings')
  result.messageTool = { bindings: declared, layout: owner.current.messageToolInitialLayout, promptDraftRetained: true }
}
