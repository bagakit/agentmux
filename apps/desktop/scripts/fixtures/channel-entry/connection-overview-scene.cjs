const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, click, press, settle, capture, details, dismiss, layout, open, close, result }) => {
  const set = value => read('Object.assign(window.channelEntryProof.diagnosis,' + JSON.stringify(value) + ')')
  await read('Object.assign(window.channelEntryProof.diagnosis,{active:false,mode:"busy",longName:false})')
  await details('healthy', 'dark', 1380)
  await read('window.channelEntryProof.diagnosis.active=true')
  await click('.agent-connector-dialog [data-connection-panel=overview] .primary-button')
  await until('document.querySelector(".agent-connector-dialog [data-receiving-state=online]")?.textContent.includes("will retry automatically")')
  assert.equal(await read('document.querySelectorAll(".agent-connector-dialog [data-connection-panel=overview] .primary-button").length'), 1)
  assert.equal(await read('document.querySelector(".agent-connector-dialog [data-connection-panel=diagnostics]").hidden'), true)
  if (process.argv.includes('--connection-overview-first')) { await capture('connection-overview-first-wide-dark'); return }
  const editor = '[data-workbench-region-id="channel-preview-region"] [data-agent-composer] [role="textbox"][aria-label="Message Agent"]'
  const composer = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');window.__overviewComposer=e;return {text:e.textContent,selection:e.editor.state.selection.toJSON()}})()')
  await click('.agent-connector-dialog [data-source-recovery-action=recover]')
  await until('document.querySelector(".agent-connector-dialog [data-connection-panel=overview]").textContent.includes("Sync recovery requested")')
  await capture('connection-online-busy-wide-dark'); await dismiss()
  async function show(receiver, appearance, width, mode = 'ready', longName = true) {
    await set({ active: false, receiver, mode, longName, recoveryLost: false }); await details('healthy', appearance, width); await set({ active: true })
    await click('.agent-connector-dialog [data-connection-panel=overview] .primary-button')
    await until('document.querySelector(".agent-connector-dialog [data-receiving-state]")?.dataset.receivingState===' + JSON.stringify(receiver === 'ended' ? 'stopped' : receiver === 'ready' ? 'online' : receiver === 'unknown' ? 'unknown' : 'recovering'))
  }
  await show('ended', 'light', 520)
  await until('document.querySelector("[data-receiver-action=recover]")')
  await capture('connection-stopped-narrow-light')
  await click('[data-receiver-action=recover]')
  await until('document.querySelector(".agent-connector-dialog [data-receiving-state=recovering]")')
  win.setContentSize(1380, 980); await until('innerWidth===1380'); await settle()
  await capture('connection-reconnecting-wide-light')
  await set({ receiver: 'unknown', recoveryLost: true }); await click('[data-receiver-action=inspect]')
  win.setContentSize(520, 980); await until('innerWidth===520'); await read('window.channelEntryProof.setTheme("dark")'); await settle()
  // Inspect cannot certify native liveness; an explicit group check observes the unknown receiver.
  await click('[role=tab][aria-controls$="-diagnostics-panel"]')
  await click('.agent-connector-dialog .connector-delivery-details > .agent-connector-section-title button')
  await until('document.querySelector(".agent-connector-dialog [data-receiving-state=unknown]")')
  await click('[role=tab][aria-controls$="-overview-panel"]')
  assert.equal(await read('!!document.querySelector("[data-receiver-action=recover]")'), false)
  await capture('connection-unknown-narrow-dark'); await dismiss()
  win.setContentSize(1380, 980); await until('innerWidth===1380'); await layout(true)
  await set({ active: true, mode: 'busy', receiver: 'ready', longName: true, recoveryLost: false })
  await read('window.channelEntryProof.setTheme("light");window.channelEntryProof.setScenario("healthy")')
  await open('feishu'); await until('document.querySelector(".connector-header-menu [data-receiving-state=online]")?.textContent.includes("will retry automatically")')
  result.compact = await read('(()=>{const r=document.querySelector("[data-workbench-region-id=channel-preview-region]");return {region:r.getBoundingClientRect().toJSON(),regions:document.querySelectorAll("[data-workbench-region-id]").length}})()')
  assert.ok(result.compact.regions > 1 && result.compact.region.width >= 350 && result.compact.region.width <= 520)
  await capture('connection-compact-narrow-light'); await press('Escape'); await close()
  const after = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');return {sameNode:e===window.__overviewComposer,text:e.textContent,selection:e.editor.state.selection.toJSON()}})()')
  assert.equal(after.sameNode, true); assert.equal(after.text, composer.text); assert.deepEqual(after.selection, composer.selection)
  result.composerPreservation = { before: composer, after }
  result.boundary = 'Early production Renderer hierarchy preview. Original dialog/tabs/receiver action presentation with controlled typed diagnosis leaves; no actual backend recovery claim. Final owner consumer and five-frame review remain pending.'
}
