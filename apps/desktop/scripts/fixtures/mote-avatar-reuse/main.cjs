const { app, nativeImage, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { resolve } = require('node:path')
const { createHash } = require('node:crypto')
const { rasterizeMoteAvatar } = require(process.argv[2])
const evidence = resolve(process.argv[3])
app.setPath('userData', resolve(evidence, 'user-data'))
app.disableHardwareAcceleration()
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
app.on('window-all-closed', () => {})
const created = [], windows = [], focus = []
let fault = null, active = 0, maxActive = 0
app.on('browser-window-created', (_, window) => windows.push(window.id))
app.on('browser-window-focus', (_, window) => focus.push(window.id))
app.on('web-contents-created', (_, contents) => {
  active++; maxActive = Math.max(maxActive, active)
  const preferences = contents.getLastWebPreferences()
  const record = { id: contents.id, sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration,
    persistentSession: contents.session.isPersistent(), destroyed: false, requests: [], capturePageCalled: false }
  created.push({ contents, record })
  contents.once('destroyed', () => { record.destroyed = true; active-- })
  contents.on('did-start-navigation', (_, url) => record.requests.push(new URL(url).protocol))
  const capture = contents.capturePage.bind(contents)
  contents.capturePage = (...args) => { record.capturePageCalled = true; return capture(...args) }
  if (fault === 'timeout') { fault = null; contents.executeJavaScript = () => new Promise(() => {}) }
})
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e3ede8"/><circle cx="128" cy="128" r="80" fill="#487566"/></svg>'
const result = { engine: process.versions.electron, directSvg: {}, cases: [], contents: [], windows, focus, passed: false }
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide()
  try {
    for (const [name, image] of [['createFromBuffer', nativeImage.createFromBuffer(Buffer.from(svg))], ['createFromDataURL', nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'))]]) result.directSvg[name] = { empty: image.isEmpty(), size: image.getSize() }
    const [one, two] = await Promise.all([rasterizeMoteAvatar(svg), rasterizeMoteAvatar(svg)])
    assert.deepEqual(one, two)
    assert.equal(created.length, 1, 'Identical concurrent avatar reads must share one in-flight renderer.')
    const image = nativeImage.createFromDataURL(one.dataUrl), bitmap = image.toBitmap()
    assert.deepEqual(image.getSize(), { width: 256, height: 256 })
    assert.equal(one.width, 256); assert.equal(one.height, 256)
    assert.deepEqual([...bitmap.subarray((128 * 256 + 128) * 4, (128 * 256 + 128) * 4 + 4)], [102, 117, 72, 255], 'The original SVG pixels must be drawn into the PNG.')
    assert.ok(created.every(item => item.record.destroyed && item.contents.isDestroyed()), 'Every successful export must close its exact renderer before returning.')
    await writeFile(resolve(evidence, 'avatar.png'), Buffer.from(one.dataUrl.split(',')[1], 'base64'))
    result.cases.push('draws-original-svg-and-shares-inflight')
    const { moteAvatarSvg } = require(process.argv[4])
    result.actualVectors = []
    for (const [name, choice] of [['default', null], ['icon-brain', 'brain'], ['face-rose-glasses', { kind: 'face', shape: 'soft', palette: 'rose', eyes: 'calm', brows: 'soft', mouth: 'smile', accessory: 'glasses' }]]) {
      const originalSvg = moteAvatarSvg(choice), rendered = await rasterizeMoteAvatar(originalSvg)
      const bytes = Buffer.from(rendered.dataUrl.split(',')[1], 'base64'), decoded = nativeImage.createFromBuffer(bytes), pixels = decoded.toBitmap()
      assert.deepEqual(decoded.getSize(), { width: 256, height: 256 })
      let painted = 0; for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) painted++
      assert.ok(painted > 0, 'The selected production drawing must paint pixels.')
      await writeFile(resolve(evidence, name + '.svg'), originalSvg)
      await writeFile(resolve(evidence, name + '.png'), bytes)
      result.actualVectors.push({ name, choice, pngSha256: createHash('sha256').update(bytes).digest('hex'), svgSha256: createHash('sha256').update(originalSvg).digest('hex'), paintedPixels: painted })
    }
    assert.equal(new Set(result.actualVectors.map(value => value.pngSha256)).size, 3)
    assert.ok(created.every(item => item.record.destroyed && item.contents.isDestroyed()))
    result.cases.push('actual-default-icon-and-nondefault-face-drawings')
    await Promise.all([rasterizeMoteAvatar(svg.replace('#487566', '#533545')), rasterizeMoteAvatar(svg.replace('#487566', '#254654'))])
    assert.equal(maxActive, 1, 'Different SVG exports must use at most one active renderer.')
    const failedThenHealthy = await Promise.allSettled([rasterizeMoteAvatar('not an SVG'), rasterizeMoteAvatar(svg.replace('#487566', '#193e38'))])
    assert.equal(failedThenHealthy[0].status, 'rejected')
    assert.match(failedThenHealthy[0].reason.message, /could not be decoded/)
    assert.equal(failedThenHealthy[1].status, 'fulfilled', 'A failed export must release the next queued avatar.')
    result.maxActive = maxActive
    result.cases.push('different-svg-serialization-and-failure-release')
    assert.ok(created.every(item => item.record.destroyed && item.contents.isDestroyed()), 'A decode failure must close its exact renderer.')
    result.cases.push('decode-failure-closes-renderer')
    fault = 'timeout'
    const started = performance.now()
    await assert.rejects(rasterizeMoteAvatar(svg + '\n'), /did not complete/)
    result.timeoutElapsedMs = performance.now() - started
    assert.ok(result.timeoutElapsedMs >= 9_500 && result.timeoutElapsedMs < 14_000)
    assert.ok(created.every(item => item.record.destroyed && item.contents.isDestroyed()), 'A timeout must close its exact renderer.')
    result.cases.push('bounded-export-timeout-closes-renderer')
    assert.equal(windows.length, 0); assert.equal(focus.length, 0); assert.equal(BrowserWindow.getAllWindows().length, 0)
    for (const { record } of created) {
      assert.equal(record.sandbox, true); assert.equal(record.contextIsolation, true); assert.equal(record.nodeIntegration, false)
      assert.equal(record.persistentSession, false); assert.equal(record.capturePageCalled, false)
      assert.ok(record.requests.every(protocol => protocol === 'data:'))
    }
    result.cases.push('sandbox-private-session-no-window-network-or-capture')
    result.passed = true
  } catch (error) { result.error = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    for (const { contents } of created) if (!contents.isDestroyed()) {
      const closed = new Promise(resolve => contents.once('destroyed', resolve))
      contents.close({ waitForBeforeUnload: false }); await closed
    }
    result.contents = created.map(item => item.record)
    result.cleanup = { remainingWindows: BrowserWindow.getAllWindows().length, remainingContents: created.filter(item => !item.contents.isDestroyed()).map(item => item.record.id) }
    await writeFile(resolve(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    app.quit()
  }
}).catch(async error => { await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: false, error: { name: error.name, message: error.message, stack: error.stack } }, null, 2)); app.quit() })
