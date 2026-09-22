import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Exact Node-only tests. This runner does not import Electron or launch a window.
const root = resolve(import.meta.dirname, '../../..')
const sourceFile = 'apps/desktop/scripts/browser-native-restart-lifecycle-observer.mjs'
const testFile = 'apps/desktop/test/browser-native-restart-lifecycle-observer.test.ts'
const mutations = [
  { label: 'ready-observation-installed-too-late', before: "app.once('ready', install)", after: "app.once('after-ready', install)" },
  { label: 'created-contents-missed', before: "listen(app, 'web-contents-created',", after: "listen(app, 'wrong-contents-created'," },
  { label: 'attachment-observation-missing', before: "['addChildView', 'removeChildView', 'setBounds', 'setVisible']", after: "['removeChildView', 'setBounds', 'setVisible']" },
  { label: 'policy-observation-missing', before: "wrap(prototype, 'setBackgroundThrottling',", after: "void (prototype, 'setBackgroundThrottling'," },
  { label: 'original-argument-object-replaced', before: 'const value = Reflect.apply(original, this, args)', after: 'const value = Reflect.apply(original, this, args.map(item => typeof item === \'object\' && item !== null ? { ...item } : item))' },
  { label: 'original-return-identity-replaced', before: '        return value', after: '        return { originalValue: value }' },
  { label: 'original-error-identity-replaced', before: '        throw error', after: "        throw new Error('Replacement diagnostic error')" },
  { label: 'returned-promise-inspected', before: '        return value', after: '        try { void value?.then } catch {}; return value' },
  { label: 'event-budget-lost', before: 'if (events.length >= limits.events) { dropped++; return }', after: 'if (false) { dropped++; return }' },
  { label: 'restore-overwrites-later-observer', before: "if (Object.getOwnPropertyDescriptor(owner, name)?.value === observed)", after: 'if (true)' },
  { label: 'unavailable-fact-presented-as-success', before: 'return { unavailable: errorKind(error) }', after: 'return { value: false }' },
  { label: 'excess-contents-getter-work', before: '!active || !eligible(this)', after: '!active' },
  { label: 'own-native-setter-missed', before: 'let prototype = /** @type {object | null} */ (wc)', after: 'let prototype = Object.getPrototypeOf(wc)' },
  { label: 'created-frame-details-dropped', before: "listen(wc, 'frame-created',", after: "listen(wc, 'wrong-frame-created'," },
  { label: 'url-query-and-credentials-retained', before: "const url = new URL(raw); return url.protocol === 'data:'", after: "return raw; const url = new URL(raw); return url.protocol === 'data:'" }
]
const inputs = [sourceFile, testFile, 'apps/desktop/scripts/verify-browser-native-restart-lifecycle-observer-mutations.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const output = join(root, '.tmp', `native-restart-lifecycle-source-${Date.now()}`)
const copy = await mkdtemp('/tmp/amx-native-lifecycle-source-')
const receipt = { schema: 'agentmux.native-restart-lifecycle-source.v1', passed: false,
  testsEnvironment: 'Node models only; no Electron runtime, GUI, out, build or native-frame claim',
  sourceBefore: hashes(originals), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
const run = async label => {
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.config.mts', '--maxWorkers=1'],
      { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stdout += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, stdout }))
  })
  await writeFile(join(output, `${label}.log`), result.stdout)
  return { exit: result.code, signal: result.signal, log: `${label}.log`, stdout: result.stdout }
}
try {
  await mkdir(output, { recursive: true })
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  await writeFile(join(copy, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(copy, 'vitest.config.mts'), `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'node', include: [${JSON.stringify(testFile)}] } });\n`)
  for (const [file, bytes] of originals) {
    await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes)
    await mkdir(dirname(join(output, `${file}.txt`)), { recursive: true }); await writeFile(join(output, `${file}.txt`), bytes)
  }
  const baseline = await run('baseline-green')
  assert.equal(baseline.exit, 0, baseline.stdout)
  receipt.baseline = { exit: baseline.exit, log: baseline.log }
  for (const { label, before, after } of mutations) {
    const source = originals.get(sourceFile).toString()
    assert.equal(source.split(before).length - 1, 1, `Unique mutation anchor: ${label}`)
    try {
      const mutated = source.replace(before, after)
      await writeFile(join(copy, sourceFile), mutated)
      await writeFile(join(output, `${label}.source.txt`), mutated)
      const red = await run(`${label}-red`)
      assert.ok(red.exit > 0 && red.signal === null, red.stdout)
      assert.match(red.stdout, /AssertionError/)
      assert.match(red.stdout, /Tests\s+[1-9]\d* failed/)
      receipt.cases.push({ label, exit: red.exit, log: red.log, sourceSha: digest(mutated) })
    } finally { await writeFile(join(copy, sourceFile), originals.get(sourceFile)) }
    const green = await run(`${label}-restore-green`)
    assert.equal(green.exit, 0, green.stdout)
    receipt.cases.at(-1).restore = { exit: green.exit, log: green.log }
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(copy, { recursive: true, force: true }); receipt.cleanup = { copyRemoved: true }
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
console.log(JSON.stringify({ passed: receipt.passed, mutants: receipt.cases.length, receipt: join(output, 'receipt.json') }))
assert.equal(receipt.passed, true, receipt.failure?.message)
