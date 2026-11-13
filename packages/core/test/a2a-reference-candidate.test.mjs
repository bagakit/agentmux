import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertJoinedReferenceCandidate, assertLoadedNativeSources, assertReferenceProductCandidate, assertNativeSourcePair, nativeSourceConditions, referenceProofSha as sha } from '../scripts/lib/a2a-reference-proof.mjs'
import { idleInputMutations } from './fixtures/a2a-idle-input-proof.mjs'

function candidate(prepared = true) {
  const sources = Object.fromEntries(Array.from({ length: 40 }, (_, index) => ['packages/core/src/owner-' + index + '.ts', sha('source-' + index)]))
  const compiled = Object.fromEntries(Array.from({ length: 101 }, (_, index) => ['owner-' + index + '.js', sha('compiled-' + index)]))
  const graph = Object.fromEntries(Object.entries(compiled).map(([path, digest]) => ['dist/' + path, digest]))
  const actual = Object.fromEntries(Object.entries(compiled).map(([path, digest]) => ['packages/core/dist/' + path, digest]))
  const preparation = { kind: 'prepared-artifact', identity: { sourceCommit: 'fixed-source', sourceTree: 'fixed-tree' },
    input: { path: 'selected-input.json', sha256: sha('selected input') },
    artifact: { inventory: { sha256: sha('complete dependency inventory') } }, coreGraph: graph }
  return { delivery: { sources: { ...sources }, compiled, ...(prepared ? { preparation: structuredClone(preparation) } : {}) },
    product: { sources: prepared ? Object.fromEntries(Object.entries(sources).slice(0, 3)) : { ...sources },
      preparation: prepared ? preparation : { kind: 'source-build' }, ...(prepared ? {} : { compiled: actual }) },
    model: { passed: true, frozenCandidate: { compiledSnapshot: true }, sourceBefore: { ...sources }, compiledBefore: { ...actual }, compiledAfter: { ...actual } },
    ...(prepared ? { modelPreparation: structuredClone(preparation), fixedCoreSources: sources } : {}) }
}

test('joins independently staged prepared consumers by full graph and immutable source, with a narrow product snapshot', () => {
  const facts = candidate(), joined = assertJoinedReferenceCandidate(facts)
  assert.equal(joined.executableFiles, 101)
  assert.equal(joined.immutableCoreSources.length, 40)
  assert.equal(joined.sharedProductSources.length, 3)
})

test('retains the source-build graph and source obligations', () => {
  const facts = candidate(false)
  assert.equal(assertJoinedReferenceCandidate(facts).sharedProductSources.length, 40)
  delete facts.product.compiled['packages/core/dist/owner-0.js']
  assert.throws(() => assertJoinedReferenceCandidate(facts), assert.AssertionError)
})

test('rejects a known delivery/product mismatch before any model evidence is available', () => {
  const { delivery, product } = candidate()
  assert.equal(assertReferenceProductCandidate({ delivery, product }).expectedJs.length, 101)
  delivery.preparation.artifact.inventory.sha256 = sha('other dependencies')
  assert.throws(() => assertReferenceProductCandidate({ delivery, product }), assert.AssertionError)
})

test('rejects a prepared delivery or model mixed into source-build Desktop evidence', () => {
  for (const consumer of ['delivery', 'model']) {
    const facts = candidate(false), prepared = candidate()
    if (consumer === 'delivery') facts.delivery.preparation = prepared.delivery.preparation
    else facts.modelPreparation = prepared.modelPreparation
    assert.throws(() => assertJoinedReferenceCandidate(facts), assert.AssertionError)
  }
})

test('rejects source-build delivery mixed into prepared Desktop and model evidence', () => {
  const facts = candidate(); delete facts.delivery.preparation
  assert.throws(() => assertJoinedReferenceCandidate(facts), assert.AssertionError)
})

