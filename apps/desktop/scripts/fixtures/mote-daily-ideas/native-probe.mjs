import { fixtureIso as _hygiene_fixtureIso } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repository = resolve(import.meta.dirname, '../../../../..'), args = process.argv.slice(2)
assert.equal(args.length, 1, 'Supply the qualified thin Source directory; this probe never builds a package or uses a user Run.')
const source = resolve(args[0]), fixture = join(source, 'apps/desktop/scripts/fixtures/agent-schedules')
const ownerSource = join(source, 'apps/desktop/scripts/fixtures/mote-daily-ideas/native-owner.ts')
const output = join(repository, '.tmp/mote-daily-ideas'); await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'native-')), privateRoot = await mkdtemp(join(tmpdir(), 'ami-'))
const state = join(privateRoot, 's'), runtime = join(privateRoot, 'r'), workspace = join(privateRoot, 'w')
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite'))('esbuild')
const receipt = { schema: 'agentmux.mote-daily-ideas-native.v1', taskId: 'T-004', passed: false, source: {}, harnessSource: {},
  calls: [], input: {}, phases: [], cleanup: { completed: false }, failure: null,
  boundary: 'One actual original Ideas/Calendar producer to typed schedule service, Core future intent and private native ctxmux input. File observations are synthetic owning Source fixtures; no real model, credential copy, user App/Run, packaging or installation.' }
