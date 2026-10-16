const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, temporary, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data')); app.setPath('sessionData', path.join(temporary, 'session-data'))
const result = { passed: false, frames: [], operations: [], errors: [] }
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1000, height: 900, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const read = code => window.webContents.executeJavaScript(typeof code === 'function' ? `(${code.toString()})()` : code)
  const settle = () => read(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const until = async predicate => {
    const deadline = Date.now() + 15000
    while (!await read(predicate)) { assert.ok(Date.now() < deadline, 'Expected UI state: ' + predicate); await new Promise(done => setTimeout(done, 20)) }
    await settle()
  }
  const frame = async name => { await settle(); await fs.writeFile(path.join(evidence, name), (await window.webContents.capturePage()).toPNG()); result.frames.push({ file: name }) }
  const toggleReminder = async () => {
    await read(() => { const summary = document.querySelector('.log-turn__reminder > summary'); summary.scrollIntoView({ block: 'center' }); summary.focus() })
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await settle()
    assert.equal(await read(() => document.querySelector('.log-turn__reminder').open), true)
  }
  window.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
  try {
    await window.loadURL(url); await read(() => document.fonts.ready)
    await until(() => document.querySelectorAll('.log-turn__reminder').length === 2)
    assert.equal(await read(() => document.querySelector('.log-turn__citation-from').textContent), 'User')
    assert.equal(await read(() => document.querySelector('.log-turn__reminder').open), false)
    await frame('desktop-wide.png')
    await toggleReminder(); await frame('desktop-reminder.png')
    await read(() => {
      const message = document.querySelector('.log-turn__citation').closest('.log-turn')
      message.querySelector('[aria-label="Copy message"]').click()
    }); await settle()
    assert.equal(await read(() => window.messageWrapperPreview.copies[0] === window.messageWrapperPreview.data.expected.first), true)
    window.setContentSize(332, 900); await settle()
    await read(() => document.querySelector('.log-turn__citation').scrollIntoView({ block: 'start' }))
    assert.equal(await read(() => document.documentElement.scrollWidth <= innerWidth), true)
    await frame('desktop-narrow.png')
    await read(() => window.messageWrapperPreview.appearance('light')); await frame('desktop-narrow-light.png')
    window.setContentSize(1000, 900); await settle(); await frame('desktop-wide-light.png')
    await read(() => window.messageWrapperPreview.appearance('dark'))
    result.operations.push({ scene: 'desktop', originalCoreRecords: true, originalCopy: true, keyboardReminder: true, narrowWidth: 332 })
    await read(() => window.messageWrapperPreview.mode('mobile')); window.setContentSize(390, 900)
    await until(() => document.querySelector('[data-scene="mobile"] .mobile-conversation .log-turn__citation'))
    await read(() => document.querySelector('.log-turn__citation').scrollIntoView({ block: 'start' }))
    await frame('mobile-conversation.png')
    await toggleReminder(); await frame('mobile-reminder.png')
    assert.equal(await read(() => document.documentElement.scrollWidth <= innerWidth), true)
    result.operations.push({ scene: 'mobile', actualMobileConsumer: true, width: 390, keyboardReminder: true, physicalDevice: false })
    await read(() => window.messageWrapperPreview.mode('desktop')); window.setContentSize(650, 900)
    await until(() => document.querySelector('.message-wrapper-preview__resource .conversation-resource-text__controls button'))
    assert.equal(await read(() => window.messageWrapperPreview.reads.filter(value => value.startsWith('resource:')).length), 0)
    await read(() => { const button = document.querySelector('.message-wrapper-preview__resource .conversation-resource-text__controls button'); button.scrollIntoView({ block: 'center' }); button.click() })
    await until(() => document.querySelector('.message-wrapper-preview__resource .log-turn__citation'))
    await read(() => document.querySelector('.message-wrapper-preview__resource').scrollIntoView({ block: 'start' }))
    await frame('complete-resource.png')
    await read(() => {
      const original = document.querySelector('.message-wrapper-preview__resource .log-turn__text strong'), range = document.createRange()
      range.selectNodeContents(original); getSelection().removeAllRanges(); getSelection().addRange(range)
      window.originalReadingNode = original; window.originalReadingSelection = getSelection().toString()
      const reminder = document.querySelector('.message-wrapper-preview__resource .log-turn__reminder'); reminder.open = true
      window.messageWrapperPreview.update()
    }); await settle()
    assert.equal(await read(() => document.querySelector('.message-wrapper-preview__resource .log-turn__text strong') === window.originalReadingNode && getSelection().toString() === window.originalReadingSelection), true)
    assert.equal(await read(() => document.querySelector('.message-wrapper-preview__resource .log-turn__reminder').open), true)
    await read(() => document.querySelector('[aria-label="Copy complete content"]').click()); await settle()
    assert.equal(await read(() => window.messageWrapperPreview.copies.at(-1) === window.messageWrapperPreview.data.expected.resource), true)
    await read(() => document.querySelector('.message-wrapper-preview__resource .log-turn__reminder').scrollIntoView({ block: 'center' }))
    await frame('resource-reading-update.png')
    assert.deepEqual(await read(() => window.messageWrapperPreview.controls), [])
    assert.equal(await read(() => document.querySelector('[aria-label="Reply draft"]').value), 'Keep the original reply draft.')
    result.operations.push({ scene: 'resource', demandRead: true, originalCopy: true, originalNodeAndRange: true, disclosurePreserved: true, draftPreserved: true })
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    await fs.writeFile(path.join(evidence, 'failure.png'), (await window.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    window.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
