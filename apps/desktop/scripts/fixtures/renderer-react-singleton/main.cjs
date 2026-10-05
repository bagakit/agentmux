const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

// Chromium switches precede these four arguments in the actual Electron argv.
const [directory, evidence, userData, variant] = process.argv.slice(-4)
const proofRoot = path.resolve(__dirname, '../../../../../.tmp/renderer-react-singleton')
for (const value of [directory, evidence, userData]) {
  assert.equal(typeof value, 'string')
  const within = path.relative(proofRoot, path.resolve(value))
  assert.ok(within && !within.startsWith('..') && !path.isAbsolute(within), 'Private fixture paths only')
}
assert.ok(['candidate', 'without-dedupe'].includes(variant))
assert.equal(evidence, path.join(directory, 'browser-receipt.json'))
assert.equal(path.dirname(userData), path.dirname(directory))
fs.mkdirSync(path.join(userData, 'session'), { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', path.join(userData, 'session'))
const receipt = { variant, cases: [], passed: false, console: [], originalAppOrRuntimeTouched: false }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let window
async function read(expression) { return window.webContents.executeJavaScript(expression) }
async function until(expression, label) {
  const end = Date.now() + 5000
  do { const value = await read(expression); if (value) return value; await delay(25) } while (Date.now() < end)
  throw new Error('Private renderer observation timed out: ' + label)
}
function nativeHookFailure(errors) {
  return errors.some(error => error.name === 'TypeError' && /null.*useMemo|useMemo.*null/u.test(error.message))
}
app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    window = new BrowserWindow({ show: false, width: 900, height: 650,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    window.webContents.on('console-message', (event) => {
      receipt.console.push({ level: event.level, message: event.message })
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const trigger of ['absolute-entry', 'linked-package']) {
      await window.loadFile(path.join(directory, 'index.html'), { query: { trigger } })
      await until('window.singletonProof && (!!document.querySelector("#original-input") || window.singletonProof.errors.length > 0)', trigger)
      if (variant === 'without-dedupe') {
        const actual = await read('window.singletonProof')
        const row = { trigger, ...actual, expectedNativeFailure: nativeHookFailure(actual.errors),
          inputMounted: await read('!!document.querySelector("#original-input")') }
        receipt.cases.push(row)
        assert.equal(row.identity.react, false, 'Same-version foreign React remains a distinct actual module')
        assert.equal(row.identity.reactDom, false, 'Foreign ReactDOM is a distinct actual module')
        assert.equal(row.expectedNativeFailure, true, 'Actual Radix provider must fail at React useMemo, not a loader or timeout')
        assert.equal(row.inputMounted, false)
        assert.deepEqual(row.actions, { split: [], confirmed: 0 })
        continue
      }
      for (const field of ['reactVersions', 'domVersions']) {
        const versions = await read('window.singletonProof.identity.' + field)
        assert.equal(versions.length, 2)
        assert.equal(typeof versions[0], 'string')
        assert.ok(versions[0].length > 0)
        assert.equal(versions[0], versions[1], 'Copied dependency must keep the actual installed version')
      }
      assert.equal(await read('window.singletonProof.identity.react'), true)
      assert.equal(await read('window.singletonProof.identity.reactDom'), true)
      await read('document.querySelector("[aria-label=\\"Choose split direction\\"]").dispatchEvent(new PointerEvent("pointerover", {bubbles:true,pointerType:"mouse"}))')
      await until('!!document.querySelector("[role=menu]")', 'original DropdownMenu opens')
      await read('Array.from(document.querySelectorAll("[role=menuitem]")).find(item => /right/i.test(item.textContent)).click()')
      await until('window.singletonProof.actions.split.length === 1 && !document.querySelector("[role=menu]")', 'original split executes once')
      await read('document.querySelector("#open-dialog").click()')
      await until('document.querySelector("[role=dialog]")?.textContent.includes("Shared React dialog")', 'original Dialog opens')
      await read('document.querySelector("[data-confirm-label=\\"Confirm once\\"]").click()')
      await until('window.singletonProof.actions.confirmed === 1 && !document.querySelector("[role=dialog]")', 'original confirm executes once')
      const actual = await read('window.singletonProof')
      const input = await read('({connected:document.querySelector("#original-input").isConnected,value:document.querySelector("#original-input").value})')
      assert.deepEqual(actual.actions, { split: ['right'], confirmed: 1 })
      assert.deepEqual(actual.errors, [])
      assert.deepEqual(input, { connected: true, value: 'retained input' })
      receipt.cases.push({ ...actual, input, originalDropdownAndDialogExercised: true })
    }
    assert.equal(receipt.cases.length, 2)
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    window?.destroy()
    fs.writeFileSync(evidence, JSON.stringify(receipt, null, 2) + '\n')
    // A qualified mutant exits 1 due to its collected actual React Hook failures.
    app.exit(receipt.passed ? variant === 'without-dedupe' ? 1 : 0 : 2)
  }
}).catch(error => { receipt.failure = { name: error.name, message: error.message }; fs.writeFileSync(evidence, JSON.stringify(receipt, null, 2)); app.exit(2) })
