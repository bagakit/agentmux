import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.argv[2] ?? join(root, '.tmp', `browser-operation-feedback-mutations-${Date.now()}`))
const copy = await mkdtemp('/tmp/amx-operation-feedback-source-')
const module = 'apps/desktop/src/main/browser-operation-feedback.ts'
const dispatcher = 'apps/desktop/src/main/browser-page-dispatch.ts'
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const config = 'apps/desktop/scripts/fixtures/browser-operation-feedback/vitest.owning.config.mts'
const inputs = [module, dispatcher, manager, 'apps/desktop/test/browser-operation-feedback.test.ts',
  'apps/desktop/test/browser-page-action-feedback.test.ts', config,
  'apps/desktop/scripts/fixtures/browser-operation-feedback/tsconfig.owning.json',
  'apps/desktop/scripts/verify-browser-operation-feedback-mutations.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
let evidenceCreated = false
const receipt = { schema: 'agentmux.browser-operation-feedback-source.v1', passed: false,
  observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBefore: hashes(originals), sharedTreeMutations: 0, nativeRuns: 0, runtimeControl: [], cases: [] }
const hook = `    if (actionFeedback && feedback !== 'observe') {
      if (feedback) {
        const prepared = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: feedback.scroll,
          awaitPromise: true, returnByValue: true }) as { exceptionDetails?: { text?: string } }
        if (prepared.exceptionDetails) throw new Error(\`The page threw while preparing \${ref}: \${pageAuthoredText(prepared.exceptionDetails.text)}\`)
        guard()
        declaration = feedback.action
      }
      await actionFeedback(node, send)
      // Display work can yield to real takeover, navigation or stop. Recheck before the original action.
      guard()
    }
`
const mutations = [
  { label: 'actual-resolved-hook-removed', file: dispatcher, before: hook, after: '' },
  { label: 'post-display-action-scope-guard-removed', file: manager,
    before: '          value = await dispatch(name, args, { beforeAction: () => beforeAction(step),\n',
    after: '          value = await dispatch(name, args, {\n' },
  { label: 'resolved-navigation-last-guard-removed', file: dispatcher,
    before: `      if (context.pageInfo().navigationId !== navigationId) throw new BrowserLocalRecoveryFailure(
        'The original document changed before this action was dispatched. Take a new snapshot().', 'locator-changed', 'not-dispatched')
`, after: '' },
  { label: 'resolved-frame-sender-last-guard-removed', file: dispatcher,
    before: `      if (node.sessionId && session.frames.get(node.sessionId) !== send) throw new BrowserLocalRecoveryFailure(
        'The original frame sender changed before this action was dispatched. Take a new snapshot().', 'locator-changed', 'not-dispatched')
`, after: '' },
  { label: 'old-owner-clear-accepted', file: module,
    before: "  if (previous && payload.phase !== 'running' && (previous.operationId !== payload.operationId || previous.navigationId !== payload.navigationId || previous.token !== payload.token)) return false\n", after: '' },
  { label: 'passive-host-hit-surface-enabled', file: module,
    before: "    'pointer-events': 'none', cursor: 'default', 'user-select': 'none', contain: 'layout style paint', overflow: 'hidden' })) {",
    after: "    'pointer-events': 'auto', cursor: 'default', 'user-select': 'none', contain: 'layout style paint', overflow: 'hidden' })) {" }
]

async function run(label) {
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1'],
      { cwd: copy, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
function green(result, expected) {
  assert.equal(result.code, 0, result.output)
  const files = /Test Files\s+(\d+) passed \((\d+)\)/.exec(result.output)
  const tests = /Tests\s+(\d+) passed \((\d+)\)/.exec(result.output)
  assert.ok(files && tests, 'Both actual owning suites must run with a nonempty result')
  assert.equal(Number(files[1]), 2); assert.equal(files[1], files[2])
  assert.ok(Number(tests[1]) > 0); assert.equal(tests[1], tests[2])
  if (expected) assert.equal(Number(tests[1]), expected)
  return Number(tests[1])
}
async function inventory(directory, prefix = '') {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const relative = join(prefix, entry.name), file = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await inventory(file, relative))
    else { const bytes = await readFile(file); result[relative] = { sha256: digest(bytes), bytes: bytes.length } }
  }
  return result
}
try {
  await mkdir(dirname(evidence), { recursive: true }); await mkdir(evidence); evidenceCreated = true
  // Small Source projection only: no Renderer, resources, compiled output, reviews or whole-repository copy.
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json',
    'apps/desktop/tsconfig.json', 'packages/core/package.json']) {
    await mkdir(dirname(join(copy, file)), { recursive: true }); await cp(join(root, file), join(copy, file))
  }
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared', 'packages/core/src']) {
    await cp(join(root, directory), join(copy, directory), { recursive: true })
  }
  for (const [file, bytes] of originals) { await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes) }
  for (const directory of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules']) {
    await symlink(join(root, directory), join(copy, directory))
  }
  receipt.projection = await inventory(copy)
  assert.ok(Object.keys(receipt.projection).length > inputs.length)
  receipt.projectionBytes = Object.values(receipt.projection).reduce((sum, item) => sum + item.bytes, 0)
  await writeFile(join(evidence, 'source-projection.json'), `${JSON.stringify(receipt.projection, null, 2)}\n`)
  // Preserve the actual original Source bytes, independent of temporary copy cleanup.
  execFileSync('tar', ['-czf', join(evidence, 'source-projection.tar.gz'), '--exclude=node_modules', '-C', copy, '.'])
  const baseline = await run('baseline-green')
  const count = green(baseline); receipt.baseline = { exit: baseline.code, log: baseline.log, tests: count }
  for (const mutation of mutations) {
    const source = originals.get(mutation.file).toString()
    assert.equal(source.split(mutation.before).length - 1, 1, `Unique actual Source block: ${mutation.label}`)
    console.log(`Source mutation: ${mutation.label}`)
    let red
    try {
      await writeFile(join(copy, mutation.file), source.replace(mutation.before, mutation.after))
      red = await run(`${mutation.label}-red`)
      assert.ok(red.code > 0 && red.signal === null, red.output)
      assert.match(red.output, /AssertionError/)
      assert.match(red.output, /Tests\s+[1-9]\d* failed/)
    } finally { await writeFile(join(copy, mutation.file), originals.get(mutation.file)) }
    const restored = await run(`${mutation.label}-restore-green`)
    green(restored, count)
    receipt.cases.push({ ...mutation, red: { exit: red.code, log: red.log }, restore: { exit: restored.code, log: restored.log, tests: count } })
    console.log(`Assertion RED / restored ${count} GREEN: ${mutation.label}`)
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(copy, { recursive: true, force: true })
  receipt.cleanup = { privateSourcePath: copy, removed: true, unrelatedPathsRemoved: [] }
  if (evidenceCreated) await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