const drifts = [
  ['a changed model executable even when its before/after hashes agree', facts => {
    facts.model.compiledBefore['packages/core/dist/owner-0.js'] = facts.model.compiledAfter['packages/core/dist/owner-0.js'] = sha('other executable')
  }],
  ['a truncated executable graph', facts => { delete facts.model.compiledBefore['packages/core/dist/owner-0.js']; delete facts.model.compiledAfter['packages/core/dist/owner-0.js'] }],
  ['a different prepared model graph', facts => { facts.modelPreparation.coreGraph['dist/owner-0.js'] = sha('different selected graph') }],
  ['an empty executable graph shared by every consumer', facts => {
    facts.delivery.compiled = {}; facts.product.preparation.coreGraph = {}; facts.modelPreparation.coreGraph = {}
    facts.delivery.preparation.coreGraph = {}; facts.model.compiledBefore = {}; facts.model.compiledAfter = {}
  }],
  ['a different original source identity', facts => { facts.modelPreparation.identity.sourceTree = 'other-tree' }],
  ['a different explicit origin descriptor', facts => { facts.delivery.preparation.input.sha256 = sha('other input') }],
  ['a changed dependency inventory', facts => { facts.modelPreparation.artifact.inventory.sha256 = sha('other dependencies') }],
  ['a source missing from an otherwise large fixed source map', facts => { delete facts.fixedCoreSources['packages/core/src/owner-39.ts'] }],
  ['a Core export manifest missing from the immutable source join', facts => {
    facts.delivery.sources['packages/core/package.json'] = facts.model.sourceBefore['packages/core/package.json'] = sha('original exports')
  }],
  ['matching test sources that both differ from the fixed product', facts => {
    facts.delivery.sources['packages/core/src/owner-39.ts'] = facts.model.sourceBefore['packages/core/src/owner-39.ts'] = sha('different source')
  }],
  ['a narrow product snapshot that differs from its original source', facts => { facts.product.sources['packages/core/src/owner-0.ts'] = sha('different product source') }]
]
for (const [name, change] of drifts) test('rejects ' + name, () => {
  const facts = candidate(); change(facts)
  assert.throws(() => assertJoinedReferenceCandidate(facts), assert.AssertionError)
})

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

test('binds every loaded file of a fixed selection to its selected bytes and refuses one it does not hold', () => {
  const [file, before, after] = idleInputMutations[mutation], path = 'packages/core/src/' + file
  const source = 'prefix ' + before + ' suffix', edited = source.replace(before, after), helper = 'export const helper = 1\n'
  const files = new Map([[path, source], ['packages/identity/src/index.ts', helper]])
  const record = (name, text, original = text) => ({ file: name, originalSHA256: sha(original), sha256: sha(text), bytes: Buffer.byteLength(text) })
  const red = [{ ...record(path, edited, source), mutation }, record('packages/identity/src/index.ts', helper)]
  const fixed = { files, hashes: { [path]: sha(source) }, complete: true }
  assert.doesNotThrow(() => assertLoadedNativeSources(red, fixed))
  assert.throws(() => assertLoadedNativeSources([...red, record('packages/relay/src/index.ts', 'live relay')], fixed), /outside the fixed commit/u)
  assert.doesNotThrow(() => assertLoadedNativeSources([...red, record('packages/relay/src/index.ts', 'live relay')], { ...fixed, complete: false }))
  assert.throws(() => assertLoadedNativeSources([record('packages/identity/src/index.ts', 'live identity edit')], fixed), assert.AssertionError)
  assert.throws(() => assertLoadedNativeSources([{ ...red[0], bytes: red[0].bytes + 1 }], fixed), assert.AssertionError)
  assert.throws(() => assertLoadedNativeSources(red, { ...fixed, hashes: { [path]: sha('declared elsewhere') } }), assert.AssertionError)
  // A record that claims another original but compiled the selected edit is still not the selected source.
  assert.throws(() => assertLoadedNativeSources([{ ...red[0], originalSHA256: sha('live original') }], { ...fixed, hashes: {} }), assert.AssertionError)
})
