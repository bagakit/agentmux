import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

// Private actual source graph: Core imports its copied source index, never a stale compiled package.
const root = resolve(import.meta.dirname, '../../..')
const journal = 'apps/desktop/src/main/browser-operation-journal.ts'
const projector = 'apps/desktop/src/main/browser-completion-control.ts'
const control = 'packages/core/src/control-host.ts'
const leaf = 'apps/desktop/scripts/fixtures/browser-checked-stream-ack/source-proof.ts'
const tests = [leaf, 'apps/desktop/test/browser-operation-journal.test.ts',
  'apps/desktop/test/browser-completion-control.test.ts', 'packages/core/test/browser-completion-facts.test.ts']
const sources = [journal, projector, 'apps/desktop/src/main/browser-outcome-journal.ts',
  'apps/desktop/src/main/browser-structured-output.ts', 'apps/desktop/src/shared/browser-operation.ts',
  'apps/desktop/src/shared/browser-outcome-criteria.ts', 'apps/desktop/src/shared/browser-structured-output.ts',
  'apps/desktop/src/shared/browser-result-artifact.ts']
const mutations = [
  { label: 'ack-barrier-removed', file: journal,
    before: 'const pending = this.enqueue(event, false)', after: 'const pending = this.enqueue(event, true)\n    this.flush(operationId)' },
  { label: 'pending-backlog-published-early', file: journal,
    before: '.filter(event => event.operationId === operationId && this.eventFacts.get(event)?.published)',
    after: '.filter(event => event.operationId === operationId)' },
  { label: 'pending-history-published-early', file: journal,
    before: 'return events.filter(event => this.eventFacts.get(event)?.published).map(cloneEvent)', after: 'return events.map(cloneEvent)' },
  { label: 'later-phase-bypasses-own-queue', file: journal,
    before: 'this.enqueue(this.record(event), true)\n    this.flush(event.operationId)', after: 'this.deliver(this.record(event))' },
  { label: 'ack-order-bypassed', file: journal, before: 'pending.ready = true\n    this.flush(operationId)', after: 'pending.ready = true\n    this.deliver(event)' },
  { label: 'live-cursor-ignored', file: journal,
    before: 'related.get(id) !== subscriber || sequence <= subscriber.afterSequence', after: 'related.get(id) !== subscriber' },
  { label: 'checked-snapshot-replaced-by-newer-operation', file: journal,
    before: "const checked = (event.event as Extract<BrowserOperationEvent, { type: 'operation-finished' | 'operation-checked' }>).operation",
    after: 'const checked = cloneOperation(operation)' },
  { label: 'failed-save-notice-removed', file: journal,
    before: 'if (!saved && checked.outcome?.evaluation)', after: 'if (false && checked.outcome?.evaluation)' },
  { label: 'old-save-notice-contaminates-new-check', file: journal,
    before: 'if (operation.outcome === outcome && outcome.evaluation) outcome.evaluation.warning = notice',
    after: 'if (operation.outcome?.evaluation) operation.outcome.evaluation.warning = notice' },
  { label: 'check-reply-reads-newer-operation', file: journal,
    before: 'return { operation: cloneOperation(checked), saved }', after: 'return { operation: cloneOperation(operation), saved }' },
  { label: 'trimmed-history-renumbers-retained-events', file: journal,
    before: '.map(event => ({ sequence: this.eventFacts.get(event)!.sequence, event }))',
    after: '.map(event => ({ sequence: this.sequenced - this.document.events.length + this.document.events.indexOf(event) + 1, event }))' },
  { label: 'pending-trimmed-event-announced-lost', file: journal,
    before: 'this.deliveryQueues.get(operationId)?.entries[0]?.sequence ?? this.sequenced + 1', after: 'this.sequenced + 1' },
  { label: 'unrelated-consumers-dispatched', file: journal,
    before: 'const related = this.subscribers.get(event.operationId)',
    after: 'const related = new Map([...this.subscribers.values()].flatMap(group => [...group]))' },
  { label: 'zero-inactive-budget-removes-live-operation', file: journal,
    before: 'inactive.slice(inactive.length - keepInactive)', after: 'inactive.slice(-keepInactive)' },
  { label: 'old-dispose-removes-new-subscription-group', file: journal,
    before: 'related.size === 0 && this.subscribers.get(operationId) === related', after: 'related.size === 0' },
  { label: 'public-live-completion-consumer-removed', file: projector,
    before: "return 'operation' in event ? { ...event, operation: projectBrowserControlOperation(event.operation) } : event", after: 'return event' },
  { label: 'public-history-completion-consumer-removed', file: projector,
    before: "if (result.operation === 'browser.history') return { ...result, operations: result.operations.map(operation => projectBrowserControlOperation(operation)) }", after: "if (result.operation === 'browser.history') return result" },
  { label: 'public-opening-barrier-removed', file: control,
    before: 'if (!opened) beforeOpening.push(event)\n        else progress(event)', after: 'progress(event)' },
  { label: 'core-public-completion-consumer-removed', file: control,
    before: 'try { completion = parseBrowserCompletionFacts(source.completion, { operationId, browserId }) }',
    after: 'try { completion = undefined }' }
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = entries => Object.fromEntries([...entries].map(([path, bytes]) => [path, digest(bytes)]))
await mkdir(join(root, '.tmp'), { recursive: true })
const copy = await mkdtemp(join(root, '.tmp', 'browser-checked-ack-source-'))
const evidence = process.env.AGENTMUX_CHECKED_STREAM_MUTATION_OUTPUT
  ? resolve(root, process.env.AGENTMUX_CHECKED_STREAM_MUTATION_OUTPUT)
  : await mkdtemp(join(root, '.tmp', 'browser-checked-ack-evidence-'))
await mkdir(evidence, { recursive: true })
const sourceFiles = async path => {
  const found = []
  for (const item of await readdir(join(root, path), { withFileTypes: true })) {
    const child = `${path}/${item.name}`
    if (item.isDirectory()) found.push(...await sourceFiles(child))
    else if (item.isFile()) found.push(child)
  }
  return found
}
const inputs = [...new Set(['package.json', 'packages/core/package.json', ...await sourceFiles('packages/core/src'),
  ...tests, ...sources, relative(root, import.meta.filename)])]
assert.ok(inputs.length > 0 && mutations.length > 0)
const original = new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))])))
const receipt = { schema: 'agentmux.browser-checked-stream-source-mutations.v1', passed: false,
  sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
const run = async label => {
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', join(copy, 'vitest.ack.config.mts'), '--maxWorkers=1'],
      { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = '', timedOut = false, force
    const timeout = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM') } catch {}
      force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 1000) }, 40_000)
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', error => { clearTimeout(timeout); clearTimeout(force); no(error) })
    child.on('close', (code, signal) => { clearTimeout(timeout); clearTimeout(force); yes({ code, signal, timedOut, output }) })
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
try {
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  await mkdir(join(copy, 'apps/desktop'), { recursive: true })
  await symlink(join(root, 'apps/desktop/node_modules'), join(copy, 'apps/desktop/node_modules'))
  // This existing Journal test scans Manager for the sole id mint site; it never executes Manager.
  // Pin that read-only scan input separately so concurrent shared-glue work is explicitly observable.
  const managerPath = 'apps/desktop/src/main/browser-view-manager.ts'
  const managerBytes = await readFile(join(root, managerPath))
  receipt.scannerInput = { path: managerPath, sourceBefore: digest(managerBytes) }
  await mkdir(dirname(join(copy, managerPath)), { recursive: true })
  await writeFile(join(copy, managerPath), managerBytes)
  await mkdir(join(copy, 'packages/core'), { recursive: true })
  await symlink(join(root, 'packages/core/node_modules'), join(copy, 'packages/core/node_modules'))
  for (const [path, bytes] of original) { await mkdir(dirname(join(copy, path)), { recursive: true }); await writeFile(join(copy, path), bytes) }
  await writeFile(join(copy, 'vitest.ack.config.mts'), `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ resolve: { alias: { '@agentmux/core': ${JSON.stringify(join(copy, 'packages/core/src/index.ts'))} } }, test: { include: ${JSON.stringify(tests)}, environment: 'node', globalSetup: [], setupFiles: [] } })\n`)
  const baseline = await run('baseline-green')
  assert.equal(baseline.code, 0, baseline.output)
  receipt.baseline = { exit: baseline.code, log: baseline.log }
  for (const { label, file, before, after } of mutations) {
    const source = original.get(file).toString()
    assert.equal(source.split(before).length - 1, 1, `Unique actual source mutation anchor: ${label}`)
    try {
      await writeFile(join(copy, file), source.replace(before, after))
      const red = await run(`${label}-red`)
      assert.ok(red.code > 0 && red.signal === null && !red.timedOut, red.output)
      assert.match(red.output, /AssertionError/)
      assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      receipt.cases.push({ label, file, before, after, exit: red.code, log: red.log })
    } finally { await writeFile(join(copy, file), original.get(file)) }
    const green = await run(`${label}-restore-green`)
    assert.equal(green.code, 0, green.output)
    receipt.cases.at(-1).restore = { exit: green.code, log: green.log }
    console.log(`${label}: Assertion RED / restored GREEN`)
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.scannerInput.sourceAfter = digest(await readFile(join(root, receipt.scannerInput.path)))
  receipt.scannerInput.copyAfter = digest(await readFile(join(copy, receipt.scannerInput.path)))
  assert.equal(receipt.scannerInput.copyAfter, receipt.scannerInput.sourceBefore)
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(copy, path))]))))
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  for (const [path, bytes] of original) {
    const artifact = join(evidence, 'sources', `${path}.txt`)
    await mkdir(dirname(artifact), { recursive: true }); await writeFile(artifact, bytes)
  }
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(copy, { recursive: true, force: true })
  receipt.cleanup = { copyRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
