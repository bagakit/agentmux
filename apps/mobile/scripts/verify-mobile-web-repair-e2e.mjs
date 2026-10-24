import assert from 'node:assert/strict'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { evidenceDirectory, repository, sha256, readJSON, readReference, checkInputs,
  checkBrowserSourceJoin, originalCLI, originalPage } from '../../host/scripts/mobile-web-evidence.mjs'

// Consume the exact completed runs. This gate does not repeat builds, tests,
// browser interaction, publication, or any original business operation.
const joined = await checkBrowserSourceJoin(), references = []
const namespace = basename(await realpath(evidenceDirectory))
function retainedPath(path, originalRoot) {
  if (path.startsWith('.local/state/mobile-web-verification/')) return path
  const suffix = path.slice((originalRoot + '/.local/state/').length)
  assert.ok(path.startsWith(originalRoot + '/.local/state/') && suffix.startsWith(namespace + '/'))
  return '.local/state/mobile-web-verification/' + suffix.slice(namespace.length + 1)
}
async function attested(path, digest, originalRoot) {
  const ref = { path: retainedPath(path, originalRoot), sha256: digest }
  const bytes = await readReference(ref); references.push(ref); return bytes
}
async function role(name) {
  const ref = joined.proof.roles[name]
  assert.ok(ref && joined.proof.references.some(item => item.path === ref.path && item.sha256 === ref.sha256))
  return JSON.parse((await readReference(ref)).toString())
}
for (const [name, schema] of [['assets-gate', 'agentmux.mobile-web-assets-gate.v1'],
  ['diagnostics-gate', 'agentmux.mobile-client-diagnostics-gate.v1']]) {
  const path = resolve(evidenceDirectory, name + '.json'), bytes = await readFile(path), gate = JSON.parse(bytes)
  assert.equal(gate.schema, schema); assert.equal(gate.browserJoin.sha256, joined.sha256)
  references.push({ path: '.local/state/mobile-web-verification/' + name + '.json', sha256: sha256(bytes) })
}

const before = originalPage(await role('preserved-before-complete'))
const after = originalPage(await role('preserved-after'))
const third = originalPage(await role('preserved-after-third'))
const attempts = before.workface.conversation.attempts
assert.ok(attempts.length > 0 && attempts.some(([, item]) => item.phase === 'unknown' && item.inputRequested === true))
assert.ok(before.image.bytes > 0 && before.image.naturalWidth > 0)
assert.equal(before.image.sha256, sha256(await readFile(resolve(repository, 'apps/mobile/src/assets/dragon.png'))))
for (const page of [after, third]) {
  assert.equal(page.sameEditor, true); assert.equal(page.url, before.url)
  assert.equal(page.editorText, before.editorText); assert.ok(page.editorText.length > 0)
  assert.deepEqual(page.image, before.image)
  assert.deepEqual(page.workface.conversation.attempts, attempts)
  assert.deepEqual(page.workface.conversation.drafts, before.workface.conversation.drafts)
}
const pending = originalPage(await role('pending-a')), current = originalPage(await role('final-c-390'))
assert.notEqual(pending.query.page.namespaceDigest, pending.query.inspection.active.digest)
assert.equal(current.query.page.namespaceDigest, current.query.inspection.active.digest)
assert.equal(current.query.loaded.producer.devicePrincipalId, pending.query.loaded.producer.devicePrincipalId)
assert.notEqual(current.query.page.documentId, pending.query.page.documentId)
const exact = originalCLI(await role('page-c-loaded'), 'app.mobile.assets.inspect')
assert.deepEqual(exact.client.loaded, current.query.loaded)
const old = originalPage(await role('old-a-retention'))
assert.equal(old.query.inspection.client.namespace, 'not-retained')
assert.equal(old.noticeDismissed, true); assert.equal(old.closed, true); assert.equal(old.sameEditor, true)
const compact = originalPage(await role('compact-c'))
assert.equal(compact.closed, true); assert.equal(compact.viewport.width, 320)
assert.equal(compact.metrics.document.scrollWidth, 320)
assert.ok(compact.metrics.close.y >= 0 && compact.metrics.close.y + compact.metrics.close.height <= compact.viewport.height)

const build = await role('build-c')
assert.equal(build.exitCode, 0); assert.deepEqual(build.sourceHashes, build.afterSourceHashes)
await checkInputs(build.sourceHashes)
assert.equal(build.buildId, current.query.page.buildId); assert.equal(build.digest, current.query.page.namespaceDigest)
const manifest = await readJSON(resolve(evidenceDirectory, 'browser-e2e-final/product-c/mobile-release.json'))
assert.equal(manifest.digest, build.digest); assert.equal(manifest.files.length, build.fileCount)
const http = await role('http-c-after')
assert.equal(http.exitCode, 0); assert.equal(http.digest, manifest.digest); assert.equal(http.buildId, manifest.buildId)
assert.equal(http.files.length, manifest.files.length); assert.ok(http.files.length > 0)
assert.equal(new Set(http.files.map(file => file.path)).size, http.files.length)
const contentNamespace = '/mobile/' + encodeURIComponent(manifest.buildId) + '/' + manifest.digest.slice(7) + '/'
assert.equal(http.root.status, 200); assert.equal(http.root.buildHeader, manifest.buildId)
assert.equal(new URL(http.root.url).pathname, contentNamespace + 'index.html')
for (const expected of manifest.files) {
  const actual = http.files.find(file => file.path === expected.path)
  assert.ok(actual); assert.equal(actual.status, 200); assert.equal(actual.bytes, expected.bytes)
  assert.equal(actual.digest, expected.digest); assert.equal(actual.buildHeader, manifest.buildId)
  assert.equal(new URL(actual.url).pathname, contentNamespace + expected.path)
}

