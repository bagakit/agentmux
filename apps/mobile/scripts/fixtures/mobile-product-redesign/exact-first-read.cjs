const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')

/** Actual App/Composer/Device owners; directory facts and the single explicit receipt are controlled. */
module.exports = async ({ win, read, until, resize, tap, button, capture, result, evidence, phase }) => {
  const editor = '.mobile-conversation-panel:not([hidden]) [contenteditable=true]'
  const facts = () => read('mobileProductScene.facts()')
  const saved = async () => {
    const f = await facts(), r = f.record
    return { recordId: r.recordId, sid: r.selectedSessionId, host: r.host, conversation: r.conversation, presentation: r.presentation,
      session: f.sessionIds.find(value => value.sessionId === r.selectedSessionId) }
  }
  const noAutomaticWork = async expected => {
    const calls = (await facts()).calls
    assert.equal(calls.filter(value => value.method === 'sdk.submitAgentPrompt').length, expected)
    assert.equal(calls.filter(value => ['agent.open', 'sdk.ensureAgentContinuity', 'sdk.writeAgent', 'sdk.resizeAgent', 'sdk.signalAgent', 'sdk.respondAgentInteraction'].includes(value.method)).length, 0)
  }
  await until(`!!document.querySelector(${JSON.stringify(editor)})`)
  await until('document.querySelector(".mobile-conversation__reading")?.textContent.includes("方案 A")')
  if (phase === 'restore') {
    const original = JSON.parse(await fs.readFile(path.join(evidence, 'renderer-result.json'), 'utf8')).exactOriginal
    const draft = original.conversation.drafts.find(([key]) => key === JSON.stringify(['draft', original.sid]))[1]
    await until(`document.querySelector(${JSON.stringify(editor)})?.textContent===${JSON.stringify(draft)}`)
    await until('!!document.querySelector(".mobile-send-status[data-phase=unknown]")')
    const restored = await saved()
    for (const key of ['recordId', 'sid', 'host', 'conversation', 'presentation', 'session']) assert.deepEqual(restored[key], original[key], 'Original Device field restored: ' + key)
    await noAutomaticWork(0)
    await resize(390, 844); await read('mobileProductScene.setAppearance("dark")')
    await capture('05-exact-original-workface-after-private-restart-390-dark')
    result.exactOriginal = restored
    result.operations.push({ action: 'exact-original-device-restored-without-replay', ...restored })
    return
  }
  await read(`window.originalCaptureEditor=document.querySelector(${JSON.stringify(editor)});window.exactOriginalReading=document.querySelector('.mobile-conversation__reading')`)
  await tap(editor, 'Write the original draft while only the directory is pending')
  await win.webContents.insertText('保留原来的依据，先比较两个小实验。')
  await until('mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text.includes("保留原来的依据"))')
  assert.deepEqual((await facts()).exactFirstRead.observation, { state: 'unconfirmed', hasSnapshot: false })
  await resize(390, 844); await read('mobileProductScene.setAppearance("dark")')
  await capture('01-exact-conversation-before-directory-390-dark')
  await noAutomaticWork(0)

  await read('mobileProductScene.acceptExactDirectory()')
  await resize(844, 390); await read('mobileProductScene.setAppearance("light")')
  await until('document.querySelectorAll(".mobile-focus-pane .mobile-agent-row__open").length===mobileProductScene.facts().sessionIds.length')
  await read('mobileProductScene.unknownNext()')
  await button('Send')
  await until('!!document.querySelector(".mobile-send-status[data-phase=unknown]")')
  await tap(editor, 'Continue a later draft while the original send remains unknown')
  await read(`(()=>{const e=document.querySelector(${JSON.stringify(editor)}),r=document.createRange(),s=getSelection();r.selectNodeContents(e);r.collapse(false);s.removeAllRanges();s.addRange(r)})()`)
  await win.webContents.insertText(' 后来补充的想法仍留在这台设备。')
  await until('mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text.includes("后来补充"))')
  const retainedRows = await read('document.querySelectorAll(".mobile-focus-pane .mobile-agent-row__open").length')
  await read('mobileProductScene.failExactDirectory()')
  await until('!!document.querySelector(".mobile-focus-pane .mobile-directory-notice")')
  assert.equal(await read('document.querySelectorAll(".mobile-focus-pane .mobile-agent-row__open").length'), retainedRows)
  const title = await read(`(()=>{const pane=document.querySelector('.mobile-focus-pane'),n=pane.querySelector('.mobile-page-header h1'),r=document.createRange();r.selectNodeContents(n);return {text:n.textContent,box:n.getBoundingClientRect().toJSON(),glyphs:r.getBoundingClientRect().toJSON(),pane:pane.getBoundingClientRect().toJSON(),actions:[...pane.querySelectorAll('.mobile-page-header button')].filter(n=>n.getClientRects().length).map(n=>({label:n.getAttribute('aria-label'),rect:n.getBoundingClientRect().toJSON()}))}})()`)
  assert.equal(title.text, 'Focus')
  assert.ok(title.glyphs.width <= title.box.width + 1, 'The complete Focus title fits beside its directory warning')
  assert.ok(title.glyphs.right <= title.pane.right, 'The Focus title remains inside its original pane')
  for (const action of title.actions) assert.ok(action.rect.width >= 44 && action.rect.height >= 44, 'Original header action keeps its touch target: ' + action.label)
  result.focusDirectoryTitle = title
  await tap('.mobile-focus-pane .mobile-directory-notice', 'Open the original nearby directory recovery')
  await capture('02-exact-directory-unavailable-retains-original-844-light')
  await button('重新读取目录', '.mobile-directory-issues')
  await until('mobileProductScene.facts().calls.filter(value=>value.method==="sdk.connect").length===1')
  await button('关闭目录信息', '.mobile-directory-issues')
  await resize(390, 844)
  assert.equal((await facts()).exactFirstRead.observation.state, 'unavailable')
  assert.equal((await facts()).exactFirstRead.retryPending, true)
  await capture('03-exact-directory-retry-awaits-original-390-light')

  await read('mobileProductScene.acceptExactDirectory(true)')
  await resize(1024, 768)
  await button('刷新空间目录', '.mobile-focus-pane')
  await until('document.querySelector(".mobile-focus-pane")?.textContent.includes("暂无会话")')
  assert.equal(await read('document.querySelectorAll(".mobile-focus-pane .mobile-agent-row__open").length'), 0)
  assert.equal(await read(`document.querySelector(${JSON.stringify(editor)})===window.originalCaptureEditor`), true)
  assert.equal(await read('document.querySelector(".mobile-conversation__reading")===window.exactOriginalReading'), true)
  assert.equal(await read('!!document.querySelector(".mobile-send-status[data-phase=unknown]")'), true)
  assert.equal(await read('document.querySelector(".mobile-app").dataset.connection'), 'connected')
  await noAutomaticWork(1)
  await capture('04-exact-ready-empty-directory-keeps-reading-1024-light')
  result.exactOriginal = await saved()
  assert.equal(result.exactOriginal.sid, 'session-result')
  assert.equal(result.exactOriginal.conversation.attempts.filter(([,value]) => value.phase === 'unknown').length, 1)
  result.operations.push({ action: 'exact-original-device-before-private-restart', ...result.exactOriginal })
  result.exactBoundary = 'Controlled SDK directory snapshots and one explicit unknown Send receipt; actual original MobileApp, Spatial, Composer and DeviceWorkface. Same private HTTP origin/profile across two OS processes. No live Relay, physical phone or user Session claim.'
}
