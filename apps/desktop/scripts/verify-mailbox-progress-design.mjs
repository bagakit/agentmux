import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

assert.equal(process.argv[2], '--mutations', 'Use the approved private production mutation proof')
const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const temporary = await mkdtemp('/tmp/amx-progress-design-')
const evidence = join(root, '.tmp/mailbox-progress-design', 'mutations-' + Date.now())
const hash = value => createHash('sha256').update(value).digest('hex')
const file = 'apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx'
const original = await readFile(join(root, file), 'utf8')
const result = { schema: 'agentmux.mailbox-progress-design.v1', passed: false, sharedSourceWritten: false, mutations: [], cleanup: {} }
async function test(label, red) {
  let code = 0, output = ''
  try {
    const response = await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
      'apps/desktop/scripts/fixtures/mailbox-progress-design/vitest.config.mts', 'apps/desktop/test/continuous-progress-panel.test.tsx', '--maxWorkers=1'],
    { cwd: temporary, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    output = response.stdout + response.stderr
  } catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(join(evidence, label + '.log'), output)
  if (red) { assert.equal(typeof code, 'number'); assert.notEqual(code, 0); assert.match(output, /AssertionError:/, 'Actual mounted assertion fails, rather than import or timeout') }
  else assert.equal(code, 0, label + ': actual mounted candidate must pass')
  return { code, assertionRed: red, log: label + '.log' }
}
try {
  await mkdir(evidence, { recursive: true })
  for (const directory of ['apps/desktop/src', 'apps/desktop/test', 'apps/desktop/resources', 'packages/core/src', 'packages/demand/src', 'packages/layout/src'])
    await cp(join(root, directory), join(temporary, directory), { recursive: true, preserveTimestamps: true })
  for (const path of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'packages/core/package.json',
    'apps/desktop/scripts/fixtures/mailbox-progress-design/vitest.config.mts', 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts'])
    await cp(join(root, path), join(temporary, path), { preserveTimestamps: true })
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules'])
    await symlink(join(root, path), join(temporary, path), 'dir')
  result.originalSha256 = hash(original)
  result.baseline = await test('baseline', false)
  const cases = [
    { name: 'saved-prompt-truncated', from: '{displayed.prompt}', to: '{displayed.prompt.slice(0, 24)}' },
    { name: 'wrong-action-kind', from: 'api.continuousProgress.action(target, loop.loopId, kind)', to: "api.continuousProgress.action(target, loop.loopId, 'stop')" },
    { name: 'unknown-claimed-confirmed', from: "error || displayed?.lastOutcome === 'unknown' || observedTarget !== target", to: 'observedTarget !== target' }
  ]
  for (const item of cases) {
    assert.equal(original.split(item.from).length, 2, 'Exactly one actual production block is mutated')
    const changed = original.replace(item.from, item.to)
    await writeFile(join(evidence, item.name + '-mutated.tsx'), changed)
    await writeFile(join(temporary, file), changed)
    let red
    try { red = await test(item.name, true) }
    finally { await writeFile(join(temporary, file), original) }
    const restored = await test(item.name + '-restored', false)
    result.mutations.push({ ...item, file, originalSha256: hash(original), mutatedSha256: hash(changed), red, restored, restoredExactly: hash(await readFile(join(temporary, file))) === hash(original) })
  }
  assert.equal(hash(await readFile(join(root, file))), hash(original), 'Private proof does not write the shared product')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await rm(temporary, { recursive: true, force: true })
  result.cleanup.temporaryRootRemoved = true
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, evidence, failure: result.failure ?? null }))
if (!result.passed) process.exitCode = 1
