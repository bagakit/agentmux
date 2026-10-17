import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { consumeGitWorkbenchReceipt, requiredGitWorkbenchFrames } from './receipt.mjs'

const exec = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'amux-git-receipt-check-'))
const repositoryRoot = join(root, 'candidate'), evidence = join(root, 'evidence'), aliasRoot = join(root, 'removed-alias')
const receiptPath = join(evidence, 'receipt.json'), inputName = 'source.mjs', input = 'export const fixture = true\n'
const checks = []
const json = value => JSON.stringify(value)
async function file(name, value) {
  await mkdir(dirname(name), { recursive: true }); await writeFile(name, value)
  return digest(value)
}
try {
  await mkdir(repositoryRoot); await mkdir(evidence)
  const git = args => exec('git', ['-C', repositoryRoot, ...args], { timeout: 10_000 })
  await git(['init', '--initial-branch=main'])
  await file(join(repositoryRoot, inputName), input)
  await git(['add', '--', inputName])
  await git(['-c', 'user.name=Receipt Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initialize private receipt verifier fixture'])
  const expectedRevision = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const sourceManifest = async () => {
    const manifest = { schema: 'agentmux.git-workbench-source.v1', files: { [inputName]: { sha256: digest(await readFile(join(repositoryRoot, inputName))) } } }
    return { digest: digest(json(manifest)), manifest }
  }
  const current = await sourceManifest(), expectedSourceDigest = current.digest
  const source = { ...current.manifest, head: expectedRevision, sourceDigest: expectedSourceDigest,
    trackedDiffSha256: digest(''), addedSources: [] }
  const manifestSha256 = await file(join(evidence, 'source-manifest.json'), json(source))
  await file(join(evidence, 'source-tracked.diff'), '')
  const builds = []
  for (const [label, target] of [['client-ui', '@agentmux/client-ui...'], ['desktop', '@agentmux/desktop']]) {
    const stdout = { path: label + '-stdout.log', sha256: await file(join(evidence, label + '-stdout.log'), 'synthetic compiler stdout\n') }
    const stderr = { path: label + '-stderr.log', sha256: await file(join(evidence, label + '-stderr.log'), '') }
    builds.push({ command: ['pnpm', '--filter', target, 'build'], cwd: repositoryRoot, sourceDigest: expectedSourceDigest, exitCode: 0, signal: null, stdout, stderr })
  }
  const rendererFiles = { 'index.html': await file(join(repositoryRoot, 'apps/desktop/out/renderer/index.html'), '<!doctype html><div>synthetic verifier fixture</div>'),
    'assets/app.js': await file(join(repositoryRoot, 'apps/desktop/out/renderer/assets/app.js'), 'void "synthetic verifier fixture";'),
    'assets/app.css': await file(join(repositoryRoot, 'apps/desktop/out/renderer/assets/app.css'), ':root{color:black}') }
  const identity = { fixture: 'synthetic-receipt-self-check-not-a-native-proof' }
  const release = { schema: 1, id: digest(json({ identity, files: Object.entries(rendererFiles).sort() })), identity, files: rendererFiles }
  const files = { [inputName]: digest(input), 'apps/desktop/out/renderer/release.json': await file(join(repositoryRoot, 'apps/desktop/out/renderer/release.json'), json(release)),
    ...Object.fromEntries(Object.entries(rendererFiles).map(([name, hash]) => ['apps/desktop/out/renderer/' + name, hash])) }
  const buildIdentity = { path: 'build-identity.json', sha256: await file(join(evidence, 'build-identity.json'), json({ sourceDigest: expectedSourceDigest, builds, files, release })) }
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(1280, 16); png.writeUInt32BE(900, 20)
  const screenshots = []
  for (const name of requiredGitWorkbenchFrames) {
    const path = join(evidence, name + '.png')
    screenshots.push({ path, sha256: await file(path, png), width: 1280, dimensions: { width: 1280, height: 900 } })
  }
  const privateRoot = join(evidence, 'private')
  const saved = { schema: 'agentmux.git-reading-surfaces.v2', passed: true, expectedRevision, sourceRevision: expectedRevision,
    expectedSourceDigest, sourceRoot: repositoryRoot, source: { digest: expectedSourceDigest, manifest: 'source-manifest.json', manifestSha256,
      trackedDiff: { path: 'source-tracked.diff', sha256: digest('') }, addedSources: [] },
    sourceChecks: [{ label: 'after-native-restart', digest: expectedSourceDigest, trackedDiffSha256: digest('') }],
    identityBefore: files, identityAfter: files, buildIdentity, builds, rendererRelease: { id: release.id, identity, files: rendererFiles },
    loadedBundles: ['first', 'second'].map(label => ({ label, files: Object.entries(files).filter(([name]) => /\.(?:js|css)$/u.test(name)).map(([path, sha256]) => ({ path, sha256 })) })), screenshots,
    runtimeAddress: { physical: join(privateRoot, 'runtime'), privateRootAlias: join(aliasRoot, 'p'), alias: join(aliasRoot, 'p/runtime') },
    cleanup: { errors: [], temporaryRootRemoved: true }, aestheticReview: 'not-performed',
    first: { pid: 101, nativeUserData: join(privateRoot, 'user-data'), nativeHome: join(privateRoot, 'home') },
    second: { pid: 102, nativeUserData: join(privateRoot, 'user-data'), nativeHome: join(privateRoot, 'home') },
    firstExit: { exitCode: 0, signal: null }, secondExit: { exitCode: 0, signal: null },
    quitAttempts: [101, 102].map(pid => ({ pid, exitCode: 0, signal: null, actualBudgetMs: 1000, elapsedMs: 1 })) }
  const options = { receiptPath, repositoryRoot, expectedRevision, expectedSourceDigest, sourceManifest }
  async function accepted(label) {
    const result = await consumeGitWorkbenchReceipt(options)
    assert.equal(result.exactEvidenceReused, true); assert.equal(result.newNativeProofRuns, 0)
    checks.push(label)
  }
  async function rejected(label, change) {
    const modified = structuredClone(saved); change(modified)
    await file(receiptPath, json(modified))
    await assert.rejects(consumeGitWorkbenchReceipt(options))
    checks.push(label)
    await file(receiptPath, json(saved))
  }
  await file(receiptPath, json(saved)); await accepted('exact-proof-shape')
  for (const [label, change] of [
    ['failed-proof', value => { value.passed = false }],
    ['wrong-candidate', value => { value.expectedRevision = '0'.repeat(40) }],
    ['wrong-source-digest', value => { value.expectedSourceDigest = '0'.repeat(64) }],
    ['no-compiled-identity', value => { value.identityBefore = {}; value.identityAfter = {} }],
    ['no-build-log-set', value => { value.builds = [] }],
    ['no-loaded-bundles', value => { value.loadedBundles = [] }],
    ['empty-loaded-bundle-identity', value => { value.loadedBundles[0].files = [{}] }],
    ['no-screenshots', value => { value.screenshots = [] }],
    ['missing-scene', value => { value.screenshots = value.screenshots.slice(1) }],
    ['bad-screenshot-hash', value => { value.screenshots[0].sha256 = '0'.repeat(64) }],
    ['escaped-screenshot-reference', value => { value.screenshots[0].path = join(root, 'outside.png') }],
    ['bad-source-manifest-hash', value => { value.source.manifestSha256 = '0'.repeat(64) }],
    ['bad-build-identity-hash', value => { value.buildIdentity.sha256 = '0'.repeat(64) }],
    ['incomplete-cleanup', value => { value.cleanup.temporaryRootRemoved = false }],
    ['cleanup-errors', value => { value.cleanup.errors = ['owned process remains'] }],
    ['same-process', value => { value.second.pid = value.first.pid }],
    ['killed-process', value => { value.firstExit.signal = 'SIGTERM' }],
    ['escaped-log-reference', value => { value.builds[0].stdout.path = '../outside.log' }]
  ]) await rejected(label, change)
  for (const [label, path, bytes] of [
    ['changed-compiled-bytes', join(repositoryRoot, 'apps/desktop/out/renderer/assets/app.js'), 'changed compiled bytes'],
    ['changed-log-bytes', join(evidence, 'client-ui-stdout.log'), 'changed log bytes'],
    ['changed-image-bytes', screenshots[0].path, 'changed image bytes'],
    ['changed-current-source', join(repositoryRoot, inputName), 'changed current source']
  ]) {
    const original = await readFile(path); await file(path, bytes)
    await assert.rejects(consumeGitWorkbenchReceipt(options)); checks.push(label)
    await file(path, original)
  }
  for (const [label, path] of [['missing-compiled-file', join(repositoryRoot, 'apps/desktop/out/renderer/assets/app.js')],
    ['missing-screenshot', screenshots[0].path]]) {
    const original = await readFile(path); await rm(path)
    await assert.rejects(consumeGitWorkbenchReceipt(options)); checks.push(label)
    await file(path, original)
  }
  await git(['-c', 'user.name=Receipt Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Move private receipt fixture HEAD'])
  await assert.rejects(consumeGitWorkbenchReceipt(options)); checks.push('changed-current-head')
  await git(['update-ref', 'refs/heads/main', expectedRevision])
  let sourceReads = 0
  await assert.rejects(consumeGitWorkbenchReceipt({ ...options, sourceManifest: async () => {
    if (++sourceReads === 2) await file(join(repositoryRoot, inputName), 'changed while consuming')
    return sourceManifest()
  } }))
  checks.push('source-changes-during-consumption'); await file(join(repositoryRoot, inputName), input)
  sourceReads = 0
  await assert.rejects(consumeGitWorkbenchReceipt({ ...options, sourceManifest: async () => {
    if (++sourceReads === 2) await file(receiptPath, json({ ...saved, changedDuringConsumption: true }))
    return sourceManifest()
  } }))
  checks.push('receipt-changes-during-consumption'); await file(receiptPath, json(saved))
  await mkdir(privateRoot)
  await assert.rejects(consumeGitWorkbenchReceipt(options)); checks.push('private-state-still-present')
  await rm(privateRoot, { recursive: true })
  await mkdir(aliasRoot)
  await assert.rejects(consumeGitWorkbenchReceipt(options)); checks.push('socket-alias-root-still-present')
  await rm(aliasRoot, { recursive: true })
  await accepted('original-proof-still-readable-after-rejections')
  const script = resolve(import.meta.dirname, '../../verify-git-workbench.mjs')
  const realRoot = resolve(import.meta.dirname, '../../../../..')
  const actualHead = (await exec('git', ['-C', realRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  let rejectedEntry
  try {
    await exec(process.execPath, [script, '--candidate', actualHead, '--source-digest', '0'.repeat(64)],
      { env: { ...process.env, AGENTMUX_GIT_WORKBENCH_RECEIPT: join(root, 'missing-receipt.json') }, timeout: 20_000 })
  } catch (error) { rejectedEntry = error }
  assert.equal(rejectedEntry?.code, 1)
  const refused = JSON.parse(rejectedEntry.stdout)
  assert.equal(refused.passed, false); assert.equal(refused.fallback, 'disabled'); assert.equal(refused.newNativeProofRuns, 0)
  checks.push('explicit-cli-refusal-without-fallback')
  console.log(JSON.stringify({ passed: true, checks, scope: 'Synthetic verifier self-check and explicit refusal only. No native proof, build, Renderer, user App or aesthetic result is produced.' }))
} finally {
  await rm(root, { recursive: true, force: true })
}
