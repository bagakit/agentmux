const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, click, press, settle, capture, layout, open, close, result }) => {
  const set = value => read('Object.assign(window.channelEntryProof.diagnosis,' + JSON.stringify(value) + ')')
  const menu = '.connector-header-menu', status = menu + ' [data-group-status]'
  const editor = '[data-workbench-region-id="channel-preview-region"] [data-agent-composer] [role="textbox"][aria-label="Message Agent"]'
  await layout(true)
  const before = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');window.__statusComposer=e;return {text:e.textContent,selection:e.editor.state.selection.toJSON()}})()')
  async function show(appearance, mode, receiver, longName = false, narrow = false) {
    await layout(narrow)
    await set({ active: true, statusMode: mode, mode: 'ready', receiver, longName, recoveryLost: false, showAvatar: true })
    await read('window.channelEntryProof.setTheme(' + JSON.stringify(appearance) + ');window.channelEntryProof.setScenario("healthy")')
    await open('feishu'); await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("Current binding")')
    await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("Ava Chen")')
    await until('(()=>{const image=document.querySelector(' + JSON.stringify(status + ' .connector-group-status__person img') + ');return !!image&&image.complete&&image.naturalWidth>0})()')
    await settle()
    assert.equal(await read('!!document.querySelector(' + JSON.stringify(status + ' .connector-connection-overview') + ')'), false)
    assert.equal(await read('document.querySelector(' + JSON.stringify(status) + ').textContent.includes("Check status")'), false)
    assert.equal(await read('[...document.querySelectorAll(' + JSON.stringify(status + ' .connector-group-status__person') + ')][1].querySelector("img")'), null)
    if (mode === 'normal') assert.equal(await read('(()=>{const label=document.querySelector(' + JSON.stringify(status + ' .connector-group-status__person > small') + ');return label.textContent==="Chat, Answer, Approve"&&label.scrollWidth<=label.clientWidth})()'), true)
  }
  await show('dark', 'normal', 'ready')
  await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("12 recent messages")')
  await capture('status-normal-wide-dark'); await press('Escape'); await close()
  await show('light', 'normal', 'ready', true, true)
  await capture('status-normal-narrow-light')
  await click('js:(()=>[...document.querySelectorAll(".connector-header-menu [role=menuitem]")].find(node=>node.textContent.startsWith("Members & access")))()')
  await until('document.querySelector("[role=tab][aria-controls$=members-panel]")?.getAttribute("aria-selected")==="true"')
  await click('[aria-label="Close group setup"]'); await until('!document.querySelector(".agent-connector-dialog")')
  await show('dark', 'unknown', 'ready', true)
  await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("Unconfirmed")')
  await capture('status-unknown-wide-dark'); await press('Escape'); await close()
  await show('light', 'normal', 'ended', true, true)
  await until('document.querySelector(' + JSON.stringify(status + ' [data-receiver-action=recover]') + ')')
  await capture('status-recovery-narrow-light')
  await click(status + ' [data-receiver-action=recover]')
  await until('document.querySelector(' + JSON.stringify(menu) + ')?.textContent.includes("Reconnecting")')
  await press('Escape'); await close()
  const after = await read('(()=>{const e=document.querySelector(' + JSON.stringify(editor) + ');return {sameNode:e===window.__statusComposer,text:e.textContent,selection:e.editor.state.selection.toJSON()}})()')
  assert.equal(after.sameNode, true); assert.equal(after.text, before.text); assert.deepEqual(after.selection, before.selection)
  result.composerPreservation = { before, after }
  result.boundary = 'Actual production compact Header/GroupStatus and original member navigation/recovery controls. Controlled typed Host DTO leaves only; original SDK/Hosted/CLI persistence and scope evidence is separate. The large Group Details layout is unchanged.'
}
