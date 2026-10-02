import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const file = 'apps/desktop/src/renderer/src/store.ts'
const tests = ['apps/desktop/test/startup-event-progress.test.tsx', 'apps/desktop/test/startup-snapshot-notice-resolution.test.tsx']
const evidence = join(root, '.tmp', 'startup-event-progress')
const digest = value => createHash('sha256').update(value).digest('hex')
const source = await readFile(join(root, file), 'utf8')
const receipt = { schema: 'agentmux.startup-event-progress.v1', passed: false,
  sourceBefore: digest(source), testHashes: {}, runtimeControl: [], callers: [], cases: [] }
const mutations = [
  { label: 'unbounded-startup-overflow', before: 'if (pendingSessionEvents.overflowed) {', after: 'while (pendingSessionEvents.overflowed) {' },
  { label: 'quiet-replacement-fact-lost', before: 'entry.retainedFacts.set(JSON.stringify([dropped.event.hostId, identity, core.type]), dropped)', after: 'void identity' },
  { label: 'metadata-overflow-false-complete', before: 'source.sessionIds.length > 0 && !readOverflowed', after: 'source.sessionIds.length > 0' },
  { label: 'completed-overflow-read-discarded', before: 'const readOverflowed = entry.overflowed', after: 'if (entry.overflowed) continue\n        const readOverflowed = entry.overflowed' }
]
const config = join(evidence, 'vitest.loaded.config.mts')
const loadPath = join(evidence, 'current-loaded.json')
const run = async (label, loaded = true) => {
  await rm(loadPath, { force: true })
  const args = ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=1', '--config',
    loaded ? relative(root, config) : './vitest.config.ts', '--root', '.']
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  if (loaded) {
    try { result.loaded = JSON.parse(await readFile(loadPath, 'utf8')) }
    catch (error) { throw new Error(`Source did not load in ${label}: ${error.message}\n${result.output}`) }
    await writeFile(join(evidence, `${label}-loaded.json`), JSON.stringify(result.loaded, null, 2) + '\n')
  }
  return result
}
try {
  await mkdir(evidence, { recursive: true })
  // Same owning configuration/freshness checks; the only added plugin records the exact
  // Store bytes Vite really loads. No copied algorithm, Runtime process or GUI is involved.
  await writeFile(config, `import owning from '../../vitest.config';
import { defineConfig } from 'vitest/config';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export default defineConfig({ ...owning, plugins: [...(owning.plugins ?? []), {
  name: 'loaded-startup-store-proof', enforce: 'pre', transform(source, id) {
    if (id === ${JSON.stringify(join(root, file))}) writeFileSync(${JSON.stringify(loadPath)}, JSON.stringify({ file: ${JSON.stringify(file)}, sha256: createHash('sha256').update(source).digest('hex') }));
  }
}] });\n`)
  for (const test of tests) receipt.testHashes[test] = digest(await readFile(join(root, test)))
  for (const [caller, expression] of [
    ['apps/desktop/src/renderer/src/App.tsx', /beginRendererStartup\(\s*initialize,/],
    ['apps/desktop/src/renderer/src/lib/startup-progress.ts', /return initialize\(\)/]
  ]) {
    const text = await readFile(join(root, caller), 'utf8')
    assert.match(text, expression, `Missing outside-definition production caller: ${caller}`)
    receipt.callers.push({ file: caller, sha256: digest(text), nonempty: true })
  }
  assert.ok(receipt.callers.length > 0 && mutations.length > 0)
  const baseline = await run('baseline-green')
  assert.equal(baseline.code, 0, baseline.output); assert.match(baseline.output, /Tests\s+30 passed/)
  assert.equal(baseline.loaded.sha256, receipt.sourceBefore)
  for (const mutation of mutations) {
    assert.equal(source.split(mutation.before).length - 1, 1, `Nonunique mutation anchor: ${mutation.label}`)
    const mutant = source.replace(mutation.before, mutation.after)
    let red
    try {
      await writeFile(join(root, file), mutant)
      red = await run(`${mutation.label}-red`)
      assert.ok(red.code > 0 && red.signal === null, red.output)
      assert.match(red.output, /AssertionError/)
      assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      assert.doesNotMatch(red.output, /Unhandled Errors|No test files found|Error during global setup/)
      assert.equal(red.loaded.sha256, digest(mutant), 'Mutated Store must actually load')
    } finally { await writeFile(join(root, file), source) }
    const green = await run(`${mutation.label}-restore-green`)
    assert.equal(green.code, 0, green.output); assert.match(green.output, /Tests\s+30 passed/)
    assert.equal(green.loaded.sha256, receipt.sourceBefore)
    receipt.cases.push({ ...mutation, assertionRed: true, exit: red.code, loaded: red.loaded,
      restore: { exit: green.code, loaded: green.loaded }, log: `${mutation.label}-red.log` })
    console.log(`PASS ${mutation.label}: loaded AssertionRED -> exact restoreGREEN`)
  }
  receipt.sourceAfter = digest(await readFile(join(root, file)))
  assert.equal(receipt.sourceAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) {
  receipt.failure = { message: error.message, stack: error.stack }
} finally {
  await writeFile(join(root, file), source)
  await rm(config, { force: true }); await rm(loadPath, { force: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: relative(root, join(evidence, 'receipt.json')) }))
