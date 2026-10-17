const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, temporary, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data'))
app.setPath('sessionData', path.join(temporary, 'session-data'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], operations: [], errors: [], console: [] }
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1080, height: 1000, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const read = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`)
  const settle = () => read(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const until = async (fn, ...args) => {
    const deadline = Date.now() + 25000
    while (!await read(fn, ...args)) { assert.ok(Date.now() < deadline, 'Expected UI state: ' + fn); await new Promise(done => setTimeout(done, 30)) }
    await settle()
  }
  const shown = async selector => {
    await until(selector => Boolean(document.querySelector(selector)), selector)
    await read(selector => document.querySelector(selector).scrollIntoView({ block: 'start' }), selector)
    await settle()
  }
  const click = async selector => {
    await shown(selector)
    const position = await read(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } }, selector)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...position })
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
    await settle()
  }
  const appearance = async (theme, width) => {
    window.setContentSize(width, 1000)
    await read(theme => window.protocolCapture.appearance(theme), theme)
    await settle()
    assert.equal(await read(() => document.documentElement.dataset.appearance), theme)
  }
  const frame = async name => {
    await settle()
    assert.equal(await read(() => document.documentElement.scrollWidth <= innerWidth), true, 'No page-wide horizontal overflow')
    await fs.writeFile(path.join(evidence, name), (await window.webContents.capturePage()).toPNG())
    result.frames.push({ file: name, ...await read(() => ({ width: innerWidth, height: innerHeight,
      scene: document.querySelector('[data-scene]').dataset.scene, appearance: document.documentElement.dataset.appearance,
      background: getComputedStyle(document.querySelector('[data-scene]')).backgroundColor })) })
  }
  const search = async text => {
    await click('[aria-label="Search settings"]')
    await read(() => document.querySelector('[aria-label="Search settings"]').select())
    window.webContents.insertText(text)
    await until(() => document.querySelector('.settings-content__header h2')?.textContent === 'Search results')
  }
  const mode = async (value, group) => {
    await read((value, group) => { if (group) window.protocolCapture.group(group); window.protocolCapture.mode(value) }, value, group)
    await until(value => document.querySelector('[data-scene]')?.dataset.scene === value, value)
    if (value !== 'settings') await until(group => document.querySelectorAll('.conversation-protocol').length === (group === 'markers' ? 3 : 2), group)
  }
  window.webContents.on('console-message', event => {
    result.console.push({ level: event.level, message: event.message })
    if (event.level === 'error') result.errors.push(event.message)
  })
  window.webContents.on('did-fail-load', (_event, code, description) => result.errors.push(`${code}: ${description}`))
  try {
    await window.loadURL(url)
    await until(() => window.protocolCapture?.ready && document.querySelectorAll('.amux-protocols__row').length === window.protocolCapture.data.catalogCount)
    await read(() => document.fonts.ready)
    assert.equal(await read(() => document.querySelectorAll('[data-protocol-example]').length), 0)
    await appearance('dark', 1080); await frame('settings-wide-dark.png')
    await appearance('light', 332); await search('A2A')
    await frame('settings-narrow-light-search.png')
    await click('[data-settings-search-result="amux-protocols:a2a"]')
    await until(() => document.activeElement?.getAttribute('data-settings-field') === 'a2a')
    await click('[data-settings-field="a2a"] > summary')
    await shown('[data-protocol-example="a2a"]')
    await frame('settings-narrow-light-expanded.png')
    await appearance('light', 1080); await search('generic')
    await click('[data-settings-search-result="amux-protocols:generic"]')
    await click('[data-settings-field="generic"] > summary')
    await shown('[data-protocol-example="generic"]')
    await frame('settings-wide-light-generic.png')
    await click('[data-settings-field="generic"] .amux-protocols__wire > summary')
    await until(() => document.querySelector('[data-settings-field="generic"] .amux-protocols__wire').open)
    assert.equal(await read(() => document.querySelector('[data-settings-field="generic"] .amux-protocols__wire pre').textContent ===
      window.protocolCapture.data.catalog.find(entry => entry.id === 'generic').examples[0].wire), true)
    await shown('[data-settings-field="generic"] .amux-protocols__wire')
    await frame('settings-wide-light-original-wire.png')
    await appearance('dark', 332)
    assert.equal(await read(() => document.querySelector('[data-settings-field="generic"] .amux-protocols__wire').open), true)
    await shown('[data-settings-field="generic"] .amux-protocols__wire')
    await frame('settings-narrow-dark-original-wire.png')
    result.operations.push({ scene: 'settings-wire', originalWireExpanded: true, originalWireExact: true,
      originalWire: await read(() => document.querySelector('[data-settings-field="generic"] .amux-protocols__wire pre').textContent) })
    await appearance('dark', 332); await search('Browser context')
    await click('[data-settings-search-result="amux-protocols:browser"]')
    await click('[data-settings-field="browser"] > summary')
    await shown('[data-protocol-example="browser"]')
    await frame('settings-narrow-dark-browser.png')
    result.operations.push({ scene: 'settings', realDirectory: true, initiallyLazy: true, trustedSearchAndExpand: true, preciseTarget: true })

    await mode('desktop', 'markers'); await appearance('dark', 1080)
    await shown('[data-protocol-kind="generic"]')
    await frame('desktop-wide-dark-markers.png')
    await read(() => document.querySelector('[data-protocol-kind="generic"] .conversation-protocol__original > summary').focus())
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await until(() => document.querySelector('[data-protocol-kind="generic"] .conversation-protocol__original').open)
    await read(() => document.querySelector('[data-protocol-kind="generic"]').closest('.log-turn').querySelector('[aria-label="Copy message"]').click())
    await until(() => window.protocolCapture.copies.at(-1) === window.protocolCapture.data.groups.markers.wires[0])
    await read(() => { document.querySelector('[data-protocol-kind="generic"] .conversation-protocol__original').open = false })
    await click('[aria-label="Reply draft"]')
    await read(() => document.querySelector('[aria-label="Reply draft"]').select())
    window.webContents.insertText('Preserve this unsent reply draft.')
    await read(() => {
      const body = document.querySelector('[data-protocol-kind="generic"] .conversation-protocol__body')
      const range = document.createRange(); range.selectNodeContents(body); getSelection().removeAllRanges(); getSelection().addRange(range)
      window.originalProtocolNode = body; window.originalProtocolSelection = getSelection().toString(); window.protocolCapture.update()
    })
    await settle()
    assert.equal(await read(() => window.originalProtocolNode === document.querySelector('[data-protocol-kind="generic"] .conversation-protocol__body') && getSelection().toString() === window.originalProtocolSelection), true)
    assert.equal(await read(() => document.querySelector('[aria-label="Reply draft"]').value), 'Preserve this unsent reply draft.')
    await read(() => getSelection().removeAllRanges())
    await appearance('light', 332); await shown('[data-protocol-kind="generic"]')
    await frame('desktop-narrow-light-markers.png')
    result.operations.push({ scene: 'desktop-markers', originalCopy: true, keyboardDisclosure: true, originalNodeAndRange: true, controlledReplyDraftPreserved: true })

    await mode('desktop', 'collaboration'); await appearance('light', 1080)
    await shown('.log-turn__declared-context')
    await frame('desktop-wide-light-collaboration.png')
    await appearance('dark', 332); await shown('[data-protocol-kind="a2a"]')
    await frame('desktop-narrow-dark-a2a.png')
    await click('.conversation-browser-context > summary')
    await until(() => document.querySelector('.conversation-browser-context').open)
    await shown('.conversation-browser-context')
    await frame('desktop-narrow-dark-browser.png')
    result.operations.push({ scene: 'desktop-collaboration', originalCoreRecords: true, context: true, browser: true, a2a: true, references: true })

    await mode('mobile', 'markers'); await appearance('dark', 390)
    await shown('[data-protocol-kind="generic"]')
    await frame('mobile-narrow-dark-markers.png')
    await mode('mobile', 'collaboration'); await appearance('light', 760)
    await shown('.log-turn__declared-context')
    await frame('mobile-wide-light-collaboration.png')
    await appearance('light', 390); await click('.conversation-browser-context > summary')
    await shown('.conversation-browser-context')
    await frame('mobile-narrow-light-browser.png')
    result.operations.push({ scene: 'mobile', actualMobileConsumer: true, originalCoreRecords: true, physicalDevice: false })
    assert.deepEqual(await read(() => window.protocolCapture.controls), [])
    assert.equal(await read(() => window.protocolCapture.reads.length > 0), true)
    result.controls = await read(() => window.protocolCapture.controls)
    result.reads = await read(() => window.protocolCapture.reads)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(await read(() => window.protocolCaptureErrors), [])
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    result.page = await read(() => ({ state: document.readyState, text: document.body.innerText.slice(0, 1000), errors: window.protocolCaptureErrors }))
    await fs.writeFile(path.join(evidence, 'failure.png'), (await window.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    window.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