const pointer = await readJSON(resolve(evidenceDirectory, 'ui-source-proof-ref.json'))
const originalRoot = (await readJSON(resolve(evidenceDirectory, 'ui-final-source-review.json'))).worktree
const source = JSON.parse((await attested(pointer.receipt, pointer.sha256, originalRoot)).toString())
const previous = JSON.parse((await attested(source.previous.receipt, source.previous.sha256, originalRoot)).toString())
assert.equal(source.schema, 'mobile-web-ui-source-delta-proof.v1')
assert.deepEqual(source.delta, ['apps/mobile/src/connection/MobileConnectionRoot.tsx',
  'apps/mobile/test/mobile-web.config.mts', 'apps/mobile/test/mobile-web.test.tsx'])
const cssPath = 'apps/mobile/src/mobile.css', css = await readFile(resolve(repository, cssPath), 'utf8')
const cssReview = await readJSON(resolve(evidenceDirectory, 'ui-final-css-source-review.json'))
assert.equal(cssReview.status, 'approved'); assert.equal(cssReview.source[cssPath], sha256(css))
assert.equal(css.split(cssReview.delta + '\n').length, 2)
assert.equal(sha256(css.replace(cssReview.delta + '\n', '')), source.source[cssPath])
for (const proof of [previous, source]) {
  for (const [path, digest] of Object.entries(proof.source)) {
    if (path === cssPath || proof === previous && source.delta.includes(path)) continue
    assert.equal(sha256(await readFile(resolve(repository, path))), digest, 'Exact current scoped source: ' + path)
  }
}
const mutations = []
for (const [proof, count] of [[previous, 13], [source, 14]]) {
  for (const run of proof.runs) {
    const mutant = !['baseline', 'restored'].includes(run.name)
    const log = (await attested(run.log, run.logSHA256, originalRoot)).toString()
    assert.equal(run.exitCode, mutant ? 1 : 0)
    assert.match(log, mutant ? /AssertionError/u : new RegExp('Tests\\s+' + count + ' passed'))
    const rows = (await attested(run.loaded, run.loadedSHA256, originalRoot)).toString().trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, run.loadedCount); assert.ok(rows.length > 0 && rows.length <= 32)
    for (const row of rows) assert.equal(row.originalSHA256, proof.source[row.file])
    if (mutant) {
      assert.ok(rows.some(row => row.mutation === run.name && row.loadedSHA256 !== row.originalSHA256))
      mutations.push(run.name)
    } else assert.ok(rows.every(row => row.loadedSHA256 === row.originalSHA256))
  }
}
assert.deepEqual(mutations.sort(), ['read-issue-text', 'release-real-io', 'native-controls-reporting', 'different-compiled-build',
  'remove-catalog-consumer', 'forget-original-namespace', 'build-only-current', 'native-as-phone-disconnect'].sort())
assert.equal(source.typecheck.exitCode, 0)
await attested(source.typecheck.log, source.typecheck.logSHA256, originalRoot)
const sourceReview = await readJSON(resolve(evidenceDirectory, 'ui-final-source-review.json'))
assert.equal(sourceReview.status, 'approved')
for (const [path, digest] of Object.entries(sourceReview.source_sha256)) assert.equal(digest, source.source[path])
const backendReview = await readJSON(resolve(evidenceDirectory, 'backend-final-root-review.json'))
assert.equal(backendReview.status, 'approved'); assert.deepEqual(backendReview.remainingFindings, [])
await checkInputs(backendReview.sourceHashes)
for (const ref of backendReview.references) await readReference(ref)
const visual = await readJSON(resolve(evidenceDirectory, 'ui-final-visual-review.json'))
assert.equal(visual.status, 'approved'); assert.deepEqual(visual.remaining_findings, [])
assert.equal(visual.source_css_sha256, sha256(css)); assert.equal(visual.images.length, 3)
for (const image of visual.images) {
  assert.equal(image.openedWith, 'tools.view_image'); assert.equal(image.independentlyOpened, true)
  await attested(image.path, image.sha256, originalRoot)
}
for (const name of ['ui-final-source-review', 'ui-final-css-source-review', 'ui-final-visual-review', 'backend-final-root-review']) {
  const bytes = await readFile(resolve(evidenceDirectory, name + '.json'))
  references.push({ path: '.local/state/mobile-web-verification/' + name + '.json', sha256: sha256(bytes) })
}
const receipt = { schema: 'agentmux.mobile-web-repair-gate.v1', at: Date.now(),
  verifierSHA256: sha256(await readFile(import.meta.filename)),
  browserJoin: { path: relative(repository, joined.path), sha256: joined.sha256 }, references,
  result: { loaded: current.query.loaded, originalUnknownOperations: attempts.map(([, item]) => item.operationId),
    retainedImage: before.image, sourceTests: 14, loadedMutations: mutations, visualViewports: visual.images.map(image => [image.width, image.height]) },
  boundary: 'Private official Host/Core/Main/E2EE Relay/WebKit; no current user Host update or physical phone certification.' }
await writeFile(resolve(evidenceDirectory, 'mobile-repair-gate.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: resolve(evidenceDirectory, 'mobile-repair-gate.json') }))
