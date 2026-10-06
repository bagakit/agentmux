import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../../../..')
const artifact = await fs.realpath(path.join(root, ".local/state/mote-avatar-starter"))
const checkerPath = path.relative(root, import.meta.filename)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const expectedImages = ['starter-normal-editor.png', 'starter-tutorial-wide.png', 'starter-tutorial-narrow.png',
  'starter-created-mixed-selected.png', 'starter-create-refused-draft-kept.png']
const expectedMutants = ['starter-overwrite', 'starter-create-disconnected']
const essentialSource = ['apps/desktop/src/main/mote-avatar-series.ts', 'apps/desktop/src/main/mote-avatar-control.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/ipc-sender-trust.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', 'apps/desktop/src/renderer/src/components/MoteAvatarSeriesEditor.tsx',
  'apps/desktop/src/renderer/src/components/MoteAvatarSeriesCreateDialog.tsx', 'apps/host/src/host.ts',
  'packages/core/src/mote-avatar-series.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux.ts',
  'packages/core/dist/mote-avatar-series.js', 'packages/core/dist/public-rpc-service.js', 'packages/core/dist/agentmux-cli-commands.js',
  'apps/desktop/resources/avatar-series/lowpoly/lowpoly-owl.png', 'apps/desktop/resources/bin/agentmux-workspace-move', checkerPath]
