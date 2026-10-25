import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdtemp, mkdir, rm, realpath, symlink, rename, readdir } from 'node:fs/promises'
import { resolve, join, relative, dirname } from 'node:path'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
const run = promisify(execFile), require = createRequire(import.meta.url), viteRequire = createRequire(require.resolve('vite')), { build } = viteRequire('esbuild')
const root = resolve(import.meta.dirname, '../../..'), fixture = join(root, 'apps/desktop/scripts/fixtures/agent-schedules')
const taskIndex = process.argv.indexOf('--task'), task = taskIndex < 0 ? 'calendar' : process.argv[taskIndex + 1]
if (task === 'presentation' || task === 'ui') { await (await import('./verify-agent-schedules-ui.mjs')).verifyScheduleUi(); process.exit(process.exitCode ?? 0) }
if (task === 'checkin') { await (await import('./verify-agent-schedules-check-in.mjs')).verifyScheduleCheckIn(); process.exit(process.exitCode ?? 0) }
assert(['calendar', 'timers'].includes(task), 'Choose calendar or timers.')
const timerTask = task === 'timers'
const evidence = join(root, '.tmp/agent-schedules', task); await mkdir(evidence, { recursive: true })
const sha = text => createHash('sha256').update(text).digest('hex')
const vitest = join(require.resolve('vitest/package.json'), '..', 'vitest.mjs'), config = join(fixture, 'vitest.config.mjs')
async function tests(label, filter, mutationEnv = {}) {
  const args = [vitest, 'run', '--config', config, ...(timerTask ? ['apps/desktop/test/agent-schedules.test.ts', 'apps/desktop/test/continuous-progress-loop-manager.test.ts', 'apps/desktop/test/continuous-progress-loop-store.test.ts', 'packages/core/test/continuous-progress.test.ts', 'packages/core/test/continuous-progress-scheduler.test.ts', 'packages/core/test/schedule-cli-discovery.test.ts'] : []), '--reporter=json', '--outputFile', join(evidence, label + '.json'), ...(filter ? ['-t', filter] : [])]
  // Isolate at process start, before Vitest/config/setup or Core modules can import.
  const suite = await mkdtemp(join(tmpdir(), 'amux-schedule-suite-'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/.test(key))),
    AGENTMUX_RUNTIME_DIRECTORY: join(suite, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(suite, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(suite, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(suite, 'messages.ndjson'), ...mutationEnv }
  let result
  try { result = { ...(await run(process.execPath, args, { cwd: root, env, maxBuffer: 4 * 1024 * 1024, timeout: 120000 })), exitCode: 0 } }
  catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code } }
  finally { await rm(suite, { recursive: true, force: true }) }
  await writeFile(join(evidence, label + '.log'), result.stdout + result.stderr)
  const report = JSON.parse(await readFile(join(evidence, label + '.json'), 'utf8'))
  assert(report.numTotalTests > 0, 'Source proof cannot be empty')
  return { exitCode: result.exitCode, failed: report.numFailedTests, passed: report.numPassedTests, assertions: report.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed')) }
}
const sourceFiles = ['packages/core/src/types.ts','packages/core/src/client.ts','packages/core/src/prompt-submission.ts','packages/core/src/agent-session-store.ts','packages/core/src/hosted-client-contract.ts','packages/core/src/hosted-client.ts','packages/core/src/hosted-runtime-service.ts','packages/core/src/headless-runtime.ts','packages/core/src/public-rpc-client.ts','packages/core/src/public-rpc-server.ts','packages/core/src/continuous-progress.ts','packages/core/src/continuous-progress-scheduler.ts','packages/core/src/agent-schedule.ts','packages/core/src/public-rpc-schedules.ts','packages/core/src/schedule-cli.ts','packages/core/src/public-rpc.ts','packages/core/src/public-rpc-service.ts','packages/core/src/rpc-native-codec.ts','packages/core/src/agentmux-cli-commands.ts','packages/core/src/index.ts','packages/core/src/schedule-calendar.ts','apps/host/src/continuous-progress-loop-manager.ts','apps/host/src/continuous-progress-loop-store.ts','apps/host/src/continuous-progress-delivery.ts','apps/host/src/goal-runtime.ts','apps/host/src/goals.ts','apps/host/src/host.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/desktop-host.ts','apps/desktop/src/main/index.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/main/ipc-sender-trust.ts','apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx','apps/desktop/src/renderer/src/lib/api.ts','apps/desktop/src/preload/index.ts','apps/desktop/src/shared/contracts.ts']
const sourceBindings = await Promise.all(sourceFiles.map(async path => ({ path, sha256: sha(await readFile(join(root,path))) })))
const testFiles = ['apps/desktop/test/agent-schedules.test.ts','apps/desktop/test/continuous-progress-loop-manager.test.ts','apps/desktop/test/continuous-progress-loop-store.test.ts','packages/core/test/client-submit-prompt-run-binding.test.ts','packages/core/test/continuous-progress.test.ts','packages/core/test/continuous-progress-scheduler.test.ts','packages/core/test/schedule-cli-discovery.test.ts','packages/core/test/helpers/object-cli-rpc.ts','apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs','apps/desktop/scripts/fixtures/agent-schedules/isolate-core.mjs','apps/desktop/scripts/fixtures/agent-schedules/owner.ts','apps/desktop/scripts/fixtures/agent-schedules/native-agent.mjs','apps/desktop/scripts/fixtures/agent-schedules/electron.ts','apps/desktop/scripts/fixtures/agent-schedules/cli.ts','tsconfig.base.json','apps/desktop/tsconfig.json','packages/core/package.json']
const testBindings = await Promise.all(testFiles.map(async path => ({ path, sha256: sha(await readFile(join(root,path))) })))
const verificationBinding = { path: 'apps/desktop/scripts/verify-agent-schedules.mjs', sha256: sha(await readFile(import.meta.filename)) }
const privateOnly = process.env.AGENT_SCHEDULE_PROBE_ONLY === '1'
let typecheck
if (!privateOnly) {
  const corePackage=JSON.parse(await readFile(join(root,'packages/core/package.json'),'utf8'))
  const paths=Object.fromEntries(Object.entries(corePackage.exports).map(([key,value])=>[key==='.'?'@agentmux/core':'@agentmux/core/'+key.slice(2),[resolve(root,'packages/core',value.types.replace('./dist/','./src/').replace('.d.ts','.ts'))]]))
  const path=join(evidence,'tsconfig.owner-source.json'), configuration=JSON.stringify({extends:join(root,'apps/desktop/tsconfig.json'),compilerOptions:{paths,incremental:false,types:['node'],typeRoots:[resolve(require.resolve('@types/node/package.json'),'../..')]},include:[join(fixture,'owner.ts'),join(root,'packages/core/test/client-submit-prompt-run-binding.test.ts'),join(root,'apps/desktop/test/agent-schedules.test.ts')]},null,2)
  await writeFile(path,configuration)
  const result=await run(process.execPath,[require.resolve('typescript/bin/tsc'),'--noEmit','-p',path],{cwd:root,timeout:60000,maxBuffer:4*1024*1024})
  await writeFile(join(evidence,'source-types.log'),result.stdout+result.stderr)
  typecheck={passed:true,configurationSha256:sha(configuration),includes:3,scope:'Original Host GoalRuntime/Manager + finite borrowed Core + owning Source tests'}
}
const baseline = privateOnly ? null : await tests('source-green'); if (baseline) { assert.equal(baseline.exitCode, 0); assert(baseline.passed > 0) }
const mutations = [
  { file: 'apps/host/src/continuous-progress-loop-manager.ts', from: 'if (loop.everyMs !== undefined && !loop.pendingCompletion)', to: 'if (false && loop.everyMs !== undefined && !loop.pendingCompletion)', filter: 'collapses missed occurrences', name: 'minute-overdue-not-collapsed' },
  { file: 'packages/core/src/continuous-progress-scheduler.ts', from: 'isAgentSchedule(loop) ? loop.nextCheckAt : this.now() + loop.intervalMs', to: 'loop.calendar ? loop.nextCheckAt : this.now() + loop.intervalMs', filter: 'freezes the original.*deadline|keeps the absolute relative deadline', name: 'relative-resume-deadline-reset' },
  { file: 'apps/host/src/continuous-progress-loop-manager.ts', from: 'if (nextDue === null) settled.status = \'stopped\'', to: "if (nextDue === null && current.afterMs === undefined) settled.status = 'stopped'", filter: 'freezes the original.*deadline|retains the original relative occurrence', name: 'relative-single-send-keeps-running' },
  { file: 'packages/core/src/schedule-calendar.ts', from: "civil.hour !== hour || civil.minute !== minute", to: 'false', filter: 'skips DST gaps', name: 'gap-normalization' },
  { file: 'packages/core/src/prompt-submission.ts', from: 'saved.lastOccurrenceAt >= expectedFutureIntent.occurrenceAt', to: 'false', filter: 'admits each occurrence once', name: 'repeat-occurrence' },
  { file: 'packages/core/src/prompt-submission.ts', from: 'promptMessageIdentity(saved.message) !== promptMessageIdentity(message) ||', to: '', filter: 'refuses changed future content fields', name: 'future-message-fields' },
  { file: 'packages/core/src/hosted-client-contract.ts', from: ", 'saveAgentFuturePromptIntent'", to: '', filter: 'delegates a borrowed future-message', name: 'hosted-method-disconnect' },
  { file: 'packages/core/src/client.ts', from: 'let authorAgentSessionId: string | undefined\n      if (input.caller)', to: 'let authorAgentSessionId: string | undefined\n      if (false && input.caller)', filter: 'authenticates future producer', name: 'future-author-disconnect' },
  { file: 'apps/host/src/continuous-progress-loop-manager.ts', from: 'await this.authorizeCaller(loop, context)', to: 'void context', filter: 'refuses unauthorized mutation', name: 'mutation-authorization' },
  { file: 'apps/host/src/continuous-progress-loop-manager.ts', from: 'await this.store.save(this.scheduler.list())\n              if (!isCurrent()) continue', to: 'if (!isCurrent()) continue', filter: 'freezes and persists the original claim', name: 'claim-before-send' },
  { file: 'apps/host/src/continuous-progress-loop-manager.ts', from: "futureIntent ? decideFutureProgress(observation, futureIntent)", to: 'false ? decideFutureProgress(observation, futureIntent)', filter: 'keeps the occurrence due', name: 'future-owner-disconnect' }
]
const reds = []
for (const mutation of privateOnly ? [] : timerTask ? mutations.filter(mutation => mutation.name.startsWith('relative-') || mutation.name.startsWith('minute-')) : mutations) {
  const path = join(root, mutation.file), source = await readFile(path, 'utf8')
  assert.equal(source.split(mutation.from).length, 2, 'Exact production mutation must be unique: ' + mutation.name)
  const copy = join(evidence, mutation.name + '.mutant.ts'), mutant = source.replace(mutation.from, mutation.to)
  await writeFile(copy, mutant)
  const red = await tests('red-' + mutation.name, mutation.filter, { AGENT_SCHEDULE_MUTANT_OWNER: path, AGENT_SCHEDULE_MUTANT_COPY: copy })
  assert.notEqual(red.exitCode, 0); assert(red.failed > 0 && red.assertions.some(item => item.failureMessages.some(message => /AssertionError|expected /u.test(message))), 'Mutation must fail a meaningful assertion')
  assert(!red.assertions.some(item => item.failureMessages.some(message => /Cannot find module|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/u.test(message))), 'Setup failures cannot qualify a behavioral RED')
  assert.equal(await readFile(path, 'utf8'), source, 'Shared production source remains byte-identical')
  reds.push({ ...mutation, sourceSha256: sha(source), mutantSha256: sha(mutant), copy, result: red })
}
const restored = privateOnly ? null : await tests('source-restored'); if (restored) assert.equal(restored.exitCode, 0)
const callerPairs = [
  ['saveAgentFuturePromptIntent(', 'packages/core/src/client.ts', 'apps/host/src/goal-runtime.ts'],
  ['decideFutureProgress(', 'packages/core/src/continuous-progress.ts', 'apps/host/src/continuous-progress-loop-manager.ts'],
  ['createSchedule(', 'packages/core/src/continuous-progress-scheduler.ts', 'apps/host/src/continuous-progress-loop-manager.ts'],
  ['deliverContinuousProgress(', 'apps/host/src/continuous-progress-delivery.ts', 'apps/host/src/goals.ts'],
  ['validateScheduleRpcResult', 'packages/core/src/public-rpc-schedules.ts', 'packages/core/src/rpc-native-codec.ts'],
  ['schedules: progress', 'apps/host/src/continuous-progress-loop-manager.ts', 'apps/host/src/goals.ts'],
  ['authorizeFutureIntent(', 'apps/host/src/goal-runtime.ts', 'apps/host/src/goals.ts']
]
const callers = []
for (const [symbol, definition, caller] of callerPairs) { const source = await readFile(join(root, caller), 'utf8'); assert(source.includes(symbol), 'Actual external production caller: ' + symbol); assert.notEqual(definition, caller); callers.push({ symbol, definition, caller, sha256: sha(source) }) }
const managerSource=await readFile(join(root,'apps/host/src/continuous-progress-loop-manager.ts'),'utf8'), controlSource=await readFile(join(root,'apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx'),'utf8')
const intervalIsolation=[
  {owner:'apps/host/src/continuous-progress-loop-manager.ts',fact:'Schedule listing selects saved schedules',pattern:'this.scheduler.list(target ?? directory).filter(isAgentSchedule)'},
  {owner:'apps/host/src/continuous-progress-loop-manager.ts',fact:'Progress list and action use the same exact-target filter',pattern:"const matches = (loop: ContinuousProgressLoop) => !isAgentSchedule(loop) && loop.taskSource?.kind !== 'goal'"},
  {owner:'apps/host/src/continuous-progress-loop-manager.ts',fact:'Progress action rejects a different target',pattern:'if (!matches(loop)) throw new AgentMuxError'}
]
for(const item of intervalIsolation)assert(managerSource.includes(item.pattern),item.fact)
assert(controlSource.includes('isAgentSchedule(loop)') && controlSource.includes('!isAgentSchedule(loop)'),'Original interval UI excludes mixed-version calendar records')
const coreManifest = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'))
const coreOutputs = Object.fromEntries(Object.entries(coreManifest.exports).filter(([key, value]) => !key.includes('*') && value.import).map(([key, value]) => [key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), join(root, 'packages/core', value.import)]))
const shippingCli = join(root, 'packages/core/bin/amux')
// Preserve the shipping Core ESM graph (including its async/cyclic modules), rather than rebundling it.
const buildOptions = { bundle: true, platform: 'node', format: 'esm', metafile: true,
  alias: { electron: join(fixture, 'electron.ts') }, logLevel: 'silent', plugins: [{ name: 'original-shipping-core', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\/core(?:\/|$)/ }, args => ({ path: coreOutputs[args.path], external: true }))
    builder.onResolve({ filter: /packages\/core\/dist\// }, args => ({ path: resolve(dirname(args.importer), args.path), external: true }))
    builder.onResolve({ filter: /^[^./]/ }, async args => {
      if (isBuiltin(args.path) || args.pluginData === 'original-resolution') return undefined
      const original = await builder.resolve(args.path, { resolveDir: dirname(args.importer), kind: args.kind, pluginData: 'original-resolution' })
      return original.errors.length ? { errors: original.errors } : { path: original.path, external: true }
    })
  } }] }
