import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { launchPrivateA2aProof } from './lib/a2a-private-model-proof.mjs'
import { referenceProofSha as sha, verifyReferenceDeliveryProof } from './lib/a2a-reference-proof.mjs'

const sourceInputs = ['packages/core/bin/amux', 'packages/core/bin/agentmux-hook.js', ...[
  'index', 'client', 'agent-capability', 'agent-global-message-queue', 'agent-message-journal', 'agent-message-query',
  'agent-message-notification', 'agent-message-notifications', 'ctxmux-run-adapter', 'agent-message-render', 'agent-outbound-message', 'agent-messaging-guidance',
  'agentmux', 'agentmux-cli-commands', 'agentmux-cli-help', 'agentmux-cli-module-skills', 'agent-skills', 'agent-self-context',
  'agent-session-identity', 'agent-session-registry', 'agent-session-store', 'prompt-submission', 'prompt-submission-record',
  'public-rpc', 'public-rpc-client', 'public-rpc-server', 'public-rpc-service', 'rpc-native-codec', 'runtime-paths',
  'providers/codex', 'providers/codex-native-input', 'providers/codex-native-rpc', 'providers/codex-managed-run',
  'providers/codex-managed-frontend', 'providers/codex-session-status', 'providers/codex-prompt-execution-evidence'
].map(name => `packages/core/src/${name}.ts`),
  'packages/core/scripts/verify-a2a-reference-agent-flow.mjs', 'packages/core/scripts/lib/a2a-private-model-proof.mjs', 'packages/core/scripts/lib/a2a-reference-proof.mjs',
  'packages/core/scripts/fixtures/a2a-reference-agent/coordinator.mjs',
  ...['peer', 'process', 'native-evidence'].map(name => `packages/core/scripts/fixtures/a2a-agent-behavior/${name}.mjs`)]

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--prepare-only')
const prepareOnly = args.length === 1, json = async path => JSON.parse(await readFile(path, 'utf8'))
async function readingProof() {
  // The bare owning command validates retained tests, loaded source, product bytes
  // and the independent image review. It does not prepare or rerun the scene.
  const result = await promisify(execFile)(process.execPath, [join(root, 'apps/desktop/scripts/verify-a2a-reference-reading.mjs')], { cwd: root, maxBuffer: 1024 * 1024 })
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).passed, true)
  const index = await json(join(root, '.tmp/a2a-reference-reading/current.json')), receiptBytes = await readFile(join(root, index.path))
  assert.equal(sha(receiptBytes), index.sha256)
  const receipt = JSON.parse(receiptBytes), productBytes = await readFile(receipt.product.path)
  assert.equal(sha(productBytes), receipt.product.sha256)
  const product = JSON.parse(productBytes), reviewBytes = await readFile(product.reviewPath)
  return { index, receipt, product, productSHA256: sha(productBytes), reviewSHA256: sha(reviewBytes) }
}

/** Joined evidence binds executable bytes and original source facts, never Git ancestry alone. */
function assertJoinedReferenceCandidate({ delivery, product, model }) {
  assert.equal(model.passed, true); assert.equal(model.frozenCandidate.compiledSnapshot, true)
  assert.deepEqual(model.compiledBefore, model.compiledAfter)
  const expectedJs = Object.keys(delivery.compiled).map(file => 'packages/core/dist/' + file).sort()
  assert.deepEqual(Object.keys(model.compiledBefore).sort(), expectedJs, 'One exact model executable graph')
  assert.deepEqual(Object.keys(product.compiled).filter(file => file.startsWith('packages/core/dist/') && file.endsWith('.js')).sort(), expectedJs, 'One exact Desktop Core executable graph')
  const sharedSources = Object.keys(delivery.sources).filter(path => path in model.sourceBefore)
  assert.ok(sharedSources.length >= 20)
  for (const path of sharedSources) assert.equal(model.sourceBefore[path], delivery.sources[path], 'Model original source candidate: ' + path)
  for (const [file, digest] of Object.entries(delivery.compiled)) {
    assert.equal(model.compiledBefore['packages/core/dist/' + file], digest, 'Model actual executable candidate: ' + file)
    assert.equal(product.compiled['packages/core/dist/' + file], digest, 'Desktop actual Core executable candidate: ' + file)
  }
  const productSources = Object.keys(delivery.sources).filter(path => path in product.sources)
  assert.ok(productSources.length >= 15)
  for (const path of productSources) assert.equal(product.sources[path], delivery.sources[path], 'Desktop original source candidate: ' + path)
  const modelProductSources = Object.keys(model.sourceBefore).filter(path => path in product.sources)
  assert.ok(modelProductSources.length >= 30)
  for (const path of modelProductSources) assert.equal(product.sources[path], model.sourceBefore[path], 'One original model and Desktop source: ' + path)
  return { sharedModelProductSources: modelProductSources, sharedModelSources: sharedSources, sharedProductSources: productSources, executableFiles: Object.keys(delivery.compiled).length }
}

