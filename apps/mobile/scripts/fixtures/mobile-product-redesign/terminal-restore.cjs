const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
module.exports = async context => {
  const { win, read, until, tap, result, evidence, phase } = context
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  if (phase !== 'restore') {
    await tap('.mobile-conversation-panel [contenteditable=true]', 'Keep the original terminal conversation draft')
    await win.webContents.insertText('终端工作保留这段未发送的正文。')
    await until('mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text.includes("终端工作保留"))')
    const facts = await read('mobileProductScene.facts()')
    result.terminalOriginal = { sid: facts.record.selectedSessionId, conversation: facts.record.conversation, run: facts.sessionIds.find(item => item.sessionId === facts.record.selectedSessionId) }
  } else {
    const original = JSON.parse(await fs.readFile(path.join(evidence, 'renderer-result.json'), 'utf8')).terminalOriginal
    const facts = await read('mobileProductScene.facts()')
    assert.equal(facts.record.selectedSessionId, original.sid)
    assert.deepEqual(facts.record.conversation, original.conversation)
    assert.deepEqual(facts.sessionIds.find(item => item.sessionId === original.sid), original.run)
    await until('document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")?.textContent.includes("终端工作保留")')
    result.terminalOriginal = original
  }
  await require('./restart-chrome.cjs')({ ...context, prefix: 'terminal-restart' })
  await tap('.mobile-header .mobile-session-view-toggle', 'Leave the original terminal selected')
  await until('mobileProductScene.facts().record.panel==="terminal"')
  const calls = await read('mobileProductScene.facts().calls')
  assert.equal(calls.filter(call => ['sdk.ensureAgentContinuity', 'agent.open', 'sdk.submitAgentPrompt', 'sdk.respondAgentInteraction', 'sdk.resizeAgent', 'sdk.writeAgent'].includes(call.method)).length, 0)
  result.terminalRestartBoundary = 'Two private Electron OS processes read the same device profile. Cold entry returns to the saved original chat by the mobile startup contract; its terminal is reopened without Run recovery, creation, input or resize. Controlled SDK facts do not prove a live Host or physical phone.'
}
