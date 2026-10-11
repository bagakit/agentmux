const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

exports.run = async p => {
  const { win, read, q, until, settle, click, type, scene, capture, owner, result, mode, ownerBundle, privateRoot, root } = p
  const field = label => q(`[data-settings-pane="continuity"] [aria-label="${label}"]`)
  const save = () => click(q('[data-settings-pane="continuity"] [data-settings-save-bar] button'))
  const saved = () => until('document.querySelector(\'[data-settings-pane="continuity"] [data-settings-save-bar]\')?.textContent.includes("Changes saved")')
  const positionRetry = async () => {
    await read(`document.activeElement?.blur(); document.querySelector('[data-continuity-retry-settings]').scrollIntoView({block:'center',behavior:'instant'})`)
    await settle()
    const facts = await read(`(()=>{const section=document.querySelector('[data-continuity-retry-settings]'),pane=section.closest('[data-settings-pane]'),r=section.getBoundingClientRect(),p=pane.getBoundingClientRect(),save=pane.querySelector('[data-settings-save-bar]').getBoundingClientRect();return{top:r.top,bottom:r.bottom,paneTop:p.top,saveTop:save.top,controls:[...section.querySelectorAll('input')].map(n=>{const b=n.getBoundingClientRect();return{label:n.ariaLabel,value:n.value,visible:b.top>=p.top&&b.bottom<=save.top&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}})}})()`)
    assert.ok(facts.top >= facts.paneTop && facts.bottom <= facts.saveTop, 'The retry group must be in the actual captured viewport')
    assert.equal(facts.controls.length, 3); assert.ok(facts.controls.every(control => control.visible))
    return facts
  }
  win.showInactive()
  await click(q('nav[aria-label="Settings sections"] [data-settings-target="continuity"]'))
  await until('document.querySelector(\'.settings-content__header h2\')?.textContent==="Session continuity"')
  if (mode === 'session-continuity-delivery') {
    await owner.update(current => ({ ...current, continuity: { ...current.continuity,
      reminderMode: 'default-plus-custom', reminderAppend: 'Keep the original task and acceptance criteria.',
      continuationEnabled: true, continuationPrompt: 'Continue the interrupted work with the retained conversation.' } }))
    await until(field('Recovery reminder') + '.value==="default-plus-custom" && ' + field('Continue interrupted work after recovery') + '.checked===true')
    assert.equal(await read(field('Append to recovery reminder') + '.value'), owner.current.continuity.reminderAppend)
    assert.equal(await read(field('Continuation prompt') + '.value'), owner.current.continuity.continuationPrompt)
    const preview = '[data-settings-pane="continuity"] [aria-label="Recovery delivery preview"]'
    const position = async () => { await read(`document.querySelector(${JSON.stringify(preview)}).scrollIntoView({block:"center"})`); await settle() }
    const complete = async () => {
      const geometry = await read(`(()=>{const n=document.querySelector(${JSON.stringify(preview)}),r=n.getBoundingClientRect(),pane=n.closest('[data-settings-pane]').getBoundingClientRect(),save=document.querySelector('[data-settings-pane="continuity"] [data-settings-save-bar]').getBoundingClientRect();return{top:r.top,bottom:r.bottom,paneTop:pane.top,saveTop:save.top,text:n.textContent}})()`)
      assert.ok(geometry.top >= geometry.paneTop - 1 && geometry.bottom <= geometry.saveTop + 1, 'The complete delivery explanation fits between the fixed header and Save')
      assert.ok(geometry.text.includes('Selected nonempty content is sent in one new input') && geometry.text.includes('If neither part has content, no input is sent') && geometry.text.includes('same original input key and actual transport or delivery receipt') && geometry.text.includes('Runtime carriage only; Provider consumption requires separate evidence') && geometry.text.includes('Only the initial recovery input carries the selected reminder and continuation') && geometry.text.includes('Later supervised retries restore context only'))
      return geometry
    }
    await position(); result.deliveryWide = await complete()
    await capture('1480-dark-continuity-delivery.png', 'Saved reminder platform note and continuation compose one input with one original key and transport receipt')
    await scene(320, 'light'); await position(); result.deliveryNarrow = await complete()
    await capture('320-light-continuity-delivery.png', 'The full shared-input explanation and transport boundary remain readable at 320 px')
    result.savedContinuity = structuredClone(owner.current.continuity)
    result.settingsOnly = true; result.deliveryOnly = true; return
  }
  assert.equal(await read(field('Recovery wait') + '.value'), '0')
  assert.equal(await read(field('Authoritative idle window') + '.value'), '86400')
  assert.equal(await read(field('First retry base delay') + '.value'), '1')
  assert.equal(await read(field('Maximum retry base delay') + '.value'), '30')
  assert.equal(await read(field('Additional retries') + '.value'), '3')
  await capture('1480-dark-continuity-defaults.png', 'Actual Settings module and effective recovery defaults')
  await type(field('Recovery wait'), '1.125')
  await save(); await saved()
  assert.deepEqual(owner.current.continuity, { activeRecoveryDelayMs: 1125 }, 'GUI persists only the authored first field')

  const { executeSettingsControl } = await import(pathToFileURL(ownerBundle).href)
  // The real compiled public server retains its package identity for the native listener worker.
  const { AgentMuxControlServer } = await import(pathToFileURL(path.join(root, 'packages/core/dist/public-rpc-server.js')).href)
  const server = new AgentMuxControlServer({ execute: request => {
    assert.ok(['settings.get', 'settings.set'].includes(request.operation), 'Saving preferences cannot execute any Session action')
    return executeSettingsControl(request, owner)
  } }, path.join(privateRoot, 'continuity.sock'))
  const cli = promisify(execFile)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTMUX_ENV; delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
  // Electron runs the ordinary Node CLI through its embedded Node mode, preserving the real bin/amux entry.
  env.ELECTRON_RUN_AS_NODE = '1'
  const command = async parts => {
    const args = [path.join(root, 'packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings', ...parts]
    const output = await cli(process.execPath, args, { env, timeout: 8000 })
    const response = JSON.parse(output.stdout)
    result.cli ??= []; result.cli.push({ args: parts, response })
    return response.result
  }
  await server.start()
  try {
    assert.equal((await command(['inspect', 'continuity'])).entries.length, 13)
    await command(['set', 'continuity.retryMaxDelayMs', '45000'])
    await command(['set', 'continuity.retryInitialDelayMs', '2125'])
    await command(['set', 'continuity.retryMaxAttempts', '2'])
    await until(field('First retry base delay') + '.value==="2.125" && ' + field('Maximum retry base delay') + '.value==="45" && ' + field('Additional retries') + '.value==="2"')
    await type(field('Additional retries'), '0'); await save(); await saved()
    assert.equal((await command(['inspect', 'continuity.retryMaxAttempts'])).entries[0].value, 0, 'The new retry field saves through mounted GUI and the original ConfigOwner')
    result.retryWide = await positionRetry()
    await capture('1480-dark-continuity-retry.png', 'Actual retry base delays and additional budget share GUI, CLI and the durable ConfigOwner without a Session action')
    await command(['set', 'continuity.reminderMode', 'default-plus-custom'])
    await command(['set', 'continuity.reminderAppend', 'Keep the original task, decisions and acceptance criteria.\nUnknown previous input must not be repeated.'])
    await command(['set', 'continuity.continuationEnabled', 'false'])
    await until(field('Recovery reminder') + '.value==="default-plus-custom"')
    await until(field('Continue interrupted work after recovery') + '.checked===false')
    assert.equal(await read(field('Append to recovery reminder') + '.value'), owner.current.continuity.reminderAppend, 'Actual CLI publications reach the mounted writable GUI')
    await type(field('Continuation prompt'), 'Continue the same interrupted task. Preserve the original workspace and decisions.')
    await click(field('Continue interrupted work after recovery')); await save(); await saved()
    assert.equal((await command(['inspect', 'continuity.continuationEnabled'])).entries[0].value, true)
    assert.equal((await command(['inspect', 'continuity.continuationPrompt'])).entries[0].value, owner.current.continuity.continuationPrompt)
    await read('document.querySelector(\'[data-settings-pane="continuity"] [data-continuity-reminder-preview]\').scrollIntoView({block:"center"})'); await settle()
    await capture('1480-dark-continuity-custom.png', 'CLI and GUI share the durable owner; complete default plus custom reminder')
    await scene(320, 'light')
    await click(q('.settings-section-picker')); await until('!!document.querySelector(".settings-section-menu[role=menu]")')
    await click('[...document.querySelectorAll(".settings-section-menu [role=menuitemradio]")].find(n=>n.textContent.trim()==="Session continuity")')
    await read('document.querySelector(\'[data-settings-pane="continuity"]\').scrollTop=0'); await settle()
    result.retryNarrow = await positionRetry()
    await capture('320-light-continuity-retry.png', 'Retry policy and context-only input boundary remain readable in the narrow original Settings surface')
    await read(`document.querySelector('[data-settings-pane="continuity"]').scrollTop=0`); await settle()
    await capture('320-light-continuity-top.png', 'Narrow native Settings picker preserves access and full readable recovery controls')
    await read('document.querySelector(\'[data-settings-pane="continuity"] [data-continuity-reminder-preview]\').scrollIntoView({block:"center"})'); await settle()
    await capture('320-light-continuity-reminder.png', 'Full effective reminder wraps without clipping at 320 px')
    await read('document.querySelector(\'[data-settings-pane="continuity"] [aria-label="Recovery delivery preview"]\').scrollIntoView({block:"center"})'); await settle()
    await capture('320-light-continuity-delivery.png', 'Independent continuation and real delivery side effects remain readable next to Save')
    const bytes = JSON.stringify(owner.current)
    await type(field('Recheck count'), '-1')
    assert.equal(await read('document.querySelector(\'[data-settings-pane="continuity"] [data-settings-save-bar] button\').disabled'), true)
    assert.equal(JSON.stringify(owner.current), bytes, 'Invalid draft affects only this settings operation')
    await type(field('Recheck count'), '4'); await save(); await saved()
    assert.equal((await command(['inspect', 'continuity.recheckMaxAttempts'])).entries[0].value, 4)
  } finally { await server.stop() }
  result.settingsOnly = true
}
