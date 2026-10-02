import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = 'packages/core/scripts/fixtures/session-work-history'
const owned = [
  'packages/core/src/types.ts', 'packages/core/src/session-timeline.ts', 'packages/core/src/session-timeline-reducer.ts',
  'packages/core/src/agent-activity-state.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/agent-session-identity.ts', 'packages/core/src/client.ts',
  'packages/core/src/agent-status-freshness.ts',
  'packages/core/test/session-work-history.test.ts', 'packages/core/test/session-timeline.test.ts',
  'packages/core/test/client-connection-lost.test.ts',
  `${fixture}/vitest.owning.config.mts`, `${fixture}/vitest.adjacent.config.mts`,
  `${fixture}/vitest.mutation.config.mts`, `${fixture}/tsconfig.owning.json`, `${fixture}/node-fixture.mjs`,
  'packages/core/scripts/verify-session-work-history.mjs'
]
const output = join(root, '.tmp', `session-work-history-${Date.now()}`)
await mkdir(output, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const bind = async () => Object.fromEntries(await Promise.all(owned.map(async path => [path, sha(await readFile(join(root, path)))])))
const sourceBefore = await bind()
const runs = []
async function run(name, args, extraEnv = {}) {
  const log = join(output, `${name}.log`)
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  await writeFile(log, stdout + stderr)
  const result = { name, args, pid: child.pid, exitCode, log: relative(root, log), outputSha: sha(stdout + stderr) }
  runs.push(result)
  return { ...result, stdout, stderr }
}
const vitest = ['node_modules/vitest/vitest.mjs', 'run', '--config']
let privateRoot
try {
  for (const config of ['vitest.owning.config.mts', 'vitest.adjacent.config.mts']) {
    const source = await readFile(join(root, fixture, config), 'utf8')
    assert(source.includes('passWithNoTests: false') && source.includes('include: [') && source.includes('packages/core/test/'))
  }
  const owning = await run('owning', [...vitest, `${fixture}/vitest.owning.config.mts`])
  assert.equal(owning.exitCode, 0, owning.stdout + owning.stderr)
  assert.match(owning.stdout, /Tests\s+12 passed \(12\)/)
  const mutations = []
  for (const mutant of ['native-producer-omitted', 'tool-evicts-status', 'cross-run-closed']) {
    const loadedPath = join(output, `${mutant}.loaded.jsonl`)
    const red = await run(mutant, [...vitest, `${fixture}/vitest.mutation.config.mts`], {
      AGENTMUX_WORK_HISTORY_MUTANT: mutant, AGENTMUX_WORK_HISTORY_MUTANT_RECEIPT: loadedPath
    })
    const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].sourceSha, sourceBefore[loaded[0].path])
    assert.notEqual(loaded[0].sourceSha, loaded[0].transformedSha)
    assert.equal(loaded[0].replacements, 1)
    assert.notEqual(red.exitCode, 0)
    assert.match(red.stdout + red.stderr, /AssertionError:/)
    assert.doesNotMatch(red.stdout + red.stderr, /Failed to load|Error during transform|No test files found/)
    assert.deepEqual(await bind(), sourceBefore)
    mutations.push({ mutant, assertionRed: true, loaded: loaded[0], receipt: relative(root, loadedPath) })
  }
  const restored = await run('restored-green', [...vitest, `${fixture}/vitest.owning.config.mts`])
  assert.equal(restored.exitCode, 0, restored.stdout + restored.stderr)
  const productionTypes = await run('production-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/core/tsconfig.build.json'])
  assert.equal(productionTypes.exitCode, 0, productionTypes.stdout + productionTypes.stderr)
  const owningTypes = await run('owning-types', ['node_modules/typescript/bin/tsc', '-p', `${fixture}/tsconfig.owning.json`])
  assert.equal(owningTypes.exitCode, 0, owningTypes.stdout + owningTypes.stderr)
  const build = await run('ordinary-private-core-build', ['packages/core/scripts/build.mjs'])
  assert.equal(build.exitCode, 0, build.stdout + build.stderr)
  const adjacent = await run('adjacent', [...vitest, `${fixture}/vitest.adjacent.config.mts`])
  assert.equal(adjacent.exitCode, 0, adjacent.stdout + adjacent.stderr)
  assert.match(adjacent.stdout, /Tests\s+88 passed \(88\)/)
  const compiled = Object.fromEntries(await Promise.all(['client.js', 'session-timeline.js', 'agent-session-store.js', 'agent-activity-state.js'].map(async path => [path, sha(await readFile(join(root, 'packages/core/dist', path)))])))
  privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-work-history-ordinary-'))
  const phases = []
  for (const phase of ['produce', 'reread']) {
    const file = join(output, `${phase}.json`)
    const actual = await run(`ordinary-${phase}`, [`${fixture}/node-fixture.mjs`, phase, privateRoot, file])
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr)
    const receipt = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(receipt.pid, actual.pid)
    phases.push(receipt)
  }
  assert.notEqual(phases[0].pid, phases[1].pid)
  assert.equal(phases[1].seedCount, 0)
  assert.equal(phases[1].readOnly, true)
  assert.deepEqual(phases[0].history, phases[1].history)
  assert.deepEqual(phases[0].projection, phases[1].projection)
  assert.deepEqual(phases[0].descriptor, phases[1].descriptor)
  await rm(privateRoot, { recursive: true }); privateRoot = undefined
  const clientSource = await readFile(join(root, 'packages/core/src/client.ts'), 'utf8')
  const storeSource = await readFile(join(root, 'packages/core/src/agent-session-store.ts'), 'utf8')
  const reducerSource = await readFile(join(root, 'packages/core/src/session-timeline-reducer.ts'), 'utf8')
  const desktopSource = await readFile(join(root, 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'), 'utf8')
  const callers = [
    ['client.ts native Hook', clientSource.includes('advanceAgentActivityCommit(current.activityCommit') && clientSource.includes('id: activityId')],
    ['client.ts ACP accepted status', clientSource.includes('await this.persistSemanticStatus(agentSessionId, session.run')],
    ['agent-session-store.ts accepted retired append', storeSource.includes('agentActivityTimelineItem(mutation.agentSessionId, observation)')],
    ['session-timeline-reducer.ts independent status', reducerSource.includes('item.activityState ? ++states')],
    ['Desktop pure projector', /import[\s\S]*projectAgentWorkHistory[\s\S]*from ['"]@agentmux\/core\/timeline['"]/.test(desktopSource) && desktopSource.includes('projectAgentWorkHistory(')]
  ]
  assert(callers.every(([, exists]) => exists), JSON.stringify(callers))
  const sourceAfter = await bind()
  assert.deepEqual(sourceAfter, sourceBefore)
  const receipt = { schema: 'agentmux.session-work-history-proof.v1', sourceBefore, sourceAfter,
    owning: { tests: 12, passed: true }, mutations, restoredGreen: true,
    types: { production: true, owning: true }, adjacent: { tests: 88, passed: true },
    compiled, phases, definitionExternalProductionCallers: callers.map(([name]) => name),
    projectorCaller: { path: 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', sha: sha(desktopSource) },
    cleanup: { privateRootRemoved: true }, runs }
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${relative(root, join(output, 'receipt.json'))}\n`)
} catch (error) {
  await writeFile(join(output, 'failure.json'), `${JSON.stringify({ error: error.stack, sourceBefore, sourceAfter: await bind(), runs }, null, 2)}\n`)
  throw error
} finally { if (privateRoot) await rm(privateRoot, { recursive: true }) }
