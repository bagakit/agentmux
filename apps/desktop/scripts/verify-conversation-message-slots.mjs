import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { captureA2aOriginalReading } from './fixtures/a2a-original-reading/capture.mjs'
import { messageSlotMutations } from './fixtures/a2a-original-reading/layout-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), area = resolve(root, '.local/conversation-message-slots')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(area, { recursive: true })
const evidence = await mkdtemp(resolve(area, 'run-'))
const positive = await captureA2aOriginalReading({ root, evidence: resolve(evidence, 'candidate'), layout: true })
assert.equal(positive.render.scenarios.length, 10)
const mutations = []
for (const mutation of messageSlotMutations) {
  const directory = resolve(evidence, mutation)
  await assert.rejects(captureA2aOriginalReading({ root, evidence: directory, layout: true, styleMutation: mutation }))
  const receipt = JSON.parse(await readFile(resolve(directory, 'capture.json')))
  assert.equal(receipt.process.exitCode, 1); assert.equal(receipt.process.timedOut, false)
  assert.equal(receipt.render.failure.name, 'AssertionError')
  assert.ok(receipt.render.scenarios.length < 10)
  assert.equal(receipt.transforms.length, 1); assert.notEqual(receipt.transforms[0].original, receipt.transforms[0].changed)
  assert.deepEqual(receipt.drift, []); assert.deepEqual(receipt.remainingPrivateProcesses, []); assert.equal(receipt.privateRootRemoved, true)
  mutations.push({ mutation, receipt: relative(root, resolve(directory, 'capture.json')), sha256: hash(await readFile(resolve(directory, 'capture.json'))), failure: receipt.render.failure.message })
}
for (const [path, identity] of Object.entries(positive.inputs)) assert.equal(hash(await readFile(resolve(root, path))), identity.sha256, 'Current positive source: ' + path)
const receipt = { schema: 'agentmux.message-slot-layout-proof.v1', passed: true, candidate: relative(root, resolve(evidence, 'candidate/capture.json')),
  candidateSha256: hash(await readFile(resolve(evidence, 'candidate/capture.json'))), sourceIdentity: positive.sourceIdentity, mutations,
  verifierSha256: hash(await readFile(resolve(root, 'apps/desktop/scripts/verify-conversation-message-slots.mjs'))),
  boundary: 'Actual Desktop platform, shared qualified A2A reference consumer and complete product CSS in private native Chromium. Ten wide/narrow variant cases, original Copy/Info and exact source receipts. Independent visual approval remains separate; no user App, Core Run or installed package claim.' }
await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
await writeFile(resolve(area, 'current.json'), JSON.stringify({ receipt: relative(root, resolve(evidence, 'receipt.json')) }))
console.log(JSON.stringify({ passed: true, scenarios: 10, mutations: mutations.length, frames: positive.render.frames.length, receipt: relative(root, resolve(evidence, 'receipt.json')) }))
