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
const receipt = { schema: 'agentmux.browser-operation-feedback-source.v1', taskId: 'T-024', passed: false,
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
    after: "    'pointer-events': 'auto', cursor: 'default', 'user-select': 'none', contain: 'layout style paint', overflow: 'hidden' })) {" },
  { label: 'actual-local-tween-block-removed', file: module,
    before: `  if (point && pointer && history && !media.matches && (history.point.x !== point.x || history.point.y !== point.y)) {
    // The action never awaits the browser's local animation or its finished promise.
    animation = pointer.animate([{ transform: \`translate(\${history.point.x}px,\${history.point.y}px)\` },
      { transform: \`translate(\${point.x}px,\${point.y}px)\` }], { duration: payload.moveMs, easing: 'cubic-bezier(0.2,0.8,0.2,1)' })
  }
`, after: '' },
  { label: 'history-uses-old-logical-destination', file: module,
    before: '      const r = pointer.getBoundingClientRect()', after: '      const r = { left: state.point.x, top: state.point.y }' },
  { label: 'actual-local-animation-completion-awaited', file: module,
    before: `    animation = pointer.animate([{ transform: \`translate(\${history.point.x}px,\${history.point.y}px)\` },
      { transform: \`translate(\${point.x}px,\${point.y}px)\` }], { duration: payload.moveMs, easing: 'cubic-bezier(0.2,0.8,0.2,1)' })
`, after: `    animation = pointer.animate([{ transform: \`translate(\${history.point.x}px,\${history.point.y}px)\` },
      { transform: \`translate(\${point.x}px,\${point.y}px)\` }], { duration: payload.moveMs, easing: 'cubic-bezier(0.2,0.8,0.2,1)' })
    return (async () => { await animation!.finished; return true })() as unknown as boolean
` },
  { label: 'expiry-invalidates-invisible-history', file: module,
    before: "    timer = setTimeout(() => state.hide('replace'), completed.completedMs)",
    after: "    timer = setTimeout(() => state.hide('invalidate'), completed.completedMs)" },
  { label: 'completion-rebuilds-host', file: module,
    before: `  if (payload.phase === 'completed' && previous) {
    previous.revision = payload.revision
    previous.complete(payload) // Preserve the actual host and any already-running move; completion never restarts it.
    return true
  }
`, after: '' },
  { label: 'queued-geometry-blind-clear', file: module,
    before: `  const onGeometry = () => {
    if (globals[key] !== state) return
    // scrollIntoView can queue a scroll after we measured its final rect. Only actual geometry changes invalidate it.
    if (visibleTarget && anchor) {
      const current = rectOf(visibleTarget)
      if (!current || !equal(anchor, current) || !equal(displayViewport, viewport())) invalidate()
    } else if (state.history && !equal(state.history.viewport, viewport())) invalidate()
  }
`, after: '  const onGeometry = () => { invalidate() }\n' },
  { label: 'actual-geometry-invalidation-removed', file: module,
    before: `  const onGeometry = () => {
    if (globals[key] !== state) return
    // scrollIntoView can queue a scroll after we measured its final rect. Only actual geometry changes invalidate it.
    if (visibleTarget && anchor) {
      const current = rectOf(visibleTarget)
      if (!current || !equal(anchor, current) || !equal(displayViewport, viewport())) invalidate()
    } else if (state.history && !equal(state.history.viewport, viewport())) invalidate()
  }
`, after: '  const onGeometry = () => {}\n' },
  { label: 'bridge-forgets-invisible-actual-source', file: module,
    before: "      if (reason === 'invalidate') bridge.source = null", after: '      bridge.source = null' },
  { label: 'reduced-motion-tween-enabled', file: module,
    before: '  if (point && pointer && history && !media.matches && (history.point.x !== point.x || history.point.y !== point.y)) {',
    after: '  if (point && pointer && history && (history.point.x !== point.x || history.point.y !== point.y)) {' },
  { label: 'reduced-motion-css-block-removed', file: module,
    before: '@media (prefers-reduced-motion: reduce){.pointer.hover svg,.executor.executing{animation:none}}', after: '' },
  { label: 'hover-local-arrow-scope-removed', file: module,
    before: "pointer = document.createElement('span'); pointer.className = payload.method === 'hover' ? 'pointer hover' : 'pointer'",
    after: "pointer = document.createElement('span'); pointer.className = 'pointer'" },
  { label: 'named-key-boundary-removed', file: module,
    before: "    this.keyLabel = typeof key === 'string' && named.includes(key) ? key : '⌨'",
    after: "    this.keyLabel = typeof key === 'string' ? key : '⌨'" },
  { label: 'executor-completion-loop-clear-removed', file: module,
    before: "    state.shadow?.querySelector('.executor')?.classList.remove('executing')\n", after: '' },
  { label: 'new-operation-history-retention-removed', file: manager,
    before: "    await entry.feedback?.clear('replace')", after: '    await entry.feedback?.clear()' },
  { label: 'readonly-wait-clear-consumer-removed', file: manager,
    before: "          } else await feedback?.clear(BROWSER_WAIT_PAGE_CALLS.has(name) ? 'invalidate' : 'replace')", after: '          }' },
  { label: 'failed-clear-retry-guard-removed', file: module,
    before: "      if (this.mode !== 'clear') void this.clear()", after: '      void this.clear()' },
  { label: 'already-invisible-history-clear-skipped', file: module,
    before: "  private async clearAt(generation: number, clearReason: FeedbackPayload['clearReason'] = 'invalidate'): Promise<void> {\n",
    after: "  private async clearAt(generation: number, clearReason: FeedbackPayload['clearReason'] = 'invalidate'): Promise<void> {\n    if (this.mode === 'clear' && !this.target) return\n" }
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
  const requested = process.argv[3]
  const selected = requested ? mutations.filter(mutation => mutation.label === requested) : mutations
  assert.ok(selected.length > 0, 'The selected actual Source mutation set is nonempty')
  receipt.selection = { requested: requested ?? null, labels: selected.map(mutation => mutation.label) }
  for (const mutation of selected) {
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