let daemon, owner, ownerLog = ''
const waitReady = child => new Promise((done, reject) => {
  let stdout = '', stderr = ''
  const timer = setTimeout(() => reject(new Error('Private owner readiness timed out: ' + stderr)), 20_000)
  child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('\n')) { clearTimeout(timer); try { done(JSON.parse(stdout.split('\n')[0])) } catch (error) { reject(error) } } })
  child.stderr.on('data', bytes => { stderr += bytes })
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('exit', code => { clearTimeout(timer); reject(new Error('Private owner exited: ' + code + ': ' + stderr)) })
})
const stop = async child => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    try { await exited } finally { clearTimeout(timer) }
  }
}
try {
  const metadata = JSON.parse(await readFile(join(dirname(source), 'source-meta.json'), 'utf8'))
  receipt.sourceBase = metadata.sourceBase; receipt.overlay = metadata.overlay
  await Promise.all([mkdir(state, { mode: 0o700 }), mkdir(runtime, { mode: 0o700 }), mkdir(workspace)])
  await mkdir(join(state, 'ctxmux'), { mode: 0o700 }); await mkdir(join(state, 'actions'))
  await symlink(join(repository, 'packages/core/node_modules'), join(attempt, 'node_modules'))
  for (const name of ['vendor', 'bin']) {
    try { await symlink(join(repository, 'packages/core', name), join(output, name)) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const metafiles = []
  const exports = Object.fromEntries(await Promise.all(['core', 'client-ui', 'demand', 'layout'].map(async name =>
    [name, JSON.parse(await readFile(join(source, 'packages', name, 'package.json'))).exports])))
  const coreSource = { name: 'original-package-source-exports', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\/(core|client-ui|demand|layout)(?:\/|$)/ }, ({ path }) => {
      const [, name, suffix = ''] = /^@agentmux\/([^/]+)(?:\/(.*))?$/.exec(path), key = suffix ? './' + suffix : '.'
      let target = exports[name][key], wildcard = ''
      if (!target) for (const [pattern, value] of Object.entries(exports[name])) if (pattern.includes('*') && key.startsWith(pattern.split('*')[0])) {
        target = value; wildcard = key.slice(pattern.split('*')[0].length); break
      }
      const entry = typeof target === 'string' ? target : name === 'client-ui' ? target?.browser : target?.import
      assert.ok(typeof entry === 'string', 'Use an actual public Source export: ' + path)
      const mapped = entry.startsWith('./src/') ? entry : entry.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
      return { path: join(source, 'packages', name, mapped.replace('*', wildcard)) }
    })
  } }
  const options = { bundle: true, platform: 'node', format: 'esm', metafile: true, logLevel: 'silent', external: ['@ctxmux/sdk', 'fs-native-extensions'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    alias: { electron: join(fixture, 'electron.ts') }, plugins: [coreSource] }
  for (const entry of ['owner', 'cli']) metafiles.push((await build({ ...options, entryPoints: [entry === 'owner' ? ownerSource : join(fixture, 'cli.ts')], outfile: join(attempt, entry + '.mjs') })).metafile)
  for (const meta of metafiles) for (const path of Object.keys(meta.inputs)) {
    const absolute = resolve(path), key = relative(source, absolute)
    if (!key.startsWith('../') && !key.includes('/node_modules/')) receipt.source[key] = sha(await readFile(absolute))
  }
  for (const path of ['packages/core/test/fixtures/fake-codex-cli.mjs', 'apps/desktop/scripts/fixtures/agent-schedules/cli.ts'])
    receipt.source[path] = sha(await readFile(join(source, path)))
  receipt.harnessSource[relative(repository, import.meta.filename)] = sha(await readFile(import.meta.filename))
  receipt.harnessSource[relative(source, ownerSource)] = sha(await readFile(ownerSource))
  const artifact = join(repository, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd')
  receipt.artifactSha256 = sha(await readFile(artifact)); receipt.sdkPath = relative(repository, await realpath(join(repository, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
  const originalCli = join(source, 'packages/core/test/fixtures/fake-codex-cli.mjs'), nativeCli = join(privateRoot, 'original-native-observer.mjs')
  const nativeCode = `import {mkdirSync,openSync,writeFileSync,appendFileSync} from 'node:fs';\nimport {join} from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst directory=join(process.env.AGENTMUX_STATE_DIRECTORY,'native-records');mkdirSync(directory,{recursive:true});const record=join(directory,'rollout-original.jsonl');writeFileSync(record,JSON.stringify({type:'session_meta',payload:{id:'native-'+process.env.AGENTMUX_AGENT_SESSION_ID,source:'cli',cwd:process.cwd()}})+'\\n');const heldOriginalRecord=openSync(record,'r');let sequence=0;process.stdin.on('data',data=>appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY,'native-input.ndjson'),JSON.stringify({sequence:++sequence,data:String(data)})+'\\n'));\nawait import(pathToFileURL(${JSON.stringify(originalCli)}).href);\n`
  await writeFile(nativeCli, nativeCode)
  receipt.generated = { nativeObserver: { sha256: sha(nativeCode), purpose: 'OS-open original Codex-format Session witness and raw ordered input observer; original repository native protocol fixture owns hook/readiness behavior.' } }
  await mkdir(join(privateRoot, 'home'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), HOME: join(privateRoot, 'home'),
    AGENTMUX_STATE_DIRECTORY: state, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
    SCHEDULE_PROBE_WORKSPACE: workspace, SCHEDULE_PROBE_AGENT: nativeCli, SCHEDULE_PROBE_CLI: join(attempt, 'cli.mjs'), SCHEDULE_PROBE_NOW: String(Date.parse(_hygiene_fixtureIso(24220800000, "minute"))) }
  daemon = spawn(artifact, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonErrors = ''; daemon.stderr.on('data', bytes => { daemonErrors += bytes })
  await new Promise((done, reject) => { const timer = setTimeout(() => reject(new Error('Private ctxmux readiness timed out.')), 20_000)
    daemon.stdio[3].once('data', () => { clearTimeout(timer); done() }); daemon.once('error', reject); daemon.once('exit', code => { clearTimeout(timer); reject(new Error('Private ctxmux exited ' + code + ': ' + daemonErrors)) }) })
  const boot = async overrides => {
    owner = spawn(process.execPath, [join(attempt, 'owner.mjs')], { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    owner.stderr.on('data', bytes => { ownerLog += bytes })
    const ready = await waitReady(owner); receipt.phases.push(ready); assert.equal(ready.borrowed, true); return ready
  }
  const first = await boot({})
  const originalSession = JSON.parse(await readFile(join(state, 'sessions.json'))).sessions.find(session => session.agentSessionId === first.target.agentSessionId)
  const nativeCase = { target: first.target, runId: originalSession.run.runId, endpoint: 'unix:' + first.socketPath, journal: join(attempt, 'production-calendar.json') }
  const report = join(attempt, 'actual-calendar.json'), loadedSource = join(attempt, 'actual-calendar.loaded-source.ndjson')
  const child = spawn(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(source, 'apps/desktop/scripts/fixtures/mote-daily-ideas/vitest.config.mts'),
    '-t', 'actual private native idea arrangement', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report],
    { cwd: source, env: { ...process.env, TMPDIR: tmpdir(), AGENTMUX_IDEAS_SOURCE_RECEIPT: loadedSource, AGENTMUX_IDEAS_NATIVE_CASE: JSON.stringify(nativeCase) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) }); clearTimeout(timeout)
  await writeFile(join(attempt, 'actual-calendar.log'), log); receipt.producer = { ...status, report: relative(repository, report), reportSha256: sha(await readFile(report)), loadedSource: relative(repository, loadedSource), loadedSha256: sha(await readFile(loadedSource)) }
  assert.equal(status.signal, null); assert.equal(status.code, 0, log)
  const tests = JSON.parse(await readFile(report)); assert.equal(tests.numPassedTests, 1); assert.equal(tests.numFailedTests, 0)
  for (const line of (await readFile(loadedSource, 'utf8')).trim().split('\n')) { const one = JSON.parse(line); assert.ok(!receipt.source[one.path] || receipt.source[one.path] === one.sha256); receipt.source[one.path] = one.sha256 }
  const journal = JSON.parse(await readFile(nativeCase.journal)); receipt.calls = journal.calls
  assert.deepEqual(journal.params.target, first.target); assert.ok(journal.params.prompt.startsWith(journal.message + '\n\n')); assert.ok(journal.params.prompt.includes(journal.frozenContext))
  assert.equal(journal.calls[0].method, 'schedule.create'); assert.equal(journal.calls[1].method, 'schedule.inspect')
  assert.equal(journal.calls[1].params.operationId, journal.params.operationId); assert.equal(journal.calls[1].result.schedule.prompt, journal.params.prompt)
  const cli = async (action, params) => {
    const path = join(privateRoot, 'cli-' + action + '.json'); await writeFile(path, JSON.stringify(params))
    const stdout = execFileSync(process.execPath, [join(attempt, 'cli.mjs'), 'schedule', action, '--data', path],
      { env: { ...env, AGENTMUX_RPC_ENDPOINT: 'unix:' + first.socketPath }, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).toString()
    const result = JSON.parse(stdout.trim().split('\n').at(-1)); assert.equal(result.ok, true)
    receipt.calls.push({ method: 'SourceCLI schedule ' + action, params, result }); return result.result
  }
  const inspected = await cli('inspect', { operationId: journal.params.operationId })
  assert.equal(inspected.schedule.prompt, journal.params.prompt); assert.equal(inspected.schedule.creationOperationId, journal.params.operationId)
  const sessions = JSON.parse(await readFile(join(state, 'sessions.json'))), saved = sessions.sessions.find(session => session.agentSessionId === first.target.agentSessionId)
  assert.ok(saved.futurePromptIntents[journal.calls[0].result.schedule.futureIntentId].prompt.includes(journal.params.prompt))
  const runId = saved.run.runId, nativeSessionId = saved.nativeHandle.sessionId
  await stop(owner)
  const schedule = journal.calls[0].result.schedule, second = await boot({ SCHEDULE_PROBE_NOW: String(schedule.nextCheckAt + 1000), SCHEDULE_PROBE_DROP_RECEIPT: '1' })
  assert.notEqual(second.pid, first.pid); assert.deepEqual(second.target, first.target); assert.equal(second.hostedOwner.runtimeId, first.hostedOwner.runtimeId)
  const check = async () => { const reply = once(owner, 'message'); owner.send('check'); return (await reply)[0] }
  await check()
  const deadline = Date.now() + 10_000
  let inputs = ''
  while (!inputs.includes(journal.message)) { try { inputs = await readFile(join(state, 'native-input.ndjson'), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (Date.now() > deadline) throw new Error('The original request was not observed in private native input.'); await new Promise(resolve => setTimeout(resolve, 20)) }
  await check(); assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), inputs, 'Unknown acknowledgement must not resend native bytes')
  const delivered = inputs.trim().split('\n').map(line => JSON.parse(line).data).join('')
  assert.ok(delivered.includes(journal.params.prompt), 'Actual ordered native bytes must contain the full frozen request, not just its visible direction.')
  const loops = JSON.parse(await readFile(join(state, 'loops.json'))), loop = loops.find(one => one.loopId === schedule.loopId)
  assert.equal(loop.status, 'paused'); assert.equal(loop.lastOutcome, 'unknown'); assert.equal(loop.pendingCompletion.prompt, journal.params.prompt)
  const originalOperation = loop.pendingCompletion.operationId
  await cli('resume', { scheduleId: loop.loopId, expectedRevision: loop.revision, operationId: 'private-original-idea-resume' }); await check()
  assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), inputs, 'Original-operation reconciliation cannot duplicate accepted native bytes')
  const reconciled = JSON.parse(await readFile(join(state, 'loops.json'))).find(one => one.loopId === loop.loopId)
  if (reconciled.pendingCompletion) assert.equal(reconciled.pendingCompletion.operationId, originalOperation)
  const after = JSON.parse(await readFile(join(state, 'sessions.json'))).sessions.find(session => session.agentSessionId === first.target.agentSessionId)
  assert.equal(after.run.runId, runId); assert.equal(after.nativeHandle.sessionId, nativeSessionId); assert.equal(after.workspacePath, first.target.workspacePath)
  await writeFile(join(attempt, 'native-input.ndjson'), inputs); await writeFile(join(attempt, 'loops.json'), JSON.stringify(loops, null, 2)); await writeFile(join(attempt, 'sessions.json'), JSON.stringify(after, null, 2))
  receipt.input = { prompt: journal.params.prompt, promptSha256: sha(journal.params.prompt), nativeBytesSha256: sha(inputs), nativeBytesFile: relative(repository, join(attempt, 'native-input.ndjson')),
    operationId: originalOperation, creationOperationId: journal.params.operationId, scheduleId: loop.loopId, futureIntentId: loop.futureIntentId, runId, nativeSessionId,
    target: first.target, unknownPaused: true, repeatedBytes: false }
  receipt.passed = true
} catch (error) {
  receipt.failure = error.stack; process.exitCode = 1
  for (const name of ['sessions.json', 'loops.json', 'native-input.ndjson', 'hosted-invocations.ndjson']) {
    try { await writeFile(join(attempt, 'failed-' + name), await readFile(join(state, name))) }
    catch (readError) { if (readError.code !== 'ENOENT') throw readError }
  }
}
finally {
  await stop(owner); await stop(daemon); await rm(privateRoot, { recursive: true, force: true })
  await writeFile(join(attempt, 'owner-stderr.log'), ownerLog)
  receipt.cleanup = { completed: true, privateRootRemoved: true, ownedProcessesStopped: true }
  const path = join(attempt, 'receipt.json'); await writeFile(path, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(repository, path), sha256: sha(await readFile(path)) }))
  if (receipt.failure) console.error(receipt.failure)
}
