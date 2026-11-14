import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { unzipSync, zipSync } from 'fflate'
import { dirname, join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert.ok(args.every((arg, i) => ['--case', '--fresh', '--record'].includes(arg) || i > 0 && ['--case', '--record'].includes(args[i - 1])), 'Use --case install [--fresh | --record FILE].')
const selected = args[args.indexOf('--case') + 1]
assert.equal(selected, 'install', 'Update is a separate Task.')
assert.ok(!(args.includes('--fresh') && args.includes('--record')), 'Prepare fresh or record explicitly selected existing proof.')
const common = resolve(repo, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim())
const area = join(dirname(common), '.local/browser-daily-p0p1/t001')
const indexPath = join(area, 'index.json'), reviewPath = join(area, 'visual-review.json')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = async path => sha(await readFile(path))
const generated = 'packages/core/src/generated/agentmux-guides.ts'
const view = 'apps/desktop/src/renderer/src/components/settings/BrowserProfileExtensions.tsx'
// Only test producers may be read from exact retained original bytes. Current GUI proof
// and verification inputs remain current-source bound; this is not a product drift exemption.
const historicalProducers = [
  'apps/desktop/scripts/verify-browser-profile-extensions-native.mjs',
  'apps/desktop/scripts/fixtures/browser-profile-extensions/main.ts',
  'apps/desktop/scripts/fixtures/browser-profile-extensions/online-install.ts',
  'apps/desktop/scripts/fixtures/browser-profile-extensions/renderer.tsx'
]
const extras = ['apps/desktop/scripts/verify-browser-profile-extension-online.mjs', 'packages/core/guides/modules/browser.md', 'packages/core/scripts/generate-guides.mjs', 'apps/desktop/package.json', 'pnpm-lock.yaml']
const variants = {
  'skip-manifest-hash': { kind: 'skip-declared-manifest-package-hash', oracle: 'A standard manifest digest mismatch must not become an installable review' },
  'hold-profile-lock': { kind: 'restore-configuration-lock-around-acquisition', oracle: 'Profile metadata must complete while the real acquisition response is still open' }
}
async function artifacts(directory, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(result, await artifacts(directory, path))
    else if (entry.isFile()) result[path] = await fileHash(join(directory, path))
  }
  return result
}
function browserModule(code) {
  // Exact current generator literal encoding, not page text or user presentation.
  const match = /^export const guideModulesBrowser: GuideDocument<"modules\/browser"> = \{ id: "modules\/browser", text: ("(?:[^"\\]|\\.)*") \}$/m.exec(code)
  assert.ok(match, 'The original generated Browser guide literal must exist')
  return JSON.parse(match[1])
}
function presentedCopy(code) {
  return code.replace('Extension saved. Native load is reported separately below.', 'Extension saved. Load status is shown with the installed item.')
    .replace('{entry.source.label} · {entry.source.kind.toUpperCase()}', '{entry.source.label}')
}
async function archived(record, path, digest) {
  const reference = record.archivedSources[path]
  assert.equal(reference.sha256, digest, 'Retained original source identity: ' + path)
  const bytes = await readFile(reference.path)
  assert.equal(sha(bytes), digest, 'Retained original source bytes: ' + path)
  return bytes
}
async function checkSources(record, index, historical = false) {
  const derived = []
  for (const [path, expected] of Object.entries(record.sources)) {
    const bytes = await readFile(resolve(repo, path)), actual = sha(bytes)
    if (actual === expected) continue
    if (path === generated) {
      const original = await archived(record, path, expected)
      const before = browserModule(original.toString()), after = browserModule(bytes.toString())
      assert.equal(after, before, 'The tested Browser guide module remains exact')
      execFileSync(process.execPath, [join(repo, 'packages/core/scripts/generate-guides.mjs'), '--check'], { cwd: repo, stdio: 'pipe' })
      derived.push({ path, before: expected, after: actual, browserModuleSha256: sha(before), boundary: 'Only the generated Browser module is reused; current generator --check passed.' })
    } else if (historical && historicalProducers.includes(path)) {
      await archived(record, path, expected)
      assert.equal(await fileHash(join(repo, path)), index.currentProducers[path], 'Current GUI producer identity: ' + path)
      derived.push({ path, before: expected, after: actual, boundary: 'Original test producer bytes retained; current GUI producer checked separately.' })
    } else if (historical && path === view) {
      const original = await archived(record, path, expected)
      assert.equal(presentedCopy(original.toString()), bytes.toString(), 'Exactly the two reviewed presentation strings; no control delta')
      assert.deepEqual(index.presentationDelta, { path, before: expected, after: actual })
      derived.push({ ...index.presentationDelta, boundary: 'Exactly two presentation strings; current GUI Native proof and independent review required.' })
    } else assert.equal(actual, expected, 'Consumed product source drift: ' + path)
  }
  return derived
}
async function checkRecord(record) {
  assert.equal(await fileHash(record.receipt), record.receiptSha256, 'Original Native receipt')
  assert.equal(record.artifactStorage, 'zip-original-bytes', 'Explicit archived artifact owner')
  const bytes = await readFile(record.artifactArchive.path)
  assert.equal(sha(bytes), record.artifactArchive.sha256, 'Original compiled/evidence archive')
  const files = unzipSync(bytes)
  assert.deepEqual(Object.keys(files).sort(), Object.keys(record.artifacts).sort(), 'Exact nonempty archive entry set')
  for (const [path, expected] of Object.entries(record.artifacts)) assert.equal(sha(files[path]), expected, 'Compiled/evidence artifact: ' + path)
  const receipt = JSON.parse(await readFile(record.receipt, 'utf8'))
  assert.equal(sha(files['receipt.json']), record.receiptSha256)
  assert.deepEqual(receipt.sources, record.sources, 'Source map is the original receipt map')
  assert.ok(Object.keys(record.artifacts).length > 5, 'Nonempty compiled/evidence set')
  for (const [path, digest] of Object.entries(receipt.bundles)) assert.equal(sha(files[path]), digest, 'Original compiled bundle identity')
  assert.deepEqual(receipt.sourceDrift, [])
  assert.ok(Object.keys(receipt.sources).length > 50)
  assert.ok(receipt.processes.length > 0)
  for (const process of receipt.processes) { assert.equal(process.exitConfirmed, true); assert.equal(process.timedOut, false); assert.deepEqual(process.remaining, []) }
  assert.equal(receipt.cleanup.privateHomeRemoved, true)
  const json = name => files[name] ? JSON.parse(Buffer.from(files[name]).toString()) : null
  return { receipt, first: json('first.json'), second: json('second.json') }
}
async function verify(index, visual = true) {
  assert.equal(index.case, selected)
  for (const [path, expected] of Object.entries(index.extraSources)) assert.equal(await fileHash(join(repo, path)), expected, 'Verification input drift: ' + path)
  const { receipt: native, first, second } = await checkRecord(index.native)
  assert.equal(native.passed, true); assert.equal(native.processes.length, 2)
  assert.ok(first.cases.length > 0 && second.cases.length > 0)
  assert.notEqual(first.pid, second.pid)
  assert.ok(first.cases.some(item => item.metadataCompletedBeforeResponseRelease === true))
  assert.equal(second.cases[0].extensionId, first.retained.extensionId)
  const derived = await checkSources(index.native, index, true)
  for (const [variant, expected] of Object.entries(variants)) {
    const record = index.mutations[variant], { receipt: rejected, first: facts } = await checkRecord(record)
    assert.equal(rejected.passed, false); assert.equal(rejected.productionMutation.kind, expected.kind)
    assert.ok(facts.failure?.message.includes(expected.oracle), 'Exact production business counterexample, not infrastructure failure')
    derived.push(...await checkSources(record, index, true))
  }
  const { receipt: ui, first: uiFacts } = await checkRecord(index.ui)
  assert.equal(ui.passed, true); assert.equal(ui.case, 'online-ui'); assert.equal(ui.processes.length, 1)
  assert.ok(uiFacts.cases.some(item => item.kind === 'current-production-GUI-presentation-and-original-Theme-runtime'))
  await checkSources(index.ui, index)
  if (visual) {
    const review = JSON.parse(await readFile(reviewPath, 'utf8'))
    assert.equal(review.verdict, 'approved', 'Independent actual-image review')
    if (index.presentationDelta) assert.deepEqual(review.presentationDelta, index.presentationDelta, 'Review binds exactly two presentation strings')
    for (const [path, expected] of Object.entries(index.images)) {
      assert.equal(await fileHash(path), expected)
      assert.ok(review.images.some(image => resolve(image.path) === resolve(path) && image.sha256 === expected), 'Review binds exact current PNG: ' + path)
    }
  }
  return { passed: true, case: selected, sourceRoot: repo, recordedSourceRoot: index.sourceRoot, index: indexPath, nativeReceipt: index.native.receipt, currentGUIReceipt: index.ui.receipt, visualReview: reviewPath, derived, appLaunched: false,
    boundary: 'Original public CLI/Profile/component/preload/IPC/Native and two bearing mutations. Current GUI tested separately after exactly two copy changes and fixture Theme-runtime initialization. Host confirmation fixture is not a person clicking the production dialog; full Desktop/Run journey is a separate integration.' }
}
async function recordReceipt(path, storage) {
  path = resolve(path)
  assert.ok(path.startsWith(join(area, 'native') + '/'), 'Select a scoped, already-ended original Native receipt')
  const receipt = JSON.parse(await readFile(path, 'utf8')), directory = dirname(path)
  const record = { receipt: path, receiptSha256: await fileHash(path), directory, sources: receipt.sources, artifacts: await artifacts(directory), archivedSources: {} }
  for (const name of [...historicalProducers, view, generated]) {
    const expected = receipt.sources[name]
    if (!expected) continue
    const destination = join(storage, expected)
    let bytes
    if (await fileHash(join(repo, name)) === expected) bytes = await readFile(join(repo, name))
    else bytes = await readFile(join(area, 'control-source-archive', expected))
    assert.equal(sha(bytes), expected)
    await writeFile(destination, bytes)
    record.archivedSources[name] = { path: destination, sha256: expected }
  }
  const files = Object.fromEntries(await Promise.all(Object.keys(record.artifacts).map(async name => [name, await readFile(join(directory, name))])))
  const zipped = zipSync(files, { level: 6 }), archive = join(storage, record.receiptSha256 + '-artifacts.zip')
  await writeFile(archive, zipped)
  record.artifactStorage = 'zip-original-bytes'
  record.artifactArchive = { path: archive, sha256: sha(zipped), boundary: 'Original receipt/artifact byte set archived without modifying historical receipts; expanded compiled caches may be removed after qualification.' }
  return record
}
async function execute(variant, run) {
  const env = { ...process.env, EXTENSIONS_CASE: variant === 'ui' ? 'online-ui' : 'online-install', EXTENSIONS_OUTPUT_ROOT: join(area, 'native') }
  delete env.EXTENSIONS_RESULT_MUTATION; delete env.EXTENSIONS_ONLINE_MUTATION
  if (variants[variant]) env.EXTENSIONS_ONLINE_MUTATION = variant
  let output = ''
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(repo, 'apps/desktop/scripts/verify-browser-profile-extensions-native.mjs')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; process.stdout.write(bytes) })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal }))
  })
  await writeFile(join(run, variant + '.log'), output)
  assert.equal(result.signal, null); assert.equal(result.code, variants[variant] ? 1 : 0)
  const final = output.trim().split('\n').reverse().map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => typeof value?.passed === 'boolean' && typeof value?.receipt === 'string')
  assert.ok(final, 'Original Native runner receipt, without replay on failure')
  return final.receipt
}
async function recordCompleted(path, storage, run, variant, retire) {
  const record = await recordReceipt(path, storage)
  // The original receipt, process completion and every archived byte are checked
  // before removing only this ended variant's reproducible compiled products.
  await checkRecord(record)
  if (retire) {
    const compiled = ['main.mjs', 'cli.mjs', 'preload.cjs', 'core', 'renderer']
    for (const name of compiled) await rm(join(record.directory, name), { recursive: true, force: true })
    await writeFile(join(run, variant + '-compiled-cleanup.json'), JSON.stringify({
      receipt: record.receipt, receiptSha256: record.receiptSha256, archive: record.artifactArchive,
      removed: compiled.map(name => join(record.directory, name)),
      boundary: 'Original ended private processes and complete archived byte set verified before exact compiled-product cleanup. Receipts, logs and images remain.'
    }, null, 2) + '\n')
  }
  return record
}
if (!args.includes('--fresh') && !args.includes('--record')) {
  try { console.log(JSON.stringify(await verify(JSON.parse(await readFile(indexPath, 'utf8'))))) }
  catch (error) { console.error(JSON.stringify({ passed: false, case: selected, index: indexPath, cacheMismatch: error.message, appLaunched: false, action: 'No App launched. Preserve original proof; --fresh only for an explicitly requested new candidate.' })); process.exitCode = 1 }
} else {
  await mkdir(join(area, 'native'), { recursive: true })
  const run = await mkdtemp(join(area, 'qualification-')), storage = join(run, 'original-sources')
  await mkdir(storage)
  for (const [path, name] of [[indexPath, 'previous-index.json'], [reviewPath, 'previous-visual-review.json']]) {
    try { await writeFile(join(run, name), await readFile(path)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const fresh = args.includes('--fresh')
  const inputs = fresh ? null : JSON.parse(await readFile(resolve(args[args.indexOf('--record') + 1]), 'utf8'))
  const native = await recordCompleted(fresh ? await execute('native', run) : inputs.native, storage, run, 'native', fresh), mutations = {}
  for (const variant of Object.keys(variants)) mutations[variant] = await recordCompleted(fresh ? await execute(variant, run) : inputs.mutations[variant], storage, run, variant, fresh)
  const ui = await recordCompleted(fresh ? await execute('ui', run) : inputs.ui, storage, run, 'ui', fresh)
  const images = Object.fromEntries(await Promise.all(['first-online-source.png', 'first-online-review.png', 'first-online-installed.png'].map(async name => { const path = join(ui.directory, name); return [path, await fileHash(path)] })))
  const old = native.sources[view], current = await fileHash(join(repo, view))
  const index = { schema: 'agentmux.profile-extension-online.proof.v2', case: selected, sourceRoot: repo, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), native, mutations, ui, images, visualReview: reviewPath,
    currentProducers: Object.fromEntries(await Promise.all(historicalProducers.map(async path => [path, await fileHash(join(repo, path))]))),
    extraSources: Object.fromEntries(await Promise.all(extras.map(async path => [path, await fileHash(join(repo, path))]))),
    ...(old !== current ? { presentationDelta: { path: view, before: old, after: current } } : {}) }
  await verify(index, false)
  await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n')
  console.log(JSON.stringify({ prepared: true, index: indexPath, appLaunched: args.includes('--fresh'), nativePassed: true, bearingMutationsRejected: Object.keys(mutations), currentGUIReceipt: ui.receipt, visualReviewRequired: reviewPath }))
}
