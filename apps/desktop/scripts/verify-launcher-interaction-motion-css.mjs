import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = resolve(import.meta.dirname, '../../..')
const cssPath = 'apps/desktop/src/renderer/src/styles/launcher.css'
const producer = 'apps/desktop/scripts/verify-launcher-interaction-motion-css.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const relative = path => path.replace(repository + '/', '')
const specs = [
  { id: 'remove-native-keyboard-focus',
    from: ".launch-surface button:focus-visible, .launcher-environment__panel button:focus-visible, .launch-refine__panel button:focus-visible { outline: 2px solid var(--focus-line); outline-offset: 2px; }",
    to: ".launch-surface button:focus-visible, .launcher-environment__panel button:focus-visible, .launch-refine__panel button:focus-visible { outline: none; outline-offset: 2px; }",
    assertion: 'Native keyboard navigation gives the custom control an independent visible focus' },
  { id: 'remove-real-host-entry-motion',
    from: ".launcher-environment__panel[data-state='open'], .launch-refine__panel[data-state='open'] { animation: launcher-panel-in var(--dur-enter) var(--ease-enter); }",
    to: ".launcher-environment__panel[data-state='open'], .launch-refine__panel[data-state='open'] { animation: none; }",
    assertion: 'motion-host-enter: actual finite motion has an intermediate time' }
]
async function readProof(file) {
  const bytes = await readFile(resolve(repository, file))
  return { path: relative(resolve(repository, file)), sha256: sha(bytes), proof: JSON.parse(bytes) }
}
async function validateCapture(reference, cssSha, green, assertion) {
  const actual = await readProof(reference.path)
  assert.equal(actual.sha256, reference.sha256, 'Exact original native capture report')
  const capture = actual.proof
  assert.equal(capture.scenes, 'interaction-motion')
  assert.equal(capture.identity.sources['styles/launcher.css'], cssSha)
  assert.equal(capture.compiled.importedStyles['styles/launcher.css'], cssSha, 'Mutated CSS was actually compiled and imported by production Workbench')
  assert.equal(capture.passed, green)
  assert.equal(capture.cleanup.remaining.length, 0)
  assert.ok(Object.keys(capture.compiled.files).length > 0)
  if (green) {
    assert.equal(capture.processes.length, 2)
    assert.equal(capture.processes[1].render.durable.passed, true)
    assert.ok(capture.frames.length > 0)
    for (const frame of capture.frames) assert.equal(sha(await readFile(resolve(repository, dirname(actual.path), frame.file))), frame.sha256)
  } else {
    const failure = capture.processes[0]?.render.failure
    assert.equal(failure?.name, 'AssertionError', 'Actual Renderer assertion RED, never an import/collection/timeout failure')
    assert.ok(failure.message.includes(assertion), 'The corresponding real native assertion turns RED')
    assert.notEqual(capture.processes[0].outcome.exitCode, 0)
  }
  return actual
}

export async function validateLauncherMotionCssReceipt(file, currentCapture) {
  const actual = await readProof(file), receipt = actual.proof
  assert.equal(receipt.schema, 'agentmux.launcher-interaction-motion-css.v1')
  assert.equal(receipt.passed, true)
  const original = sha(await readFile(resolve(repository, cssPath)))
  assert.equal(receipt.source.path, cssPath)
  assert.equal(receipt.source.sha256, original)
  assert.equal(receipt.producer.path, producer)
  assert.equal(receipt.producer.sha256, sha(await readFile(resolve(repository, producer))))
  assert.deepEqual(receipt.mutations.map(item => item.id), specs.map(item => item.id))
  await validateCapture(receipt.baseline, original, true)
  for (const [index, mutation] of receipt.mutations.entries()) {
    assert.equal(mutation.status, 'assertion-red-exact-restore-green')
    assert.equal(mutation.originalSha256, original)
    assert.notEqual(mutation.mutatedSha256, original)
    await validateCapture(mutation.red, mutation.mutatedSha256, false, specs[index].assertion)
    const restored = await validateCapture(mutation.restored, original, true)
    if (currentCapture) assert.equal(restored.proof.sourceDigest, currentCapture.sourceDigest, 'Actual restored motion capture binds the final candidate')
  }
  return actual
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
  const output = resolve(repository, arg('--output') ?? 'docs/reviews/evidence/launcher-interaction-motion-2026-10-04')
  if (arg('--receipt')) {
    const result = await validateLauncherMotionCssReceipt(resolve(repository, arg('--receipt')))
    console.log(JSON.stringify({ passed: true, receipt: result.path, mutations: result.proof.mutations.length, mode: 'read-only-current-proof' }))
  } else {
    assert.ok(arg('--baseline'), 'A completed actual baseline capture is required')
    await mkdir(output, { recursive: true })
    const path = resolve(repository, cssPath), original = await readFile(path), originalSha256 = sha(original)
    const baseline = await readProof(resolve(repository, arg('--baseline')))
    await validateCapture(baseline, originalSha256, true)
    const mutations = []
    async function capture(label) {
      const directory = resolve(output, 'css-mutations', label)
      const args = ['apps/desktop/scripts/verify-launcher-launchpad.mjs', '--scenes=interaction-motion', '--output=' + relative(directory)]
      const run = spawnSync(process.execPath, args, { cwd: repository, encoding: 'utf8', timeout: 180000 })
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, 'qualification.log'), `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? '\n' + run.error : ''}`)
      assert.ok(!run.error, label + ': native capture completed')
      return await readProof(resolve(directory, 'capture-receipt.json'))
    }
    for (const spec of specs) {
      assert.equal(sha(await readFile(path)), originalSha256, 'Concurrent CSS changed; do not replace it')
      assert.equal(original.toString().split(spec.from).length, 2, 'One nonempty actual production declaration: ' + spec.id)
      const mutated = Buffer.from(original.toString().replace(spec.from, spec.to)), mutatedSha256 = sha(mutated)
      let red
      await writeFile(path, mutated)
      try {
        red = await capture(spec.id + '-red')
        await validateCapture(red, mutatedSha256, false, spec.assertion)
      } finally {
        assert.equal(sha(await readFile(path)), mutatedSha256, 'Concurrent mutation-period edit; never overwrite it')
        await writeFile(path, original)
        assert.equal(sha(await readFile(path)), originalSha256, 'Exact original CSS restored')
      }
      const restored = await capture(spec.id + '-restored')
      await validateCapture(restored, originalSha256, true)
      mutations.push({ id: spec.id, status: 'assertion-red-exact-restore-green', originalSha256, mutatedSha256,
        red: { path: red.path, sha256: red.sha256 }, restored: { path: restored.path, sha256: restored.sha256 } })
      console.log(spec.id + ': actual native Assertion RED / exact restore GREEN')
    }
    const receipt = { schema: 'agentmux.launcher-interaction-motion-css.v1', passed: true,
      source: { path: cssPath, sha256: originalSha256 }, producer: { path: producer, sha256: sha(await readFile(resolve(repository, producer))) },
      baseline: { path: baseline.path, sha256: baseline.sha256 }, mutations,
      boundary: 'Two real production CSS mutations compile into isolated Electron Workbench. Native keyboard/RAF assertions turn RED; original bytes restore and full native scenes plus two-process durable restore turn GREEN. No user App or Run touched.' }
    await writeFile(resolve(output, 'css-mutations.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify({ passed: true, receipt: relative(resolve(output, 'css-mutations.json')) }))
  }
}
