import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// This closed source graph imports only errors.ts: no dist, Desktop, Runtime or GUI is executed.
const root = resolve(import.meta.dirname, '../../..')
const file = 'packages/core/src/browser-completion-facts.ts'
const test = 'packages/core/test/browser-completion-facts.test.ts'
const inputs = [file, test, 'packages/core/src/errors.ts', 'packages/core/scripts/verify-browser-completion-facts-mutations.mjs']
const original = new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))])))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = entries => Object.fromEntries([...entries].map(([path, bytes]) => [path, digest(bytes)]))
const evidence = join(root, '.tmp', `browser-completion-facts-mutations-${Date.now()}`)
const copy = await mkdtemp('/tmp/amx-completion-mutations-')
const receipt = { schema: 'agentmux.browser-completion-source-mutations.v1', passed: false,
  sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
const mutations = [
  ['original-operation-join-ignored', 'parsed.context.operationId !== identity(expected.operationId)', 'false'],
  ['foreign-browser-join-ignored', 'parsed.context.browserId !== identity(expected.browserId)', 'false'],
  ['extra-raw-request-or-approval-fields-accepted', 'Object.keys(result).some(key => !keys.includes(key))', 'false'],
  ['blank-identities-and-keys-accepted', '!value.trim()', 'false'],
  ['identity-utf8-byte-bound-disconnected', 'new TextEncoder().encode(result).length > 512', 'false'],
  ['unsupported-condition-status-accepted', "value !== 'passed' && value !== 'not-met' && value !== 'unavailable'", 'false'],
  ['unsafe-asset-version-accepted', 'if (!Number.isSafeInteger(run.version) || (run.version as number) < 1)', 'if (false)'],
  ['unsupported-scalar-accepted', "if (!(typeof expected === 'string' && expected.length <= 16 * 1024) &&\n        !(typeof expected === 'number' && Number.isFinite(expected)) && typeof expected !== 'boolean')", 'if (false)'],
  ['empty-conditions-produce-white-green', 'source.conditions.length < 1', 'false'],
  ['condition-count-bound-disconnected', 'source.conditions.length > MAX_CONDITIONS', 'false'],
  ['human-result-without-actual-version-accepted', "!parsed.assetRun && parsed.conditions.some(item => item.criterion.kind === 'human-checkpoint' && item.status !== 'unavailable')", 'false'],
  ['aggregate-disagrees-with-condition-facts', 'parsed.status !== aggregate', 'false'],
  ['unavailable-reclassified-as-not-met', "parsed.conditions.some(item => item.status === 'unavailable')", 'false'],
  ['all-returned-conditions-empty-block', 'parsed.conditions = source.conditions.map(value => {', 'parsed.conditions = source.conditions.slice(0, 0).map(value => {'],
  ['total-json-budget-disconnected', 'new TextEncoder().encode(JSON.stringify(parsed)).length > MAX_BYTES', 'false'],
  ['unicode-budget-counts-characters-instead-of-bytes', 'new TextEncoder().encode(JSON.stringify(parsed)).length > MAX_BYTES', 'JSON.stringify(parsed).length > MAX_BYTES'],
  ['unknown-workspace-guessed', 'context.workspaceId === null ? null', "context.workspaceId === null ? 'guessed-workspace'"],
  ['zero-false-empty-string-defaulted', 'return { kind: source.kind, key: text(source.key, 128), expected }', "return { kind: source.kind, key: text(source.key, 128), expected: expected || 'default' }"],
  ['caller-context-aliased', 'if (parsed.context.operationId !== identity(expected.operationId)', "parsed.context = source.context as AgentMuxBrowserCompletion['context']\n  if (parsed.context.operationId !== identity(expected.operationId)"],
  ['shared-notice-omits-retained-browser-work', "'Completion facts are unreadable; verification is unavailable. Existing Browser work remains.'", "'verification is unavailable'" ]
]
const run = async label => {
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', join(copy, 'vitest.config.mts'), '--maxWorkers=1'], {
      cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true
    })
    let output = '', timedOut = false, force
    const timeout = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 1000)
    }, 30_000)
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', error => { clearTimeout(timeout); clearTimeout(force); no(error) })
    child.on('close', (code, signal) => { clearTimeout(timeout); clearTimeout(force); yes({ code, signal, timedOut, output }) })
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
try {
  await mkdir(evidence, { recursive: true })
  await cp(join(root, 'package.json'), join(copy, 'package.json'))
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  for (const [path, bytes] of original) { await mkdir(dirname(join(copy, path)), { recursive: true }); await writeFile(join(copy, path), bytes) }
  await writeFile(join(copy, 'vitest.config.mts'), `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: [${JSON.stringify(test)}] } })\n`)
  const baseline = await run('baseline-green')
  assert.equal(baseline.code, 0, baseline.output)
  for (const [label, before, after] of mutations) {
    const source = original.get(file).toString()
    assert.equal(source.split(before).length - 1, 1, `Unique mutation anchor: ${label}`)
    try {
      await writeFile(join(copy, file), source.replace(before, after))
      const red = await run(`${label}-red`)
      assert.ok(red.code > 0 && red.signal === null && !red.timedOut, red.output)
      assert.match(red.output, /AssertionError/)
      assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      receipt.cases.push({ label, before, after, exit: red.code, log: red.log })
    } finally { await writeFile(join(copy, file), original.get(file)) }
    const green = await run(`${label}-restore-green`)
    assert.equal(green.code, 0, green.output)
    receipt.cases.at(-1).restore = { exit: green.code, log: green.log }
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))]))))
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(copy, path))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(copy, { recursive: true, force: true })
  receipt.cleanup = { copyRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