const built = await build({ ...buildOptions, entryPoints: [join(fixture, 'owner.ts')], outfile: join(evidence, 'owner.mjs') })
const compilationInputs = Object.keys(built.metafile.inputs).map(path => resolve(root, path))
const compiledCoreInputs = (await readdir(join(root, 'packages/core/dist'))).filter(name => /\.(?:js|json)$/.test(name)).map(name => join(root, 'packages/core/dist', name))
const compiledBindings = await Promise.all([...compiledCoreInputs, shippingCli, ...compilationInputs, join(evidence, 'owner.mjs')].map(async path => ({ path: relative(root, path), sha256: sha(await readFile(path)) })))
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amsch-")), state = join(privateRoot, 's'), runtime = join(privateRoot, 'r'), workspace = join(privateRoot, 'w')
await Promise.all([mkdir(state, { mode: 0o700 }), mkdir(runtime, { mode: 0o700 }), mkdir(workspace)])
await mkdir(join(state, 'ctxmux'), { mode: 0o700 })
await mkdir(join(state, 'actions'), { mode: 0o700 })
const baseEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'), SCHEDULE_PROBE_WORKSPACE: workspace, SCHEDULE_PROBE_AGENT: join(fixture, 'native-agent.mjs'), SCHEDULE_PROBE_CLI: shippingCli, SCHEDULE_PROBE_NOW: String(Date.parse(_hygiene_fixtureIso(24134400000, "minute"))) }
const artifact = join(root, 'packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
const daemon = spawn(artifact, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env: baseEnv, stdio: ['ignore','ignore','pipe','pipe'] })
let owner, nativeErrors = ''; daemon.stderr.on('data', part => { nativeErrors += String(part) })
const waitReady = child => new Promise((yes, no) => {
  let stdout = '', stderr = ''; const timeout = setTimeout(() => no(new Error('Private owner readiness timed out: ' + stderr)), 20000)
  child.stderr.on('data', part => { stderr += String(part) }); child.stdout.on('data', part => { stdout += String(part); if (stdout.includes('\n')) { clearTimeout(timeout); try { yes(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))) } catch (error) { no(error) } } }); child.once('error', no); child.once('exit', code => { clearTimeout(timeout); no(new Error(`Private owner exited ${code}: ${stderr}`)) })
})
const stop = async child => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } }
const boot = async env => { owner = spawn(process.execPath, [join(evidence, 'owner.mjs')], { env, stdio: ['ignore','pipe','pipe','ipc'] }); return await waitReady(owner) }
const cliJournal = []
const cli = async (env, action, data, fail = false) => {
  const input = join(privateRoot, 'request-' + globalThis.crypto.randomUUID() + '-' + action + '.json'); await writeFile(input, JSON.stringify(data))
  let result; try { result = { ...(await run(process.execPath, [shippingCli, 'schedule', action, '--data', input], { env: { ...env, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(runtime, 'schedule.sock') }, timeout: 20000 })), code: 0 } } catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
  const body = JSON.parse((result.stdout || result.stderr).trim().split('\n').at(-1))
  cliJournal.push({ action, request: data, result: body, exitCode: result.code }); assert.equal(result.code === 0, !fail, 'Actual CLI result: ' + JSON.stringify(body)); return body
}
const check = async checkAt => { const reply = once(owner, 'message'); owner.send(checkAt === undefined ? 'check' : { checkAt }); return (await reply)[0] }
const managedCliJournal = []
const managedCli = async (action, params) => {
  const prefix = join(state,'actions',String(managedCliJournal.length)), pending = prefix+'.pending.json', requestPath = prefix+'.request.json', responsePath = prefix+'.response.json'
  await writeFile(pending,JSON.stringify({ action,params })); await rename(pending,requestPath)
  const deadline=Date.now()+20000; let response
  while (!response) { try { response=JSON.parse(await readFile(responsePath,'utf8')) } catch(error) { if(error.code!=='ENOENT' && !(error instanceof SyntaxError)) throw error; if(Date.now()>deadline) throw new Error('Private native managed CLI receipt timed out'); await new Promise(r=>setTimeout(r,20)) } }
  assert.equal(response.code,0,'Actual authenticated Agent CLI result'); managedCliJournal.push({ action,params,result:response.body }); return response.body
}
let restart
try {
  await new Promise((yes, no) => { daemon.stdio[3].once('data', yes); daemon.once('error', no); daemon.once('exit', code => no(new Error(`Private ctxmux ${code}: ${nativeErrors}`))) })
  const a = await boot(baseEnv), calendar = { kind: 'daily', timezone: 'UTC', time: _hygiene_fixtureClock(9, 30), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' } }
  assert.equal(a.borrowed, true); assert.equal(a.hostedOwner.processId, a.pid)
  const originalRequest = { target: a.target, ...(timerTask ? { afterMs: 90000 } : { calendar }), prompt: 'one future question', operationId: 'private-schedule-create' }
  const created = await cli(baseEnv, 'create', originalRequest)
  const schedule = created.result.schedule; assert(schedule.loopId && schedule.revision === 1)
  if (timerTask) {
    assert.equal(schedule.afterMs, 90000); assert.equal(schedule.nextCheckAt, Number(baseEnv.SCHEDULE_PROBE_NOW) + 90000)
    const civil = await cli(baseEnv, 'create', { target: a.target, calendar, prompt: 'saved calendar remains separate', operationId: 'private-calendar-create' })
    await cli(baseEnv, 'cancel', { scheduleId: civil.result.schedule.loopId, expectedRevision: 1, operationId: 'private-calendar-cancel' })
  }
  const agentCreated = await managedCli('create',{ target:a.target,...(timerTask ? {afterMs:300000} : {calendar:{...calendar,kind:'once',date:_hygiene_fixtureCivil(12, 1)}}),prompt:'original authenticated agent future message',operationId:'private-agent-schedule-create' })
  const agentSchedule=agentCreated.result.schedule
  await managedCli('cancel',{scheduleId:agentSchedule.loopId,expectedRevision:1,operationId:'private-agent-schedule-cancel'})
  const { AgentMuxFileAgentSessionStore } = await import(new URL('../../../packages/core/dist/index.js', import.meta.url).href)
  const privateStore = new AgentMuxFileAgentSessionStore(join(state, 'sessions.json'))
  const savedSession = (await privateStore.load()).find(item => item.agentSessionId === a.target.agentSessionId)
  assert.equal(savedSession.futurePromptIntents[schedule.futureIntentId].active, true)
  assert(savedSession.futurePromptIntents[schedule.futureIntentId].prompt.includes('one future question'))
  assert.equal(savedSession.futurePromptIntents[agentSchedule.futureIntentId].message.authorAgentSessionId,a.target.agentSessionId)
  assert.equal(savedSession.futurePromptIntents[agentSchedule.futureIntentId].active,false)
  await stop(owner)
  const overdue = { ...baseEnv, SCHEDULE_PROBE_NOW: String(schedule.nextCheckAt), SCHEDULE_PROBE_DROP_RECEIPT: '1' }
  const b = await boot({ ...overdue, SCHEDULE_PROBE_NOW: String(schedule.nextCheckAt - 1) }); assert.notEqual(a.pid, b.pid); assert.deepEqual(a.target, b.target)
  assert.equal(b.borrowed, true); assert.equal(a.hostedOwner.runtimeId, b.hostedOwner.runtimeId); assert.notEqual(a.hostedOwner.ownerInstanceId, b.hostedOwner.ownerInstanceId)
  const before = await cli(overdue, 'inspect', { scheduleId: schedule.loopId }); assert.equal(before.result.schedule.nextCheckAt, schedule.nextCheckAt)
  const duplicate = await cli(overdue, 'create', originalRequest); assert.equal(duplicate.result.schedule.nextCheckAt, schedule.nextCheckAt); assert.equal(duplicate.result.schedule.loopId, schedule.loopId)
  await check(schedule.nextCheckAt)
  const unknown = await cli(overdue, 'inspect', { scheduleId: schedule.loopId }); assert.equal(unknown.result.schedule.lastOutcome, 'unknown')
  const originalOperation = unknown.result.schedule.pendingCompletion.operationId
  const nativeBefore = await readFile(join(state, 'native-input.ndjson'), 'utf8')
  assert(nativeBefore.includes('one future question'), 'Real private native provider received the original input'); await writeFile(join(evidence,'native-input.ndjson'),nativeBefore)
  await stop(owner)
  const c = await boot({ ...overdue, SCHEDULE_PROBE_DROP_RECEIPT: '' }); assert.notEqual(b.pid, c.pid)
  assert.equal(c.borrowed, true); assert.equal(b.hostedOwner.runtimeId, c.hostedOwner.runtimeId); assert.notEqual(b.hostedOwner.ownerInstanceId, c.hostedOwner.ownerInstanceId)
  const recovered = await cli(overdue, 'inspect', { operationId: originalOperation }); assert.equal(recovered.result.schedule.pendingCompletion.operationId, originalOperation); assert.equal(recovered.result.schedule.status, 'paused')
  await check(); assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), nativeBefore, 'Unknown receipt restart never blindly resends')
  await cli(overdue, 'resume', { scheduleId: schedule.loopId, expectedRevision: 1, operationId: 'private-resume' }); await check()
  assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), nativeBefore, 'Explicit original-operation reconciliation does not duplicate native input')
  if (timerTask) {
    const ended = await cli(overdue, 'inspect', { scheduleId: schedule.loopId }); assert.equal(ended.result.schedule.status, 'stopped'); assert.equal(ended.result.schedule.nextCheckAt, schedule.nextCheckAt)
    await check(); assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), nativeBefore, 'A sent one-shot never starts another occurrence')
    await cli(overdue, 'cancel', { scheduleId: schedule.loopId, expectedRevision: 2, operationId: 'private-cancel' })
    await cli(overdue, 'resume', { scheduleId: schedule.loopId, expectedRevision: 3, operationId: 'private-rejected' }, true)
    // Exercise a second original intent through the same public CLI, Host and native Run.
    const repeatedRequest = { target: a.target, everyMs: 60_000, prompt: 'repeat the original task', operationId: 'private-repeat-create' }
    const repeated = (await cli(overdue, 'create', repeatedRequest)).result.schedule
    assert.equal(repeated.everyMs, 60_000)
    assert.equal(repeated.nextCheckAt, Number(overdue.SCHEDULE_PROBE_NOW) + 60_000)
    await stop(owner)
    const repeatDue = { ...overdue, SCHEDULE_PROBE_NOW: String(repeated.nextCheckAt), SCHEDULE_PROBE_DROP_RECEIPT: '1' }
    const d = await boot({ ...repeatDue, SCHEDULE_PROBE_NOW: String(repeated.nextCheckAt - 1) }); assert.deepEqual(d.target, a.target)
    const recoveredRepeat = (await cli(repeatDue, 'inspect', { scheduleId: repeated.loopId })).result.schedule
    assert.equal(recoveredRepeat.futureIntentId, repeated.futureIntentId)
    await check(repeated.nextCheckAt)
    const repeatUnknown = (await cli(repeatDue, 'inspect', { scheduleId: repeated.loopId })).result.schedule
    assert.equal(repeatUnknown.lastOutcome, 'unknown')
    const repeatOperation = repeatUnknown.pendingCompletion.operationId
    const repeatInput = await readFile(join(state, 'native-input.ndjson'), 'utf8')
    assert(repeatInput.includes('repeat the original task'), 'Original native Run received the repeating message')
    await stop(owner)
    const reconcile = { ...repeatDue, SCHEDULE_PROBE_DROP_RECEIPT: '' }
    const e = await boot(reconcile); assert.deepEqual(e.target, a.target)
    const repeatRecovered = (await cli(reconcile, 'inspect', { operationId: repeatOperation })).result.schedule
    assert.equal(repeatRecovered.loopId, repeated.loopId); assert.equal(repeatRecovered.status, 'paused')
    await check(); assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), repeatInput, 'Unknown repeating input is not blindly resent')
    await cli(reconcile, 'resume', { scheduleId: repeated.loopId, expectedRevision: 1, operationId: 'private-repeat-resume' })
    await check()
    assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), repeatInput, 'Original repeating operation reconciles without duplicate input')
    const delivered = (await cli(reconcile, 'inspect', { scheduleId: repeated.loopId })).result.schedule
    assert.equal(delivered.lastOccurrenceAt, repeated.nextCheckAt)
    assert.equal(delivered.nextCheckAt, repeated.nextCheckAt + 60_000)
    await stop(owner)
    const secondDue = { ...reconcile, SCHEDULE_PROBE_NOW: String(delivered.nextCheckAt) }
    const f = await boot({ ...secondDue, SCHEDULE_PROBE_NOW: String(delivered.nextCheckAt - 1) }); assert.deepEqual(f.target, a.target)
    await check(delivered.nextCheckAt)
    const repeatedAgain = (await cli(secondDue, 'inspect', { scheduleId: repeated.loopId })).result.schedule
    assert.equal(repeatedAgain.lastOccurrenceAt, delivered.nextCheckAt)
    assert.equal(repeatedAgain.nextCheckAt, delivered.nextCheckAt + 60_000)
    const twice = await readFile(join(state, 'native-input.ndjson'), 'utf8')
    assert.equal(twice.split('repeat the original task').length - 1, 2, 'Exactly two original messages reach the same native Run')
    await cli(secondDue, 'cancel', { scheduleId: repeated.loopId, expectedRevision: 2, operationId: 'private-repeat-cancel' })
  } else {
    await cli(overdue, 'pause', { scheduleId: schedule.loopId, expectedRevision: 2, operationId: 'private-pause' })
    await cli(overdue, 'cancel', { scheduleId: schedule.loopId, expectedRevision: 3, operationId: 'private-cancel' })
    await cli(overdue, 'resume', { scheduleId: schedule.loopId, expectedRevision: 4, operationId: 'private-rejected' }, true)
  }
  const hostedWire = await readFile(join(state, 'hosted-invocations.ndjson'), 'utf8'), invocations = hostedWire.trim().split('\n').map(line => JSON.parse(line))
  assert(invocations.some(item => item.method === 'saveAgentFuturePromptIntent' && item.args[0].intentId === schedule.futureIntentId && item.args[0].active === true), 'Actual Main borrowed client delegates the saved intent')
  assert(invocations.some(item => item.method === 'submitAgentPrompt' && item.args[0].expectedFutureIntent?.intentId === schedule.futureIntentId), 'Actual Main borrowed client delegates the same future occurrence')
  assert(invocations.some(item => item.method === 'saveAgentFuturePromptIntent' && item.args[0].intentId === schedule.futureIntentId && item.args[0].active === false), 'Cancel converges the original Host admission')
  await writeFile(join(evidence,'hosted-invocations.ndjson'),hostedWire)
  const finalSession = (await privateStore.load()).find(item => item.agentSessionId === a.target.agentSessionId)
  assert.deepEqual(finalSession.run, savedSession.run); assert.equal(finalSession.futurePromptIntents[schedule.futureIntentId].active, false)
  assert.equal(finalSession.futurePromptIntents[schedule.futureIntentId].lastOperationId, originalOperation)
  await writeFile(join(evidence,'future-admission.json'),JSON.stringify({ saved: savedSession, recovered: finalSession },null,2)+'\n')
  restart = { pids: [a.pid,b.pid,c.pid], hostedOwners: [a.hostedOwner,b.hostedOwner,c.hostedOwner], borrowedClient: true, target: a.target, run: savedSession.run, scheduleId: schedule.loopId, nextDue: schedule.nextCheckAt, originalOperation, hostedInvocationSha256: sha(hostedWire), nativeInputSha256: sha(nativeBefore), artifactSha256: sha(await readFile(artifact)), sdkPath: await realpath(join(root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')) }
} finally { await stop(owner); await stop(daemon); await rm(privateRoot, { recursive: true, force: true }) }
await writeFile(join(evidence,'actual-cli.ndjson'),cliJournal.map(item=>JSON.stringify(item)).join('\n')+'\n')
await writeFile(join(evidence,'actual-managed-cli.ndjson'),managedCliJournal.map(item=>JSON.stringify(item)).join('\n')+'\n')
for (const binding of [...sourceBindings,...testBindings,...compiledBindings,verificationBinding]) assert.equal(sha(await readFile(join(root,binding.path))),binding.sha256,'Qualified candidate remained unchanged: '+binding.path)
await writeFile(join(evidence, privateOnly ? 'private-probe.json' : 'receipt.json'), JSON.stringify({ schema: 'agentmux.agent-schedules.v1', passed: !privateOnly, task, sourceBindings, testBindings, compiledBindings, verificationBinding, qualification: { host: 'private original semantic Host + production GoalRuntime using finite borrowed SDK over real Unix RPC', provider: 'private native hook fixture with real ctxmux Input', electron: 'unrelated Electron surface APIs are unavailable', userAppOrModel: 'not operated', intervalIsolation:'Finite original IPC/UI Source wiring inspection; not a claim of operating the Electron app' }, typecheck, baseline, mutations: reds, restored, callers, intervalIsolation, restart }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: !privateOnly, task, tests: restored?.passed ?? 0, mutations: reds.length, restartPids: restart.pids, receipt: join(evidence, privateOnly ? 'private-probe.json' : 'receipt.json') }) + '\n')
