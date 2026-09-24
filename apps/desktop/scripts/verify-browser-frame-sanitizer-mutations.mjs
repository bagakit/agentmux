// Each incremental case freezes its own actual Source inputs. No shared-tree mutation.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const selected = process.argv[2]
assert.ok(['--case=url', '--case=marker'].includes(selected), 'Choose exactly one incremental case')
assert.equal(process.argv.length, 3)
const kind = selected.slice(7), expectedTests = 26
const tests = ['apps/desktop/test/browser-frame-probe-scenario.test.ts', 'apps/desktop/test/browser-ref-resolve.test.ts']
const helper = 'apps/desktop/scripts/browser-frame-probe-scenario.mjs'
const sources = [helper, 'apps/desktop/src/main/browser-selection.ts', 'apps/desktop/src/main/browser-ref-resolve.ts',
  'apps/desktop/src/main/browser-page-snapshot.ts', 'apps/desktop/src/main/browser-frame-documents.ts',
  'apps/desktop/src/main/browser-snapshot-query.ts', 'apps/desktop/src/shared/browser-snapshot-query.ts',
  'apps/desktop/scripts/verify-browser-frame-sanitizer-mutations.mjs']
const mutations = {
  url: { label: 'sanitized-url-exact-join-removed', before: "    const nativeUrl = new URL(native.url)\n    nativeUrl.username = ''; nativeUrl.password = ''; nativeUrl.search = ''; nativeUrl.hash = ''\n    assert.equal(new URL(context.selection.pageUrl).href, nativeUrl.href)", after: '' },
  marker: { label: 'real-sanitized-id-marker-replaced-by-url', before: "const document = context.selection.attributes.id?.replace(/^frame-action-/, '')", after: 'const document = fixtureName(context.selection.pageUrl)' }
}
const mutation = mutations[kind], digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [...tests, ...sources]
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const privateRoot = await mkdtemp('/tmp/agentmux-frame-sanitizer-source-')
const evidence = await mkdtemp(join(root, `.tmp/browser-frame-${kind}-sanitizer-source-`))
const receipt = { schema: 'agentmux.browser-frame-sanitizer-increment-mutations.v1', kind, passed: false,
  sourceBefore: hashes(original), expectedTests, sharedTreeMutations: 0, cases: [],
  boundary: 'Actual production selection sanitizer plus Native scenario oracle/generated programs and ref owner with fake CDP. No Native, socket producer, build, installed artifact or ordinary application restart.' }
async function run(label) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', ...tests, '--config', join(privateRoot, 'vitest.mutation.config.mts'), '--maxWorkers=1'],
      { cwd: privateRoot, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 30_000)
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, output }) })
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
const green = result => {
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, new RegExp(`Tests\\s+${expectedTests} passed`))
}
try {
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json']) {
    await mkdir(dirname(join(privateRoot, file)), { recursive: true }); await cp(join(root, file), join(privateRoot, file))
  }
  await symlink(join(root, 'node_modules'), join(privateRoot, 'node_modules'))
  for (const [file, bytes] of original) {
    await mkdir(dirname(join(privateRoot, file)), { recursive: true }); await writeFile(join(privateRoot, file), bytes)
    await mkdir(dirname(join(evidence, 'source', `${file}.txt`)), { recursive: true }); await writeFile(join(evidence, 'source', `${file}.txt`), bytes)
  }
  await writeFile(join(privateRoot, 'vitest.mutation.config.mts'), `import { defineConfig } from 'vitest/config';export default defineConfig({test:{include:${JSON.stringify(tests)},setupFiles:[${JSON.stringify(join(privateRoot, 'vitest.setup.ts'))}]}});`)
  green(await run('baseline-green'))
  const source = original.get(helper).toString(); assert.equal(source.split(mutation.before).length - 1, 1, mutation.label)
  try {
    await writeFile(join(privateRoot, helper), source.replace(mutation.before, mutation.after))
    const red = await run(`${mutation.label}-red`)
    assert.ok(red.code > 0 && !red.timedOut && red.signal === null, red.output)
    assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
    receipt.cases.push({ ...mutation, file: helper, exit: red.code, log: red.log })
  } finally { await writeFile(join(privateRoot, helper), original.get(helper)) }
  const restored = await run(`${mutation.label}-restore-green`); green(restored)
  receipt.cases[0].restore = { exit: restored.code, log: restored.log }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(privateRoot, file))]))))
  assert.deepEqual(receipt.sourceBefore, receipt.sourceAfter); assert.deepEqual(receipt.sourceBefore, receipt.copyAfter)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup = { copyRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, kind, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
assert.equal(receipt.passed, true, receipt.failure?.message)
