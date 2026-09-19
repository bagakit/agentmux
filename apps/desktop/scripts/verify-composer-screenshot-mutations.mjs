import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.join(root, 'docs/reviews/evidence/messagetool-screenshot-p0-2026-10-02/source-mutations')
const main = 'apps/desktop/src/main/composer-screenshot.ts'
const components = 'apps/desktop/src/renderer/src/components/'
const tests = ['composer-screenshot.test.ts', 'composer-local-feedback.test.tsx', 'composer-paste-selection.test.tsx'].map(file => `apps/desktop/test/${file}`)
const cases = [
  ['request-settlement-releases-selector', main, 'settled = true\n      reject(captureFailure(reason))', 'settled = true\n      captureOwner = null\n      reject(captureFailure(reason))'],
  ['child-error-releases-without-close', main, "firstFailure ??= `The screen selector failed: ${describe(error)}.`", "captureOwner = null\n      firstFailure ??= `The screen selector failed: ${describe(error)}.`"],
  ['child-error-listener-consumed-once', main, "child.on('error', onError)", "child.once('error', onError)"],
  ['missing-file-fabricated-cancel', main, '} catch (error) {\n            reason =', "} catch (error) {\n            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { settled = true; resolve(null); return }\n            reason ="],
  ['timeout-late-file-flips-success', main, 'let reason = firstFailure', 'let reason: string | undefined = undefined'],
  ['first-failure-drops-actual-close', main, '        if (reason) reason += ` Actual close: code ${code}, signal ${signal}.`\n', ''],
  ['launcher-late-result-not-isolated', components + 'NewTabSurface.tsx', 'if (!feedback.isCurrent()) return null\n', ''],
  ['feedback-generation-not-owned', components + 'ComposerFeedback.tsx', 'mounted.current && currentScope.current.generation === generation', 'mounted.current']
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = [...new Set([...cases.map(([, file]) => file), ...tests])]
const originals = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(root, file))])))
const receipt = { passed: false, inputs: Object.fromEntries([...originals].map(([file, bytes]) => [file, digest(bytes)])), cases: [], artifacts: {} }
const args = ['exec', 'vitest', 'run', ...tests, '--maxWorkers=1']
const command = `pnpm_config_verify_deps_before_run=false pnpm ${args.join(' ')}`
const run = async name => {
  const result = spawnSync('pnpm', args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, encoding: 'utf8', timeout: 45_000 })
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const file = path.join(evidence, `${name}.log`)
  await fs.writeFile(file, log)
  const relative = path.relative(root, file)
  receipt.artifacts[relative] = digest(log)
  return { result, log, file: relative }
}
await fs.mkdir(evidence, { recursive: true })
try {
  for (const [name, file, before, after] of cases) {
    const original = originals.get(file)
    const source = original.toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Mutation anchor must be unique: ${name}`)
    const mutated = source.replace(before, after)
    try {
      await fs.writeFile(path.join(root, file), mutated)
      const red = await run(name)
      assert.ok(Number.isInteger(red.result.status) && red.result.status !== 0, `Mutation survived or failed to execute: ${name}`)
      assert.match(red.log, /AssertionError/, `No behavioral assertion failed: ${name}`)
      assert.match(red.log, /Tests\s+[1-9]\d* failed/, `No failing tests executed: ${name}`)
      receipt.cases.push({ name, file, redExit: red.result.status, log: red.file, command, mutation: { before, after, mutatedSha256: digest(mutated) } })
    } finally { await fs.writeFile(path.join(root, file), original) }
  }
  const green = await run('restored-green')
  assert.equal(green.result.status, 0, green.log)
  assert.match(green.log, /Tests\s+[1-9]\d* passed/, 'No tests executed after restoration')
  receipt.green = { exit: green.result.status, log: green.file, command }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const [file, original] of originals) await fs.writeFile(path.join(root, file), original)
  receipt.restored = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await fs.readFile(path.join(root, file)))])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.deepEqual(receipt.restored, receipt.inputs, 'Exact owning source and tested inputs must be restored')
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, cases: receipt.cases.length, exactRestoration: true }))
