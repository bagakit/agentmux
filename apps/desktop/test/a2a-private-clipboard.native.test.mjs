import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { installPrivateA2aNativeClipboard, assertPrivateA2aClipboardWrite } from '../scripts/fixtures/a2a-inbox-product/runtime.mjs'

function fixture() {
  const calls = [], records = [], snapshots = [], result = { original: true }, response = Promise.resolve(result), failure = new Error('Original native failure')
  class NativeOwner {
    request(...args) { calls.push({ owner: this, args }); if (args[0] === 'originalFailure') throw failure; return response }
    async writeClipboardText(text) { await this.request('clipboardWrite', { format: 'text', data: text }) }
    async readClipboardText() { return await this.request('clipboardRead', { format: 'text' }) }
    async readClipboardImage() { return await this.request('clipboardRead', { format: 'png' }) }
    async writeClipboardImage(data) { return await this.request('clipboardWrite', { format: 'png', data }) }
    captureScreenshot() { return this.request('screenshotCapture', { original: true }) }
    inspectOperation(id) { return this.request('inspectOperation', { id }) }
    dispose() { return this.request('dispose') }
  }
  let persistenceFailed = false
  const native = new NativeOwner(), prototype = Object.getPrototypeOf(native)
  const preserved = ['readClipboardImage', 'writeClipboardImage', 'captureScreenshot', 'inspectOperation', 'dispose'].map(name => [name, native[name]])
  // The same serialized installer executes inside the original Main call frame.
  const install = runInNewContext('(' + installPrivateA2aNativeClipboard.toString() + ')', { Buffer })
  const installation = install({ native, ui: native, prototype, record: value => records.push(value), persist: value => { if (persistenceFailed) throw new Error('Private recorder persistence failed'); snapshots.push(JSON.parse(JSON.stringify(value))) } })
  return { native, prototype, calls, records, snapshots, result, response, failure, preserved, installation, failPersistence: () => { persistenceFailed = true } }
}

test('original native text writes record the complete value and distinct sequence without a transport acknowledgement', async () => {
  const f = fixture(), text = '原消息\n<amux>literal</amux> 🦉'
  assert.equal(await f.native.writeClipboardText(text), undefined)
  assert.equal(await f.native.writeClipboardText(text), undefined)
  assert.deepEqual(f.calls, [])
  assertPrivateA2aClipboardWrite(f.records[0], text, 0); assertPrivateA2aClipboardWrite(f.records[1], text, 1)
  assert.equal(f.records[0].byteLength, Buffer.byteLength(text))
  assert.equal(f.records[0].written, undefined); assert.equal(f.records[0].changeCount, undefined)
  assert.equal(f.snapshots.at(-1).sequence, 2); assert.equal(f.snapshots.at(-1).writes.length, 2)
})

test('native reads and clipboard image or raw transport bypasses are denied before any original request', async () => {
  const f = fixture()
  await assert.rejects(f.native.readClipboardText(), /Unexpected native clipboard read/u)
  await assert.rejects(f.native.readClipboardImage(), /transport request blocked/u)
  await assert.rejects(f.native.writeClipboardImage('private-image'), /transport request blocked/u)
  await assert.rejects(f.native.request('clipboardRead', { format: 'text' }), /transport request blocked/u)
  await assert.rejects(f.native.request('clipboardWrite', { format: 'text', data: 'must-not-write' }), /transport request blocked/u)
  assert.deepEqual(f.calls, []); assert.deepEqual(f.records, [])
  assert.equal(f.snapshots.at(-1).reads.length, 1)
  assert.deepEqual(f.snapshots.at(-1).blockedRequests.map(row => row.method), ['clipboardRead', 'clipboardWrite', 'clipboardRead', 'clipboardWrite'])
})

test('unrelated native capabilities retain their original contract even when recorder persistence fails', async () => {
  const f = fixture(), options = { original: true }, params = { id: 'original-operation' }; f.failPersistence()
  assert.equal(Object.getPrototypeOf(f.native), f.prototype)
  for (const [name, original] of f.preserved) assert.equal(f.native[name], original)
  let response
  assert.doesNotThrow(() => { response = f.native.request('inspectOperation', params, options) }, 'Unrelated native input must not depend on clipboard recorder persistence')
  assert.equal(response, f.response); assert.equal(await response, f.result)
  assert.equal(await f.native.captureScreenshot(), f.result)
  assert.equal(f.calls[0].owner, f.native); assert.equal(f.calls[0].args[1], params); assert.equal(f.calls[0].args[2], options)
  assert.equal(f.calls[1].args[0], 'screenshotCapture')
  assert.throws(() => f.native.request('originalFailure'), error => error === f.failure)
  assert.equal(f.installation.sameOriginalOwner, true); assert.equal(f.installation.sameOriginalPrototype, true)
})

test('a foreign UI owner is rejected before any native method can be replaced', () => {
  const f = fixture(), original = f.native.request
  assert.throws(() => installPrivateA2aNativeClipboard({ native: f.native, ui: {}, prototype: f.prototype }), /original macOS NativeDesktop UI owner/u)
  assert.equal(f.native.request, original)
})

test('a previous identical body or wrong private port cannot sign a fresh Copy attempt', () => {
  const value = { text: 'same body', byteLength: 9, sequence: 1, port: 'NativeDesktop.writeClipboardText', destination: 'private-recorder' }
  assert.equal(assertPrivateA2aClipboardWrite(value, value.text, 0), value)
  assert.throws(() => assertPrivateA2aClipboardWrite(value, value.text, 1), /new private native text-port write/u)
  assert.throws(() => assertPrivateA2aClipboardWrite({ ...value, port: 'electron.clipboard.writeText' }, value.text, 0), { name: 'AssertionError' })
  assert.throws(() => assertPrivateA2aClipboardWrite({ ...value, text: 'partial' }, value.text, 0), { name: 'AssertionError' })
})
