const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
module.exports = async ({ win, read, until, resize, tap, button, capture, result, evidence, phase }) => {
  await until('typeof mobileProductScene!=="undefined"&&!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  const facts = () => read('mobileProductScene.facts()')
  const noLifecycle = async () => assert.equal((await facts()).calls.filter(call =>
    ['sdk.ensureAgentContinuity', 'agent.open', 'sdk.submitAgentPrompt'].includes(call.method)).length, 0,
  'Opening or restoring a presentation does not recover a Run, create an Agent or send input')
  if (phase === 'restore') {
    const original = JSON.parse(await fs.readFile(path.join(evidence, 'renderer-result.json'), 'utf8')).recoveryOriginal
    const restored = (await facts()).record
    for (const key of ['selectedSessionId', 'conversation', 'agentCreates']) assert.deepEqual(restored[key], original[key], `Original ${key} survives a new OS process`)
    assert.equal(restored.presentation.recentMoteSpaceId, 'mote-resources')
    assert.deepEqual(restored.presentation.identity, original.presentation.identity)
    assert.equal(restored.selectedSessionId, 'session-mote', 'Recent conversation wins over the last visited Mote directory')
    await until('document.querySelector("[contenteditable=true]")?.textContent.includes("原草稿在重启后保留")')
    await capture('chat-start-restored-phone')
    await noLifecycle(); result.recoveryRestored = restored; return
  }
  assert.equal((await facts()).record.selectedSessionId, 'session-mote', 'Fresh entry opens the primary Mote saved main Session')
  assert.equal((await facts()).record.presentation.identity.context.regionId, 'region-mote', 'Original occurrence wins over the same SID elsewhere')
  await noLifecycle()
  await capture('chat-start-primary-phone')
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Retain original draft')
  win.webContents.insertText('原草稿在重启后保留')
  await until('mobileProductScene.facts().record.conversation?.drafts.some(([,text])=>text.includes("原草稿在重启后保留"))')
  await button('Mote', '.mobile-navigation')
  await until('document.querySelectorAll(".mobile-mote-choice").length===2')
  assert.equal(await read('document.querySelectorAll(".mobile-mote-directory .mobile-space-children").length'), 0, 'Mote is not a file or Profile tree')
  for (const mode of ['dark', 'light']) for (const width of [390, 320]) {
    await read(`mobileProductScene.setAppearance(${JSON.stringify(mode)})`); await resize(width, 760)
    const geometry = await read(`Array.from(document.querySelectorAll('.mobile-mote-choice,.mobile-mote-profile-action')).map(n=>({name:n.getAttribute('aria-label'),rect:n.getBoundingClientRect().toJSON()}))`)
    assert.ok(geometry.length >= 3)
    assert.ok(geometry.every(({rect}) => rect.height >= 44 && rect.width >= 44), 'Mote and Profile retain real touch targets')
    result.operations.push({ action: 'navigation-geometry', mode, width, geometry })
    await capture(`chat-start-motes-${mode}-${width}`)
  }
  await button('查看 Mote 资料 · 我的 Mote', '.mobile-mote-selected')
  await until('!!document.querySelector(".mobile-mote-profile")')
  await capture('chat-start-profile-light-narrow')
  await button('关闭面板', '[role=dialog]')
  await button('选择 Mote · 资料协作', '.mobile-spatial-panel')
  await until('mobileProductScene.facts().record.presentation.recentMoteSpaceId==="mote-resources"')
  await capture('chat-start-secondary-light-narrow')
  await read('mobileProductScene.seedSpatialRecovery()')
  result.recoveryOriginal = (await facts()).record
  assert.equal(result.recoveryOriginal.selectedSessionId, 'session-mote')
  assert.equal(result.recoveryOriginal.presentation.showSession, false, 'Last directory is retained but startup prioritizes the original chat')
  await noLifecycle()
}
