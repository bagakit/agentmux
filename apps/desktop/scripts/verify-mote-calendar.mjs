import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url)
const run = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Source-bound owning proof; actual Electron image review remains independent. */
export async function verifyMoteCalendar() {
  const parent = join(root, '.local/state/mote-calendar'); await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'renderer-proof-'))
  const config = join(root, 'apps/desktop/scripts/fixtures/mote-calendar/vitest.config.mts')
  const component = name => 'apps/desktop/src/renderer/src/components/' + name + '.tsx'
  const paths = [...['MoteCalendar', 'MoteDetailsPanel', 'MoteIdeaControls', 'CalendarScheduleControl', 'ScheduleArrangementRow', 'ScheduleCreateForm', 'ScheduleOperationNotice', 'ContinuousProgressControl', 'SessionMailbox'].map(component),
    ...['schedule-controller', 'schedule-clock', 'schedule-draft', 'launcher-state', 'api'].map(name => 'apps/desktop/src/renderer/src/lib/' + name + '.ts'),
    ...['mote-calendar', 'agent'].map(name => 'apps/desktop/src/renderer/src/styles/' + name + '.css'), 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
    ...['mote-calendar', 'calendar-schedule-control', 'continuous-progress-panel', 'mote-ideas'].map(name => 'apps/desktop/test/' + name + '.test.tsx'),
    'apps/desktop/test/helpers/schedule-rpc-fixture.ts', 'apps/desktop/scripts/fixtures/mote-calendar/vitest.config.mts',
    'apps/desktop/scripts/fixtures/agent-schedules/vitest.ui.config.mts', 'apps/desktop/scripts/fixtures/agent-schedules/isolate-core.mjs',
    'apps/desktop/scripts/verify-mote-calendar.mjs', 'apps/desktop/scripts/verify-agent-schedules-ui.mjs',
    'packages/core/src/schedule-calendar.ts', 'packages/core/src/public-rpc-schedules.ts', 'packages/core/package.json']
  const sourceBindings = await Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })))
  async function test(label, mutation) {
    const privateRoot = await mkdtemp(join(tmpdir(), 'mote-calendar-proof-'))
    const reportPath = join(directory, label + '.json'), log = join(directory, label + '.log'), loaded = join(directory, label + '.loaded.ndjson')
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/.test(key))),
      AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'queue.ndjson'), MOTE_CALENDAR_SOURCE_RECEIPT: loaded,
      ...(mutation ? { AGENT_SCHEDULE_MUTANT_OWNER: join(root, mutation.file), AGENT_SCHEDULE_MUTANT_COPY: mutation.copy } : {}) }
    let code = 0, output = ''
    try { const result = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', reportPath,
      ...(mutation ? ['-t', mutation.filter] : [])], { cwd: root, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }); output = result.stdout + result.stderr }
    catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
    finally { await rm(privateRoot, { recursive: true, force: true }) }
    await writeFile(log, output)
    const reportBytes = await readFile(reportPath), report = JSON.parse(reportBytes)
    assert(report.numTotalTests > 0 && report.numPassedTests + report.numFailedTests > 0, 'A nonempty owning suite is required')
    const failures = report.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed'))
    if (mutation) {
      assert.notEqual(code, 0); assert(report.numFailedTests > 0)
      assert(failures.some(test => test.failureMessages.some(message => /AssertionError|expected /u.test(message))))
      assert(!failures.some(test => test.failureMessages.some(message => /Cannot find module|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/u.test(message))))
    } else { assert.equal(code, 0, output.slice(-6000)); assert.equal(report.numFailedTests, 0) }
    const loadedBytes = await readFile(loaded), files = loadedBytes.toString().trim().split('\n').map(line => JSON.parse(line))
    const owner = mutation?.file ?? component('MoteCalendar')
    assert(files.some(item => relative(root, item.path) === owner && item.sha256 === (mutation?.mutantSha256 ?? sourceBindings.find(item => item.path === owner).sha256)), 'Current production owner was loaded')
    return { label, code, total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
      report: relative(root, reportPath), reportSha256: sha(reportBytes), log: relative(root, log), logSha256: sha(output), loaded: relative(root, loaded), loadedSha256: sha(loadedBytes) }
  }
  const runs = [await test('baseline')], mutations = []
  const changes = [
    { file: component('MoteCalendar'), name: 'countdown-visibility', from: "source.records.filter(record => showEnded || record.status !== 'stopped')", to: "source.records.filter(record => !!record.calendar && (showEnded || record.status !== 'stopped'))", filter: 'actual Mote Renderer list and original control' },
    { file: component('ScheduleOperationNotice'), name: 'same-operation-retry', from: 'operation.perform(operation.pending)', to: 'operation.perform({ ...operation.pending, params: { ...operation.pending.params, operationId: crypto.randomUUID() } })', filter: 'retains an uncertain creation|recovers a lost ack' },
    { file: component('MoteCalendar'), name: 'week-projection', from: "active && mode !== 'upcoming'", to: "active && mode === 'month'", filter: 'Week projects only seven civil days' },
    { file: component('ScheduleCreateForm'), name: 'draft-preservation', from: "...(pristine ? { timing: 'calendar'", to: "...(true ? { timing: 'calendar'", filter: 'date shortcuts keep edited timing' },
    { file: component('ScheduleCreateForm'), name: 'chosen-target', from: ' && targetFields.every(key => value.target?.[key] === baseline.target?.[key])', to: '', filter: 'a date shortcut preserves an explicitly chosen discussion' },
    { file: component('ScheduleCreateForm'), name: 'confirmed-save-feedback', from: "if (request.action === 'create') setSavedArrangement({ key: draftKey, record })", to: '', filter: 'Week projects only seven civil days' }
  ]
  for (const change of changes) {
    const original = await readFile(join(root, change.file), 'utf8'); assert.equal(original.split(change.from).length, 2)
    const mutated = original.replace(change.from, change.to), copy = join(directory, change.name + '.tsx'); await writeFile(copy, mutated)
    const mutation = { ...change, copy, sourceSha256: sha(original), mutantSha256: sha(mutated) }
    mutations.push({ ...mutation, copy: relative(root, copy) }); runs.push(await test('red-' + change.name, mutation))
  }
  runs.push(await test('restored'))
  const configuration = { extends: join(root, 'apps/desktop/tsconfig.json'), compilerOptions: { incremental: false, types: ['node'], typeRoots: [resolve(require.resolve('@types/node/package.json'), '../..')] },
    include: [join(root, component('MoteCalendar')), join(root, 'apps/desktop/test/mote-calendar.test.tsx'), join(root, 'apps/desktop/src/renderer/src/global.d.ts'), resolve(require.resolve('vite'), '../../../client.d.ts')] }
  const typeConfig = join(directory, 'tsconfig.json'); await writeFile(typeConfig, JSON.stringify(configuration, null, 2))
  const types = await run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', typeConfig], { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  await writeFile(join(directory, 'types.log'), types.stdout + types.stderr)
  for (const item of sourceBindings) assert.equal(sha(await readFile(join(root, item.path))), item.sha256, 'Candidate changed: ' + item.path)
  const receipt = { passed: true, sourceBindings, runs, mutations, types: { passed: true, configuration },
    boundary: 'Mounted MoteDetailsPanel/MoteCalendar, original Session arrangements and Ideas, typed API facade -> actual Unix public RPC/Main/private Store. Controlled future-intent owner; no Native Session, Run or model. Electron capture and independent aesthetic review are separate.' }
  const receiptPath = join(directory, 'receipt.json'), bytes = JSON.stringify(receipt, null, 2) + '\n'; await writeFile(receiptPath, bytes)
  await writeFile(join(parent, 'renderer-latest.json'), JSON.stringify({ receipt: relative(root, receiptPath), sha256: sha(bytes) }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, tests: runs[0].passed, mutations: mutations.length, receipt: relative(root, receiptPath) }))
  return receipt
}
if (process.argv[1] === import.meta.filename) await verifyMoteCalendar()
