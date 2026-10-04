import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, open, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const presentation = 'apps/desktop/src/renderer/src/components/SessionActivityPresentation.tsx'
const test = 'apps/desktop/test/shared-session-recovery.test.tsx'
const config = 'apps/desktop/scripts/fixtures/shared-session-recovery/vitest.owning.config.mts'
const self = relative(root, fileURLToPath(import.meta.url))
const owningPaths = [pane, presentation, test, config, self]
const cases = [
  'a failed shared Session keeps its original cause, recovery action, content and Composer in the selected secondary',
  'an unconfirmed appearance keeps the same selected secondary nonempty without changing its original Session',
  'a hidden secondary retained conversation does not create native or captured-history reads while its primary stays readable'
]
const mutants = [
  { id: 'original-failure-ui', file: pane,
    before: 'recovery={pendingAgentRestore ? cloneElement(restoreSurface, { supplement: null }) : undefined}',
    after: 'recovery={undefined}', killedBy: cases[0] },
  { id: 'early-return-ui', file: pane,
    before: 'return retainPresentations(() => cloneElement(connectingSurface, { visible: false }),',
    after: 'return retainPresentations(() => null,', killedBy: cases[1] },
  { id: 'hidden-retired-reading', file: pane,
    before: 'enabled: target.visible !== false && !parked',
    after: 'enabled: !parked', killedBy: cases[2] }
]
const base = join(root, '.tmp/shared-session-recovery')
const locator = join(base, 'source-qualification.json')
const reference = async file => ({ path: relative(root, file), sha256: sha(await readFile(file)) })
const assertions = result => result.testResults.flatMap(file => file.assertionResults)

