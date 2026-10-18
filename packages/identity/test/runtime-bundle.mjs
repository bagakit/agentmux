import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { bundleIdentityRuntime } from '../scripts/runtime-bundle.mjs'

test('the shared runtime recipe preserves portable ESM and isolated allocator contracts', async () => {
  const { module, source } = await bundleIdentityRuntime()
  const esm = await import('data:text/javascript,' + encodeURIComponent(module))
  assert.deepEqual(Object.keys(esm).sort(), ['mintCapabilityToken', 'mintObjectId'])
  assert.match(esm.mintObjectId(), /^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  assert.match(esm.mintCapabilityToken(), /^[1-9A-HJ-NP-Za-km-z]{43,44}$/u)

  const sizes = []
  const isolated = runInNewContext(source, { crypto: { getRandomValues(bytes) {
    sizes.push(bytes.length)
    bytes.fill(sizes.length === 1 ? 255 : sizes.length === 2 ? 0 : 1)
    return bytes
  } } })
  assert.deepEqual(Object.keys(isolated).sort(), ['mintCapabilityToken', 'mintObjectId'])
  assert.equal(isolated.mintObjectId(), '111111111111')
  assert.deepEqual(sizes, [9, 9])
  assert.match(isolated.mintCapabilityToken(), /^[1-9A-HJ-NP-Za-km-z]{43,44}$/u)
  assert.deepEqual(sizes, [9, 9, 32])
  assert.doesNotMatch(module, /\bimport\s*(?:\(|\{|['"])/u)
  assert.doesNotMatch(source, /\bimport\s*(?:\(|\{|['"])/u)
})
