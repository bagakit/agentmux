import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const digest = value => createHash('sha256').update(value).digest('hex')
const exec = promisify(execFile)
export const requiredGitWorkbenchFrames = ['repository-no-implicit-selection-dark-wide', 'merge-commit-dark-wide', 'standard-message-dark-wide',
  'inline-diff-dark-wide', 'inline-diff-light-wide', 'inline-diff-dark-narrow', 'inline-diff-light-narrow',
  'manyrefs-dark-wide', 'manyrefs-light-narrow', 'empty-reference-search-light-narrow',
  'old-tip-nonstandard-message-dark-wide', 'history-unavailable-fixed-review-dark-wide',
  'history-unavailable-fixed-review-light-narrow', 'history-window-dark-scrolled', 'older-commit-located-dark',
  'locate-outside-retained-light', 'git-tools-before-restart-dark-wide',
  'git-tools-restored-before-navigation-dark-wide', 'restored-inline-and-explicit-diff-dark']

function relativeFile(root, name) {
  assert.ok(typeof name === 'string' && name && !isAbsolute(name) && !name.split(/[\\/]/u).includes('..'), 'Proof references must name an original relative file')
  const file = resolve(root, name)
  assert.ok(file.startsWith(resolve(root) + sep), 'Proof reference escaped its original root')
  return file
}
async function hashedFile(file, expected) {
  assert.match(expected ?? '', /^[0-9a-f]{64}$/u, 'Proof reference needs an exact SHA-256')
  const bytes = await readFile(file)
  assert.equal(digest(bytes), expected, 'Original proof bytes changed: ' + file)
  return bytes
}
async function absent(file) {
  await assert.rejects(lstat(file), error => error?.code === 'ENOENT', 'Private proof state was not cleaned: ' + file)
}

