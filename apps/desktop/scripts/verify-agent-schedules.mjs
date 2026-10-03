import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdtemp, mkdir, rm, realpath, symlink, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
const run = promisify(execFile), require = createRequire(import.meta.url), viteRequire = createRequire(require.resolve('vite')), { build } = viteRequire('esbuild')
const root = resolve(import.meta.dirname, '../../..'), fixture = join(root, 'apps/desktop/scripts/fixtures/agent-schedules')
const taskIndex = process.argv.indexOf('--task'), task = taskIndex < 0 ? 'calendar' : process.argv[taskIndex + 1]
if (task === 'presentation' || task === 'ui') { await (await import('./verify-agent-schedules-ui.mjs')).verifyScheduleUi(); process.exit(process.exitCode ?? 0) }
assert.equal(task, 'calendar', 'This lane currently qualifies the calendar task only.')
const evidence = join(root, '.tmp/agent-schedules/calendar'); await mkdir(evidence, { recursive: true })
const sha = text => createHash('sha256').update(text).digest('hex')
const vitest = join(require.resolve('vitest/package.json'), '..', 'vitest.mjs'), config = join(fixture, 'vitest.config.mjs')
async function tests(label, filter, mutationEnv = {}) {
  const args = [vitest, 'run', '--config', config, '--reporter=json', '--outputFile', join(evidence, label + '.json'), ...(filter ? ['-t', filter] : [])]
  let result; try { result = { ...(await run(process.execPath, args, { cwd: root, env: { ...process.env, ...mutationEnv }, maxBuffer: 4 * 1024 * 1024, timeout: 120000 })), exitCode: 0 } } catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code } }
  await writeFile(join(evidence, label + '.log'), result.stdout + result.stderr)
  const report = JSON.parse(await readFile(join(evidence, label + '.json'), 'utf8'))
  assert(report.numTotalTests > 0, 'Source proof cannot be empty')
  return { exitCode: result.exitCode, failed: report.numFailedTests, passed: report.numPassedTests, assertions: report.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed')) }
}
const sourceFiles = ['packages/core/src/types.ts','packages/core/src/client.ts','packages/core/src/prompt-submission.ts','packages/core/src/agent-session-store.ts','packages/core/src/hosted-client-contract.ts','packages/core/src/hosted-client.ts','packages/core/src/hosted-runtime-service.ts','packages/core/src/headless-runtime.ts','packages/core/src/public-rpc-client.ts','packages/core/src/public-rpc-server.ts','packages/core/src/continuous-progress.ts','packages/core/src/continuous-progress-scheduler.ts','packages/core/src/agent-schedule.ts','packages/core/src/public-rpc-schedules.ts','packages/core/src/schedule-cli.ts','packages/core/src/public-rpc.ts','packages/core/src/public-rpc-service.ts','packages/core/src/rpc-native-codec.ts','packages/core/src/agentmux-cli-commands.ts','packages/core/src/index.ts','apps/desktop/src/main/agent-schedule-calendar.ts','apps/desktop/src/main/continuous-progress-loop-manager.ts','apps/desktop/src/main/continuous-progress-loop-store.ts','apps/desktop/src/main/continuous-progress-delivery.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/desktop-host.ts','apps/desktop/src/main/index.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/main/ipc-sender-trust.ts','apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx','apps/desktop/src/renderer/src/lib/api.ts','apps/desktop/src/preload/index.ts','apps/desktop/src/shared/contracts.ts']
const sourceBindings = await Promise.all(sourceFiles.map(async path => ({ path, sha256: sha(await readFile(join(root,path))) })))
const testFiles = ['apps/desktop/test/agent-schedules.test.ts','apps/desktop/test/continuous-progress-loop-manager.test.ts','apps/desktop/test/continuous-progress-loop-store.test.ts','packages/core/test/client-submit-prompt-run-binding.test.ts','packages/core/test/continuous-progress.test.ts','packages/core/test/continuous-progress-scheduler.test.ts','apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs','apps/desktop/scripts/fixtures/agent-schedules/owner.ts','apps/desktop/scripts/fixtures/agent-schedules/native-agent.mjs','apps/desktop/scripts/fixtures/agent-schedules/electron.ts','apps/desktop/scripts/fixtures/agent-schedules/cli.ts','tsconfig.base.json','apps/desktop/tsconfig.json','packages/core/package.json']
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
  typecheck={passed:true,configurationSha256:sha(configuration),includes:3,scope:'Original Main RuntimeController/Manager + finite borrowed Host + owning Source tests'}
}
const baseline = privateOnly ? null : await tests('source-green'); if (baseline) { assert.equal(baseline.exitCode, 0); assert(baseline.passed > 0) }
const mutations = [
  { file: 'apps/desktop/src/main/agent-schedule-calendar.ts', from: "civil.hour !== hour || civil.minute !== minute", to: 'false', filter: 'skips DST gaps', name: 'gap-normalization' },
  { file: 'packages/core/src/prompt-submission.ts', from: 'saved.lastOccurrenceAt >= expectedFutureIntent.occurrenceAt', to: 'false', filter: 'admits each occurrence once', name: 'repeat-occurrence' },
  { file: 'packages/core/src/prompt-submission.ts', from: 'promptMessageIdentity(saved.message) !== promptMessageIdentity(message) ||', to: '', filter: 'refuses changed future content fields', name: 'future-message-fields' },
  { file: 'packages/core/src/hosted-client-contract.ts', from: ", 'saveAgentFuturePromptIntent'", to: '', filter: 'delegates a borrowed future-message', name: 'hosted-method-disconnect' },
  { file: 'packages/core/src/client.ts', from: 'let authorAgentSessionId: string | undefined\n      if (input.caller)', to: 'let authorAgentSessionId: string | undefined\n      if (false && input.caller)', filter: 'authenticates future producer', name: 'future-author-disconnect' },
  { file: 'apps/desktop/src/main/continuous-progress-loop-manager.ts', from: 'await this.authorizeCaller(loop, context)', to: 'void context', filter: 'refuses unauthorized mutation', name: 'mutation-authorization' },
  { file: 'apps/desktop/src/main/continuous-progress-loop-manager.ts', from: 'await this.store.save(this.scheduler.list())\n              if (!isCurrent()) continue', to: 'if (!isCurrent()) continue', filter: 'freezes and persists the original claim', name: 'claim-before-send' },
  { file: 'apps/desktop/src/main/continuous-progress-loop-manager.ts', from: "futureIntent ? decideFutureProgress(observation, futureIntent)", to: 'false ? decideFutureProgress(observation, futureIntent)', filter: 'keeps the occurrence due', name: 'future-owner-disconnect' }
]
const reds = []
for (const mutation of privateOnly ? [] : mutations) {
  const path = join(root, mutation.file), source = await readFile(path, 'utf8')
  assert.equal(source.split(mutation.from).length, 2, 'Exact production mutation must be unique: ' + mutation.name)
  const copy = join(evidence, mutation.name + '.mutant.ts'), mutant = source.replace(mutation.from, mutation.to)
  await writeFile(copy, mutant)
  const red = await tests('red-' + mutation.name, mutation.filter, { AGENT_SCHEDULE_MUTANT_OWNER: path, AGENT_SCHEDULE_MUTANT_COPY: copy })
  assert.notEqual(red.exitCode, 0); assert(red.failed > 0 && red.assertions.some(item => item.failureMessages.some(message => /AssertionError|expected /u.test(message))), 'Mutation must fail a meaningful assertion')
  assert.equal(await readFile(path, 'utf8'), source, 'Shared production source remains byte-identical')
  reds.push({ ...mutation, sourceSha256: sha(source), mutantSha256: sha(mutant), copy, result: red })
}
const restored = privateOnly ? null : await tests('source-restored'); if (restored) assert.equal(restored.exitCode, 0)
const callerPairs = [
  ['saveAgentFuturePromptIntent(', 'packages/core/src/client.ts', 'apps/desktop/src/main/runtime-controller.ts'],
  ['decideFutureProgress(', 'packages/core/src/continuous-progress.ts', 'apps/desktop/src/main/continuous-progress-loop-manager.ts'],
  ['createCalendar(', 'packages/core/src/continuous-progress-scheduler.ts', 'apps/desktop/src/main/continuous-progress-loop-manager.ts'],
  ['deliverContinuousProgress(', 'apps/desktop/src/main/continuous-progress-delivery.ts', 'apps/desktop/src/main/index.ts'],
  ['validateScheduleRpcResult', 'packages/core/src/public-rpc-schedules.ts', 'packages/core/src/rpc-native-codec.ts'],
  ['schedules: args.progressLoops', 'apps/desktop/src/main/continuous-progress-loop-manager.ts', 'apps/desktop/src/main/ipc.ts'],
  ['authorizeFutureIntent(', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/index.ts']
]
const callers = []
for (const [symbol, definition, caller] of callerPairs) { const source = await readFile(join(root, caller), 'utf8'); assert(source.includes(symbol), 'Actual external production caller: ' + symbol); assert.notEqual(definition, caller); callers.push({ symbol, definition, caller, sha256: sha(source) }) }
const ipcSource=await readFile(join(root,'apps/desktop/src/main/ipc.ts'),'utf8'), controlSource=await readFile(join(root,'apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx'),'utf8')
const intervalIsolation=[
  {owner:'apps/desktop/src/main/ipc.ts',fact:'Original interval list excludes calendar',pattern:'list().filter(loop => !loop.calendar && progressTargetMatches(loop, target))'},
  {owner:'apps/desktop/src/main/ipc.ts',fact:'Original interval action excludes calendar',pattern:'list().find(loop => !loop.calendar && loop.loopId === loopId && progressTargetMatches(loop, target))'},
  {owner:'apps/desktop/src/main/ipc.ts',fact:'One original owner routes calendar and interval events to their typed consumers',pattern:'send(loop.calendar ? SCHEDULE_CHANGED : CONTINUOUS_PROGRESS_CHANGED, loop)'}
]
for(const item of intervalIsolation)assert(ipcSource.includes(item.pattern),item.fact)
assert(controlSource.includes('loop.calendar') && controlSource.includes('!loop.calendar'),'Original interval UI excludes mixed-version calendar records')
const buildOptions = { bundle: true, platform: 'node', format: 'esm', external: ['@ctxmux/sdk','fs-native-extensions'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, alias: { electron: join(fixture, 'electron.ts'), '@agentmux/core': join(root, 'packages/core/src/index.ts'), '@agentmux/core/run-status': join(root, 'packages/core/src/agent-run-status.ts'), '@agentmux/core/agent-status': join(root, 'packages/core/src/agent-status-freshness.ts') }, logLevel: 'silent' }
for (const [source, target] of [[join(root, 'packages/core/node_modules'), join(evidence, 'node_modules')], [join(root, 'packages/core/vendor'), join(evidence, '../vendor')], [join(root, 'packages/core/bin'), join(evidence, '../bin')]]) { try { await symlink(source, target) } catch (error) { if (error.code !== 'EEXIST') throw error } }
await build({ ...buildOptions, entryPoints: [join(fixture, 'owner.ts')], outfile: join(evidence, 'owner.mjs') })
await build({ ...buildOptions, entryPoints: [join(fixture, 'cli.ts')], outfile: join(evidence, 'cli.mjs') })
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amsch-")), state = join(privateRoot, 's'), runtime = join(privateRoot, 'r'), workspace = join(privateRoot, 'w')
await Promise.all([mkdir(state, { mode: 0o700 }), mkdir(runtime, { mode: 0o700 }), mkdir(workspace)])
await mkdir(join(state, 'ctxmux'), { mode: 0o700 })
await mkdir(join(state, 'actions'), { mode: 0o700 })
const baseEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'), SCHEDULE_PROBE_WORKSPACE: workspace, SCHEDULE_PROBE_AGENT: join(fixture, 'native-agent.mjs'), SCHEDULE_PROBE_CLI: join(evidence,'cli.mjs'), SCHEDULE_PROBE_NOW: String(Date.parse(_hygiene_fixtureIso(24134400000, "minute"))) }
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
  let result; try { result = { ...(await run(process.execPath, [join(evidence, 'cli.mjs'), 'schedule', action, '--data', input], { env: { ...env, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(runtime, 'schedule.sock') }, timeout: 20000 })), code: 0 } } catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
  const body = JSON.parse((result.stdout || result.stderr).trim().split('\n').at(-1))
  cliJournal.push({ action, request: data, result: body, exitCode: result.code }); assert.equal(result.code === 0, !fail, 'Actual CLI result: ' + JSON.stringify(body)); return body
}
const check = async () => { const reply = once(owner, 'message'); owner.send('check'); return (await reply)[0] }
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
  const created = await cli(baseEnv, 'create', { target: a.target, calendar, prompt: 'one future question', operationId: 'private-schedule-create' })
  const schedule = created.result.schedule; assert(schedule.loopId && schedule.revision === 1)
  const agentCreated = await managedCli('create',{ target:a.target,calendar:{...calendar,kind:'once',date:_hygiene_fixtureCivil(12, 1)},prompt:'original authenticated agent future message',operationId:'private-agent-schedule-create' })
  const agentSchedule=agentCreated.result.schedule
  await managedCli('cancel',{scheduleId:agentSchedule.loopId,expectedRevision:1,operationId:'private-agent-schedule-cancel'})
  const savedDocument = JSON.parse(await readFile(join(state, 'sessions.json'), 'utf8')), savedSession = savedDocument.sessions.find(item => item.agentSessionId === a.target.agentSessionId)
  assert.equal(savedSession.futurePromptIntents[schedule.futureIntentId].active, true)
  assert(savedSession.futurePromptIntents[schedule.futureIntentId].prompt.includes('one future question'))
  assert.equal(savedSession.futurePromptIntents[agentSchedule.futureIntentId].message.authorAgentSessionId,a.target.agentSessionId)
  assert.equal(savedSession.futurePromptIntents[agentSchedule.futureIntentId].active,false)
  await stop(owner)
  const overdue = { ...baseEnv, SCHEDULE_PROBE_NOW: String(schedule.nextCheckAt), SCHEDULE_PROBE_DROP_RECEIPT: '1' }
  const b = await boot(overdue); assert.notEqual(a.pid, b.pid); assert.deepEqual(a.target, b.target)
  assert.equal(b.borrowed, true); assert.equal(a.hostedOwner.runtimeId, b.hostedOwner.runtimeId); assert.notEqual(a.hostedOwner.ownerInstanceId, b.hostedOwner.ownerInstanceId)
  const before = await cli(overdue, 'inspect', { scheduleId: schedule.loopId }); assert.equal(before.result.schedule.nextCheckAt, schedule.nextCheckAt)
  await check()
  const unknown = await cli(overdue, 'inspect', { scheduleId: schedule.loopId }); assert.equal(unknown.result.schedule.lastOutcome, 'unknown')
  const originalOperation = unknown.result.schedule.pendingCompletion.operationId
  const nativeBefore = await readFile(join(state, 'native-input.ndjson'), 'utf8')
  assert(nativeBefore.includes('one future question'), 'Real private native provider received the original input'); await writeFile(join(evidence,'native-input.ndjson'),nativeBefore)
  await stop(owner)
  const c = await boot(overdue); assert.notEqual(b.pid, c.pid)
  assert.equal(c.borrowed, true); assert.equal(b.hostedOwner.runtimeId, c.hostedOwner.runtimeId); assert.notEqual(b.hostedOwner.ownerInstanceId, c.hostedOwner.ownerInstanceId)
  const recovered = await cli(overdue, 'inspect', { operationId: originalOperation }); assert.equal(recovered.result.schedule.pendingCompletion.operationId, originalOperation); assert.equal(recovered.result.schedule.status, 'paused')
  await check(); assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), nativeBefore, 'Unknown receipt restart never blindly resends')
  await cli(overdue, 'resume', { scheduleId: schedule.loopId, expectedRevision: 1, operationId: 'private-resume' }); await check()
  assert.equal(await readFile(join(state, 'native-input.ndjson'), 'utf8'), nativeBefore, 'Explicit original-operation reconciliation does not duplicate native input')
  await cli(overdue, 'pause', { scheduleId: schedule.loopId, expectedRevision: 2, operationId: 'private-pause' })
  await cli(overdue, 'cancel', { scheduleId: schedule.loopId, expectedRevision: 3, operationId: 'private-cancel' })
  await cli(overdue, 'resume', { scheduleId: schedule.loopId, expectedRevision: 4, operationId: 'private-rejected' }, true)
  const hostedWire = await readFile(join(state, 'hosted-invocations.ndjson'), 'utf8'), invocations = hostedWire.trim().split('\n').map(line => JSON.parse(line))
  assert(invocations.some(item => item.method === 'saveAgentFuturePromptIntent' && item.args[0].intentId === schedule.futureIntentId && item.args[0].active === true), 'Actual Main borrowed client delegates the saved intent')
  assert(invocations.some(item => item.method === 'submitAgentPrompt' && item.args[0].expectedFutureIntent?.intentId === schedule.futureIntentId), 'Actual Main borrowed client delegates the same future occurrence')
  assert(invocations.some(item => item.method === 'saveAgentFuturePromptIntent' && item.args[0].intentId === schedule.futureIntentId && item.args[0].active === false), 'Cancel converges the original Host admission')
  await writeFile(join(evidence,'hosted-invocations.ndjson'),hostedWire)
  const finalDocument = JSON.parse(await readFile(join(state, 'sessions.json'), 'utf8')), finalSession = finalDocument.sessions.find(item => item.agentSessionId === a.target.agentSessionId)
  assert.deepEqual(finalSession.run, savedSession.run); assert.equal(finalSession.futurePromptIntents[schedule.futureIntentId].active, false)
  assert.equal(finalSession.futurePromptIntents[schedule.futureIntentId].lastOperationId, originalOperation)
  await writeFile(join(evidence,'future-admission.json'),JSON.stringify({ saved: savedSession, recovered: finalSession },null,2)+'\n')
  restart = { pids: [a.pid,b.pid,c.pid], hostedOwners: [a.hostedOwner,b.hostedOwner,c.hostedOwner], borrowedClient: true, target: a.target, run: savedSession.run, scheduleId: schedule.loopId, nextDue: schedule.nextCheckAt, originalOperation, hostedInvocationSha256: sha(hostedWire), nativeInputSha256: sha(nativeBefore), artifactSha256: sha(await readFile(artifact)), sdkPath: await realpath(join(root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')) }
} finally { await stop(owner); await stop(daemon); await rm(privateRoot, { recursive: true, force: true }) }
await writeFile(join(evidence,'actual-cli.ndjson'),cliJournal.map(item=>JSON.stringify(item)).join('\n')+'\n')
await writeFile(join(evidence,'actual-managed-cli.ndjson'),managedCliJournal.map(item=>JSON.stringify(item)).join('\n')+'\n')
for (const binding of [...sourceBindings,...testBindings,verificationBinding]) assert.equal(sha(await readFile(join(root,binding.path))),binding.sha256,'Qualified candidate remained unchanged: '+binding.path)
await writeFile(join(evidence, privateOnly ? 'private-probe.json' : 'receipt.json'), JSON.stringify({ schema: 'agentmux.agent-schedules.v1', passed: !privateOnly, task, sourceBindings, testBindings, verificationBinding, qualification: { host: 'private original semantic Host + Main/Runtime methods using finite borrowed SDK over real Unix RPC', provider: 'private native hook fixture with real ctxmux Input', electron: 'unrelated Electron surface APIs are unavailable', userAppOrModel: 'not operated', intervalIsolation:'Finite original IPC/UI Source wiring inspection; not a claim of operating the Electron app' }, typecheck, baseline, mutations: reds, restored, callers, intervalIsolation, restart }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: !privateOnly, task, tests: restored?.passed ?? 0, mutations: reds.length, restartPids: restart.pids, receipt: join(evidence, privateOnly ? 'private-probe.json' : 'receipt.json') }) + '\n')