async function bytes(file, expected) {
  const original = await fs.readFile(file)
  if (expected) assert.equal(sha(original), expected, 'Original evidence bytes changed: ' + file)
  return original
}
async function json(file, digest) { return JSON.parse(await bytes(file, digest)) }
async function bind(file) { return { path: file, sha256: sha(await bytes(file)) } }
async function capture(scope) {
  const args = ['apps/desktop/scripts/fixtures/mote-avatar-series/editor-capture.mjs', scope]
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data; process.stdout.write(data) })
  child.stderr.on('data', data => { stderr += data; process.stderr.write(data) })
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  const file = stdout.trim().split('\n').at(-1)
  assert.ok(path.isAbsolute(file ?? '') && path.dirname(file).startsWith(path.join(artifact, 'runs') + path.sep), 'Actual bounded capture must publish its own raw receipt')
  const raw = await json(file)
  assert.equal(exitCode, scope === 'starter' ? 0 : 1, stderr)
  return { raw: await bind(file), source: raw.source, compiled: raw.compiled, images: raw.images,
    renderer: await bind(path.join(raw.directory, 'renderer-result.json')) }
}
async function actualReceipt(binding) {
  assert.ok(path.isAbsolute(binding.raw.path))
  const original = await json(binding.raw.path, binding.raw.sha256)
  assert.equal(original.scope, 'starter')
  assert.equal(path.dirname(binding.raw.path), original.directory)
  assert.ok(original.directory.startsWith(path.join(artifact, 'runs') + path.sep), 'Only this bounded private artifact namespace is admitted')
  assert.deepEqual(binding.source, original.source, 'Summary must preserve the complete original raw source identities')
  assert.deepEqual(binding.compiled, original.compiled, 'Summary must preserve the actual consumed bundles')
  assert.deepEqual(binding.images, original.images, 'Summary must preserve every original screenshot name and identity')
  for (const name of essentialSource) assert.match(original.source[name] ?? '', /^[a-f0-9]{64}$/, 'A real product/source boundary is absent: ' + name)
  assert.ok(Object.keys(original.source).length >= essentialSource.length)
  for (const [name, digest] of Object.entries(original.source)) await bytes(path.resolve(root, name), digest)
  for (const name of ['editor-entry.js', 'editor-entry.css', 'production-preload.cjs', 'editor-native.cjs', 'host-entry.mjs', 'index.html'])
    assert.match(original.compiled[name] ?? '', /^[a-f0-9]{64}$/, 'Actual compiled consumer missing: ' + name)
  for (const [name, digest] of Object.entries(original.compiled)) await bytes(path.join(original.directory, 'compiled', name), digest)
  const renderer = await json(binding.renderer.path, binding.renderer.sha256)
  assert.equal(binding.renderer.path, path.join(original.directory, 'renderer-result.json'))
  assert.deepEqual(renderer, original.renderer, 'Nested receipt must match the original actual native process receipt')
  assert.equal(original.process.exitConfirmed, true); assert.equal(original.process.timedOut, false)
  assert.equal(original.process.exitSignal, null)
  assert.deepEqual(original.sourceDrift, [])
  assert.ok(renderer.operations.length > 0 && renderer.sourceCalls.length > 0 && renderer.starter.processes.length === 2,
    'Empty setup or a direct-owner-only execution cannot satisfy the product scope')
  const host = renderer.starter.processes.find(value => value.kind === 'actual-public-host')
  const main = renderer.starter.processes.find(value => value.kind === 'original-native-source')
  assert.ok(host.pid > 0 && main.pid > 0 && host.pid !== main.pid)
  assert.equal(main.socket, host.socket + '.desktop', 'The actual default public consumer must cross the original two sockets')
  assert.equal(renderer.starter.userRoot, path.join(original.directory, 'private-home/.agentmux/avatars'))
  if (renderer.starter.configBefore) await bytes(path.join(original.directory, 'config.json'), renderer.starter.configBefore)
  for (const item of [renderer.starter.guiCreated, renderer.starter.cliCreated, renderer.starter.lostAck].filter(Boolean)) {
    const folder = path.join(renderer.starter.userRoot, item.input.seriesId)
    assert.equal(item.result.path, folder)
    assert.deepEqual((await fs.readdir(folder)).sort(), Object.keys(item.files).sort(), 'All actual starter files must be bound')
    for (const [name, expected] of Object.entries(item.files)) {
      const actual = await bytes(path.join(folder, name), expected.sha256)
      assert.equal(actual.length, expected.bytes)
    }
  }
  for (const conflict of [renderer.starter.conflict, renderer.starter.guiConflict].filter(Boolean)) {
    const folder = path.join(renderer.starter.userRoot, conflict.input?.seriesId ?? conflict.seriesId)
    assert.deepEqual((await fs.readdir(folder)).sort(), Object.keys(conflict.after).sort())
    for (const [name, expected] of Object.entries(conflict.after)) {
      const actual = await bytes(path.join(folder, name), expected.sha256); assert.equal(actual.length, expected.bytes)
    }
  }
  for (const [name, digest] of Object.entries(original.images)) {
    assert.equal(path.basename(name), name, 'An image name must identify an exact file in this capture')
    const image = await bytes(path.join(original.directory, name), digest)
    assert.ok(image.length > 1000 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'A complete real PNG is required')
  }
  assert.deepEqual(renderer.images.slice().sort(), Object.keys(original.images).sort(), 'All native screenshot names must be bound')
  return original
}
function noPublication(renderer) {
  assert.equal(renderer.attemptedSaves, 0); assert.equal(renderer.saveCalls.length, 0); assert.equal(renderer.writes, 0)
  assert.equal(renderer.publications.length, 0); assert.equal(renderer.flushRequests.length, 0)
}
function productOracle(original) {
  assert.equal(original.passed, true); assert.equal(original.process.exitCode, 0); assert.equal(original.renderer.passed, true)
  assert.deepEqual(original.renderer.errors, []); noPublication(original.renderer)
  const facts = original.renderer.starter
  assert.equal(facts.initiallyMissing, true); assert.equal(facts.cancelZeroWrites, true); assert.equal(facts.publicConsumerPassed, true); assert.equal(facts.phase, 'complete')
  assert.equal(facts.addHitTarget.exact, true)
  assert.ok(original.renderer.operations.some(value => value.action === 'assert-add-center-is-original-hit' && value.exact === true))
  assert.equal(facts.guiCreated.result.state, 'created'); assert.equal(facts.cliCreated.result.state, 'created')
  for (const item of [facts.guiCreated, facts.cliCreated]) {
    assert.equal(item.result.path, path.join(facts.userRoot, item.input.seriesId))
    assert.deepEqual(item.result.files, ['starter.png', 'series.json', 'README.md'])
    assert.deepEqual(Object.keys(item.files).sort(), item.result.files.slice().sort())
    assert.ok(Object.values(item.files).every(file => file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256)))
  }
  assert.equal(facts.guiCreated.files['starter.png'].sha256, original.source['apps/desktop/resources/avatar-series/lowpoly/lowpoly-owl.png'])
  assert.equal(facts.cliCreated.files['starter.png'].sha256, facts.guiCreated.files['starter.png'].sha256)
  assert.deepEqual(facts.mixedEntriesUsable.map(value => value.kind).sort(), ['face2d', 'image'])
  assert.equal(facts.draftAfterCreate.png, facts.draftBeforeCreate.png)
  assert.ok(facts.draftAfterCreate.entries.every(value => value.active === 'false'))
  assert.deepEqual(facts.conflict.after, facts.conflict.before); assert.deepEqual(facts.guiConflict.after, facts.guiConflict.before)
  assert.equal(facts.guiConflict.draftAfter.png, facts.guiConflict.draftBefore.png)
  assert.equal(facts.lostAck.result.state, 'created'); assert.equal(facts.lostAck.ui.id, facts.lostAck.input.seriesId); assert.equal(facts.lostAck.ui.created, null)
  assert.equal(facts.lostAck.callsAfter, facts.lostAck.callsBefore + 1); assert.equal(facts.lostAck.draftAfter.png, facts.lostAck.draftBefore.png)
  assert.equal(facts.lostAck.ui.message, 'Creation was not confirmed. Check this folder before trying again.')
  assert.equal(facts.untrusted.refused, true); assert.ok(original.renderer.ipcTrust.some(value => value.trusted) && original.renderer.ipcTrust.some(value => !value.trusted))
  assert.deepEqual(facts.cliRevealed, { seriesId: facts.cliCreated.input.seriesId, path: facts.cliCreated.result.path, outcome: 'requested' })
  assert.deepEqual(original.renderer.revealCalls.map(value => value.path), [facts.guiCreated.result.path, facts.cliCreated.result.path])
  assert.equal(original.renderer.copyCalls[0].text, facts.guiCreated.result.path)
  assert.ok(facts.cli.some(value => value.args.join(' ').startsWith('space mote avatar series create --series ') && value.exitCode === 0))
  assert.ok(facts.cli.some(value => value.args.includes('preview') && value.args.at(-1) === '-'))
  assert.ok(facts.cli.some(value => value.exitCode !== 0 && value.args.includes('existing-series')))
  assert.deepEqual(Object.keys(original.images).sort(), expectedImages.slice().sort(), 'All five complete product frames are required')
  assert.deepEqual(facts.captures.map(value => value.name).sort(), expectedImages.slice().sort())
  for (const item of facts.captures) {
    assert.equal(item.sha256, original.images[item.name]); assert.ok(item.bytes > 1000); assert.equal(item.settled.remainingFinite, 0)
    assert.ok(item.size.width >= 440 && item.size.height >= 800)
  }
  assert.equal(facts.captures.find(value => value.name === 'starter-tutorial-narrow.png').facts.bodyWidth, 440)
  assert.equal(facts.captures.find(value => value.name === 'starter-normal-editor.png').facts.missingNotice.length, 0)
}
function mutationOracle(original, id, normal) {
  assert.equal(original.passed, false); assert.equal(original.process.exitCode, 1); assert.equal(original.renderer.passed, false)
  assert.equal(original.mutation.id, id); assert.equal(original.mutation.originalSha256, normal.source[original.mutation.file])
  assert.notEqual(original.mutation.originalSha256, original.mutation.effectiveSha256)
  assert.equal(original.renderer.error.code, 'ERR_ASSERTION', 'Only the intended semantic assertion may kill this mutant')
  assert.equal(original.renderer.starter.cancelZeroWrites, true); noPublication(original.renderer)
  if (id === 'starter-overwrite') {
    assert.equal(original.renderer.starter.phase, 'cli-conflict')
    assert.match(original.renderer.error.message, /real public CLI must refuse/)
    assert.ok(original.renderer.starter.cli.some(value => value.args.includes('existing-series') && value.exitCode === 0), 'Removing exclusive mkdir must produce the real forbidden success')
    assert.ok(original.renderer.createCalls.some(value => value.input.seriesId === 'existing-series' && value.value?.state === 'created'), 'The forbidden success must originate in the actual native owner')
    const conflict = original.renderer.starter.conflict
    assert.deepEqual(Object.keys(conflict.after).sort(), ['README.md', 'sentinel.bin', 'series.json', 'starter.png'])
    assert.deepEqual(conflict.after['sentinel.bin'], conflict.before['sentinel.bin'])
    assert.equal(conflict.after['starter.png'].sha256, normal.source['apps/desktop/resources/avatar-series/lowpoly/lowpoly-owl.png'])
  } else {
    assert.equal(original.renderer.starter.phase, 'gui-create')
    assert.match(original.renderer.error.message, /actual GUI creation must reach/)
    assert.equal(original.renderer.createCalls.length, 0, 'Removing the real GUI create wire must not reach the owner')
  }
}

