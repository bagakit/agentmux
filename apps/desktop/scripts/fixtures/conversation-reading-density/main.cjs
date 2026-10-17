const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, temporary, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data')); app.setPath('sessionData', path.join(temporary, 'session-data'))
const result = { passed: false, frames: [], operations: [], errors: [] }
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1000, height: 960, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const read = code => window.webContents.executeJavaScript(typeof code === 'function' ? `(${code.toString()})()` : code)
  const settle = () => read(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const until = async predicate => {
    const deadline = Date.now() + 15000
    while (!await read(predicate)) { assert.ok(Date.now() < deadline, 'Expected UI state: ' + predicate); await new Promise(done => setTimeout(done, 20)) }
    await settle()
  }
  const frame = async name => { await settle(); await fs.writeFile(path.join(evidence, name), (await window.webContents.capturePage()).toPNG()); result.frames.push({ file: name }) }
  const keyboardActivate = async selector => {
    await read(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button) throw Error('Missing keyboard target'); button.scrollIntoView({block:'center'}); button.focus() })()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await settle()
  }
  const hasNoOverflow = async () => {
    assert.equal(await read(() => document.documentElement.scrollWidth <= innerWidth), true, 'No page-wide horizontal overflow')
    assert.equal(await read(() => { const previews = [...document.querySelectorAll('.conversation-reply-observation__toggle')]; return previews.length > 0 && previews.every(node => node.scrollWidth <= node.clientWidth + 1) }), true, 'Nonempty previews fit their own available width')
  }
  window.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
  try {
    await window.loadURL(url); await read(() => document.fonts.ready)
    await until(() => document.querySelector('[data-native-record-id="final-reply"] .log-turn__body'))
    await until(() => document.querySelector('[data-native-record-id="progress-two"] [data-message-continuation="true"]'))
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] .conversation-reply-observation__preview').textContent), '已完成对话记录检查。')
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] button[aria-expanded]').getAttribute('aria-expanded')), 'false')
    assert.equal(await read(() => document.querySelector('[data-native-record-id="progress-two"] .log-turn__sender-id code').textContent === window.readingDensityPreview.data.expected.sessionId), true)
    assert.equal(await read(() => document.querySelectorAll('[data-captured-reply-observation]').length), 1)
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation]').closest('.conversation-record-process') !== null), true)
    await hasNoOverflow(); await frame('desktop-wide-dark.png')
    window.setContentSize(332, 960); await settle(); await hasNoOverflow(); await frame('desktop-narrow-dark.png')
    await read(() => window.readingDensityPreview.appearance('light')); await settle(); await hasNoOverflow(); await frame('desktop-narrow-light.png')
    window.setContentSize(1000, 960); await settle(); await frame('desktop-wide-light.png')
    result.operations.push({ scene: 'desktop', actualActivityView: true, compactOriginalObservation: true, continuedExactIdentity: true, width: [1000, 332], themes: ['dark', 'light'] })

    await read(() => window.readingDensityPreview.appearance('dark'))
    await keyboardActivate('[data-captured-reply-observation] button[aria-expanded]')
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] button[aria-expanded]').getAttribute('aria-expanded')), 'true')
    await read(() => document.querySelector('[data-captured-reply-observation] [aria-label="Message details"]').click()); await settle()
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] .conversation-input-details__body').textContent.includes('Stop')), true)
    await read(() => document.querySelector('[data-captured-reply-observation] [aria-label="Copy message"]').click()); await settle()
    assert.equal(await read(() => window.readingDensityPreview.copies.at(-1) === window.readingDensityPreview.data.expected.reply), true)
    await read(() => {
      const original = document.querySelector('[data-captured-reply-observation] .log-turn__body'), range = document.createRange()
      range.selectNodeContents(original); getSelection().removeAllRanges(); getSelection().addRange(range)
      window.originalDensityNode = original; window.originalDensitySelection = getSelection().toString()
      document.querySelector('[data-captured-reply-observation]').closest('.conversation-record-process').querySelector('.wf-head').click()
    }); await settle()
    await read(() => document.querySelector('[data-captured-reply-observation]').closest('.conversation-record-process').querySelector('.wf-head').click()); await settle()
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] .log-turn__body') === window.originalDensityNode && getSelection().toString() === window.originalDensitySelection), true, 'Original DOM and Range survive process disclosure')
    const readsBefore = await read(() => window.readingDensityPreview.reads.length)
    for (let count = 0; count < 8; count++) { await read(() => window.readingDensityPreview.unrelated()); await settle() }
    assert.equal(await read(() => window.readingDensityPreview.reads.length), readsBefore, 'Unrelated host renders do not read history')
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] .log-turn__body') === window.originalDensityNode && getSelection().toString() === window.originalDensitySelection), true)
    await read(() => window.readingDensityPreview.append())
    await until(() => window.readingDensityPreview.reads.includes('readConversationChanges'))
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] .log-turn__body') === window.originalDensityNode && getSelection().toString() === window.originalDensitySelection), true, 'Original reading survives public changes')
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] button[aria-expanded]').getAttribute('aria-expanded')), 'true')
    assert.equal(await read(() => document.querySelector('[data-captured-reply-observation] .conversation-input-details__body') !== null), true)
    await read(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await settle()
    await read(() => document.querySelector('[data-captured-reply-observation]').scrollIntoView({ block: 'start' }))
    await frame('desktop-original-reading.png')
    assert.equal(await read(() => document.querySelector('[aria-label="Reply draft"]').value === window.readingDensityPreview.data.expected.draft), true)
    result.operations.push({ scene: 'original', originalCopy: true, exactInfo: true, keyboardExpand: true, processDisclosure: true, originalNodeAndRange: true, unrelatedReads: 0, publicChanges: true, detailsPreserved: true, hostDraftPreserved: true })

    await read(() => {
      document.querySelectorAll('.conversation-record-process .wf-head').forEach(button => { if (button.getAttribute('aria-expanded') !== 'true') button.click() })
    }); await settle()
    await until(() => document.querySelector('[data-native-step-id="collaboration-report"]'))
    assert.equal(await read(() => document.querySelector('[data-native-step-id="collaboration-report"] .log-row__title').textContent.includes('/root/reviewer → /root')), true, 'Collaboration summary retains the complete recorded sender → recipient pair')
    await keyboardActivate('[data-native-step-id="collaboration-report"] > button')
    assert.equal(await read(() => document.querySelector('[data-native-step-id="collaboration-report"]').textContent.includes('独立评审')), true, 'Recorded collaboration body is directly readable')
    await read(() => document.querySelector('[data-native-step-id="collaboration-report"]').scrollIntoView({ block: 'center' }))
    await frame('desktop-collaboration.png')
    result.operations.push({ scene: 'collaboration', recordedNativeScope: true, recordedSenderRecipient: true, originalMessageId: true, keyboardDisclosure: true })

    await read(() => window.readingDensityPreview.mode('mobile')); window.setContentSize(390, 960)
    await until(() => document.querySelector('.mobile-conversation [data-native-record-id="final-reply"] .log-turn__body'))
    await read(() => document.querySelector('[data-native-record-id="progress-one"]').scrollIntoView({ block: 'start' })); await settle()
    await hasNoOverflow(); await frame('mobile-dark.png')
    await keyboardActivate('[data-captured-reply-observation] button[aria-expanded]')
    await read(() => document.querySelector('[data-captured-reply-observation] [aria-label="Copy message"]').click()); await settle()
    assert.equal(await read(() => window.readingDensityPreview.copies.at(-1) === window.readingDensityPreview.data.expected.reply), true)
    await read(() => window.readingDensityPreview.appearance('light')); await settle()
    await read(() => document.querySelector('[data-captured-reply-observation]').scrollIntoView({ block: 'start' }))
    await hasNoOverflow(); await frame('mobile-original-light.png')
    assert.deepEqual(await read(() => window.readingDensityPreview.controls), [])
    result.operations.push({ scene: 'mobile', actualMobileConsumer: true, width: 390, originalCopy: true, keyboardExpand: true, themes: ['dark', 'light'], physicalDevice: false })
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    await fs.writeFile(path.join(evidence, 'failure.png'), (await window.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    window.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
