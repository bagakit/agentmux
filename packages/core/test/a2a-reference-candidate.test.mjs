import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertJoinedReferenceCandidate, assertReferenceProductCandidate, referenceProofSha as sha } from '../scripts/lib/a2a-reference-proof.mjs'

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
  ['matching test sources that both differ from the fixed product', facts => {
    facts.delivery.sources['packages/core/src/owner-39.ts'] = facts.model.sourceBefore['packages/core/src/owner-39.ts'] = sha('different source')
  }],
  ['a narrow product snapshot that differs from its original source', facts => { facts.product.sources['packages/core/src/owner-0.ts'] = sha('different product source') }]
]
for (const [name, change] of drifts) test('rejects ' + name, () => {
  const facts = candidate(); change(facts)
  assert.throws(() => assertJoinedReferenceCandidate(facts), assert.AssertionError)
})
