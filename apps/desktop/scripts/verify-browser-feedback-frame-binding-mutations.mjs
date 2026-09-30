import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const source = join(root, 'apps/desktop/scripts/fixtures/browser-operation-feedback/frame-pixels.mjs')
const test = join(root, 'apps/desktop/scripts/fixtures/browser-operation-feedback/frame-pixels.test.mjs')
const out = resolve(process.argv[2] ?? join(root, 'docs/reviews/evidence/browser-operation-feedback-frame-binding-2026-10-04/source-attempt-1'))
const original = await readFile(source, 'utf8'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const own = await mkdtemp(join(tmpdir(), 'amx-feedback-frame-source-'))
const receipt = { schema: 'agentmux.browser-feedback-frame-source.v1', author: '/root/browser_surfaces', passed: false,
  source: { path: source, sha256: sha(original), bytes: Buffer.byteLength(original) }, mutants: [], sourceDrift: [], privateRemoved: false }
await mkdir(out, { recursive: true })
async function run(label, bytes) {
  const path = join(own, 'frame-pixels.mjs'); await writeFile(path, bytes)
  const result = spawnSync(process.execPath, ['--test', test], { cwd: root, env: { ...process.env, AGENTMUX_FEEDBACK_PIXEL_SOURCE: path }, encoding: 'utf8' })
  const raw = result.stdout + result.stderr
  await writeFile(join(out, label + '.log'), raw)
  return { exitCode: result.status, log: label + '.log', logSha256: sha(raw), sourceSha256: sha(bytes), assertionRed: raw.includes('ERR_ASSERTION') }
}
function removeOnce(bytes, line) {
  assert.equal(bytes.split(line).length, 2, 'Exact actual owning Source block exists once')
  return bytes.replace(line, '')
}
try {
  receipt.baseline = await run('baseline', original); assert.equal(receipt.baseline.exitCode, 0)
  const start = original.indexOf('export function inspectFeedbackFrame(bitmap, sample) {')
  assert.ok(start >= 0 && original.slice(start).includes('original-bitmap-cue-roi-and-computed-paint'))
  const mutants = [
    { name: 'remove-entire-bitmap-refusal-body', bytes: original.slice(0, start) + 'export function inspectFeedbackFrame(bitmap, sample) { return { compatible: true, phase: sample.hud.phase, textPixels: {count:1}, arrowPixels: {count:1} } }\n' },
    { name: 'remove-actual-label-boundary-and-foreground-phase-refusal', bytes: removeOnce(removeOnce(original,
      "  if (outside.length >= 2 * sy) return unknown('text-paint-exceeds-candidate-label')\n"),
      "  if (glyphs.length < Math.ceil(6 * sx * sy)) return unknown('text-phase-paint-not-present')\n") }
  ]
  for (const mutant of mutants) {
    const result = await run(mutant.name + '-red', mutant.bytes)
    assert.notEqual(result.exitCode, 0); assert.equal(result.assertionRed, true)
    const restored = await run(mutant.name + '-restored', original); assert.equal(restored.exitCode, 0)
    receipt.mutants.push({ name: mutant.name, ...result, restored })
  }
  assert.equal(await readFile(source, 'utf8'), original)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await rm(own, { recursive: true }); receipt.privateRemoved = true; await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }) + '\n')