export async function consumeGitWorkbenchReceipt({ receiptPath, repositoryRoot, expectedRevision, expectedSourceDigest, sourceManifest }) {
  const receiptFile = resolve(repositoryRoot, receiptPath), evidence = dirname(receiptFile)
  const receiptBytes = await readFile(receiptFile), saved = JSON.parse(receiptBytes)
  assert.equal(saved.schema, 'agentmux.git-reading-surfaces.v2')
  assert.equal(saved.passed, true, 'Only a successful original native proof can be consumed')
  assert.equal(saved.failure ?? null, null)
  assert.equal(saved.expectedRevision, expectedRevision)
  assert.equal(saved.sourceRevision, expectedRevision)
  assert.equal(saved.expectedSourceDigest, expectedSourceDigest)
  const head = async () => (await exec('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.equal(await head(), expectedRevision, 'Current candidate HEAD differs from the original native proof')
  const current = await sourceManifest()
  assert.equal(current.digest, expectedSourceDigest, 'Current source manifest differs from the original native proof')
  assert.equal(saved.source?.digest, expectedSourceDigest)
  const sourceBytes = await hashedFile(relativeFile(evidence, saved.source.manifest), saved.source.manifestSha256)
  const source = JSON.parse(sourceBytes)
  assert.equal(source.head, expectedRevision); assert.equal(source.sourceDigest, expectedSourceDigest)
  assert.deepEqual({ schema: source.schema, files: source.files }, current.manifest)
  assert.equal(digest(JSON.stringify(current.manifest)), expectedSourceDigest)
  await hashedFile(relativeFile(evidence, saved.source.trackedDiff.path), saved.source.trackedDiff.sha256)
  assert.equal(source.trackedDiffSha256, saved.source.trackedDiff.sha256)
  assert.deepEqual(source.addedSources, saved.source.addedSources)
  assert.ok(Array.isArray(saved.sourceChecks) && saved.sourceChecks.length > 0)
  assert.equal(saved.sourceChecks.at(-1).label, 'after-native-restart')
  for (const check of saved.sourceChecks) {
    assert.equal(check.digest, expectedSourceDigest)
    assert.equal(check.trackedDiffSha256, saved.source.trackedDiff.sha256)
  }

  assert.ok(isAbsolute(saved.sourceRoot ?? ''), 'The original compiled candidate root must remain explicit')
  assert.ok(saved.identityBefore && Object.keys(saved.identityBefore).length > 0)
  assert.deepEqual(saved.identityAfter, saved.identityBefore)
  for (const [name, hash] of Object.entries(saved.identityBefore)) {
    const bytes = await hashedFile(relativeFile(saved.sourceRoot, name), hash)
    assert.ok(bytes.length > 0, 'Compiled/source identity cannot contain an empty file')
    if (current.manifest.files[name]?.sha256) assert.equal(hash, current.manifest.files[name].sha256)
  }
  const buildIdentityBytes = await hashedFile(relativeFile(evidence, saved.buildIdentity?.path), saved.buildIdentity?.sha256)
  const built = JSON.parse(buildIdentityBytes)
  assert.equal(built.sourceDigest, expectedSourceDigest)
  assert.deepEqual(built.files, saved.identityBefore)
  assert.deepEqual(built.builds, saved.builds)
  assert.deepEqual(saved.builds?.map(build => build.command), [
    ['pnpm', '--filter', '@agentmux/client-ui...', 'build'], ['pnpm', '--filter', '@agentmux/desktop', 'build']
  ])
  for (const build of saved.builds) {
    assert.equal(build.cwd, saved.sourceRoot); assert.equal(build.sourceDigest, expectedSourceDigest)
    assert.equal(build.exitCode, 0); assert.equal(build.signal, null)
    for (const output of [build.stdout, build.stderr]) await hashedFile(relativeFile(evidence, output.path), output.sha256)
  }
  assert.equal(built.release?.schema, 1)
  assert.deepEqual({ id: built.release.id, identity: built.release.identity, files: built.release.files }, saved.rendererRelease)
  const release = saved.rendererRelease
  assert.ok(release?.files && Object.keys(release.files).length > 0)
  assert.equal(release.id, digest(JSON.stringify({ identity: release.identity, files: Object.entries(release.files).sort() })))
  const releaseFile = 'apps/desktop/out/renderer/release.json'
  assert.ok(saved.identityBefore[releaseFile], 'The original Renderer release must be a bound compiled input')
  const originalRelease = JSON.parse(await readFile(relativeFile(saved.sourceRoot, releaseFile)))
  assert.deepEqual(originalRelease, built.release)
  assert.equal(originalRelease.id, release.id); assert.deepEqual(originalRelease.identity, release.identity); assert.deepEqual(originalRelease.files, release.files)
  for (const [name, hash] of Object.entries(release.files)) {
    const path = 'apps/desktop/out/renderer/' + name
    relativeFile(resolve(saved.sourceRoot, 'apps/desktop/out/renderer'), name)
    assert.equal(saved.identityBefore[path], hash, 'Release and original compiled identity must agree')
  }
  assert.ok(Array.isArray(saved.loadedBundles) && saved.loadedBundles.length > 0)
  for (const label of ['first', 'second']) assert.ok(saved.loadedBundles.some(bundle => bundle.label === label))
  for (const bundle of saved.loadedBundles) {
    assert.ok(Array.isArray(bundle.files) && bundle.files.length > 0)
    for (const file of bundle.files) {
      assert.ok(typeof file.path === 'string' && Object.hasOwn(saved.identityBefore, file.path), 'A loaded bundle must name a bound original file')
      assert.match(file.sha256 ?? '', /^[0-9a-f]{64}$/u)
      assert.equal(saved.identityBefore[file.path], file.sha256, 'Actual loaded bundle must belong to the original compiled identity')
    }
  }

  assert.ok(Array.isArray(saved.screenshots) && saved.screenshots.length > 0)
  const names = new Set()
  for (const frame of saved.screenshots) {
    assert.ok(isAbsolute(frame.path ?? '') && resolve(frame.path).startsWith(evidence + sep), 'A screenshot must remain inside its original evidence round')
    const name = frame.path.slice(evidence.length + 1)
    assert.ok(!names.has(name), 'Original screenshots must be uniquely addressed'); names.add(name)
    const bytes = await hashedFile(relativeFile(evidence, name), frame.sha256)
    assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Original screenshot must have a PNG header')
    assert.deepEqual(frame.dimensions, { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })
    assert.equal(frame.dimensions.width, frame.width); assert.equal(frame.dimensions.height, 900)
  }
  for (const name of requiredGitWorkbenchFrames) assert.ok(names.has(name + '.png'), 'Original required full-frame scene is missing: ' + name)

  const privateRoot = resolve(evidence, 'private')
  assert.equal(saved.runtimeAddress?.physical, resolve(privateRoot, 'runtime'))
  assert.equal(saved.cleanup?.temporaryRootRemoved, true)
  assert.deepEqual(saved.cleanup.errors, [])
  await absent(privateRoot)
  assert.ok(isAbsolute(saved.runtimeAddress?.privateRootAlias ?? ''))
  assert.equal(saved.runtimeAddress.alias, resolve(saved.runtimeAddress.privateRootAlias, 'runtime'))
  await absent(saved.runtimeAddress.privateRootAlias)
  await absent(dirname(saved.runtimeAddress.privateRootAlias))
  assert.ok(Number.isInteger(saved.first?.pid) && saved.first.pid > 1)
  assert.ok(Number.isInteger(saved.second?.pid) && saved.second.pid > 1)
  assert.notEqual(saved.first.pid, saved.second.pid)
  for (const label of ['first', 'second']) {
    assert.equal(saved[label].nativeUserData, resolve(privateRoot, 'user-data'))
    assert.equal(saved[label].nativeHome, resolve(privateRoot, 'home'))
    assert.equal(saved[label + 'Exit']?.exitCode, 0); assert.equal(saved[label + 'Exit']?.signal, null)
  }
  assert.equal(saved.quitAttempts?.length, 2)
  for (const [index, label] of ['first', 'second'].entries()) {
    const quit = saved.quitAttempts[index]
    assert.equal(quit.pid, saved[label].pid); assert.equal(quit.exitCode, 0); assert.equal(quit.signal, null)
    assert.ok(quit.actualBudgetMs > 0 && quit.elapsedMs >= 0)
  }
  assert.equal(await head(), expectedRevision, 'Candidate HEAD changed while consuming the original proof')
  assert.deepEqual(await sourceManifest(), current, 'Source changed while consuming the original proof')
  assert.equal(digest(await readFile(receiptFile)), digest(receiptBytes), 'Original receipt changed during consumption')
  return { passed: true, exactEvidenceReused: true, receipt: receiptFile, receiptSha256: digest(receiptBytes),
    expectedRevision, expectedSourceDigest, originalNativeProofRuns: 1, newNativeProofRuns: 0,
    screenshots: saved.screenshots.length, aestheticReview: saved.aestheticReview,
    boundary: 'Read-only consumption of the original candidate-bound native proof; no build, Electron launch or repeated native proof. Independent visual review is consumed separately by the integration owner.' }
}
