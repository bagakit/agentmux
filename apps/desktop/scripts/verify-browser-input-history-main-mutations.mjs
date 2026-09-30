import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.argv[2] ?? join(root, '.tmp', `browser-input-history-main-mutations-${Date.now()}`))
const copy = await mkdtemp('/tmp/amx-input-history-source-')
const store = 'apps/desktop/src/main/browser-input-history.ts'
const ipc = 'apps/desktop/src/main/ipc.ts'
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const config = 'apps/desktop/scripts/fixtures/browser-input-history/vitest.main.config.mts'
const inputs = [store, ipc, manager, 'apps/desktop/src/main/ipc-sender-trust.ts',
  'apps/desktop/src/shared/browser-input-history.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/test/browser-input-history-store.test.ts', 'apps/desktop/test/browser-input-history-ipc.test.ts',
  config, 'apps/desktop/scripts/fixtures/browser-input-history/vitest.process.config.mts',
  'apps/desktop/scripts/fixtures/browser-input-history/process.test.ts',
  'apps/desktop/scripts/fixtures/browser-input-history/tsconfig.main.json',
  'apps/desktop/scripts/verify-browser-input-history-main-mutations.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const recordBinding = `  handleWithEvent('browser:recordInputHistory', async (event, target: BrowserInputHistoryTarget, text: string) => {
    requireTrustedSender('browser:recordInputHistory', event)
    return await browserInputHistory.record(resolveInputHistoryScope(target), text)
  })
`
const mutations = [
  { label: 'durable-write-removed', file: store, test: 'keeps exact trimmed query',
    before: '    await durableWriteFile(this.path(scope), document)\n', after: '' },
  { label: 'workspace-missing-from-file-scope', file: store, test: 'isolates real Workspace',
    before: '.update(JSON.stringify([scope.workspaceId, scope.profileId]))', after: '.update(JSON.stringify([scope.profileId]))' },
  { label: 'userinfo-persisted', file: store, test: 'excludes entire URL userinfo',
    before: "      if (hasUrlUserinfo(text)) return { scope: actualScope, entries, outcome: 'url-userinfo' }\n", after: '' },
  { label: 'actual-read-collection-emptied', file: store, test: 'keeps exact trimmed query',
    before: '      return document.entries\n', after: '      return []\n' },
  { label: 'entry-count-pruning-removed', file: store, test: 'bounds actual count',
    before: '        .slice(0, MAX_BROWSER_INPUT_HISTORY_ENTRIES)\n', after: '\n' },
  { label: 'serialized-byte-pruning-removed', file: store, test: 'bounds actual count',
    before: "      while (Buffer.byteLength(this.document(actualScope, next), 'utf8') > MAX_BROWSER_INPUT_HISTORY_FILE_BYTES) next.pop()\n", after: '' },
  { label: 'deduplication-removed', file: store, test: 'keeps exact trimmed query',
    before: '...entries.filter(entry => entry.text !== text)', after: '...entries' },
  { label: 'resource-workspace-replaced-by-display', file: manager, test: 'round-trips real durable history',
    before: '    return { workspaceId: entry.workspaceId, profileId: entry.profileId }\n',
    after: "    return { workspaceId: 'display-workspace', profileId: entry.profileId }\n" },
  { label: 'confirmed-profile-guard-removed', file: manager, test: 'uses the actual Profile manager',
    before: "    if (entry.profileId !== profileId) throw new Error('The Browser Profile changed before input history was requested.')\n", after: '' },
  { label: 'stale-delete-scope-accepted', file: ipc, test: 'uses the actual Profile manager',
    before: `    if (expected?.workspaceId !== scope.workspaceId || expected?.profileId !== scope.profileId) {
      throw new Error('The input history scope changed. Reopen this input history before deleting.')
    }
`, after: '' },
  { label: 'foreign-record-sender-accepted', file: ipc, test: 'rejects another sender',
    before: "    requireTrustedSender('browser:recordInputHistory', event)\n", after: '' },
  { label: 'product-record-handler-removed', file: ipc, test: 'round-trips real durable history',
    before: recordBinding, after: '' },
  { label: 'agent-navigation-recorded', file: ipc, test: 'rejects another sender',
    before: "  handle('browser:navigate', async (id: string, url: string) => await browsers.navigate(id, url))\n",
    after: `  handle('browser:navigate', async (id: string, url: string) => {
    await browserInputHistory.record(browsers.inputHistoryScope(id, browserProfiles.defaultProfileId()), url)
    return await browsers.navigate(id, url)
  })
