import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertLoadedNativeSources, assertNativeSourcePair, nativeSourceConditions, referenceProofSha as sha } from '../scripts/lib/a2a-reference-proof.mjs'
import { idleInputMutations } from './fixtures/a2a-idle-input-proof.mjs'

const mutation = 'final-input-fence-is-omitted'
const dependency = () => ({ file: 'packages/identity/src/index.ts', originalSHA256: sha('dependency'), sha256: sha('dependency'), bytes: 10 })
const owner = 'packages/core/src/prompt-submission.ts'
const target = edited => ({ file: owner, originalSHA256: sha('original owner'), sha256: sha(edited ? 'edited owner' : 'original owner'),
  bytes: Buffer.byteLength(edited ? 'edited owner' : 'original owner'), ...(edited ? { mutation } : {}) })

test('pairs historical compiler conditions while allowing exactly the declared owner mutation', () => {
  assert.doesNotThrow(() => assertNativeSourcePair([target(true), dependency()], [dependency(), target(false)], mutation))
})

test('rejects individually valid dependency versions that differ between RED and restore', () => {
  const red = [target(true), dependency()], restored = [target(false), { ...dependency(), originalSHA256: sha('new dependency'), sha256: sha('new dependency') }]
  assert.doesNotThrow(() => nativeSourceConditions(red, owner))
  assert.doesNotThrow(() => nativeSourceConditions(restored, owner))
  assert.throws(() => assertNativeSourcePair(red, restored, mutation), assert.AssertionError)
})

test('rejects missing conditions, changed non-target byte counts and multiple source versions in one run', () => {
  assert.throws(() => assertNativeSourcePair([target(true), dependency()], [target(false)], mutation), assert.AssertionError)
  assert.throws(() => assertNativeSourcePair([target(true), dependency()], [target(false), { ...dependency(), bytes: 11 }], mutation), assert.AssertionError)
  assert.throws(() => nativeSourceConditions([dependency(), { ...dependency(), originalSHA256: sha('changed'), sha256: sha('changed') }]), assert.AssertionError)
})

test('rejects undeclared compilation edits and malformed source conditions', () => {
  assert.throws(() => nativeSourceConditions([{ ...dependency(), sha256: sha('edited') }]), assert.AssertionError)
  assert.throws(() => nativeSourceConditions([{ ...dependency(), file: '../foreign.ts' }]), assert.AssertionError)
  assert.throws(() => nativeSourceConditions([{ ...dependency(), originalSHA256: 'invalid' }]), assert.AssertionError)
  assert.throws(() => nativeSourceConditions([{ ...dependency(), bytes: 0 }]), assert.AssertionError)
  assert.throws(() => nativeSourceConditions([{ ...target(true), file: 'prompt-submission.ts' }], 'prompt-submission.ts'), assert.AssertionError)
})

test('binds every loaded declared owner to its current bytes and its one declared mutation', () => {
  const [path, before, after] = idleInputMutations[mutation]
  const source = 'prefix ' + before + ' suffix', edited = source.replace(before, after)
  const record = (name, text, original = text) => ({ file: name, originalSHA256: sha(original), sha256: sha(text), bytes: Buffer.byteLength(text) })
  const red = [{ ...record(path, edited, source), mutation }, record('packages/relay/src/index.ts', 'undeclared dependency')]
  const owners = { files: new Map([[path, source]]), hashes: { [path]: sha(source) } }
  assert.doesNotThrow(() => assertLoadedNativeSources(red, owners))
  assert.throws(() => assertLoadedNativeSources([{ ...red[0], bytes: red[0].bytes + 1 }], owners), assert.AssertionError)
  assert.throws(() => assertLoadedNativeSources(red, { ...owners, hashes: { [path]: sha('declared elsewhere') } }), assert.AssertionError)
  // A record that claims another original but compiled the declared edit is still not the current owner source.
  assert.throws(() => assertLoadedNativeSources([{ ...red[0], originalSHA256: sha('live original') }], { ...owners, hashes: {} }), assert.AssertionError)
})
