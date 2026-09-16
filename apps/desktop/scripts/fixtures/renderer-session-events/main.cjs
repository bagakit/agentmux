const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, productPreload, expectation] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.session-event-bridge-probe.v1', passed: false, pid: process.pid,
  versions: { electron: process.versions.electron, node: process.versions.node },
  mainSends: 0, coreConnected: false, userRunTouched: false,
  boundary: 'One synthetic Main event through actual product preload and actual Renderer API. No xterm, Core connection, Runtime Run, model, user input or user Home access.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, webPreferences: {
      preload: productPreload, nodeIntegration: false, contextIsolation: true, sandbox: false
    } })
    await win.loadFile(html)
    assert.equal(await win.webContents.executeJavaScript('window.bridgeProbeReady'), true)
    const dataBytes = new Uint8Array(16 * 1024).fill(65)
    win.webContents.send('agentmux:session-event', { type: 'core', hostId: 'private-host', event: {
      type: 'terminal-output', run: { runId: 'private-run-0' }, dataBytes, data: 'A'.repeat(dataBytes.byteLength),
      evidence: { source: 'terminal-output', observedAt: 1, run: { runId: 'private-run-0' },
        outputByteRange: { startByte: 0, endByte: dataBytes.byteLength } }
    } })
    result.mainSends++
    const receipt = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000
      const read = async () => {
        try {
          const value = await win.webContents.executeJavaScript('window.bridgeProbe()')
          const expectedCount = expectation === 'baseline' ? 8 : 1
          if (value.deliveries.length >= expectedCount) return resolve(value)
          if (Date.now() >= deadline) return reject(new Error('The expected public consumers did not receive the event'))
          setTimeout(read, 10)
        } catch (error) { reject(error) }
      }
      void read()
    })
    result.renderer = receipt
    assert.equal(receipt.registeredConsumers, 8)
    assert.deepEqual(receipt.errors, [])
    const indices = expectation === 'baseline' ? [0, 1, 2, 3, 4, 5, 6, 7] : [0]
    assert.deepEqual(receipt.deliveries.map(item => item.index), indices)
    assert.deepEqual(receipt.deliveries.filter(item => item.matches).map(item => item.index), [0])
    assert.deepEqual(receipt.deliveries.map(item => [item.bytes, item.first, item.last]), indices.map(() => [16 * 1024, 65, 65]))
    assert.equal(receipt.receivedBytes, 16 * 1024 * indices.length)
    assert.equal(receipt.envelopeIdentities, indices.length)
    assert.equal(receipt.typedArrayIdentities, indices.length)
    assert.equal(receipt.backingBufferIdentities, indices.length)
    await win.webContents.executeJavaScript('window.finishBridgeProbe()')
    assert.equal((await win.webContents.executeJavaScript('window.bridgeProbe()')).registeredConsumers, 0)
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    fs.writeFileSync(path.join(privateRoot, 'native-result.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
