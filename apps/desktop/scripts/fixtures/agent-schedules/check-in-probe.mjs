import { fixtureClock as _hygiene_fixtureClock, fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, realpath, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..'), require = createRequire(import.meta.url), { build } = createRequire(require.resolve('vite'))('esbuild'), run = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
export async function checkInNativeProbe(evidence, { factsOnly = false, onProgress = () => {} } = {}) {
  await mkdir(evidence, { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8')), alias = { electron: join(fixture, 'electron.ts') }
  for (const [key, value] of Object.entries(manifest.exports)) alias['@agentmux/core' + (key === '.' ? '' : key.slice(1))] = resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace('.js', '.ts'))
  for (const [source, target] of [[join(root, 'packages/core/node_modules'), join(evidence, 'node_modules')], [join(root, 'packages/core/vendor'), join(evidence, '../vendor')], [join(root, 'packages/core/bin'), join(evidence, '../bin')]]) { try { await symlink(source, target) } catch (error) { if (error.code !== 'EEXIST') throw error } }
  const options = { bundle: true, platform: 'node', format: 'esm', external: ['@ctxmux/sdk', 'fs-native-extensions'], alias, logLevel: 'silent', metafile: true, banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } }
  const sourceBindings = {}
  for (const name of ['check-in-owner', 'cli']) { const result = await build({ ...options, entryPoints: [join(fixture, name + '.ts')], outfile: join(evidence, name + '.mjs') }); for (const file of Object.keys(result.metafile.inputs)) sourceBindings[file] = sha(await readFile(resolve(root, file))) }
  const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amq-")), state = join(privateRoot, 's'), runtime = join(privateRoot, 'r'), workspace = join(privateRoot, 'w')
  for (const dir of [state, runtime, workspace, join(state, 'ctxmux'), join(state, 'actions')]) await mkdir(dir, { mode: 0o700 })
  const initial = Date.now() - 360000, baseEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
    AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state, AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
    SCHEDULE_PROBE_WORKSPACE: workspace, SCHEDULE_PROBE_AGENT: join(fixture, 'check-in-native.mjs'), SCHEDULE_PROBE_CLI: join(evidence, 'cli.mjs'), SCHEDULE_PROBE_NOW: String(initial) }
  const artifact = join(root, 'packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
  const daemon = spawn(artifact, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env: baseEnv, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let owner, serial = 0, stderr = '', journal = [], managedJournal = [], owners = [], result
  daemon.stderr.on('data', part => { stderr += String(part) })
  const stop = async child => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } }
  const boot = async env => {
    owner = spawn(process.execPath, [join(evidence, 'check-in-owner.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const ready = await new Promise((yes, no) => { let out = '', err = ''; const timeout = setTimeout(() => no(new Error('Private owner timeout: ' + err)), 20000); owner.stdout.on('data', part => { out += String(part); if (out.includes('\n')) { clearTimeout(timeout); yes(JSON.parse(out.split('\n')[0])) } }); owner.stderr.on('data', part => { err += String(part) }); owner.once('exit', code => { clearTimeout(timeout); no(new Error('Private owner exited ' + code + ': ' + err)) }); owner.once('error', no) })
    owners.push(ready); return ready
  }
  const command = async (action, params = {}) => { const id = ++serial; const response = new Promise((yes, no) => { const timer = setTimeout(() => { owner.off('message', receive); no(new Error('Private command timeout ' + action)) }, 30000); const receive = value => { if (value.id !== id) return; clearTimeout(timer); owner.off('message', receive); value.error ? no(new Error(JSON.stringify(value.error))) : yes(value.result) }; owner.on('message', receive) }); owner.send({ id, action, ...params }); return await response }
  const cli = async (action, params, expectedSuccess = true) => {
    const dataPath = join(privateRoot, 'request-' + ++serial + '.json'); await writeFile(dataPath, JSON.stringify(params))
    let output; try { output = { ...(await run(process.execPath, [join(evidence, 'cli.mjs'), 'schedule', action, '--data', dataPath], { env: { ...baseEnv, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(runtime, 'schedule.sock') }, timeout: 20000 })), code: 0 } } catch (error) { output = { stdout: error.stdout, stderr: error.stderr, code: error.code } }
    const body = JSON.parse((output.stdout || output.stderr).trim().split('\n').at(-1)); journal.push({ action, params, code: output.code, body }); assert.equal(output.code === 0, expectedSuccess, JSON.stringify(body)); return body
  }
  try {
    await new Promise((yes, no) => { daemon.stdio[3].once('data', yes); daemon.once('error', no); daemon.once('exit', code => no(new Error('Private ctxmux ' + code + ': ' + stderr))) })
    const first = await boot(baseEnv); assert(first.borrowed); assert.equal(first.hostedOwner.processId, first.pid)
    const humanTimeline = await command('human', { operationId: 'genuine-human-topic' }), marker = humanTimeline.items.find(item => item.id === 'prompt:genuine-human-topic')
    assert.equal(marker.authorHuman, true); assert.equal(marker.status, 'complete'); assert.equal(marker.authorAgentSessionId, undefined)
    await delay(200)
    const firstFacts = await command('facts', { now: Date.now() }); await writeFile(join(evidence, 'genuine-human-facts.json'), JSON.stringify(firstFacts, null, 2) + '\n')
    assert.equal(firstFacts.observation.known, true, 'Actual native input timestamps must permit the genuine captured human context')
    assert(firstFacts.page.items.some(item => item.kind === 'user-message')); assert.equal(firstFacts.observation.human.id, marker.id)
    assert((await command('cancel-read')).rejected, 'Actual borrowed finite SDK cancels its strict read')
    if (factsOnly) result = { factsOnly, owners, firstFacts }
    else {
      const policy = { silenceMs: 300000, minIntervalMs: 300000, dailyBudget: 1, quiet: { start: _hygiene_fixtureClock(0, 0), end: _hygiene_fixtureClock(0, 1) } }, calendar = { kind: 'daily', timezone: 'UTC', time: new Date(marker.createdAt).toISOString().slice(11, 16), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' } }
      const created = await cli('create', { target: first.target, calendar, checkIn: policy, prompt: 'Ask one question about our confirmed design decision.', operationId: 'quiet-followup-opt-in' }), schedule = created.result.schedule
      assert.deepEqual(schedule.checkIn, policy)
      const prefix = join(state, 'actions', 'managed-checkin'), pending = prefix + '.pending.json'; await writeFile(pending, JSON.stringify({ action: 'create', params: { target: first.target, calendar, checkIn: policy, prompt: 'Managed caller cannot enable quiet follow-up', operationId: 'managed-forbidden-opt-in' } })); await rename(pending, prefix + '.request.json')
      const deadline = Date.now() + 20000; let response
      while (!response) { try { response = JSON.parse(await readFile(prefix + '.response.json', 'utf8')) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; if (Date.now() > deadline) throw error; await delay(20) } }
      assert.notEqual(response.code, 0); assert.equal(response.body.error.code, 'SCHEDULE_CHECK_IN_OPT_IN_REQUIRED'); managedJournal.push(response)
      const beforeInputs = await readFile(join(state, 'native-input.ndjson'), 'utf8')
      onProgress({ step: 'Waiting for the saved five-minute silence interval', until: marker.createdAt + policy.silenceMs + 50 })
      while (Date.now() < marker.createdAt + policy.silenceMs + 50) await delay(Math.min(1000, marker.createdAt + policy.silenceMs + 50 - Date.now()))
      const claimAt = Date.now(), checked = await command('check', { now: claimAt }), asked = checked.find(item => item.loopId === schedule.loopId)
      assert.equal(asked.lastOutcome, 'sent', JSON.stringify(asked)); assert.equal(asked.checkInState.unanswered.humanId, marker.id); assert.equal(asked.checkInState.budgetUsed, 1)
      await delay(200); const afterInputs = await readFile(join(state, 'native-input.ndjson'), 'utf8'); assert.notEqual(afterInputs, beforeInputs); assert(afterInputs.includes('Ask one question about our confirmed design decision.'))
      const askedFacts = await command('facts', { now: Date.now() }); assert.equal(askedFacts.observation.known, false, 'The follow-up native input never fabricates a human reply')
      const replyTimeline = await command('human', { operationId: 'genuine-human-reply' }), reply = replyTimeline.items.find(item => item.id === 'prompt:genuine-human-reply'); assert(reply.createdAt > claimAt); assert.notEqual(reply.id, marker.id)
      await delay(200); const replyFacts = await command('facts', { now: Date.now() }); assert.equal(replyFacts.observation.known, true); assert.equal(replyFacts.observation.human.id, reply.id)
      await cli('pause', { scheduleId: schedule.loopId, expectedRevision: 1, operationId: 'quiet-pause' }); await stop(owner)
      const second = await boot({ ...baseEnv, SCHEDULE_PROBE_NOW: String(claimAt + 86400000) }); assert.notEqual(second.pid, first.pid); assert.deepEqual(second.target, first.target); assert.equal(second.hostedOwner.runtimeId, first.hostedOwner.runtimeId); assert.notEqual(second.hostedOwner.ownerInstanceId, first.hostedOwner.ownerInstanceId)
      const recovered = await cli('inspect', { scheduleId: schedule.loopId }); assert.deepEqual(recovered.result.schedule.checkInState, asked.checkInState)
      await cli('resume', { scheduleId: schedule.loopId, expectedRevision: 2, operationId: 'quiet-resume' }); const answered = (await command('check', { now: claimAt + 86400000 })).find(item => item.loopId === schedule.loopId)
      assert.equal(answered.lastOutcome, 'sent'); assert.equal(answered.checkInState.unanswered.humanId, reply.id, 'A genuinely newer human input clears the original unanswered fence')
      await cli('cancel', { scheduleId: schedule.loopId, expectedRevision: 3, operationId: 'quiet-cancel' })
      await writeFile(join(evidence, 'genuine-reply-facts.json'), JSON.stringify({ claimAt, marker, reply, asked, askedFacts, replyFacts, recovered, answered }, null, 2) + '\n')
      await writeFile(join(evidence, 'native-input.ndjson'), await readFile(join(state, 'native-input.ndjson')))
      result = { owners, sourceBindings, firstFacts, claimAt, marker, reply, scheduleId: schedule.loopId, artifactSha256: sha(await readFile(artifact)), sdkPath: await realpath(join(root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')), qualified: 'Actual native timestamps and authenticated captured humans. First silence interval elapsed on the wall clock; subsequent calendar recovery uses a test Host clock. Same real Run and independent Host PID, no model response claim.' }
    }
    await writeFile(join(evidence, 'hosted-invocations.ndjson'), await readFile(join(state, 'hosted-invocations.ndjson')))
    await writeFile(join(evidence, 'actual-cli.json'), JSON.stringify(journal, null, 2)); await writeFile(join(evidence, 'actual-managed-cli.json'), JSON.stringify(managedJournal, null, 2))
    await writeFile(join(evidence, 'native-probe.json'), JSON.stringify(result, null, 2) + '\n'); return result
  } finally { await stop(owner); await stop(daemon); await rm(privateRoot, { recursive: true, force: true }) }
}
if (process.argv[1] === import.meta.filename) { const evidence = resolve(root, '.tmp/agent-schedules/checkin-native-' + globalThis.crypto.randomUUID()); console.log(JSON.stringify({ evidence })); const result = await checkInNativeProbe(evidence, { factsOnly: process.argv.includes('--facts-only'), onProgress: value => console.log(JSON.stringify(value)) }); console.log(JSON.stringify({ passed: true, owners: result.owners.map(owner => owner.pid), evidence })) }
