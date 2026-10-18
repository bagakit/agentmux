import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { deriveObjectId, isObjectId, mintObjectId, mintCapabilityToken } from '../dist/index.js'
import * as runtime from '../dist/runtime.js'
import { identityRuntimeSource } from '../dist/runtime-source.js'

const indexUrl = new URL('../src/index.ts', import.meta.url)
const index = await readFile(indexUrl, 'utf8')

function exerciseFormat(api) {
  assert.equal(api.isObjectId('111111111111'), true)
  for (const value of ['111111111111\n', '111111111111\r', '111111111111\r\n', '11111111111', '1111111111111']) {
    assert.equal(api.isObjectId(value), false)
  }
}

function exercise(source) {
  const sizes = []
  const api = runInNewContext(source, {
    crypto: {
      getRandomValues(bytes) {
        sizes.push(bytes.length)
        // First ordinary sample overflows; the complete next sample must be used.
        bytes.fill(sizes.length === 1 ? 255 : sizes.length === 2 ? 0 : 1)
        return bytes
      },
    },
  })
  assert.equal(api.mintObjectId(), '111111111111')
  assert.deepEqual(sizes, [9, 9])
  const token = api.mintCapabilityToken()
  assert.deepEqual(sizes, [9, 9, 32])
  assert.match(token, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/u)
  assert.equal(isObjectId(token), false)
}

test('published module and isolated source consume the same allocator', async () => {
  exercise(identityRuntimeSource)
  const ids = [mintObjectId(), runtime.mintObjectId()]
  assert.ok(ids.every(isObjectId))
  assert.notEqual(ids[0], ids[1])
  assert.notEqual(mintCapabilityToken(), runtime.mintCapabilityToken())
  const module = await readFile(new URL('../dist/runtime.js', import.meta.url), 'utf8')
  assert.doesNotMatch(module, /\bimport\s*(?:\(|\{|['"])/u)
  assert.doesNotMatch(identityRuntimeSource, /\bimport\s*(?:\(|\{|['"])/u)
  assert.ok(module.length > 0 && identityRuntimeSource.length > 0)
})

test('business derivation keeps opaque keys and domains independent', () => {
  exerciseFormat({ isObjectId })
  assert.equal(deriveObjectId('object', ' a:b'), deriveObjectId('object', ' a:b'))
  assert.notEqual(deriveObjectId('object', ' a:b'), deriveObjectId('object', 'a:b'))
  assert.notEqual(deriveObjectId('object', 'a'), deriveObjectId('operation', 'a'))
  assert.ok(isObjectId(deriveObjectId('object', 'a')))
  assert.equal(isObjectId('00000000-0000-4000-8000-000000000000'), false)
})

test('actual allocator mutations fail the isolated consumer assertions', async () => {
  const mutations = [
    ['new Uint8Array(32)', 'new Uint8Array(8)'],
    ["id.length <= 12 ? id.padStart(12, '1') : null", "id.slice(0, 12).padStart(12, '1')"],
    ['new Uint8Array(9)', 'new Uint8Array(8)'],
  ]
  assert.ok(mutations.length > 0)
  for (const [before, after] of mutations) {
    assert.ok(index.includes(before), `mutation anchor missing: ${before}`)
    const result = await build({
      entryPoints: [new URL('../src/runtime-entry.ts', import.meta.url).pathname],
      bundle: true, platform: 'neutral', target: 'es2022', format: 'iife',
      globalName: 'AgentMuxIdentity', write: false, minify: true, legalComments: 'none',
      plugins: [{ name: 'allocator-mutation', setup(builder) {
        builder.onLoad({ filter: /[/\\]identity[/\\]src[/\\]index\.ts$/ }, () => ({
          contents: index.replace(before, after), loader: 'ts', resolveDir: new URL('../src/', import.meta.url).pathname,
        }))
      } }],
    })
    assert.throws(() => exercise(`(()=>{${result.outputFiles[0].text};return AgentMuxIdentity;})()`))
  }
  exercise(identityRuntimeSource)
})

test('removing the actual format boundary fails control-character consumers', async () => {
  const anchor = '{12}$/u.test(value)'
  assert.ok(index.includes(anchor))
  const result = await build({
    entryPoints: [indexUrl.pathname], bundle: true, platform: 'neutral', format: 'iife',
    globalName: 'AgentMuxIdentity', write: false, minify: true, legalComments: 'none',
    plugins: [{ name: 'format-mutation', setup(builder) {
      builder.onLoad({ filter: /[/\\]identity[/\\]src[/\\]index\.ts$/ }, () => ({
        contents: index.replace(anchor, '{12}/u.test(value)'), loader: 'ts', resolveDir: new URL('../src/', import.meta.url).pathname,
      }))
    } }],
  })
  const api = runInNewContext(`(()=>{${result.outputFiles[0].text};return AgentMuxIdentity;})()`)
  assert.throws(() => exerciseFormat(api))
  exerciseFormat({ isObjectId })
})
