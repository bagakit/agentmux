import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Run exact Renderer tests against private copied sources; never mutate the shared worktree. */
export async function verifyRendererSourceMutations({ name, tests, sources, mutations }) {
  const root = resolve(import.meta.dirname, '../../../..')
  const copy = await mkdtemp('/tmp/amx-renderer-mutation-')
  const evidence = join(root, '.tmp', name)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const inputs = [...new Set([...tests, ...sources])]
  const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
  const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
  const receipt = { schema: 'agentmux.renderer-source-mutation.v1', passed: false, name,
    sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
  const run = async label => {
    const args = ['exec', 'vitest', 'run', ...tests, '--config', join(copy, 'vitest.mutation.config.mts'), '--maxWorkers=1']
    const result = await new Promise((yes, no) => {
      const child = spawn('pnpm', args, { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
    })
    await writeFile(join(evidence, `${label}.log`), result.output)
    return { ...result, log: `${label}.log` }
  }
  try {
    await mkdir(evidence, { recursive: true })
    for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts']) await cp(join(root, file), join(copy, file))
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
    for (const pkg of ['core', 'layout', 'demand']) {
      const destination = join(copy, 'packages', pkg)
      await mkdir(destination, { recursive: true })
      for (const entry of await readdir(join(root, 'packages', pkg))) {
        if (['node_modules', 'vendor'].includes(entry)) continue
        await cp(join(root, 'packages', pkg, entry), join(destination, entry), { recursive: true })
      }
      await symlink(join(root, 'packages', pkg, 'node_modules'), join(destination, 'node_modules'))
    }
    const desktop = join(copy, 'apps/desktop')
    await mkdir(desktop, { recursive: true })
    for (const file of ['src', 'resources', 'package.json', 'tsconfig.json']) await cp(join(root, 'apps/desktop', file), join(desktop, file), { recursive: true })
    await mkdir(join(desktop, 'node_modules/@agentmux'), { recursive: true })
    for (const entry of await readdir(join(root, 'apps/desktop/node_modules'))) {
      if (entry !== '@agentmux') await symlink(join(root, 'apps/desktop/node_modules', entry), join(desktop, 'node_modules', entry))
    }
    for (const pkg of ['core', 'layout', 'demand']) await symlink(join(copy, 'packages', pkg), join(desktop, 'node_modules/@agentmux', pkg))
    for (const [file, bytes] of original) { await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes) }
    await writeFile(join(copy, 'vitest.mutation.config.mts'), `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: ${JSON.stringify(tests)}, setupFiles: [${JSON.stringify(join(copy, 'vitest.setup.ts'))}] } });\n`)
    const baseline = await run('baseline-green')
    assert.equal(baseline.code, 0, baseline.output)
    for (const { label, file, before, after } of mutations) {
      const source = original.get(file).toString()
      assert.equal(source.split(before).length - 1, 1, `Unique mutation anchor: ${label}`)
      try {
        await writeFile(join(copy, file), source.replace(before, after))
        const red = await run(`${label}-red`)
        assert.ok(red.code > 0 && red.signal === null, red.output)
        assert.match(red.output, /AssertionError/)
        assert.match(red.output, /Tests\s+[1-9]\d* failed/)
        receipt.cases.push({ label, file, before, after, exit: red.code, log: red.log })
      } finally { await writeFile(join(copy, file), original.get(file)) }
      const green = await run(`${label}-restore-green`)
      assert.equal(green.code, 0, green.output)
      receipt.cases.at(-1).restore = { exit: green.code, log: green.log }
    }
    receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
    assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
    receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
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
}
