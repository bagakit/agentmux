import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSupervisionCoreOwner } from '../scripts/session-supervision-evidence.mjs'

const directories: string[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }) })

// Synthetic artifacts exercise the reader's refusal boundary only. Native owner
// qualification always reads the original producer, loaded module and raw report.
async function artifacts() {
  const root = await mkdtemp(path.join(tmpdir(), 'supervision-evidence-')); directories.push(root)
  const gate = 'packages/core/scripts/verify-resume-context-observation.mjs', owner = 'packages/core/src/client.ts'
  const put = async (file: string, body: any) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), typeof body === 'string' ? body : JSON.stringify(body))
  }
  await put(gate, 'original gate fixture'); await put(owner, 'original owner fixture')
  const row = (index: number, failed = false) => ({ fullName: 'business case ' + index,
    status: failed ? 'failed' : 'passed', failureMessages: failed ? ['AssertionError: expected original input to remain unchanged'] : [] })
  const reports: Record<string, any> = {}, modules: Record<string, string> = {}
  const result = async (name: string, failed = false) => {
    const assertions = Array.from({ length: 33 }, (_, index) => row(index, failed && index === 0))
    reports[name] = { success: !failed, numTotalTests: 33, numPassedTests: failed ? 32 : 33, numFailedTests: failed ? 1 : 0,
      testResults: [{ message: '', assertionResults: assertions }] }
    modules[name] = 'export const fixture = ' + JSON.stringify(name)
    await put('proof/' + name + '.json', reports[name]); await put('proof/package/dist/' + name + '.mjs', modules[name])
    return { name, code: failed ? 1 : 0, signal: null, total: 33, passed: failed ? 32 : 33, failed: failed ? 1 : 0,
      semanticRed: failed, bundleSha256: hash(modules[name]), failures: failed ? [{ name: assertions[0].fullName, messages: assertions[0].failureMessages }] : [] }
  }
  const receipt = { schema: 'agentmux.resume-context-observation-proof.v1', passed: true, sourceStable: true,
    inputs: { [gate]: hash('original gate fixture'), [owner]: hash('original owner fixture') },
    results: [await result('candidate'), ...await Promise.all(Array.from({ length: 18 }, (_, index) => result('mutant-' + index, true)))] }
  const save = () => put('proof/receipt.json', receipt); await save()
  return { root, receipt, reports, put, save, read: () => readSupervisionCoreOwner(root, 'T003', 'proof/receipt.json') }
}

it('reads only source-bound raw counts and distinct loaded counterexamples from the new owner contract', async () => {
  const f = await artifacts(), read = await f.read()
  expect(read.sourceInputs).toBe(2); expect(read.baselineCases).toHaveLength(33); expect(read.loadedCounterexamples).toBe(18)
})

it('cannot substitute an archived task receipt or passed flag for the current supervision owner', async () => {
  const f = await artifacts(); f.receipt.schema = 'agentmux.post-start-availability-proof.v1'; await f.save()
  await expect(f.read()).rejects.toThrow()
})

it('rejects missing source pins and changed current owner bytes', async () => {
  const f = await artifacts(); await f.put('packages/core/src/client.ts', 'changed candidate')
  await expect(f.read()).rejects.toThrow('another source candidate')
  f.receipt.inputs = {} as typeof f.receipt.inputs; await f.save()
  await expect(f.read()).rejects.toThrow('no source inputs')
})

it('requires the complete new owner counterexample set', async () => {
  const f = await artifacts(); f.receipt.results.pop(); await f.save()
  await expect(f.read()).rejects.toThrow('counterexamples are missing')
})

it('does not accept a duplicate baseline as an additional business proof', async () => {
  const f = await artifacts(); f.receipt.results.push(f.receipt.results[0]); await f.save()
  await expect(f.read()).rejects.toThrow('Exactly one original candidate baseline')
})

it('binds the original loaded mutation module bytes', async () => {
  const f = await artifacts(); await f.put('proof/package/dist/mutant-0.mjs', 'different bytes')
  await expect(f.read()).rejects.toThrow('loaded supervision module changed')
})

it('cross-checks producer totals with all raw rows instead of trusting a rewritten header', async () => {
  const f = await artifacts(), report = f.reports.candidate
  report.testResults[0].assertionResults.pop(); report.numTotalTests--; report.numPassedTests--
  await f.put('proof/candidate.json', report)
  await expect(f.read()).rejects.toThrow('producer count mismatch: total')
})

it('rejects a process exception even if the producer claims semantic RED', async () => {
  const f = await artifacts(), report = f.reports['mutant-0']
  report.testResults[0].assertionResults[0].failureMessages = ['Error: the worker process terminated']
  await f.put('proof/mutant-0.json', report)
  await expect(f.read()).rejects.toThrow('lacks a business assertion failure')
})

it('compares the exact failed business identity and message with the original producer', async () => {
  const f = await artifacts(); f.receipt.results[1].failures[0].name = 'different target case'; await f.save()
  await expect(f.read()).rejects.toThrow('failure identities and business assertions')
})
