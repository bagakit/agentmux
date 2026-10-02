import { tmpdir as fixtureTmpdir } from 'node:os'
import { join as fixtureJoin, sep as fixtureSep } from 'node:path'
const fixtureRootPath = relative => { const temporary = relative.replace(/^(?:private\/)?tmp\//u, ''); return (temporary === relative ? fixtureJoin(fixtureTmpdir(), 'agentmux-fixtures') : fixtureTmpdir()) + fixtureSep + temporary.replaceAll('/', fixtureSep) }
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Mutations run in a private compiled copy; no shared source, output or user Runtime is mutated. */
export async function runA2aProof({ name, tests, regressionTests = [], mutations, callers, sourceInputs, environment }) {
  const evidence = join(root, '.tmp', `${name}-${Date.now()}`)
  const copy = await realpath(await mkdtemp(fixtureRootPath("tmp/amx-a2a-proof-")))
  const core = join(copy, 'core'), dist = join(core, 'dist')
  const inputs = [...new Set([...sourceInputs, ...tests, ...regressionTests, ...callers.map(item => item.path)])]
  const sourceHashes = async () => Object.fromEntries(await Promise.all(inputs.map(async path => [path, hash(await readFile(join(root, path)))])))
  const receipt = { schema: 'agentmux.a2a-protocol-proof.v1', name, privateCopyRoot: copy, passed: false, sharedTreeMutations: 0, cases: [] }
  const originals = new Map()
  const run = async (label, selectedTests = tests, testRoot = root) => {
    const outputPath = join(evidence, `${label}.json`)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...selectedTests,
        ...(testRoot === copy ? ['--config', join(copy, 'vitest.config.mts')] : []),
        '--maxWorkers=1', '--reporter=json', `--outputFile=${outputPath}`], {
        cwd: testRoot, env: { ...process.env, ...environment({ core, dist, url: path => pathToFileURL(join(dist, path)).href }) },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      child.on('error', no)
      child.on('close', (code, signal) => yes({ code, signal, output }))
    })
    await writeFile(join(evidence, `${label}.log`), result.output)
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.ok(report.numTotalTests > 0, `${label}: no tests were collected`)
    assert.equal(result.signal, null, `${label}: test process was interrupted`)
    return { exit: result.code, tests: report.numTotalTests, failed: report.numFailedTests,
      assertionFailures: report.testResults.flatMap(item => item.assertionResults).filter(item => item.status === 'failed')
        .flatMap(item => item.failureMessages).filter(message => message.includes('AssertionError') || /__VITEST_(?:REJECTS|RESOLVES)__/u.test(message)).length,
      log: `${label}.log`, report: `${label}.json` }
  }
  try {
    await mkdir(evidence, { recursive: true })
    receipt.sourceBefore = await sourceHashes()
    await mkdir(core, { recursive: true })
    await cp(join(root, 'packages/core/dist'), dist, { recursive: true })
    await writeFile(join(core, 'package.json'), '{"type":"module"}\n')
    for (const entry of ['vendor', 'bin', 'node_modules']) await symlink(join(root, 'packages/core', entry), join(core, entry))
    const projectTests = [...new Set(mutations.flatMap(mutation => mutation.projectTests ?? []))]
    if (projectTests.length) {
      // Registered IPC tests retain their real relative module graph and local mocks in this copy.
      await cp(join(root, 'apps/desktop/src'), join(copy, 'apps/desktop/src'), { recursive: true })
      await cp(join(root, 'apps/desktop/browser-extension'), join(copy, 'apps/desktop/browser-extension'), { recursive: true })
      await cp(join(root, 'apps/desktop/test/helpers'), join(copy, 'apps/desktop/test/helpers'), { recursive: true })
      await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
      await symlink(join(root, 'apps/desktop/node_modules'), join(copy, 'apps/desktop/node_modules'))
      await writeFile(join(copy, 'package.json'), '{"type":"module"}\n')
      for (const test of projectTests) {
        await mkdir(resolve(join(copy, test), '..'), { recursive: true })
        await cp(join(root, test), join(copy, test))
      }
      await writeFile(join(copy, 'vitest.config.mts'), `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ esbuild: { jsx: 'automatic' }, server: { fs: { allow: ${JSON.stringify([root, copy])} } }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: ${JSON.stringify(projectTests)} } })\n`)
    }
    for (const mutation of mutations) {
      if (!originals.has(mutation.file)) originals.set(mutation.file, await readFile(join(dist, mutation.file), 'utf8'))
    }
    receipt.executionInputs = Object.fromEntries([...originals].map(([file, bytes]) => [file, hash(bytes)]))
    receipt.baseline = await run('baseline-green')
    assert.equal(receipt.baseline.exit, 0, `Baseline failed: ${receipt.baseline.log}`)
    if (regressionTests.length) {
      receipt.regression = await run('existing-restart-green', regressionTests)
      assert.equal(receipt.regression.exit, 0, `Existing restart regression failed: ${receipt.regression.log}`)
    }
    if (projectTests.length) {
      receipt.privateProjectBaseline = await run('registered-ipc-baseline-green', projectTests, copy)
      assert.equal(receipt.privateProjectBaseline.exit, 0, `Registered IPC baseline failed: ${receipt.privateProjectBaseline.log}`)
    }
    for (const mutation of mutations) {
      const original = originals.get(mutation.file)
      assert.equal(original.split(mutation.before).length - 1, 1, `Unique mutation anchor: ${mutation.label}`)
      let red
      try {
        await writeFile(join(dist, mutation.file), original.replace(mutation.before, mutation.after))
        red = await run(`${mutation.label}-red`, mutation.projectTests ?? tests, mutation.projectTests ? copy : root)
        assert.ok(red.exit > 0 && red.failed > 0 && red.assertionFailures > 0,
          `Mutation must fail a behavior assertion: ${mutation.label} (${red.log})`)
      } finally { await writeFile(join(dist, mutation.file), original) }
      const restored = await run(`${mutation.label}-restore-green`, mutation.projectTests ?? tests, mutation.projectTests ? copy : root)
      assert.equal(restored.exit, 0, `Restore failed: ${restored.log}`)
      receipt.cases.push({ label: mutation.label, file: mutation.file, red, restored })
      process.stdout.write(`${mutation.label}: RED -> GREEN\n`)
    }
    // Every definition-excluded path below is a product caller, not a test inventory.
    receipt.callers = await Promise.all(callers.map(async ({ symbol, path }) => {
      const source = await readFile(join(root, path), 'utf8')
      const lines = source.split('\n').flatMap((line, index) => line.includes(symbol) ? [{ line: index + 1, text: line.trim() }] : [])
      assert.ok(lines.length > 0, `${symbol}: no production caller in ${path}`)
      return { symbol, path, lines }
    }))
    assert.ok(receipt.callers.length > 0)
    receipt.sourceAfter = await sourceHashes()
    assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
    for (const [file, bytes] of originals) assert.equal(await readFile(join(dist, file), 'utf8'), bytes)
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  finally {
    await rm(copy, { recursive: true, force: true })
    receipt.cleanup = { privateCopyRemoved: true }
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  }
  assert.equal(receipt.passed, true, receipt.failure?.message)
  process.stdout.write(`${JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') })}\n`)
}
