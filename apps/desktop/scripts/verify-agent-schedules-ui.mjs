import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

export async function verifyScheduleUi() {
  const root = resolve(import.meta.dirname, '../../..'), run = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex'), require = createRequire(import.meta.url)
  const parent = join(root, '.tmp/agent-schedules/ui'); await mkdir(parent, { recursive: true }); const evidence = await mkdtemp(join(parent, 'attempt-'))
  const files = ['apps/desktop/src/renderer/src/components/CalendarScheduleControl.tsx', 'apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/styles/agent.css', 'packages/core/src/agent-schedule.ts', 'packages/core/src/public-rpc-schedules.ts', 'apps/desktop/test/calendar-schedule-control.test.tsx', 'apps/desktop/test/continuous-progress-panel.test.tsx', 'apps/desktop/scripts/fixtures/agent-schedules/vitest.ui.config.mts', 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'apps/desktop/scripts/verify-agent-schedules-ui.mjs', 'apps/desktop/scripts/verify-agent-schedules.mjs']
  const sourceBindings = await Promise.all(files.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })))
  const config = join(root, 'apps/desktop/scripts/fixtures/agent-schedules/vitest.ui.config.mts')
  const manifest = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'))
  const paths = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), [resolve(root, 'packages/core', value.types.replace('./dist/', './src/').replace('.d.ts', '.ts'))]]))
  const typeConfiguration = { extends: join(root, 'apps/desktop/tsconfig.json'), compilerOptions: { paths, incremental: false, types: ['node'], typeRoots: [resolve(require.resolve('@types/node/package.json'), '../..')] }, include: [join(root, files[0]), join(root, files[1]), join(root, 'apps/desktop/src/renderer/src/global.d.ts'), resolve(require.resolve('vite'), '../../../client.d.ts')] }
  const typeConfig = join(evidence, 'tsconfig.json'); await writeFile(typeConfig, JSON.stringify(typeConfiguration, null, 2))
  const types = await run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', typeConfig], { cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(join(evidence, 'types.log'), types.stdout + types.stderr)
  async function test(label, filter, env = {}) {
    let code = 0, stdout = '', stderr = ''
    try { ({ stdout, stderr } = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', join(evidence, label + '.json'), ...(filter ? ['-t', filter] : [])], { cwd: root, env: { ...process.env, ...env }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })) }
    catch (error) { code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
    await writeFile(join(evidence, label + '.log'), stdout + stderr)
    const report = JSON.parse(await readFile(join(evidence, label + '.json'), 'utf8'))
    assert(report.numTotalTests > 0 && (report.numPassedTests + report.numFailedTests) > 0, 'The owning Source tests cannot be empty')
    return { code, passed: report.numPassedTests, failed: report.numFailedTests, assertion: report.testResults.some(file => file.assertionResults.some(test => test.failureMessages.some(message => /AssertionError|expected /u.test(message)))) }
  }
  const baseline = await test('baseline'); assert.equal(baseline.code, 0)
  const mutations = [
    { file: files[1], name: 'display-id', from: 'agentSessionId: session.control.agentSessionId,', to: 'agentSessionId: session.id,', filter: 'exact control identity' },
    { file: files[0], name: 'saved-prompt', from: 'params: { target, calendar, prompt, operationId:', to: 'params: { target, calendar, prompt: "lost instruction", operationId:', filter: 'saves daily' },
    { file: files[0], name: 'original-retry', from: 'void perform(pending)', to: 'void perform({ ...pending, params: { ...pending.params, operationId: crypto.randomUUID() } })', filter: 'uncertain creation' },
    { file: files[0], name: 'later-target', from: 'if (current.current !== captured) return\n      accept(receipt.schedule, captured);', to: 'accept(receipt.schedule, captured);', filter: 'late creation clear' },
    { file: files[0], name: 'inspection-receipt', from: 'if (complete && result.schedule.lastOutcome !== \'unknown\')', to: 'if (true)', filter: 'attempted mutation' },
    { file: files[0], name: 'late-list', from: ' || before !== updates.current', to: '', filter: 'fresher event facts' }
  ]
  const reds = []
  for (const mutation of mutations) {
    const owner = join(root, mutation.file), bytes = await readFile(owner, 'utf8'); assert.equal(bytes.split(mutation.from).length, 2)
    const mutant = bytes.replace(mutation.from, mutation.to), copy = join(evidence, mutation.name + '.tsx'); await writeFile(copy, mutant)
    const result = await test(mutation.name, mutation.filter, { AGENT_SCHEDULE_MUTANT_OWNER: owner, AGENT_SCHEDULE_MUTANT_COPY: copy })
    assert.notEqual(result.code, 0); assert(result.failed > 0 && result.assertion, 'Only a behavioral Assertion RED qualifies')
    assert.equal(await readFile(owner, 'utf8'), bytes, 'The shared candidate remains unchanged')
    reds.push({ ...mutation, sourceSha256: sha(bytes), mutantSha256: sha(mutant), result, copy })
  }
  const restored = await test('restored'); assert.equal(restored.code, 0)
  const callers = [
    { definition: files[0], caller: files[1], anchor: '<CalendarScheduleControl target={target}' },
    { definition: files[1], caller: files[2], anchor: '<ContinuousProgressControl ' },
    ...['list', 'inspect', 'create', 'pause', 'resume', 'cancel', 'onChanged'].map(method => ({ definition: 'apps/desktop/src/renderer/src/lib/api.ts', caller: files[0], anchor: 'api.schedule.' + method + '(' }))
  ]
  for (const caller of callers) { assert.notEqual(caller.definition, caller.caller); assert((await readFile(join(root, caller.caller), 'utf8')).includes(caller.anchor), 'Nonempty actual product consumer') }
  for (const binding of sourceBindings) assert.equal(sha(await readFile(join(root, binding.path))), binding.sha256, 'Candidate bytes unchanged')
  const receipt = { schema: 'agentmux.schedule-ui.v1', task: 'presentation', passed: true, sourceBindings, types: { passed: true, configuration: typeConfiguration }, baseline, mutations: reds, restored, callers, boundary: 'Original mounted Renderer controls and typed facade Source. Actual private Electron visual capture/review is separate; no user App, Native lifecycle, model, package or install qualification.' }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await writeFile(join(parent, 'last.json'), JSON.stringify({ receipt: join(evidence, 'receipt.json') }) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, tests: restored.passed, mutations: reds.length, callers: callers.length, receipt: join(evidence, 'receipt.json') }) + '\n')
}
