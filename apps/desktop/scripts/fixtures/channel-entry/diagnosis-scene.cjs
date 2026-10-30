const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, click, press, settle, capture, details, dismiss, layout, open, close, result }) => {
  const set = value => read('(()=>{Object.assign(window.channelEntryProof.diagnosis,' + JSON.stringify(value) + ');return true})()')
  const editor = '[data-workbench-region-id="channel-preview-region"] [data-agent-composer] [role="textbox"][aria-label="Message Agent"]'
  const button = text => 'js:[...document.querySelectorAll(".agent-connector-dialog button")].find(n=>n.textContent===' + JSON.stringify(text) + ')'
  await until('document.querySelector(' + JSON.stringify(editor) + ')'); await click(editor); win.webContents.selectAll(); await until('getSelection().toString()==="Keep this original research draft."')
  await win.webContents.insertText('Keep this original research draft.'); await settle()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' }); await settle()
  const before = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');window.__diagnosisEditor=e;return {selection:e.editor.state.selection.toJSON(),text:e.textContent}})()')
  async function show(mode, theme, width, longName = false) {
    await set({ active: false, mode, longName }); await details('healthy', theme, width); await set({ active: true })
    await click('.connector-delivery-details > .agent-connector-section-title button')
    await until('document.querySelector(".connector-traffic-summary").textContent.includes("Bot receive check incomplete")')
  }
  await show('busy', 'dark', 1380); await until('document.querySelector(".connector-traffic-summary").textContent.includes("Conversation reading is busy")')
  assert.equal(await read('[...document.querySelectorAll(".agent-connector-dialog button")].filter(n=>n.textContent==="Check group activity").length'), 0)
  await capture('diagnosis-busy-wide-dark'); await dismiss()
  const after = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');return {selection:e.editor.state.selection.toJSON(),text:e.textContent,sameNode:e===window.__diagnosisEditor}})()')
  assert.equal(after.sameNode, true); assert.deepEqual(after.selection, before.selection); assert.equal(after.text, before.text); result.composerPreservation = { before, after }
  await show('ready', 'light', 520, true); await capture('diagnosis-ready-gap-narrow-light'); await dismiss()
  await show('waiting', 'light', 1380); await click(button('View original input'))
  await until('document.querySelector("[data-original-input-waiting]")?.textContent.includes("Input environment check incomplete")')
  await until('document.querySelector("[data-input-wait-action=rejoin]")'); await capture('diagnosis-original-wait-wide-light'); await dismiss()
  await show('admitted', 'dark', 520, true)
  await until('document.querySelector("[data-direction=incoming]").textContent.includes("Last message: Accepted by Agent")')
  await capture('diagnosis-group-receipt-narrow-dark')
  await click(button('View earlier receipts'))
  await until('document.querySelector("[data-delivery-operation=preview-original-older-result]")')
  await click('[data-delivery-operation="preview-original-older-result"] button')
  await until('document.querySelector("[data-selected-delivery=preview-original-older-result]")')
  assert.equal(await read('!!document.querySelector("[data-delivery-action=retry]")'), false)
  assert.equal(await read('!!document.querySelector("[data-delivery-action=continue]")'), false)
  await capture('diagnosis-older-original-narrow-dark'); await dismiss()
  win.setContentSize(1380, 980); await until('innerWidth===1380'); await layout(true); await set({ active: true, mode: 'busy', longName: true }); await read('window.channelEntryProof.setTheme("light");window.channelEntryProof.setScenario("healthy")')
  await open('feishu'); await until('document.querySelector(".connector-header-menu [data-direction=outgoing]")?.textContent.includes("Conversation reading is busy")')
  result.compactHeader = await read('(()=>{const region=document.querySelector("[data-workbench-region-id=channel-preview-region]"),menu=document.querySelector(".connector-header-menu");return {region:region.getBoundingClientRect().toJSON(),regions:document.querySelectorAll("[data-workbench-region-id]").length,text:menu.textContent}})()')
  assert.ok(result.compactHeader.regions > 1 && result.compactHeader.region.width >= 350 && result.compactHeader.region.width <= 520)
  await capture('diagnosis-busy-compact-narrow-light'); await press('Escape'); await close()
  result.diagnosisScope = 'Five planned state surfaces, plus the same narrow-dark state with its original older receipt explicitly opened. No automatic row inspections or live platform effects.'
}
