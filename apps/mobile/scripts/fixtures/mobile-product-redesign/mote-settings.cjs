const assert = require('node:assert/strict')

module.exports = async ({ win, read, until, button, capture, result, phase }) => {
  const field = '[aria-label="心跳间隔（分钟）"]'
  const facts = () => read('mobileProductScene.facts()')
  const minutes = async text => {
    await read(`(()=>{const n=document.querySelector(${JSON.stringify(field)});n.scrollIntoView({block:'center'});n.focus()})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
    await win.webContents.insertText(text)
    await until(`document.querySelector(${JSON.stringify(field)})?.value===${JSON.stringify(text)}`)
    await until(`mobileProductScene.facts().record.moteQuickDrafts?.[0]?.values.presence?.intervalMs===${Number(text) * 60000}`)
    result.operations.push({ action: 'original-field-input', text, value: await read(`document.querySelector(${JSON.stringify(field)}).value`) })
  }
  const top = async () => {
    await read("(()=>{document.activeElement?.blur();document.querySelector('.mobile-sheet').scrollTop=0})()")
    await until("document.querySelector('.mobile-sheet').scrollTop===0")
  }
  const values = async () => {
    await read(`(()=>{document.activeElement?.blur();document.querySelector(${JSON.stringify(field)}).closest('fieldset').scrollIntoView({block:'start'})})()`)
    const observed = await facts()
    assert.equal(observed.settingsOverflow, false, 'Original settings sheet stays within its width')
    assert.equal(observed.appearance, 'light', 'Original theme runtime applies the captured appearance')
  }
  await button('编辑快捷配置')
  await until("document.querySelector('.mobile-mote-quick-editor')?.textContent.includes('已核对当前配置')")
  if (phase === 'restore') {
    await until(`document.querySelector(${JSON.stringify(field)})?.value==='47'`)
    const retained = await facts(), original = retained.record.moteQuickDrafts[0]
    assert.equal(original.values.presence.intervalMs, 2820000)
    assert.equal(original.attempts.at(-1).phase, 'unknown')
    assert.equal(original.blockedAttemptId, original.attempts.at(-1).input.operationId)
    assert.equal(original.attempts.at(-1).input.values.presence.intervalMs, 1020000)
    await values(); await capture('mote-settings-restored-unknown-390-light')
    await button('保存快捷配置')
    assert.equal((await facts()).calls.filter(call => call.method === 'space.mote.preferences.save').length, 0, 'Reopening never replays the original save')
    result.operations.push({ action: 'original-device-settings-restored', record: original, recordId: retained.record.recordId ?? null, host: retained.record.host })
    return
  }
  await until("[...document.querySelector('[aria-label=\"新对话使用的 Agent\"]').options].some(option=>option.value==='next')")
  // A hidden Chromium window has no OS select popup. Exercise its actual select
  // and React handler with the standard browser option-selection event pair.
  await read("(()=>{const n=document.querySelector('[aria-label=\"新对话使用的 Agent\"]');n.value='next';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await until("document.querySelector('[aria-label=\"新对话使用的 Agent\"]').value==='next'")
  result.operations.push({ action: 'original-select-option', input: 'Actual select input/change events; OS popup selection not observed', value: await read("document.querySelector('[aria-label=\"新对话使用的 Agent\"]').value") })
  await minutes('7'); await top(); await capture('mote-settings-pending-display-editable-390-light')
  const pending = await facts()
  assert.ok(pending.calls.some(call => call.method === 'space.mote.preferences.read' && call.params.includeChoices === 'executors'))
  assert.ok(pending.calls.some(call => call.method === 'space.mote.preferences.read' && call.params.includeChoices === 'locations'))
  await button('保存快捷配置')
  await until("document.querySelector('.mobile-mote-quick-editor')?.textContent.includes('快捷配置已保存')")
  const saved = await facts(), first = saved.calls.filter(call => call.method === 'space.mote.preferences.save')
  assert.equal(first.length, 1)
  assert.equal(first[0].params.destination, undefined)
  assert.equal(first[0].draftAtDispatch.blockedAttemptId, first[0].params.operationId)
  assert.deepEqual(first[0].draftAtDispatch.attempts.at(-1).input, first[0].params)
  result.operations.push({ action: 'original-no-display-save-confirmed', packet: first[0].params })
  await read("mobileSettingsScenario({catalog:'failed'})")
  await until("document.querySelector('.mobile-mote-quick-editor')?.textContent.includes('展示候选暂时不可用')")
  await top(); await capture('mote-settings-display-failure-recovery-390-light')
  await read("mobileSettingsScenario({catalog:'ready',loseNextReceipt:true})")
  await button('重新核对候选')
  await until("!document.querySelector('.mobile-mote-quick-editor').textContent.includes('展示候选暂时不可用')")
  await minutes('17'); await button('保存快捷配置')
  await until("mobileProductScene.facts().record.moteQuickDrafts?.[0]?.attempts.at(-1)?.phase==='unknown'")
  await minutes('47'); await values(); await capture('mote-settings-unknown-keeps-later-draft-390-light')
  const retained = await facts(), original = retained.record.moteQuickDrafts[0]
  assert.equal(original.values.presence.intervalMs, 2820000)
  assert.equal(original.attempts.at(-1).input.values.presence.intervalMs, 1020000)
  assert.equal(original.attempts.at(-1).phase, 'unknown')
  assert.equal(retained.recordIssue, null)
  result.operations.push({ action: 'original-device-settings-retained', record: original, recordId: retained.record.recordId ?? null, host: retained.record.host })
  await win.webContents.session.flushStorageData()
}
