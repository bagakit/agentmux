import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(root, 'package.json'))
const main = 'apps/desktop/src/main/browser-demonstration-recorder.ts'
const test = 'apps/desktop/test/browser-demonstration-recorder.test.ts'
const capture = 'apps/desktop/src/main/browser-demonstration-capture.ts'
const surface = 'apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx'
const tests = [test, 'apps/desktop/test/browser-demonstration-capture.test.ts', 'apps/desktop/test/browser-demonstration-surface.test.tsx']
const inputs = [main, capture, surface, ...tests,
  'apps/desktop/src/main/browser-cdp-session.ts', 'apps/desktop/src/main/browser-page-snapshot.ts',
  'apps/desktop/src/main/browser-snapshot-query.ts', 'apps/desktop/src/main/browser-selection-script.ts',
  'apps/desktop/src/shared/browser-demonstration.ts', 'apps/desktop/src/shared/browser-operation.ts',
  'apps/desktop/src/shared/browser-step-evidence.ts', 'apps/desktop/src/shared/browser-snapshot-query.ts']
const originals = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')])))
const source = originals.get(main)
const digest = value => createHash('sha256').update(value).digest('hex')
const evidence = path.join(root, 'docs/reviews/evidence/browser-task-capabilities-2026-10-03/t010-source')
const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-recorder-mutations-'))
const cases = [
  ['capture-time-follows-slow-storage', 'const recordedAt = this.now()\n    const gesture = this.recentGesture(input.browserId, input.navigationId)\n    return this.change(async () => {', 'return this.change(async () => {\n      const recordedAt = this.now()\n      const gesture = this.recentGesture(input.browserId, input.navigationId)'],
  ['page-synthetic-event-accepted', 'input.isTrusted !== true', 'false'],
  ['native-input-not-required', "if (!gesture || !(input.kind === 'fill' ? FILL_INPUTS : CLICK_INPUTS).has(gesture.type)) return null", 'if (false) return null'],
  ['input-value-retained', 'args: [], ...(target ? { target } : {}),', 'args: (input.value ? [input.value] : []), ...(target ? { target } : {}),'],
  ['restart-recording-resumes', "draft.status = 'interrupted'", "draft.status = 'recording'"],
  ['unread-history-overwritten', 'if (this.loadUnavailable) return', 'if (false) return'],
  ['unknown-navigation-claimed-human', "source: human ? 'native-human' : 'navigation'", "source: 'native-human'"],
  ['step-budget-one-extra', 'draft.steps.length >= MAX_STEPS', 'draft.steps.length > MAX_STEPS'],
  ['target-proof-not-awaited', 'safeTarget(await input.target)', 'safeTarget(input.target)']
].map(([name, before, after]) => [main, name, before, after])
cases.push(
  [capture, 'untrusted-event-enters-capture', 'if (event.isTrusted !== true) return;', 'if (false) return;'],
  [capture, 'hover-triggers-observation', '!NATIVE_INPUTS.has(input.type)', 'false'],
  [capture, 'backend-identity-guessed', 'candidate.backendNodeId === backendNodeId', 'candidate.backendNodeId > 0'],
  [capture, 'ambiguous-target-approved', 'matches.length !== 1', 'matches.length < 1'],
  [capture, 'isolated-world-unproven', 'response.result?.value === true', 'true'],
  [capture, 'owner-not-released', 'this.session?.detach()', 'void 0'],
  [capture, 'cleanup-warning-discarded', 'if (cleanupWarning) this.warning = cleanupWarning', 'void 0'],
  [capture, 'slow-start-reacquires-owner', 'if (generation !== this.generation) return draft', 'if (false) return draft'],
  [capture, 'budget-stop-keeps-debugger', "if (draft && draft.status !== 'recording' && this.active) this.release()", 'void 0'],
  [capture, 'event-budget-removed', 'state.events.length >= ${MAX_EVENTS}', 'false'],
  [surface, 'blocked-reason-hidden', '{step.blockedReason ? <small', '{false ? <small'],
  [surface, 'interrupted-claims-recording', "const recording = draft?.status === 'recording'", "const recording = draft !== null"]
)
const receipt = { passed: false, boundary: 'Actual implementation and actual regression tests copied into a private source root; no user process, source mutation or Browser evidence. Caller and native acceptance remain separate.', inputs: Object.fromEntries([...originals].map(([file, text]) => [file, digest(text)])), cases: [] }
const run = async name => {
  const result = spawnSync(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', ...tests, '--root', isolated, '--maxWorkers=1'], { cwd: isolated, encoding: 'utf8', timeout: 30_000 })
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const file = path.join(evidence, `${name}.log`)
  await fs.writeFile(file, log)
  return { result, log, file: path.relative(root, file), sha256: digest(log) }
}
try {
  await fs.mkdir(evidence, { recursive: true })
  await fs.writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n')
  await fs.writeFile(path.join(isolated, 'vitest.config.mjs'), "export default { esbuild: { jsx: 'automatic' } }\n")
  await fs.symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  for (const [file, text] of originals) {
    await fs.mkdir(path.dirname(path.join(isolated, file)), { recursive: true })
    await fs.writeFile(path.join(isolated, file), text)
  }
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(isolated, 'apps/desktop/node_modules'), 'dir')
  const baseline = await run('baseline-green')
  assert.equal(baseline.result.status, 0, baseline.log)
  assert.match(baseline.log, /Tests\s+20 passed/, 'All actual regression tests must execute')
  for (const [file, name, before, after] of cases) {
    const source = originals.get(file)
    const occurrences = source.split(before).length - 1
    assert.ok(occurrences > 0, `Mutation anchor missing: ${name}`)
    const mutated = source.replaceAll(before, after)
    await fs.writeFile(path.join(isolated, file), mutated)
    const red = await run(name)
    assert.ok(Number.isInteger(red.result.status) && red.result.status !== 0, `Mutation survived: ${name}`)
    assert.match(red.log, /AssertionError/, `Behavioral assertion must fail: ${name}`)
    assert.match(red.log, /Tests\s+[1-9]\d* failed/, `Failing tests must execute: ${name}`)
    receipt.cases.push({ file, name, occurrences, redExit: red.result.status, log: red.file, sha256: red.sha256, mutatedSha256: digest(mutated) })
    await fs.writeFile(path.join(isolated, file), source)
  }
  const green = await run('restored-green')
  assert.equal(green.result.status, 0, green.log)
  assert.match(green.log, /Tests\s+20 passed/, 'Restored source must execute all actual tests')
  receipt.green = { exit: green.result.status, log: green.file, sha256: green.sha256 }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message } }
finally {
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...originals.keys()].map(async file => [file, digest(await fs.readFile(path.join(root, file), 'utf8'))])))
  await fs.rm(isolated, { recursive: true, force: true })
  receipt.privateSourceRemoved = true
  await fs.mkdir(evidence, { recursive: true })
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Owning source/test inputs must remain exactly unchanged')
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, cases: receipt.cases.length, originalSourceUnchanged: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')) }))
