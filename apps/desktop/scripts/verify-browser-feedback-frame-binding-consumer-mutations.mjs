import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const sourcePath = resolve(root, 'apps/desktop/scripts/browser-feedback-frame-binding-receipt.mjs')
const testPath = resolve(root, 'apps/desktop/scripts/fixtures/browser-operation-feedback/frame-binding-receipt.test.mjs')
const output = resolve(process.argv[2])
await mkdir(output, { recursive: true })
const source = await readFile(sourcePath, 'utf8'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ownRoot = await mkdtemp(join(tmpdir(), 'amx-frame-consumer-mutant-'))
const mutantPath = join(ownRoot, 'consumer.mjs')
const helper = resolve(root, 'apps/desktop/scripts/fixtures/browser-operation-feedback/frame-pixels.mjs')
const isolated = text => text.replace("'./fixtures/browser-operation-feedback/frame-pixels.mjs'", JSON.stringify(helper))
const packet = { schema: 'agentmux.frame-binding-consumer-mutations.v1', source: { path: sourcePath, sha256: hash(source) }, mutants: [] }
function run(label) {
  const result = spawnSync(process.execPath, ['--test', testPath], { cwd: root, env: { ...process.env, AGENTMUX_FEEDBACK_BINDING_CONSUMER_SOURCE: mutantPath }, encoding: 'utf8' })
  return { label, status: result.status, raw: (result.stdout ?? '') + (result.stderr ?? '') }
}
async function record(result) { const path = join(output, result.label + '.log'); await writeFile(path, result.raw); return { path, status: result.status, sha256: hash(result.raw) } }
try {
  await writeFile(mutantPath, isolated(source))
  const baseline = run('baseline'); packet.baseline = await record(baseline); assert.equal(baseline.status, 0)
  const blocks = [
    { name: 'remove-original-pixel-recompute', old: "const recomputed = inspectFeedbackFrame(bitmap, sample)\n      assert.equal(recomputed.compatible, true, 'Original PNG independently contains the candidate cue and phase: ' + recomputed.reason)\n      assert.deepEqual(recomputed, frame.pixelEvidence, 'Producer flags never substitute for original pixel recomputation')", replacement: 'const recomputed = frame.pixelEvidence' },
    { name: 'remove-directed-paint-progress-block', old: "const travel = progress.at(-1).along - progress[0].along\n  assert.ok(travel > Math.max(6, distance * 0.1), 'Forward painted travel exceeds hover float and cached start')\n  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].along > progress[i - 1].along, 'Actual intermediate arrows progress toward the current target')", replacement: 'const travel = progress.at(-1).along - progress[0].along' }
  ]
  for (const block of blocks) {
    assert.equal(source.split(block.old).length - 1, 1, 'Actual owning block is unique and nonempty')
    await writeFile(mutantPath, isolated(source.replace(block.old, block.replacement)))
    const red = run(block.name + '-red'); const redFile = await record(red)
    assert.notEqual(red.status, 0); assert.match(red.raw, /ERR_ASSERTION|AssertionError/)
    await writeFile(mutantPath, isolated(source))
    const restored = run(block.name + '-restored'); const greenFile = await record(restored); assert.equal(restored.status, 0)
    packet.mutants.push({ name: block.name, actualBlockSha256: hash(block.old), red: redFile, restored: greenFile })
  }
  assert.equal(hash(await readFile(sourcePath)), hash(source))
  packet.passed = true
} catch (error) { packet.passed = false; packet.error = error.message; process.exitCode = 1 }
finally { await rm(ownRoot, { recursive: true }); packet.privateRootRemoved = true; await writeFile(join(output, 'receipt.json'), JSON.stringify(packet, null, 2) + '\n') }
