import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

// This entry audits existing evidence. It never builds, launches a process or
// replays a historical operation; missing or stale evidence is a failing gate.
const root = resolve(import.meta.dirname, '../../..')
const option = (name, fallback) => resolve(root, process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? fallback)
const artifacts = option('--artifacts', '.bagakit/feature-tracker/features/f-3n98f7r5x/artifacts')
const books = join(artifacts, 'books'), output = option('--output', '.tmp/ebook-reading/receipt.json')
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.ebook-reading-verification.v1', passed: false, mode: 'receipt-only', evidence: [], facts: {}, limitations: [] }
receipt.verifier = { path: relative(root, import.meta.filename), sha256: sha(await readFile(import.meta.filename)) }
const bytes = path => readFile(resolve(root, path))
const json = async path => {
  const data = await bytes(path)
  receipt.evidence.push({ path: relative(root, resolve(root, path)), sha256: sha(data) })
  return JSON.parse(data.toString())
}
const current = async sources => {
  assert.ok(sources && Object.keys(sources).length, 'A source map must be nonempty')
  for (const [path, hash] of Object.entries(sources)) assert.equal(sha(await bytes(path)), hash, 'Current original source: ' + path)
}
const nativeSuccess = (report, outcome) => {
  assert.ok(report.checks > 0 && !report.failure, report.failure ?? 'Nonempty native assertions')
  assert.ok(outcome.exitCode === 0 && outcome.exitConfirmed && !outcome.timedOut, 'The exact native process must complete successfully')
}
const red = value => {
  assert.equal(value.mutationHits, 1, 'Exactly one loaded source mutation')
  assert.ok(value.mutatedSource.before !== value.mutatedSource.after, 'The loaded source really changes')
  assert.ok(value.report.checks > 0 && value.report.failure, 'The mutation reaches a business assertion')
  assert.ok(value.outcome.exitCode !== 0 && value.outcome.exitConfirmed && !value.outcome.timedOut, 'A semantic RED has a confirmed process exit')
}
try {
  assert.ok(process.argv.includes('--receipt'), 'Use --receipt; this gate consumes evidence without executing tests')
  const parser = await json(join(books, 'native-green-final.json'))
  assert.equal(Object.keys(parser.report.results).length, 16)
  assert.ok(Object.values(parser.report.results).every(value => value.checks > 0 && !value.failure))
  for (const [path, hash] of Object.entries(parser.sourceHashes)) assert.equal(sha(await bytes('packages/editor-extensions/' + path)), hash, 'Current parser fixture/source: ' + path)
  const comic = await json(join(books, 'final-mutant-comic-case.json'))
  assert.equal(comic.mutationHits, 1)
  assert.ok(comic.report.results.cbz.failure?.startsWith('No supported image files in archive'))
  assert.ok(Object.entries(comic.report.results).filter(([name]) => name !== 'cbz').every(([, value]) => value.checks > 0 && !value.failure))
  assert.ok(comic.outcome.exitConfirmed && !comic.outcome.timedOut)
  assert.notEqual(comic.mutatedSource.original, comic.mutatedSource.loaded)
  assert.equal(sha(await bytes('packages/editor-extensions/' + comic.mutatedSource.path)), comic.mutatedSource.original)

  const reader = await json(join(books, 'reader-native-final.json'))
  nativeSuccess(reader.report, reader.outcome)
  await current(reader.sourceHashes)
  const formats = ['epub', 'mobi', 'azw3', 'fb2', 'cbz', 'cbr', 'djvu']
  assert.deepEqual(Object.keys(reader.report.formats), formats)
  for (const value of Object.values(reader.report.formats)) assert.ok(value.sections > 0 && value.appPid !== value.parserPid && value.pixels.unprivileged, 'A real independent parser and unprivileged rendered document per format')
  const carry = await json(join(books, 'carry/reader-source-carry-review.json'))
  assert.equal(carry.status, 'approved-scoped')
  assert.ok(carry.completeEnumeratedMutationScope && carry.remaining.length === 0)
  await current(carry.currentSources)
  assert.deepEqual(carry.mutations.map(value => value.mutation).sort(), ['navigation', 'csp', 'reload', 'fit', 'caller', 'source-close', 'axis'].sort())
  for (const value of Object.values(carry.originalSourceRecovery)) assert.equal(sha(await bytes(value.path)), value.sha256, 'Exact historical source bytes remain available')
  for (const value of carry.mutations) {
    assert.equal(value.status, 'approved')
    assert.equal(sha(await bytes(value.originalReceipt.path)), value.originalReceipt.sha256, 'Historical RED receipt remains unchanged')
    red(await json(value.originalReceipt.path))
    const source = (await bytes(value.current.path)).toString()
    assert.equal(sha(source), value.current.sha256)
    assert.equal(source.split(value.current.anchor).length, 2)
    assert.equal(sha(source.replace(value.current.anchor, value.current.replacement)), value.current.prospectiveChangedSha256)
  }
  const illustration = await json(join(books, 'reader-mutant-illustration-final.json'))
  red(illustration)
  assert.equal(carry.freshIllustration.sha256, sha(await bytes(join(books, 'reader-mutant-illustration-final.json'))))
  assert.equal(illustration.mutatedSource.before, sha(await bytes(illustration.mutatedSource.path)))
  assert.equal(sha(await bytes(join(books, 'reader-current-illustration-source.tsx'))), illustration.mutatedSource.before)

  const nativePath = option('--native-receipt', '.tmp/file-view-reading/native-restart.json')
  const file = await json(nativePath)
  assert.equal(file.schema, 'agentmux.book-file-restart.v1')
  assert.equal(file.processes.length, 2)
  nativeSuccess(file.writer, file.processes[0]); nativeSuccess(file.reader, file.processes[1])
  assert.notEqual(file.processes[0].originalPid, file.processes[1].originalPid)
  assert.ok(file.reader.restored && file.writer.readingReceipt.position.progress > .79 && file.reader.physicalProgress > .77)
  assert.ok(file.reader.recovery.changedSourceReopened && file.reader.recovery.toolbarReload && file.reader.recovery.navigationSaved)
  assert.ok(['spatial:read', 'spatial:commit', 'ui:writeWorkbenchState', 'files:openBook', 'files:openSource'].every(key => !file.writer.hotPath[key]))
  const fileVisual = await json(join(books, 'reader-file-visual-review.json'))
  assert.equal(fileVisual.status, 'approved')
  assert.equal(fileVisual.nativeReceipt.sha256, sha(await bytes(nativePath)))
  // Vite reports these two AVIF inputs as transformed JavaScript URL modules.
  // Preserve their original values and the independent review, without calling
  // those module hashes hashes of the raw image bytes.
  const assetModules = new Set(['packages/client-ui/brand/heroes/origin-banner.avif', 'packages/client-ui/brand/heroes/origin-launch.avif'])
  assert.deepEqual(fileVisual.sourceAudit.moduleSourceExceptions.map(value => value.path).sort(), [...assetModules].sort())
  for (const item of fileVisual.sourceAudit.moduleSourceExceptions) {
    assert.equal(file.sourceHashes[item.path], item.moduleTransformSha256)
    assert.equal(sha(await bytes(item.path)), item.rawFileSha256)
  }
  for (const [path, hash] of Object.entries(file.sourceHashes)) {
    if (assetModules.has(path)) continue
    if (path === '.tmp/book-file-restart-build/host.ts') {
      assert.equal(sha(await bytes(join(books, 'restart-host-source.ts'))), hash, 'Exact generated fixture entry is archived before cache cleanup')
      continue
    }
    assert.equal(sha(await bytes(path)), hash, 'Actual File consumer source: ' + path)
  }
  assert.ok(Object.keys(file.sourceHashes).some(path => path.endsWith('/electron.mjs')), 'The original native driver is source-bound')
  const owner = await json(option('--reading-receipt', '.tmp/file-view-reading/receipt.json'))
  assert.ok(owner.passed && owner.complete && owner.baseline.passed === 16 && owner.restored.passed === 16 && owner.mutations.length === 10)
  await current(owner.sources)
  assert.equal(owner.native.sha256, sha(await bytes(nativePath)))

  const gallery = await json('.tmp/book-reader-captures/capture-receipt.json')
  const visual = await json(join(books, 'reader-visual-review.json'))
  assert.ok(visual.status === 'approved' && visual.finalApproval)
  assert.equal(gallery.frames.length, 11); assert.equal(visual.reviewedFrames.length, 11)
  for (const frame of gallery.frames) {
    assert.equal(sha(await bytes('.tmp/book-reader-captures/' + frame.name)), frame.sha256)
    assert.ok(visual.reviewedFrames.some(value => value.name === frame.name && value.sha256 === frame.sha256))
    const source = await json(frame.sourceReceipt)
    assert.ok(source.report.captures.some(value => value.name === frame.name && value.sha256 === frame.sha256))
    assert.deepEqual(frame.sourceHashes, source.sourceHashes)
  }
  assert.equal(visual.sourceCarryReview.currentSha256, sha(await bytes(visual.sourceCarryReview.path)))
  const fileGallery = await json('.tmp/book-file-captures/capture-receipt.json')
  assert.equal(fileGallery.frames.length, 2)
  for (const frame of fileGallery.frames) {
    assert.equal(sha(await bytes('.tmp/book-file-captures/' + frame.name)), frame.sha256)
    assert.ok(fileVisual.frames.some(value => value.name === frame.name && value.sha256 === frame.sha256 && value.verdict === 'approved'))
  }

  const publicCarry = await json(join(artifacts, 'public-file-consumer/carry/public-source-carry-review.json'))
  assert.ok(publicCarry.status === 'approved' && publicCarry.completePublicScope)
  await current(publicCarry.currentSources)
  assert.equal(sha(await bytes(publicCarry.originalReceipt.path)), publicCarry.originalReceipt.sha256)
  const publicReceipt = await json(publicCarry.originalReceipt.path)
  assert.ok(publicReceipt.passed && publicReceipt.mutations.length === 8)

  receipt.facts = { formats, nativeChecks: reader.report.checks, restartChecks: [file.writer.checks, file.reader.checks], processIds: file.processes.map(value => value.originalPid), readingProgress: file.reader.physicalProgress, ordinaryReadingCost: file.writer.hotPath, memberTests: 16, memberMutations: 10, readerMutations: 8, comicMutation: 1, galleryFrames: 11, fileFrames: 2, publicMutations: 8 }
  receipt.limitations = [reader.report.largeCbr.limitation, reader.report.largeFb2.limitation, 'A private targeted Electron build proves the actual File/Store/native owner chain; it is not an installed App.', 'The two named AVIF entries preserve Vite transformed-module hashes, not raw asset byte hashes. Final production assets remain the production-build gate responsibility.', 'Historical source and RED receipts are retained; seven reviewed unchanged mechanisms are carried, while the illustration mutation ran on current source.']
  receipt.passed = true
} catch (error) { receipt.failure = error.stack ?? String(error) }
await mkdir(resolve(output, '..'), { recursive: true })
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, output, facts: receipt.facts, failure: receipt.failure }))
process.exitCode = receipt.passed ? 0 : 1
