const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

exports.run = async p => {
  const { win, read, q, until, settle, click, type, scene, capture, owner, result, mode, ownerBundle, privateRoot, root } = p
  const field = label => q(`[data-settings-pane="${['Use active state when interruption detection is unsupported', 'Continue interrupted work after recovery'].includes(label) ? 'automation' : 'continuity'}"] [aria-label="${label}"]`)
  async function section(id) {
    const nav = q(`nav[aria-label="Settings sections"] [data-settings-target="${id}"]`)
    const title = await read(nav + '?.textContent.trim()')
    if (await read(nav + '.checkVisibility()')) await click(nav)
    else {
      await click(q('.settings-section-picker'))
      await until('!!document.querySelector(".settings-section-menu[role=menu]")')
      await click(`[...document.querySelectorAll('.settings-section-menu [role=menuitemradio]')].find(n=>n.textContent.trim()===${JSON.stringify(title)})`)
    }
    await until(`document.querySelector('.settings-page')?.dataset.settingsPage===${JSON.stringify(id)}`)
  }
  const fallback = field('Use active state when interruption detection is unsupported')
  const continuation = field('Continue interrupted work after recovery')
  const save = () => click(q('[data-settings-pane]:not([hidden]) [data-settings-save-bar] button'))
  const saved = () => until('document.querySelector(\'[data-settings-pane]:not([hidden]) [data-settings-save-bar]\')?.textContent.includes("Changes saved")')
  const positionContinuation = async () => {
    await section('automation')
    await read(`document.activeElement?.blur(); document.querySelector('[data-continuity-interruption-settings]').scrollIntoView({block:'center',behavior:'instant'})`)
    await settle()
    const facts = await read(`(()=>{const section=document.querySelector('[data-continuity-interruption-settings]'),pane=section.closest('[data-settings-pane]'),r=section.getBoundingClientRect(),p=pane.getBoundingClientRect(),save=pane.querySelector('[data-settings-save-bar]').getBoundingClientRect();return{top:r.top,bottom:r.bottom,paneTop:p.top,saveTop:save.top,text:section.textContent,controls:[...section.querySelectorAll('input')].map(n=>{const b=n.getBoundingClientRect();return{label:n.ariaLabel,checked:n.checked,visible:b.top>=p.top&&b.bottom<=save.top}})}})()`)
    assert.equal(facts.controls.length, 2)
    assert.ok(facts.controls.every(control => control.visible), 'Both continuation choices remain visible in the captured viewport')
    assert.ok(facts.text.includes('supports detection but reports an unknown result never uses this fallback'))
    assert.equal(await read('document.querySelector("[data-continuity-continuation-preview]").textContent'), '<amux:continue />')
    return facts
  }
  win.showInactive()
  await click(q('nav[aria-label="Settings sections"] [data-settings-target="continuity"]'))
  await until('document.querySelector(\'.settings-content__header h2\')?.textContent==="Execution"')
  assert.equal(await read(field('Recovery wait') + '.value'), '0')
  assert.equal(await read(field('Automatic recovery window') + '.value'), '86400')
  await capture('1480-dark-execution-defaults.png', 'Actual Execution module and automatic recovery defaults')
  await section('automation')
  assert.equal(await read(fallback + '.checked'), false)
  assert.equal(await read(continuation + '.checked'), true)
  const retained = { reminderMode: 'default-plus-custom', reminderAppend: 'Keep the original task and acceptance criteria.', continuationPrompt: 'An old authored continuation.' }
  await owner.update(current => ({ ...current, continuity: { ...current.continuity, ...retained } }))
  await until(field('Automatic recovery window') + '.value==="86400"')
  assert.equal(await read(q('[aria-label="Recovery reminder"]') + '===null'), true)
  assert.equal(await read(q('[aria-label="Continuation prompt"]') + '===null'), true)
  result.continuationWide = await positionContinuation()
  await capture('1480-dark-automation-continuation.png', 'Default-off active fallback, Provider unknown boundary and fixed continuation')
  if (mode === 'session-continuity-delivery') {
    await scene(320, 'light'); result.continuationNarrow = await positionContinuation()
    await capture('320-light-automation-continuation.png', 'Automation continuation choices wrap in the original narrow Settings surface')
    result.savedContinuity = structuredClone(owner.current.continuity)
    result.settingsOnly = true; result.deliveryOnly = true; return
  }
  await section('continuity')
  await type(field('Recovery wait'), '1.125'); await save(); await saved()
  assert.deepEqual(owner.current.continuity, { ...retained, activeRecoveryDelayMs: 1125 }, 'GUI preserves retained input while saving only the authored first field')

  const { executeSettingsControl } = await import(pathToFileURL(ownerBundle).href)
  const { AgentMuxControlServer } = await import(pathToFileURL(path.join(root, 'packages/core/dist/public-rpc-server.js')).href)
  const server = new AgentMuxControlServer({ execute: request => {
    assert.ok(['settings.get', 'settings.set'].includes(request.operation), 'Saving preferences cannot execute any Session action')
    return executeSettingsControl(request, owner)
  } }, path.join(privateRoot, 'continuity.sock'))
  const cli = promisify(execFile), env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTMUX_ENV; delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
  env.ELECTRON_RUN_AS_NODE = '1'
  const command = async parts => {
    const args = [path.join(root, 'packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings', ...parts]
    const output = await cli(process.execPath, args, { env, timeout: 8000 }), response = JSON.parse(output.stdout)
    result.cli ??= []; result.cli.push({ args: parts, response }); return response.result
  }
  await server.start()
  try {
    const entries = (await command(['inspect', 'continuity'])).entries
    assert.equal(entries.length, 11)
    assert.deepEqual(entries.find(entry => entry.key === 'continuity.activeInterruptionFallback'), { key: 'continuity.activeInterruptionFallback', kind: 'boolean', value: false, default: false })
    assert.ok(entries.every(entry => !Object.hasOwn(retained, entry.key.slice('continuity.'.length))))
    await command(['set', 'continuity.activeInterruptionFallback', 'true'])
    await until(fallback + '.checked===true')
    await section('automation')
    await click(fallback); await save(); await saved()
    assert.equal((await command(['inspect', 'continuity.activeInterruptionFallback'])).entries[0].value, false)
    await command(['set', 'continuity.confirmedIdleWindowMs', '7200000'])
    await until(field('Automatic recovery window') + '.value==="7200"')
    await command(['set', 'continuity.retryMaxDelayMs', '45000'])
    await command(['set', 'continuity.retryInitialDelayMs', '2125'])
    await command(['set', 'continuity.retryMaxAttempts', '2'])
    await until(field('First retry base delay') + '.value==="2.125" && ' + field('Maximum retry base delay') + '.value==="45" && ' + field('Additional retries') + '.value==="2"')
    await command(['set', 'continuity.continuationEnabled', 'false'])
    await until(continuation + '.checked===false')
    assert.equal(await read('document.querySelector("[data-continuity-continuation-preview]")'), null)
    await section('automation')
    await click(continuation); await save(); await saved()
    assert.equal((await command(['inspect', 'continuity.continuationEnabled'])).entries[0].value, true)
    for (const key of Object.keys(retained)) {
      await assert.rejects(command(['set', `continuity.${key}`, 'replacement']))
      assert.equal(owner.current.continuity[key], retained[key], 'Historical authored input remains intact')
    }
    result.continuationWideSaved = await positionContinuation()
    await capture('1480-dark-automation-saved.png', 'Mounted controls and public CLI consume the same durable settings owner')
    await scene(320, 'light')
    await click(q('.settings-section-picker')); await until('!!document.querySelector(".settings-section-menu[role=menu]")')
    await click('[...document.querySelectorAll(".settings-section-menu [role=menuitemradio]")].find(n=>n.textContent.trim()==="Execution")')
    await read('document.querySelector(\'[data-settings-pane="continuity"]\').scrollTop=0'); await settle()
    await capture('320-light-execution-top.png', 'Narrow Settings menu keeps the same Execution module and saved recovery window')
    result.continuationNarrow = await positionContinuation()
    await capture('320-light-automation-continuation.png', 'Fallback and fixed continuation remain readable at 320 px')
    const bytes = JSON.stringify(owner.current)
    await section('continuity')
    await type(field('Recheck count'), '-1')
    assert.equal(await read('document.querySelector(\'[data-settings-pane="continuity"] [data-settings-save-bar] button\').disabled'), true)
    assert.equal(JSON.stringify(owner.current), bytes, 'Invalid draft affects only this settings operation')
    await type(field('Recheck count'), '4'); await save(); await saved()
    assert.equal((await command(['inspect', 'continuity.recheckMaxAttempts'])).entries[0].value, 4)
    result.savedContinuity = structuredClone(owner.current.continuity)
  } finally { await server.stop() }
  result.settingsOnly = true
}
