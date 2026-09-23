import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Source-only owner proof: resolve the real Core source entry, never stale dist or a stub.
const root = resolve(import.meta.dirname, '../../..')
const file = 'apps/desktop/src/main/browser-outcome-criteria.ts'
const test = 'apps/desktop/test/browser-outcome-download-owner.test.ts'
const inputs = [file, test, 'apps/desktop/scripts/verify-browser-outcome-download-owner-mutations.mjs',
  'apps/desktop/src/main/browser-downloads.ts', 'apps/desktop/src/main/workspace-files.ts',
  'apps/desktop/src/main/browser-operation-journal.ts', 'apps/desktop/src/main/browser-outcome-journal.ts',
  'apps/desktop/src/main/browser-structured-output.ts', 'apps/desktop/src/shared/browser-structured-output.ts',
  'apps/desktop/src/shared/browser-outcome-criteria.ts', 'apps/desktop/src/shared/browser-download.ts',
  'apps/desktop/src/shared/workspace-file-bytes.ts', 'packages/core/src/index.ts',
  'packages/core/src/durable-write.ts', 'packages/core/src/execution-host.ts',
  'packages/core/src/process-runner.ts', 'packages/core/src/errors.ts']
const original = new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))])))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = entries => Object.fromEntries([...entries].map(([path, bytes]) => [path, digest(bytes)]))
const evidence = join(root, '.tmp', `browser-outcome-download-owner-mutations-${Date.now()}`)
const copy = await mkdtemp('/tmp/amx-outcome-download-owner-')
const receipt = { schema: 'agentmux.browser-download-outcome-source-mutations.v1', passed: false,
  sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
const mutations = [
  ['unconfirmed-failed-receipt-becomes-not-met', "if (receipt.status === 'failed') return result(condition, 'unavailable',", "if (receipt.status === 'failed') return result(condition, 'not-met',"],
  ['unconfirmed-failed-receipt-becomes-passed', "if (receipt.status === 'failed') return result(condition, 'unavailable',", "if (receipt.status === 'failed') return result(condition, 'passed',"],
  ['failed-branch-disconnected', "if (receipt.status === 'failed')", 'if (false)'],
  ['cancelled-receipt-confused-with-unavailable', "if (receipt.status !== 'completed') return result(condition, 'not-met',", "if (receipt.status !== 'completed') return result(condition, 'unavailable',"],
  ['all-download-conditions-return-empty-block', 'for (const condition of registration.criteria)', 'for (const condition of registration.criteria.slice(0, 0))']
]
const run = async label => {
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', join(copy, 'vitest.owner.config.mts'), '--maxWorkers=1'], {
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
  for (const path of ['package.json', 'vitest.setup.ts', 'tsconfig.base.json', 'packages/core/package.json']) {
    await mkdir(dirname(join(copy, path)), { recursive: true }); await cp(join(root, path), join(copy, path))
  }
  await cp(join(root, 'apps/desktop/src'), join(copy, 'apps/desktop/src'), { recursive: true })
  await cp(join(root, 'packages/core/src'), join(copy, 'packages/core/src'), { recursive: true })
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  await symlink(join(root, 'apps/desktop/node_modules'), join(copy, 'apps/desktop/node_modules'))
  await symlink(join(root, 'packages/core/node_modules'), join(copy, 'packages/core/node_modules'))
  for (const [path, bytes] of original) { await mkdir(dirname(join(copy, path)), { recursive: true }); await writeFile(join(copy, path), bytes) }
  await writeFile(join(copy, 'vitest.owner.config.mts'), `import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({ resolve: { alias: { '@agentmux/core': resolve(import.meta.dirname, 'packages/core/src/index.ts') } },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: [${JSON.stringify(test)}], setupFiles: [resolve(import.meta.dirname, 'vitest.setup.ts')] } });\n`)
  const baseline = await run('baseline-green')
  assert.equal(baseline.code, 0, baseline.output)
  for (const [label, before, after] of mutations) {
    const source = original.get(file).toString()
    assert.equal(source.split(before).length - 1, 1, `Unique mutation anchor: ${label}`)
    try {
      await writeFile(join(copy, file), source.replace(before, after))
      const red = await run(`${label}-red`)
      assert.ok(red.code > 0 && red.signal === null && !red.timedOut, red.output)
      assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      receipt.cases.push({ label, before, after, exit: red.code, log: red.log })
    } finally { await writeFile(join(copy, file), original.get(file)) }
    const green = await run(`${label}-restore-green`)
    assert.equal(green.code, 0, green.output)
    receipt.cases.at(-1).restore = { exit: green.code, log: green.log }
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))]))))
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(copy, path))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore); assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(copy, { recursive: true, force: true }); receipt.cleanup = { copyRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
