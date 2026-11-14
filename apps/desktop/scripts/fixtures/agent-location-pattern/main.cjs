const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const [html, temporary, evidence] = process.argv.slice(2)
app.setPath('userData', join(temporary, 'user-data'))
app.setPath('sessionData', join(temporary, 'session-data'))
const report = { passed: false, frames: [], nativeInput: true, privatePreviewOnly: true }
let win

function evaluate(fn, ...args) {
  return win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')')
}
async function wait(fn, ...args) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(fn, ...args)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('Missing expected Renderer result: ' + fn)
}
async function key(key, code, windowsVirtualKeyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode,
      ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}) })
  }
}
async function click(selector) {
  const point = await evaluate(selector => {
    const target = document.querySelector(selector)
    if (!target) throw Error('Missing pointer target: ' + selector)
    target.scrollIntoView({ block: 'nearest' })
    const rect = target.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, selector)
  for (const type of ['mousePressed', 'mouseReleased'])
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function capture(name) {
  await evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const file = name + '.png'
  const png = (await win.webContents.capturePage()).toPNG()
  await writeFile(join(evidence, file), png)
  report.frames.push({ file, sha256: createHash('sha256').update(png).digest('hex') })
}
async function source() {
  await evaluate(() => { document.querySelector('.focus-context').focus() })
  await key('ArrowDown', 'ArrowDown', 40)
  await wait(() => Boolean(document.querySelector('.agent-information-reader__facts')))
  await click('.agent-information-reader__facts')
  await wait(() => {
    const tab = [...document.querySelectorAll('.agent-information-details__tabs button')].find(button => button.textContent === 'Source')
    if (!tab) return false
    tab.dataset.locationSourceTab = ''
    return true
  })
  await click('[data-location-source-tab]')
  await wait(() => Boolean(document.querySelector('.agent-locations')))
}
async function openPicker() {
  await click('.agent-locations')
  await wait(() => document.querySelector('.quick-switch [role=combobox]') === document.activeElement)
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { backgroundThrottling: false, sandbox: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait(() => Boolean(window.agentLocationFixture))
    await source()
    assert.equal(await evaluate(() => document.querySelector('.agent-locations').dataset.locationObservation), 'confirmed')
    assert.match(await evaluate(() => document.querySelector('.agent-information-reader__source').textContent), /Execution directory/)
    await capture('source-dark-confirmed')

    const before = await evaluate(() => agentLocationFixture.facts())
    report.before = before
    assert.equal(before.sameRun, true, 'The preview has the original Run before the first choice')
    await openPicker()
    await wait(() => document.querySelectorAll('.quick-switch__row[data-kind=location]').length === 2)
    const labels = await evaluate(() => [...document.querySelectorAll('.quick-switch__row')].map(row => row.textContent))
    assert.equal(new Set(labels).size, 2)
    await capture('same-name-choices-dark')
    await key('Escape', 'Escape', 27)
    await wait(() => !document.querySelector('.quick-switch') && document.activeElement === document.querySelector('.focus-context'))
    assert.deepEqual(await evaluate(() => agentLocationFixture.facts()), before)

    await source()
    await openPicker()
    await evaluate(() => {
      for (const row of document.querySelectorAll('.quick-switch__row'))
        if (JSON.parse(row.title).regionId === 'review-region') row.dataset.originalDestination = ''
    })
    await click('[data-original-destination]')
    await wait(() => !document.querySelector('.quick-switch') && agentLocationFixture.facts().selection?.regionId === 'review-region')
    const after = await evaluate(() => ({ ...agentLocationFixture.facts(),
      visibleTab: [...document.querySelectorAll('.workbench-tab-slot[data-workbench-tab-id="review-view"]')]
        .some(node => node.getBoundingClientRect().width > 0 && node.closest('.pane-body__region')?.dataset.active === 'true') }))
    report.after = after
    assert.equal(after.selection.tabId, 'review-view')
    assert.equal(after.selection.groupId, 'review-group')
    assert.equal(after.visibleTab, true)
    assert.equal(after.sameDrafts, true)
    assert.equal(after.sameRun, true)
    await capture('original-destination-dark')

    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 660, height: 560, deviceScaleFactor: 1, mobile: false })
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await evaluate(async () => { agentLocationFixture.setAppearance('light'); await agentLocationFixture.unavailable() })
    await source()
    assert.match(await evaluate(() => document.querySelector('.agent-locations').textContent), /Locations unconfirmed/)
    await capture('source-light-unconfirmed')
    await openPicker()
    assert.match(await evaluate(() => document.querySelector('.quick-switch').textContent), /Location sources are not confirmed/)
    await capture('chooser-light-unconfirmed')
    await key('Escape', 'Escape', 27)
    await wait(() => !document.querySelector('.quick-switch'))
    report.accepted = { labels, navigation: after.selection, originalDraft: after.sameDrafts, originalRun: after.sameRun }
    report.passed = true
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack }
  } finally {
    await writeFile(join(evidence, 'render.json'), JSON.stringify(report, null, 2))
    win?.destroy()
    app.exit(report.passed ? 0 : 1)
  }
})