const delivery = prepareOnly ? null : await verifyReferenceDeliveryProof({ root })
const reading = prepareOnly ? null : await readingProof()
const modelResult = await launchPrivateA2aProof({
  repository: root, sourceInputs,
  coordinatorEntry: join(import.meta.dirname, 'fixtures/a2a-reference-agent/coordinator.mjs'),
  freezeCandidate: true, name: 'a2a-reference-agent-flow', schema: 'agentmux.a2a-reference-agent-launcher.v1',
  scenario: 'idle-reference-native-discovery', model: process.env.AGENTMUX_A2A_REFERENCE_MODEL || 'gpt-6.1-sol',
  prepareOnly, privatePrefix: 'amr-', requiredFlags: ['--no-daemon', 'app-server', '--remote']
})

if (!prepareOnly) {
  assert.equal(modelResult.passed, true)
  const model = await json(modelResult.launcher), actual = await json(modelResult.receipt)
  assert.equal(actual.passed, true); assert.equal(actual.finiteSample, true); assert.equal(actual.completeFeatureCoverage, false)
  assert.equal(model.cleanup.privateRootRemoved, true); assert.deepEqual(model.cleanup.errors, [])
  assert.equal(model.redaction.credentialValueFound, false)
  const finalDelivery = await verifyReferenceDeliveryProof({ root }), finalReading = await readingProof()
  assert.equal(finalDelivery.sha256, delivery.sha256); assert.deepEqual(finalReading.index, reading.index)
  const candidate = assertJoinedReferenceCandidate({ delivery, product: reading.product, model })
  const changedSource = structuredClone(model); changedSource.sourceBefore['packages/core/src/client.ts'] = '0'.repeat(64)
  assert.throws(() => assertJoinedReferenceCandidate({ delivery, product: reading.product, model: changedSource }))
  const oldModel = structuredClone(model); oldModel.compiledBefore['packages/core/dist/client.js'] = '0'.repeat(64); oldModel.compiledAfter['packages/core/dist/client.js'] = '0'.repeat(64)
  assert.throws(() => assertJoinedReferenceCandidate({ delivery, product: reading.product, model: oldModel }))
  await assert.rejects(verifyReferenceDeliveryProof({ root, index: { path: delivery.artifactIndex, sha256: '0'.repeat(64) } }))
  const joined = join(dirname(modelResult.receipt), 'joined.json')
  await writeFile(joined, JSON.stringify({ schema: 'agentmux.a2a-reference-joined-proof.v1', passed: true, finiteModelSample: true,
    delivery: { receipt: delivery.receipt, artifactIndex: delivery.artifactIndex, sha256: delivery.sha256, cases: delivery.cases, compiledMutants: delivery.compiledMutants, nativeSourceMutants: delivery.nativeSourceMutants, reopen: delivery.reopen, sameIdleUnknown: delivery.sameIdleUnknown },
    reading: { ...reading.index, productSHA256: reading.productSHA256, independentReviewSHA256: reading.reviewSHA256, productPath: reading.receipt.product.path, reviewPath: reading.product.reviewPath },
    model: { receipt: modelResult.receipt, receiptSHA256: sha(await readFile(modelResult.receipt)), launcher: modelResult.launcher, launcherSHA256: sha(await readFile(modelResult.launcher)) }, candidate,
    evidenceGuards: ['changed original source rejected', 'old model executable rejected', 'changed artifact digest rejected'],
    boundary: 'Consumes the exact existing Core/Provider and reading/product/image-review evidence. Reopen proves the original Core notification owner and Run, not a new whole-App restart contract. Model adoption remains one finite actual sample.' }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, completeFeatureCoverage: false, joined }) + '\n')
}