` }
]
const receipt = { schema: 'agentmux.browser-input-history-main-source.v1', taskId: 'T-026', passed: false,
  observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBefore: hashes(originals), sharedTreeMutations: 0, nativeRuns: 0,
  systemClipboard: [], userAppRuntimeControl: [], cases: [] }
let evidenceCreated = false
async function run(label, test) {
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--maxWorkers=1', ...(test ? ['-t', test] : [])], { cwd: copy,
      env: { ...process.env, AGENTMUX_HISTORY_PROCESS_EVIDENCE: join(evidence, `${label}-two-process.json`) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
function green(result, expected) {
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
  const tests = /Tests\s+(\d+) passed/.exec(result.output)
  assert.ok(tests, 'Actual nonempty tests must run')
  assert.equal(Number(tests[1]), expected)
  assert.doesNotMatch(result.output, /Tests\s+\d+ failed/)
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
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json',
    'apps/desktop/tsconfig.json', 'packages/core/package.json']) {
    await mkdir(dirname(join(copy, file)), { recursive: true }); await cp(join(root, file), join(copy, file))
  }
  // Dependencies are the existing Main/shared/Core Source graph, not another App or compiled delivery.
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared', 'packages/core/src']) {
    await cp(join(root, directory), join(copy, directory), { recursive: true })
  }
  for (const [file, bytes] of originals) { await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes) }
  for (const directory of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules']) await symlink(join(root, directory), join(copy, directory))
  receipt.projection = await inventory(copy)
  receipt.projectionBytes = Object.values(receipt.projection).reduce((sum, item) => sum + item.bytes, 0)
  assert.ok(receipt.projectionBytes < 16 * 1024 * 1024, 'Private Source projection budget')
  execFileSync('tar', ['-czf', join(evidence, 'source-projection.tar.gz'), '--exclude=node_modules', '-C', copy, '.'])
  const baseline = await run('baseline-green'); green(baseline, 12)
  receipt.baseline = { exit: baseline.code, log: baseline.log, tests: 12 }
  const requested = process.argv[3]
  const wanted = requested ? requested.split(',') : null
  const selected = wanted ? mutations.filter(mutation => wanted.includes(mutation.label)) : mutations
  assert.ok(selected.length > 0, 'Actual selected mutation blocks must be nonempty')
  if (wanted) assert.equal(selected.length, wanted.length, 'Every requested mutation label must resolve')
  receipt.selection = { requested: wanted, labels: selected.map(mutation => mutation.label) }
  for (const mutation of selected) {
    const source = originals.get(mutation.file).toString()
    assert.equal(source.split(mutation.before).length - 1, 1, `Unique Source block: ${mutation.label}`)
    let red
    try {
      await writeFile(join(copy, mutation.file), source.replace(mutation.before, mutation.after))
      red = await run(`${mutation.label}-red`, mutation.test)
      assert.ok(red.code > 0 && red.signal === null, red.output)
      assert.match(red.output, /AssertionError/)
      assert.match(red.output, /Tests\s+[1-9]\d* failed/)
    } finally { await writeFile(join(copy, mutation.file), originals.get(mutation.file)) }
    const restored = await run(`${mutation.label}-restored-green`, mutation.test); green(restored, 1)
    receipt.cases.push({ ...mutation, red: { exit: red.code, log: red.log }, restore: { exit: restored.code, log: restored.log, tests: 1 } })
    console.log(`Actual Assertion RED / restored GREEN: ${mutation.label}`)
  }
  const final = await run('final-all-restored-green'); green(final, 12)
  receipt.final = { exit: final.code, log: final.log, tests: 12 }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.liveSourceDrift = inputs.filter(file => receipt.sourceAfter[file] !== receipt.sourceBefore[file])
  // A colleague may add an unrelated BVM/IPC/contracts hunk. Never reset it, nor certify it as this cut.
  receipt.candidateOnly = true
  receipt.liveSourceMatchesCut = receipt.liveSourceDrift.length === 0
  receipt.taskComplete = false
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(copy, { recursive: true })
  receipt.cleanup = { privateSourcePath: copy, removed: true, unrelatedPathsRemoved: [] }
  if (evidenceCreated) await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