if (process.argv.includes('--capture')) {
  await fs.mkdir(artifact, { recursive: true })
  const product = await capture('starter'), mutations = []
  const normal = await actualReceipt(product); productOracle(normal)
  for (const id of expectedMutants) {
    const binding = await capture(id); const original = await actualReceipt(binding); mutationOracle(original, id, normal)
    mutations.push({ id, ...binding })
  }
  const output = { schema: 'agentmux.mote-avatar-starter.product.v1', scope: 'starter', checker: { path: checkerPath, sha256: sha(await bytes(import.meta.filename)) },
    product, mutations, visualReview: null,
    boundary: 'Source-bound actual private GUI/default public Host/Main/CLI consumption and semantic mutants. Independent complete-image approval is still required; no installed package or live Mote operation claim.' }
  const file = path.join(artifact, 'final-product-receipt.json')
  await fs.writeFile(file, JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify({ functionalPassed: true, visualReview: 'pending', receipt: file, images: expectedImages, mutations: expectedMutants }))
} else {
  assert.ok(process.argv.includes('--recorded'), 'Choose --capture once for a frozen candidate, or --recorded FILE for the read-only final gate')
  const file = path.resolve(root, process.argv[process.argv.indexOf('--recorded') + 1])
  const summary = await json(file)
  assert.equal(summary.schema, 'agentmux.mote-avatar-starter.product.v1'); assert.equal(summary.scope, 'starter')
  assert.equal(summary.checker.path, checkerPath); await bytes(import.meta.filename, summary.checker.sha256)
  const original = await actualReceipt(summary.product); productOracle(original)
  assert.deepEqual(summary.mutations.map(value => value.id).sort(), expectedMutants.slice().sort())
  for (const mutation of summary.mutations) mutationOracle(await actualReceipt(mutation), mutation.id, original)
  assert.ok(summary.visualReview, 'Actual independent complete-image approval has not been recorded')
  const review = await json(summary.visualReview.path, summary.visualReview.sha256)
  assert.equal(review.schema, 'agentmux.mote-avatar-starter.visual-review.v1'); assert.equal(review.status, 'approved')
  assert.ok(review.reviewer && review.reviewer !== review.author); assert.equal(review.productReceiptSha256, summary.product.raw.sha256)
  await bytes(review.report.path, review.report.sha256)
  assert.deepEqual(review.images.map(value => value.name).sort(), expectedImages.slice().sort(), 'Independent review must cover every actual full-image frame')
  for (const image of review.images) {
    assert.equal(image.actuallyViewedFullImage, true); assert.equal(image.sha256, original.images[image.name])
    assert.equal(image.path, path.join(original.directory, image.name)); await bytes(image.path, image.sha256)
  }
  console.log(JSON.stringify({ passed: true, scope: 'starter', originalReceipt: summary.product.raw.path, images: expectedImages,
    mutants: expectedMutants, reviewer: review.reviewer, boundary: summary.boundary }))
}
