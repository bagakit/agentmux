import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dirname, '../../..')
const proofRoot = await mkdtemp('/tmp/amx-lifecycle-feedback-')
const evidence = join(sourceRoot, 'docs/reviews/evidence/agent-launch-resume-feedback-2026-10-02')
const components = 'apps/desktop/src/renderer/src/components/'
const store = 'apps/desktop/src/renderer/src/store.ts'
const helper = 'apps/desktop/src/renderer/src/lib/agent-lifecycle-feedback.ts'
const test = 'apps/desktop/test/agent-launch-resume-feedback.test.tsx'
const inputs = [store, helper, components + 'AgentLifecycleFeedback.tsx', components + 'NewTabSurface.tsx',
  components + 'SessionPane.tsx', components + 'AgentSessionComposer.tsx', components + 'GlobalSystemNotices.tsx',
  'apps/desktop/src/renderer/src/lib/session-service-notices.ts', 'apps/desktop/src/renderer/src/App.tsx', test]
const digest = value => createHash('sha256').update(value).digest('hex')
const originals = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(sourceRoot, file))])))
const mutations = [
  ['launch-feedback-disconnected', components + 'NewTabSurface.tsx',
    '      {regionId ? <AgentLifecycleFeedback owner={{ regionId }} busy={busy !== null} retry={launchFromLauncher} /> : null}\n', '', 'actual creation'],
  ['resume-feedback-disconnected', components + 'SessionPane.tsx',
    "      {session.kind === 'agent' ? <AgentLifecycleFeedback owner={{ subject: session.control }}\n        busy={recovering} retry={() => void recover()} /> : null}\n", '', 'actual Resume failure'],
  ['restore-action-missing', helper, 'Review the reported cause, then retry Resume for this same Session. This failure does not stop other Sessions.',
    'Wait without a recovery action.', 'actual Resume failure'],
  ['old-run-allowed-to-report', store, '      if (!live || !sessionOwnsControl(live, current.control)) return\n',
    '      if (!live) return\n', 'a late old Run rejection'],
  ['duplicate-global-alarm', 'apps/desktop/src/renderer/src/App.tsx', 'error={lifecycleError ? null : error}', 'error={error}', 'the actual App offers']
]
const receipt = { schema: 'agentmux.agent-lifecycle-feedback-source-proof.v1', passed: false,
  sharedTreeMutations: [], sharedRuntimeControl: [], liveInput: [],
  inputs: Object.fromEntries([...originals].map(([file, bytes]) => [file, digest(bytes)])), cases: [], logs: {},
  scope: 'Exact copied Renderer owning source and test B=A; Core/layout/demand source and dist are copied dependencies, not a complete repository proof. Native behavior consumes T-001 historical private receipt.' }
const run = async (name, match) => {
  const args = ['exec', 'vitest', 'run', test, '--config', join(proofRoot, 'vitest.feedback.config.mts'), '--maxWorkers=1',
    ...(match ? ['-t', match] : [])]
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', args, { cwd: proofRoot, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes.toString() }); child.stderr.on('data', bytes => { output += bytes.toString() })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  const file = `${name}.log`; await writeFile(join(evidence, file), result.output)
  receipt.logs[file] = digest(result.output)
  return { ...result, log: file, command: `pnpm ${args.map(arg => JSON.stringify(arg)).join(' ')}` }
}
try {
  await mkdir(evidence, { recursive: true })
  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'vitest.setup.ts']) {
    try { await cp(join(sourceRoot, file), join(proofRoot, file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await symlink(join(sourceRoot, 'node_modules'), join(proofRoot, 'node_modules'))
  for (const pkg of ['core', 'layout', 'demand']) {
    const destination = join(proofRoot, 'packages', pkg); await mkdir(destination, { recursive: true })
    for (const entry of await readdir(join(sourceRoot, 'packages', pkg), { withFileTypes: true })) {
      if (['node_modules', 'vendor'].includes(entry.name)) continue
      await cp(join(sourceRoot, 'packages', pkg, entry.name), join(destination, entry.name), { recursive: true })
    }
    await symlink(join(sourceRoot, 'packages', pkg, 'node_modules'), join(destination, 'node_modules'))
  }
  const desktop = join(proofRoot, 'apps/desktop'); await mkdir(desktop, { recursive: true })
  for (const item of ['src', 'resources', 'package.json', 'tsconfig.json']) await cp(join(sourceRoot, 'apps/desktop', item), join(desktop, item), { recursive: true })
  await mkdir(join(desktop, 'node_modules/@agentmux'), { recursive: true })
  for (const entry of await readdir(join(sourceRoot, 'apps/desktop/node_modules'))) {
    if (entry === '@agentmux') continue
    await symlink(join(sourceRoot, 'apps/desktop/node_modules', entry), join(desktop, 'node_modules', entry))
  }
  for (const pkg of ['core', 'layout', 'demand']) await symlink(join(proofRoot, 'packages', pkg), join(desktop, 'node_modules/@agentmux', pkg))
  await mkdir(dirname(join(proofRoot, test)), { recursive: true }); await writeFile(join(proofRoot, test), originals.get(test))
  await writeFile(join(proofRoot, 'vitest.feedback.config.mts'), `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: [${JSON.stringify(test)}], setupFiles: [${JSON.stringify(join(proofRoot, 'vitest.setup.ts'))}] } });\n`)
  for (const [name, file, before, after, match] of mutations) {
    const source = originals.get(file).toString()
    assert.equal(source.split(before).length - 1, 1, `Unique source mutation: ${name}`)
    try {
      await writeFile(join(proofRoot, file), source.replace(before, after))
      const red = await run(name, match)
      assert.ok(red.code > 0 && red.signal === null, `${name}: process failure rather than assertion`)
      assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      receipt.cases.push({ name, file, before, after, exit: red.code, signal: red.signal, log: red.log, command: red.command })
    } finally { await writeFile(join(proofRoot, file), originals.get(file)) }
  }
  const green = await run('copied-control-green')
  assert.equal(green.code, 0, green.output); assert.equal(green.signal, null); assert.match(green.output, /Tests\s+6 passed/)
  receipt.green = { exit: green.code, signal: green.signal, log: green.log, command: green.command, tests: 6 }
  receipt.sourceAfter = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(sourceRoot, file)))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Selected actual source/test B=A')
  receipt.copyAfter = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(proofRoot, file)))])))
  assert.deepEqual(receipt.copyAfter, receipt.inputs, 'Copied control exact restoration')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(proofRoot, { recursive: true, force: true }); receipt.cleanup = { proofRootRemoved: true, remaining: [] }
  await writeFile(join(evidence, 'source-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, copiedControlTests: receipt.green.tests, sharedTreeMutations: 0, cleanup: receipt.cleanup }))