async function validate(receipt) {
  assert.equal(receipt.schema, 'agentmux.shared-session-recovery.source.v1')
  assert.equal(receipt.passed, true)
  assert.equal(receipt.mutants.length, 3)
  assert.ok(Object.keys(receipt.source).length > 10, 'Loaded production Source must not be empty')
  assert.equal(receipt.callers.length, 2, 'Definition-external production callers must be present')
  for (const [file, hash] of Object.entries({ ...receipt.source, ...receipt.owningSource }))
    assert.equal(sha(await readFile(join(root, file))), hash, 'Source changed: ' + file)
  for (const caller of receipt.callers) {
    assert.ok(caller.calls > 0)
    assert.equal(sha(await readFile(join(root, caller.file))), caller.sha256)
  }
  for (const run of [receipt.baseline, ...receipt.mutants, receipt.restored]) {
    for (const item of [run.results, run.log, run.loaded])
      assert.equal(sha(await readFile(join(root, item.path))), item.sha256, 'Proof changed: ' + item.path)
    const result = JSON.parse(await readFile(join(root, run.results.path), 'utf8'))
    const rows = (await readFile(join(root, run.loaded.path), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(rows.length > 10)
    const loaded = rows.filter(row => row.file === (run.mutation?.file ?? pane))
    assert.ok(loaded.some(row => row.sha256 === (run.mutation?.sha256 ?? receipt.owningSource[pane])))
    assert.deepEqual(assertions(result).map(item => item.title).sort(), [...cases].sort())
    assert.equal(result.numTotalTests, 3); assert.equal(result.numPendingTests, 0)
    if (run.mutation) {
      assert.notEqual(run.exitCode, 0)
      const killed = assertions(result).find(item => item.title === run.killedBy)
      assert.equal(killed?.status, 'failed')
      assert.ok(killed.failureMessages.some(message => /AssertionError/.test(message)))
      assert.ok(killed.failureMessages.every(message => !/TypeError:|ReferenceError:|SyntaxError:/.test(message)))
    } else { assert.equal(run.exitCode, 0); assert.equal(result.numPassedTests, 3); assert.equal(result.numFailedTests, 0) }
  }
}

async function execute() {
  const attempt = join(base, 'source-' + globalThis.crypto.randomUUID())
  await mkdir(attempt, { recursive: true })
  const owningSource = Object.fromEntries(await Promise.all(owningPaths.map(async file => [file, sha(await readFile(join(root, file)))])))
  const receipt = { schema: 'agentmux.shared-session-recovery.source.v1', passed: false,
    sourcePinnedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    owningSource, source: {}, callers: [], mutants: [], boundary: 'Original App/Workbench/SessionPane/Activity/Composer, Source-only DTO ports and isolated PTY paint. No Native lifecycle, model, auth, UI screenshot or type qualification.' }
  const require = createRequire(join(root, 'package.json'))
  async function run(name, mutation) {
    const folder = join(attempt, name); await mkdir(folder)
    const loaded = join(folder, 'loaded.ndjson'), results = join(folder, 'results.json'), log = join(folder, 'run.log')
    const cfg = join(folder, 'vitest.config.mjs')
    const original = mutation ? await readFile(join(root, mutation.file), 'utf8') : ''
    if (mutation) assert.equal(original.split(mutation.before).length, 2, 'Mutation anchor must be unique')
    const changed = mutation ? original.replace(mutation.before, mutation.after) : ''
    const plugin = mutation ? `{ name:'actual-owning-mutation', enforce:'pre', transform(code,id){if(id.split('?')[0]===${JSON.stringify(join(root, mutation.file))})return {code:${JSON.stringify(changed)},map:null};} }` : ''
    await writeFile(cfg, `import base from ${JSON.stringify(pathToFileURL(join(root, config)).href)};export default {...base,cacheDir:${JSON.stringify(join(folder, 'vite-cache'))},plugins:[${plugin}${plugin ? ',' : ''}...(base.plugins??[])],test:{...base.test,reporters:['default','json'],outputFile:{json:${JSON.stringify(results)}}}};\n`)
    const fd = await open(log, 'w')
    let exitCode
    try {
      const child = spawn(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', cfg],
        { cwd: root, env: { ...process.env, AGENTMUX_NOTE_LOADED: loaded }, stdio: ['ignore', fd.fd, fd.fd] })
      exitCode = await new Promise((resolveExit, reject) => {
        const timer = setTimeout(() => { child.kill('SIGTERM') }, 90000)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(Error('Owning test interrupted: ' + signal)) : resolveExit(code) })
      })
    } finally { await fd.close() }
    const rows = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const one = { name, exitCode, results: await reference(results), log: await reference(log), loaded: await reference(loaded),
      ...(mutation ? { killedBy: mutation.killedBy, mutation: { id: mutation.id, file: mutation.file, sha256: sha(changed) } } : {}) }
    assert.ok(rows.length > 10, 'No actual loaded Source')
    await rm(join(folder, 'vite-cache'), { recursive: true, force: true })
    if (!mutation) {
      for (const row of rows) {
        if (!/^(apps\/desktop\/src|packages\/(core|demand|layout)\/)/.test(row.file) || !/\.(?:[cm]?[jt]sx?|json)$/.test(row.file)) continue
        assert.equal(sha(await readFile(join(root, row.file))), row.sha256, 'Loaded definition drift: ' + row.file)
        receipt.source[row.file] = row.sha256
      }
    }
    return one
  }
  const output = join(attempt, 'receipt.json')
  try {
    receipt.baseline = await run('baseline')
    for (const mutation of mutants) receipt.mutants.push(await run(mutation.id, mutation))
    receipt.restored = await run('restored')
    for (const [file, needle] of [
      ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', '<SessionPane'],
      [pane, '<SessionActivityPresentation']
    ]) {
      const bytes = await readFile(join(root, file)), calls = bytes.toString().split(needle).length - 1
      assert.ok(calls > 0); assert.equal(receipt.source[file], sha(bytes), 'Caller must be actually loaded')
      receipt.callers.push({ file, calls, sha256: sha(bytes) })
    }
    receipt.passed = true
    await validate(receipt)
  } catch (error) { receipt.passed = false; receipt.error = { message: error.message, stack: error.stack }; throw error }
  finally { await writeFile(output, JSON.stringify(receipt, null, 2) + '\n') }
  await writeFile(locator, JSON.stringify(await reference(output), null, 2) + '\n')
  return receipt
}

// Reuse only unchanged production, owner and raw proof bytes. A changed input is
// requalified by the same three bounded cases; missing or empty evidence cannot pass.
let receipt
try {
  const item = JSON.parse(await readFile(locator, 'utf8')), bytes = await readFile(join(root, item.path))
  assert.equal(sha(bytes), item.sha256)
  receipt = JSON.parse(bytes); await validate(receipt)
} catch { receipt = await execute() }
console.log(JSON.stringify({ passed: true, owningCases: 3, mutants: receipt.mutants.length,
  sourceFiles: Object.keys(receipt.source).length, callers: receipt.callers.length, locator: relative(root, locator),
  boundary: receipt.boundary }))
