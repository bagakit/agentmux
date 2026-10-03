import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { checkInNativeProbe } from './fixtures/agent-schedules/check-in-probe.mjs'

export async function verifyScheduleCheckIn() {
  const root = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url), run = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const parent = join(root, '.tmp/agent-schedules/checkin'); await mkdir(parent, { recursive: true }); const evidence = await mkdtemp(join(parent, 'attempt-'))
  const paths = ['packages/core/src/types.ts', 'packages/core/src/client.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/session-timeline.ts', 'packages/core/src/agent-schedule.ts', 'packages/core/src/continuous-progress-scheduler.ts', 'packages/core/src/public-rpc-schedules.ts', 'packages/core/src/schedule-cli.ts', 'apps/desktop/src/main/agent-schedule-check-in.ts', 'apps/desktop/src/main/continuous-progress-loop-manager.ts', 'apps/desktop/src/main/continuous-progress-loop-store.ts', 'apps/desktop/src/main/continuous-progress-delivery.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/components/CalendarScheduleControl.tsx', 'apps/desktop/src/renderer/src/styles/agent.css', 'docs/design/behavior/agent-capabilities-and-messaging.md', 'docs/specs/public-capabilities.md', 'docs/guides/agentmux-cli-object-control.md', 'apps/desktop/test/agent-schedule-check-in.test.ts', 'apps/desktop/test/calendar-schedule-control.test.tsx', 'packages/core/test/native-source-reconciliation.test.ts', 'apps/desktop/scripts/fixtures/agent-schedules/vitest.check-in.config.mjs', 'apps/desktop/scripts/fixtures/agent-schedules/check-in-owner.ts', 'apps/desktop/scripts/fixtures/agent-schedules/check-in-provider.ts', 'apps/desktop/scripts/fixtures/agent-schedules/check-in-native.mjs', 'apps/desktop/scripts/fixtures/agent-schedules/check-in-probe.mjs', 'apps/desktop/scripts/verify-agent-schedules.mjs', 'apps/desktop/scripts/verify-agent-schedules-check-in.mjs']
  const sourceBindings = await Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })))
  const manifest = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8')), corePaths = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), [resolve(root, 'packages/core', value.types.replace('./dist/', './src/').replace('.d.ts', '.ts'))]]))
  const configuration = { extends: join(root, 'apps/desktop/tsconfig.json'), compilerOptions: { paths: corePaths, incremental: false, types: ['node'], typeRoots: [resolve(require.resolve('@types/node/package.json'), '../..')] }, include: [join(root, paths[28]), join(root, paths[24]), join(root, paths[25]), join(root, paths[26]), join(root, paths[19]), join(root, 'apps/desktop/src/renderer/src/global.d.ts'), resolve(require.resolve('vite'), '../../../client.d.ts')] }
  const configPath = join(evidence, 'tsconfig.json'); await writeFile(configPath, JSON.stringify(configuration, null, 2))
  const types = await run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', configPath], { cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(join(evidence, 'types.log'), types.stdout + types.stderr)
  const names = 'quiet follow-up|fresh current witness|exact current Run witness|strict current read|quiet follow-up controls', config = join(root, 'apps/desktop/scripts/fixtures/agent-schedules/vitest.check-in.config.mjs')
  async function test(label, filter = names, env = {}) {
    const loaded = join(evidence, label + '.loaded.ndjson'); let code = 0, stdout = '', stderr = ''
    try { ({ stdout, stderr } = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '-t', filter, '--reporter=json', '--outputFile', join(evidence, label + '.json')], { cwd: root, env: { ...process.env, ...env, AGENT_SCHEDULE_CHECKIN_LOADED: loaded }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })) } catch (error) { code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
    await writeFile(join(evidence, label + '.log'), stdout + stderr)
    const report = JSON.parse(await readFile(join(evidence, label + '.json'), 'utf8')), rows = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert(report.numPassedTests + report.numFailedTests > 0, 'Owning Source assertions cannot be empty'); assert(rows.length > 0, 'Loaded production Source cannot be empty')
    return { code, passed: report.numPassedTests, failed: report.numFailedTests, assertion: report.testResults.some(file => file.assertionResults.some(test => test.failureMessages.some(message => /AssertionError|expected |promise resolved .+ instead of rejecting/u.test(message)))), loaded, rows }
  }
  const baseline = await test('baseline'); assert.equal(baseline.code, 0); assert.equal(baseline.passed, 16)
  const mutations = [
    { file: paths[1], name: 'strict-retained-fallback', from: "if (options.requireCurrentSource) { diagnose(error instanceof Error ? error.message : 'Current native source confirmation failed.'); throw error }", to: '', filter: 'fresh current witness' },
    { file: paths[1], name: 'strict-final-current-fence', from: 'if (options.requireCurrentSource) strictWitness = assertWitness', to: 'if (false) strictWitness = assertWitness', filter: 'exact current Run witness' },
    { file: paths[2], name: 'borrowed-read-cancellation', from: 'signal = cancellation; wireArgs = [args[0], value, ...args.slice(2)]', to: 'wireArgs = [args[0], value, ...args.slice(2)]', filter: 'borrowed strict current read' },
    { file: paths[9], name: 'trusted-human', from: "item.status === 'complete' && item.authorHuman === true &&", to: "item.status === 'complete' &&", filter: 'exact completed captured human' },
    { file: paths[9], name: 'await-later-human', from: ' || item.createdAt > now', to: '', filter: 'bounded coverage' },
    { file: paths[9], name: 'later-native-unknown', from: ' || item.startedAt! > human.createdAt', to: '', filter: 'bounded coverage' },
    { file: paths[9], name: 'quiet-time', from: "if (start < end ? time >= start && time < end : time >= start || time < end)", to: 'if (false)', filter: 'simultaneously enforces' },
    { file: paths[9], name: 'civil-budget', from: 'if (used >= policy.dailyBudget)', to: 'if (false)', filter: 'simultaneously enforces' },
    { file: paths[9], name: 'unanswered-distinct-human', from: 'human.id !== unanswered.humanId && human.createdAt > unanswered.claimAt', to: 'true', filter: 'distinct genuine later human' },
    { file: paths[10], name: 'final-skipped-unanswered', from: "if (outcome === 'skipped' && newCheckInClaim && settled.checkInState)", to: 'if (false && settled.checkInState)', filter: 'real final delivery input fence' },
    { file: paths[19], name: 'renderer-opt-in', from: '...(checkIn ? { checkIn: structuredClone(DEFAULT_AGENT_SCHEDULE_CHECK_IN) } : {})', to: '...{}', filter: 'explicit opt-in and preserve' },
    { file: paths[19], name: 'renderer-known-follow-up', from: "if (checkIn && visible.some(schedule => schedule.checkIn && schedule.status !== 'stopped'))", to: 'if (false)', filter: 'known paused arrangement' }
  ]
  const reds = []
  for (const mutation of mutations) {
    const owner = join(root, mutation.file), source = await readFile(owner, 'utf8'); assert.equal(source.split(mutation.from).length, 2, 'Unique loaded Source mutation: ' + mutation.name)
    const mutant = source.replace(mutation.from, mutation.to), copy = join(evidence, mutation.name + '.ts'); await writeFile(copy, mutant)
    const result = await test(mutation.name, mutation.filter, { AGENT_SCHEDULE_MUTANT_OWNER: owner, AGENT_SCHEDULE_MUTANT_COPY: copy })
    assert.notEqual(result.code, 0); assert(result.failed > 0 && result.assertion, 'Meaningful assertion RED: ' + mutation.name)
    assert(result.rows.some(row => row.path === mutation.file && row.loadedSha256 === sha(mutant) && row.originalSha256 === sha(source)), 'The actual owning production mutant was loaded')
    assert.equal(await readFile(owner, 'utf8'), source, 'Shared Source bytes remain unchanged')
    const { rows: _, ...summary } = result; reds.push({ ...mutation, sourceSha256: sha(source), mutantSha256: sha(mutant), copy, result: summary })
  }
  const restored = await test('restored'); assert.equal(restored.code, 0); assert.equal(restored.passed, baseline.passed)
  const callers = [
    { definition: paths[9], caller: paths[13], anchor: 'checkInHumanObservation(target.agentSessionId, timeline, page, now)' },
    { definition: paths[9], caller: paths[10], anchor: 'decideCheckIn(this.require(claim.loop.loopId), human, checkAt)' },
    { definition: paths[13], caller: paths[14], anchor: 'runtime.observeCheckIn(target, now, signal, await configStore.get())' },
    { definition: paths[1], caller: paths[13], anchor: 'requireCurrentSource: true, signal' },
    { definition: paths[6], caller: paths[10], anchor: 'this.scheduler.createCalendar(' },
    { definition: paths[7], caller: 'packages/core/src/rpc-native-codec.ts', anchor: 'validateScheduleRpcResult' },
    { definition: paths[18], caller: paths[19], anchor: 'api.schedule.create(request.params)' },
    { definition: paths[10], caller: paths[15], anchor: 'await client.call(method, input)' }
  ]
  for (const caller of callers) { assert.notEqual(caller.definition, caller.caller); assert((await readFile(join(root, caller.caller), 'utf8')).includes(caller.anchor), 'Nonempty exact production consumer: ' + caller.anchor) }
  const native = process.env.AGENT_SCHEDULE_CHECKIN_NATIVE_RECEIPT ? JSON.parse(await readFile(process.env.AGENT_SCHEDULE_CHECKIN_NATIVE_RECEIPT, 'utf8')) : await checkInNativeProbe(join(evidence, 'native'), { onProgress: value => process.stdout.write(JSON.stringify(value) + '\n') })
  assert(native.owners.length >= 2 && new Set(native.owners.map(owner => owner.pid)).size === native.owners.length); assert(native.claimAt - native.marker.createdAt >= 300000); assert(native.reply.createdAt > native.claimAt); assert.notEqual(native.reply.id, native.marker.id)
  for (const [path, hash] of Object.entries(native.sourceBindings)) assert.equal(sha(await readFile(resolve(root, path))), hash, 'The actual Native chain consumed this same candidate: ' + path)
  for (const binding of sourceBindings) assert.equal(sha(await readFile(join(root, binding.path))), binding.sha256, 'Final candidate bytes unchanged: ' + binding.path)
  const receipt = { schema: 'agentmux.schedule-check-in.v1', passed: true, task: 'checkin', sourceBindings, types: { passed: true, configuration }, baseline: { passed: baseline.passed, loaded: baseline.loaded }, mutations: reds, restored: { passed: restored.passed, loaded: restored.loaded }, callers, native, boundary: 'Original schedule/store/input owners and a real private native Run. Trusted Unix CLI opt-in, managed caller rejection, authenticated human marker, wall-clock silence and independent Host PID recovery. Policy Source assertions also cover original unknown-operation payload recovery. Model wording and user App are not qualified; visual review is a separate original Renderer artifact.' }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await writeFile(join(parent, 'last.json'), JSON.stringify({ receipt: join(evidence, 'receipt.json') }))
  process.stdout.write(JSON.stringify({ passed: true, task: 'checkin', tests: restored.passed, mutations: reds.length, owners: native.owners.map(owner => owner.pid), receipt: join(evidence, 'receipt.json') }) + '\n')
}
