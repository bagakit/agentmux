const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
module.exports = async ({ win, read, until, resize, tap, button, capture, result, evidence }) => {
  const editor = '.mobile-conversation [contenteditable=true]'
  await read('mobileProductScene.prepareDensity();mobileProductScene.prepareWebUpdate()')
  await until('!!document.querySelector(".mobile-web-update-notice:not([hidden])")')
  await button('Focus', '.mobile-navigation'); await button('实验建议', '.mobile-focus-project')
  await until(`!!document.querySelector(${JSON.stringify(editor)})`)
  await tap(editor, 'Original draft editor'); win.webContents.insertText('更新网页前保留这份草稿。')
  const original = await read('mobileProductScene.facts().record.selectedSessionId')
  const picked = path.join(evidence, 'selected-picture.png')
  await fs.copyFile(path.resolve(__dirname, '../../../../../apps/desktop/resources/icon-128.png'), picked)
  await win.webContents.debugger.sendCommand('Page.enable')
  await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
  let listener
  const chooser = new Promise(resolve => { listener = (_event, method, params) => {
    if (method === 'Page.fileChooserOpened') { win.webContents.debugger.removeListener('message', listener); resolve(params) }
  }; win.webContents.debugger.on('message', listener) })
  await tap('.mobile-conversation [aria-label="Reference files for the Agent to read"]', 'Choose original local image')
  const opened = await Promise.race([chooser, new Promise((_, reject) => setTimeout(() => reject(Error('Original file chooser did not open')), 5000))])
  await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { backendNodeId: opened.backendNodeId, files: [picked] })
  await until('!!document.querySelector(".mobile-attachment[data-phase=selected]")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await capture(`web-update-notice-${width}-${appearance}`)
    assert.ok(await read(`document.querySelector(${JSON.stringify(editor)}).textContent.includes('保留这份草稿')`))
  }
  await tap('.mobile-web-update-notice .mobile-notice__dismiss', 'Dismiss available update')
  assert.equal(await read('!!document.querySelector(".mobile-web-update-notice")'), false)
  await button('手机设置与连接')
  await until('!!document.querySelector(".mobile-web-update-settings")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-web-update-settings").scrollIntoView({block:"center"})')
    await capture(`web-update-settings-${width}-${appearance}`)
  }
  await button('载入最新版', '.mobile-web-update-settings')
  await until('document.querySelector(".mobile-web-update-settings")?.textContent.includes("所选附件仅保存在当前页面")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-web-update-settings").scrollIntoView({block:"center"})')
    await capture(`web-update-blocked-${width}-${appearance}`)
  }
  await button('关闭面板', '[role=dialog]')
  assert.ok(await read(`document.querySelector(${JSON.stringify(editor)}).textContent.includes('保留这份草稿')`))
  assert.equal(await read('!!document.querySelector(".mobile-attachment[data-phase=selected]")'), true)
  await button('移除 selected-picture.png 本地引用')
  await read(`(()=>{window.originalDeviceSetItem = Storage.prototype.setItem; window.failedDeviceWrite = false; Storage.prototype.setItem = function(key, value) { if (key === 'agentmux-mobile-workface-v1') { window.failedDeviceWrite = true; throw Error('Controlled device write unavailable') } return window.originalDeviceSetItem.call(this, key, value) }; return true})()`)
  await tap(editor, 'Edit original draft during controlled device write failure')
  win.webContents.insertText('！')
  await until('window.failedDeviceWrite')
  await read('(()=>{Storage.prototype.setItem = window.originalDeviceSetItem; return true})()')
  await button('手机设置与连接')
  await until('!!document.querySelector(".mobile-web-update-settings")')
  await button('载入最新版', '.mobile-web-update-settings')
  await until('document.querySelector(".mobile-web-update-settings")?.textContent.includes("尚未确认保存在设备")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-web-update-settings").scrollIntoView({block:"center"})')
    await capture(`web-update-storage-${width}-${appearance}`)
  }
  await button('关闭面板', '[role=dialog]')
  assert.ok(await read(`document.querySelector(${JSON.stringify(editor)}).textContent.includes('保留这份草稿')`))
  const final = await read('mobileProductScene.facts()')
  assert.equal(final.record.selectedSessionId, original)
  assert.equal(final.calls.filter(call => ['file.upload', 'sdk.submitAgentPrompt', 'sdk.ensureAgentContinuity'].includes(call.method)).length, 0)
  result.webUpdateBoundary = 'Actual MobileApp, real safety provider and local File owner with controlled exact page/Host observation and connection; no live Host, device, reload, physical phone or OS keyboard claim.'
}
