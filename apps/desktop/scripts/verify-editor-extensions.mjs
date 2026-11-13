import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

// Join existing, source-bound proofs for the admitted candidate. Building,
// capturing and independent review are explicit producer operations.
const root = resolve(import.meta.dirname, '../../..')
const artifacts = resolve(root, process.argv.find(value => value.startsWith('--artifacts='))?.slice(12) ?? '.bagakit/feature-tracker/features/f-3n98f7r5x/artifacts')
const integration = join(artifacts, 'integration')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.editor-extensions-integration.v1', passed: false, evidence: [], limitations: [] }
const read = async path => {
  const bytes = await readFile(path)
  receipt.evidence.push({ path: relative(root, path), sha256: sha(bytes) })
  return JSON.parse(bytes)
}
const current = async sources => {
  assert.ok(sources && Object.keys(sources).length, 'Nonempty original source identities')
  for (const [path, digest] of Object.entries(sources)) assert.equal(sha(await readFile(resolve(root, path))), digest, 'Current source: ' + path)
}
const consume = (script, args) => {
  const child = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  assert.equal(child.status, 0, child.stderr || child.stdout)
}
try {
  assert.ok(process.argv.includes('--receipt'), 'Use --receipt to consume the existing proofs.')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  receipt.candidate = git('rev-parse', 'HEAD')
  git('merge-base', '--is-ancestor', receipt.candidate, 'main')
  assert.equal(git('diff', '--name-only', 'HEAD'), '', 'Accepted source is committed.')
  const plan = JSON.parse(await readFile(join(artifacts, '../tasks.json')))
  for (const id of ['T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-008']) {
    const task = plan.tasks.find(value => value.id === id)
    assert.ok(task?.status === 'done' && task.gate_result === 'pass' && task.last_gate_commands.length > 0 && task.last_gate_commands.every(value => value.status === 'pass'), 'Accepted slice: ' + id)
  }
  const graph = await read(join(integration, 'production-bundle.json'))
  assert.ok(graph.passed)
  git('merge-base', '--is-ancestor', graph.candidate.head, receipt.candidate)
  await current(graph.sources)
  assert.equal(graph.startup.eagerFormatEngines.length, 0)
  assert.equal(graph.bookReader.djvuWasm.length, 2)
  for (const name of ['rebase-review.json', 'source-reading-carry.json']) {
    const review = await read(join(integration, name))
    assert.equal(review.status, 'approved')
    await current(review.currentSources)
  }
  const catalog = await read(join(integration, 'catalog-final/receipt.json'))
  assert.ok(catalog.passed && catalog.tests > 0 && catalog.catalogBytes < 32768 && catalog.mutation.loaded && catalog.restored)
  const previews = await read(join(integration, 'previews-final/receipt.json'))
  assert.ok(previews.passed && previews.tests >= 141 && previews.mutation.loaded && previews.restored)
  const pages = await read(join(integration, 'page-decoders-final/receipt.json'))
  assert.ok(pages.passed && pages.mutations.length === 7 && pages.cleanup === 'confirmed')
  await current(pages.sources)
  const pdf = await read(join(artifacts, 'file-sources/overlap/summary.json'))
  assert.ok(pdf.passed && pdf.reads.firstFrameBytes > 0 && pdf.reads.firstFrameBytes < pdf.reads.fileBytes && pdf.reads.idleByteGrowth === 0 && pdf.reads.hiddenReadGrowth === 0)
  consume('apps/desktop/scripts/verify-ebook-reading.mjs', ['--receipt', '--artifacts=' + artifacts])
  consume('apps/desktop/scripts/verify-workspace-media-playback.mjs', ['--receipt', '--output=' + join(integration, 'media')])
  const books = await read(join(root, '.tmp/ebook-reading/receipt.json'))
  const media = await read(join(integration, 'media/capture-receipt.json'))
  assert.ok(books.passed && media.passed && media.processes.length === 2 && media.frames.length === 12)
  receipt.facts = { catalogBytes: catalog.catalogBytes, previewTests: previews.tests, startup: graph.startup, books: books.facts,
    media: media.processes.map(value => ({ phase: value.phase, render: value.render })), pdf: { cold: pdf.cold, warm: pdf.warm, reads: pdf.reads } }
  receipt.limitations = [pdf.caveat, ...books.limitations, 'Targeted private Electron consumers and the real production build are proved; no installed-app replacement was requested or performed.']
  receipt.passed = true
} catch (error) { receipt.failure = error.stack ?? String(error) }
const output = join(integration, 'receipt.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, output, candidate: receipt.candidate, failure: receipt.failure }))
process.exitCode = receipt.passed ? 0 : 1
