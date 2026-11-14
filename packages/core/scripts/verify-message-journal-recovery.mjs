#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = resolve(process.env.AGENTMUX_MESSAGE_RECOVERY_EVIDENCE ?? join(dirname(common), '.local/reliability-fixes/core/message-journal'),
  new Date().toISOString().replaceAll(/[:.]/gu, '-') + '-' + process.pid)
await mkdir(evidence, { recursive: true, mode: 0o700 })
const digest = value => createHash('sha256').update(value).digest('hex')
const queuePath = 'packages/core/src/agent-global-message-queue.ts', journalPath = 'packages/core/src/agent-message-journal.ts'
const sourcePaths = [queuePath, journalPath, 'packages/core/src/storage-recovery.ts',
  'packages/core/test/message-journal-namespace.test.ts','packages/core/test/helpers/message-journal-crash-loader.mjs','packages/core/test/message-journal-recovery.test.ts', 'packages/core/test/agent-global-message-queue.test.ts',
  'packages/core/test/helpers/message-journal-recovery-worker.mjs', 'packages/core/test/helpers/prompt-receipt-source-loader.mjs',
  'packages/core/test/vitest.message-journal-recovery.config.mts', 'packages/core/test/tsconfig.message-journal-recovery.json',
  'packages/core/scripts/verify-message-journal-recovery.mjs']
const sources = new Map(await Promise.all(sourcePaths.map(async path => [path, await readFile(join(root, path), 'utf8')])))
const receipt = { kind: 'agentmux.message-journal-recovery.v1', root, startedAt: new Date().toISOString(),
  scope: 'Original Queue owner, online SQLite main/mutex/private tables and archives; real second source processes; isolated namespaces only. No production access, Runtime or business input.',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...sources].map(([path, source]) => [path, digest(source)])), tests: [], mutations: [] }
