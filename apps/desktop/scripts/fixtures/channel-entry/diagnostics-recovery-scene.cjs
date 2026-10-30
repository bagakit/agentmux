const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, click, settle, capture, details, dismiss, layout, result }) => {
  const diagnostic = '.agent-connector-dialog [data-connection-panel=diagnostics]'
  const action = diagnostic + ' [data-direction=outgoing] [data-source-recovery-action=recover]'
  const editor = '[data-workbench-region-id="channel-preview-region"] [data-agent-composer] [role="textbox"][aria-label="Message Agent"]'
  await layout(true)
  const before = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');window.__diagnosticComposer=e;return {text:e.textContent,selection:e.editor.state.selection.toJSON()}})()')
  await read('Object.assign(window.channelEntryProof.diagnosis,{active:false,mode:"busy",receiver:"ready",longName:false,recoveryLost:false})')
  await details('healthy', 'dark', 1380)
  await read('window.channelEntryProof.diagnosis.active=true')
  await click('.agent-connector-dialog [data-connection-panel=overview] .primary-button')
  await until('document.querySelector(".agent-connector-dialog [data-connection-panel=overview] [data-source-recovery-action=recover]")')
  await click('[role=tab][aria-controls$="-diagnostics-panel"]')
  await until('document.querySelector(' + JSON.stringify(diagnostic) + ')?.hidden===false&&!!document.querySelector(' + JSON.stringify(action) + ')')
  assert.equal(await read('document.querySelector(".agent-connector-dialog [data-connection-panel=overview]").hidden'), true)
  assert.equal(await read('document.querySelector(' + JSON.stringify(diagnostic + ' [data-direction=outgoing]') + ').textContent.includes("Check read result")'), false)
  await capture('diagnostic-source-busy-wide-dark')
  win.setContentSize(520, 980); await until('innerWidth===520')
  await read('window.channelEntryProof.setTheme("light")'); await settle()
  await click(action)
  await until('document.querySelector(' + JSON.stringify(diagnostic + ' [data-direction=outgoing]') + ').textContent.includes("Sync recovery requested")')
  await click('[role=tab][aria-controls$="-members-panel"]'); await click('[role=tab][aria-controls$="-diagnostics-panel"]')
  assert.equal(await read('document.querySelector(' + JSON.stringify(diagnostic + ' [data-direction=outgoing]') + ').textContent.includes("Sync recovery requested")'), true)
  await capture('diagnostic-source-requested-narrow-light'); await dismiss()
  const after = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');return {sameNode:e===window.__diagnosticComposer,text:e.textContent,selection:e.editor.state.selection.toJSON()}})()')
  assert.equal(after.sameNode, true); assert.equal(after.text, before.text); assert.deepEqual(after.selection, before.selection)
  result.composerPreservation = { before, after }
  result.boundary = 'Original visible Diagnostics source direction invokes the shared Overview action and retains its request feedback across tabs. Controlled typed RPC leaves in native capture; actual same-cut SDK/IPC/Main/Hosted/Publication behavior is verified separately. No live effects or pause/resume.'
}
