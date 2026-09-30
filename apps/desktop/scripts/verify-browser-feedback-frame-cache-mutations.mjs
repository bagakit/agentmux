import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..'), source = join(root, 'apps/desktop/scripts/fixtures/browser-operation-feedback/frame-state.mjs')
const test = join(root, 'apps/desktop/scripts/fixtures/browser-operation-feedback/frame-state.test.mjs')
const out = join(root, 'docs/reviews/evidence/browser-operation-feedback-frame-binding-2026-10-04/source-cache')
const original = await readFile(source, 'utf8'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const own = await mkdtemp(join(tmpdir(), 'amx-feedback-frame-cache-')), path = join(own, 'frame-state.mjs')
const receipt = { passed: false, sourceSha256: sha(original), sourceBytes: Buffer.byteLength(original), scope: 'actual-reader-must-not-start-Canvas', privateRemoved: false }
await mkdir(out, { recursive: true })
async function run(label, bytes) {
  await writeFile(path, bytes)
  const result = spawnSync(process.execPath, ['--test', test], { cwd: root, env: { ...process.env, AGENTMUX_FEEDBACK_FRAME_STATE_SOURCE: path }, encoding: 'utf8' })
  const raw = result.stdout + result.stderr; await writeFile(join(out, label + '.log'), raw)
  return { exitCode: result.status, sourceSha256: sha(bytes), logSha256: sha(raw), assertionRed: raw.includes('ERR_ASSERTION') }
}
try {
  receipt.baseline = await run('baseline', original); assert.equal(receipt.baseline.exitCode, 0)
  const anchor = 'return `(()=>{const hud=${originalExpression};'
  assert.equal(original.split(anchor).length, 2, 'The actual action-time expression body exists once')
  receipt.mutant = await run('action-time-Canvas-cold-start-red', original.replace(anchor, 'return `(()=>{new OffscreenCanvas(1,1);const hud=${originalExpression};'))
  assert.notEqual(receipt.mutant.exitCode, 0); assert.equal(receipt.mutant.assertionRed, true)
  receipt.restored = await run('restored', original); assert.equal(receipt.restored.exitCode, 0)
  assert.equal(await readFile(source, 'utf8'), original); receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await rm(own, { recursive: true }); receipt.privateRemoved = true; await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
console.log(JSON.stringify({ passed: receipt.passed, out }))