async function save(name, value) { const path = join(evidence, name); await writeFile(path, value, { mode: 0o600 }); await chmod(path, 0o600); return path }
async function run(label, args, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
  await save(label + '.log', result.output); return result
}
async function tests(label, pattern) {
  const results = join(evidence, label + '.private.json'), loads = await save(label + '-loads.private.ndjson', '')
  const result = await run(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/vitest.message-journal-recovery.config.mts',
    '--reporter=json', '--outputFile', results, ...(pattern ? ['-t', pattern] : [])],
  { AGENTMUX_RECEIPT_SOURCE_LOADS: loads, AGENTMUX_TEST_RECEIPT_SOURCE_LOADS: loads })
  await chmod(results, 0o600)
  const parsed = JSON.parse(await readFile(results, 'utf8'))
  const failures = parsed.testResults.flatMap(suite => suite.assertionResults ?? []).filter(assertion => assertion.status === 'failed')
  const loaded = (await readFile(loads, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const item of loaded) {
    if (!item.path.startsWith(join(root, 'packages/core/src/')) || digest(await readFile(item.path)) !== item.sha256) throw Error('Loaded Core source changed or escaped the candidate: ' + item.path)
  }
  const required = pattern ? [queuePath, journalPath] : [queuePath, journalPath, 'packages/core/src/storage-recovery.ts']
  for (const path of required) if (!loaded.some(item => item.path === join(root, path))) throw Error('Actual owner was not consumed: ' + path)
  return { code: result.code, total: parsed.numTotalTests, passed: parsed.numPassedTests, failed: parsed.numFailedTests,
    runtimeErrors: parsed.numRuntimeErrorTestSuites ?? 0, failures: failures.map(value => ({ name: value.fullName, messages: value.failureMessages })),
    results, loads }
}
function green(result) { if (result.code !== 0 || result.total !== 34 || result.passed !== 34 || result.failed !== 0 || result.runtimeErrors) throw Error('Message source gate was not a nonempty 34/34 pass: ' + JSON.stringify(result)) }
function replace(source, from, to) { if (source.split(from).length !== 2) throw Error('Mutation anchor changed: ' + from); return source.replace(from, to) }
const mutations = [
  {id:'create-replacement-original-mutex',path:journalPath,pattern:'second-process original writer',edit:s=>replace(s,"if((await header(path))?.equals(sqliteHeader)||await hasOriginalMessageArchive(path))throw",'if(false)throw')},
  {id:'reverse-ack-used-SQLite-main',path:journalPath,pattern:'existing unconfirmed mutex|real initializer crash',edit:s=>replace(s,"if(completed===undefined)throw new Error('The used SQLite journal", "if(false)throw new Error('The used SQLite journal")},
  {id:'guess-empty-initialization-fresh',path:journalPath,pattern:'unconfirmed empty first-pair',edit:s=>replace(s,'if(prefix===null&&!freshMutex)throw','if(false)throw')},
  {id:'block-original-complete-legacy',path:journalPath,pattern:'complete legacy source',edit:s=>replace(s,"  if (prefix?.equals(sqliteHeader)) {\n    if(completed===undefined)","  if(prefix!==null&&completed===undefined)throw new Error('incorrect legacy refusal')\n  if (prefix?.equals(sqliteHeader)) {\n    if(completed===undefined)")},
  {id:'discard-confirmed-cutover-on-body-rejection',path:queuePath,pattern:'historical message with no proof',edit:s=>replace(s,"mutex?.exec(initializedMutex?'COMMIT':'ROLLBACK')","mutex?.exec('ROLLBACK')")},
  { id: 'raw-copy-uncommitted-journal', path: journalPath, pattern: 'spilled uncommitted SQLite', edit: source => {
    const from = `          const bytes = BigInt(Number(db.prepare('PRAGMA page_size').get()!.page_size)) * BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count))
          await requireRecoverySpace(directory, bytes)
          await backup(db, file)`
    return replace(source, from, "if (id === 'journal') await snapshotRecoveryFile(target, file); else {\n" + from + "\n}")
  } },
  { id: 'hold-original-writer-mutex', path: queuePath, pattern: 'second real source process save', edit: source => replace(source,
    'await captureMessageJournalRecovery(this.path, output)', 'await this.withLock(() => captureMessageJournalRecovery(this.path, output))') },
  { id: 'drop-private-mutex-cut', path: journalPath, pattern: 'complete original main/mutex', edit: source => replace(source,
    "['mutex', mutex, path + '.mutex.sqlite'], ['journal', journal, path]", "['journal', journal, path]") },
  { id: 'ignore-original-incarnation-pair', path: journalPath, pattern: 'contradictory incarnations', edit: source => replace(source,
    'if (journal && mutex && incarnation !== acknowledged)', 'if (false)') },
  { id: 'initialize-lost-source', path: journalPath, pattern: 'first-launch missing namespaces', edit: source => replace(replace(source,
    "    const attributes = await lstat(target)\n    if (!attributes.isFile() || (attributes.mode & 0o077) !== 0) throw new Error('The original message recovery source is not a protected regular file.')",
    "    await mkdir(dirname(target), { recursive: true })"), 'new DatabaseSync(target, { readOnly: true })', 'new DatabaseSync(target)') },
  { id: 'skip-directory-confirmation', path: journalPath, pattern: 'directory sync failure', edit: source => replace(source,
    'await backup(db, file)\n          await chmod(file, 0o600); await syncMessageJournal(file)', 'await backup(db, file)\n          await chmod(file, 0o600) /* regression: no directory persistence acknowledgement */') }
]
const asset = join(root, 'packages/core/dist/agent-global-message-queue.js')
let previousAsset
try { previousAsset = await readFile(asset) } catch (error) { if (error.code !== 'ENOENT') throw error }
try {
  await mkdir(dirname(asset), { recursive: true })
  // Existing cross-process regressions import their package entry. This explicit
  // test-only bridge binds that entry to this worktree's source, with no build.
  await writeFile(asset, "import {register} from 'node:module';register(new URL('../test/helpers/prompt-receipt-source-loader.mjs',import.meta.url),import.meta.url);const {DurableAgentMuxMessageQueue}=await import('../src/agent-global-message-queue.ts');export {DurableAgentMuxMessageQueue};\n", { mode: 0o600 })
  const types = await run('types', ['node_modules/typescript/bin/tsc', '--project', 'packages/core/test/tsconfig.message-journal-recovery.json', '--pretty', 'false'])
  if (types.code !== 0) throw Error('Narrow storage RPC type check failed.')
  const baseline = await tests('baseline'); green(baseline); receipt.tests.push(baseline); console.log('baseline: 34/34 source-bound message recovery tests passed')
  for (const mutation of mutations) {
    const path = join(root, mutation.path), original = sources.get(mutation.path)
    if (await readFile(path, 'utf8') !== original) throw Error('Candidate changed before mutation: ' + path)
    try {
      const modified = mutation.edit(original); await writeFile(path, modified)
      const result = await tests('mutation-' + mutation.id, mutation.pattern)
      if (result.code === 0 || result.failed < 1 || result.runtimeErrors || !result.failures.length ||
        result.failures.some(value => !value.messages.some(message => /AssertionError|expected |promise (?:resolved|rejected)/isu.test(message)))) throw Error('No business assertion rejected mutation: ' + mutation.id)
      receipt.mutations.push({ id: mutation.id, mutantSHA256: digest(modified), ...result }); console.log('mutation ' + mutation.id + ': business assertion rejected')
    } finally { await writeFile(path, original) }
  }
  const restored = await tests('restored'); green(restored); receipt.tests.push(restored)
  for (const [path, source] of sources) if (await readFile(join(root, path), 'utf8') !== source) throw Error('Source was not restored: ' + path)
  receipt.verdict = 'pass'; console.log('restored: 34/34; '+mutations.length+'/'+mutations.length+' causal mutations rejected')
} catch (error) { receipt.verdict = 'fail'; receipt.failure = error.stack ?? String(error); process.exitCode = 1; console.error(receipt.failure) }
finally {
  for (const path of [queuePath, journalPath]) if (await readFile(join(root, path), 'utf8') !== sources.get(path)) await writeFile(join(root, path), sources.get(path))
  if (previousAsset) await writeFile(asset, previousAsset); else await rm(asset, { force: true })
  receipt.endedAt = new Date().toISOString()
  console.log('evidence: ' + await save('verification.private.json', JSON.stringify(receipt, null, 2) + '\n'))
}
