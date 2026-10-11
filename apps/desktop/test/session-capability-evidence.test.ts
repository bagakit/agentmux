import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSessionOwnerProof } from '../scripts/session-capability-evidence.mjs'

const roots: string[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

// Deliberately incomplete artifacts exercise refusal only. They never stand in
// for the actual Native owner gates consumed by the product qualification.
async function incompleteProof() {
  const root = await mkdtemp(path.join(tmpdir(), 'session-evidence-')); roots.push(root)
  const gate = 'packages/core/scripts/verify-agent-post-start-availability.mjs'
  const source = 'packages/core/src/client.ts'
  const put = async (file: string, body: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), body) }
  await put(gate, 'original producer fixture'); await put(source, 'original owner fixture')
  const bundle = 'export const candidate = true'
  const before = { [gate]: hash('original producer fixture'), [source]: hash('original owner fixture') }
  const result = (name: string, code: number) => ({ name, code, signal: null, total: 13, passed: code === 0 ? 13 : 0,
    failed: code === 0 ? 0 : 1, semanticRed: code === 1, bundleSha256: hash(bundle) })
  const receipt = { schema: 'agentmux.post-start-availability-proof.v1', passed: true, before,
    results: [result('candidate', 0), ...Array.from({ length: 6 }, (_, index) => result('mutation-' + index, 1))], callers: [] }
  const baseline = { success: true, numTotalTests: 13, numPassedTests: 13, numFailedTests: 0,
    testResults: [{ assertionResults: Array.from({ length: 13 }, (_, index) => ({
    fullName: 'collection fixture ' + index, status: 'passed', failureMessages: [] })) }] }
  await put('proof/candidate.json', JSON.stringify(baseline)); await put('proof/package/dist/candidate.mjs', bundle)
  const save = async () => put('proof/receipt.json', JSON.stringify(receipt))
  await save()
  return { root, receipt, baseline, put, save, read: () => readSessionOwnerProof(root, 'T003', 'proof/receipt.json') }
}

it('cannot qualify an authored passed flag without original source inputs', async () => {
  const f = await incompleteProof(); f.receipt.before = {} as typeof f.receipt.before; await f.save()
  await expect(f.read()).rejects.toThrow('no source inputs')
})

it('refuses a real source change even when the original receipt says passed', async () => {
  const f = await incompleteProof(); await f.put('packages/core/src/client.ts', 'changed owner fixture')
  await expect(f.read()).rejects.toThrow('another source candidate')
})

it('does not accept empty collection as a green owner baseline', async () => {
  const f = await incompleteProof(); await f.put('proof/candidate.json', JSON.stringify({ success: true, testResults: [] }))
  await expect(f.read()).rejects.toThrow('no executed business cases')
})

it('binds the loaded module bytes instead of trusting its declared hash', async () => {
  const f = await incompleteProof(); await f.put('proof/package/dist/candidate.mjs', 'different module')
  await expect(f.read()).rejects.toThrow('loaded owner module changed')
})

it('rejects a removed passed assertion while the raw header and original receipt still claim it ran', async () => {
  const f = await incompleteProof(); f.baseline.testResults[0].assertionResults.pop()
  await f.put('proof/candidate.json', JSON.stringify(f.baseline))
  await expect(f.read()).rejects.toThrow('report count mismatch: total')
})

it('compares raw counts with the producer even if a truncated report rewrites its header', async () => {
  const f = await incompleteProof(); f.baseline.testResults[0].assertionResults.pop()
  f.baseline.numTotalTests = 12; f.baseline.numPassedTests = 12
  await f.put('proof/candidate.json', JSON.stringify(f.baseline))
  await expect(f.read()).rejects.toThrow('producer count mismatch: total')
})

it.each(['passed', 'failed'] as const)('rejects a producer %s count that differs from the raw assertions', async field => {
  const f = await incompleteProof(); f.receipt.results[0][field] += 1; await f.save()
  await expect(f.read()).rejects.toThrow('producer count mismatch: ' + field)
})

it('requires the original counterexample set rather than a baseline-only success', async () => {
  const f = await incompleteProof(); f.receipt.results.splice(1); await f.save()
  await expect(f.read()).rejects.toThrow('omitted its baseline or loaded counterexamples')
})

it('a process or setup failure cannot substitute for a business assertion RED', async () => {
  const f = await incompleteProof()
  await f.put('proof/mutation-0.json', JSON.stringify({ success: false, numTotalTests: 13, numPassedTests: 0, numFailedTests: 1,
    testResults: [{ assertionResults: [{ fullName: 'collection fixture', status: 'failed', failureMessages: ['Worker process unexpectedly exited'] },
      ...Array.from({ length: 12 }, (_, index) => ({ fullName: 'skipped fixture ' + index, status: 'skipped', failureMessages: [] }))] }] }))
  await expect(f.read()).rejects.toThrow('lacks a business assertion failure')
})
