import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_SERVICE_UNIT_EVIDENCE ?? join(root, '.local/state/terminal-service-fanout-unit')
await mkdir(join(root, '.local/state'), { recursive: true })
const temporary = await mkdtemp(join(root, '.local/state/.run-service-unit-'))
const owner = 'apps/desktop/src/renderer/src/lib/run-service-projection.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const test = 'apps/desktop/test/run-service-projection.test.ts'
const mutations = [
  ['progress-notification', owner, 'const changed = !previous || previous.health !== health', 'const changed = true', 'retains every full revision'],
  ['stale-revision', owner, 'service.revision <= previous.service.revision', 'false', 'rejects wrong Host'],
  ['wrong-run', owner, 'core.run.runId])', "'original'])", 'rejects wrong Host'],
  ['muted-health', owner, 'const changed = !previous || previous.health !== health', 'const changed = !previous', 'preserves ordered pressure'],
  ['disconnected-ingress', store, '!runServiceProjection.apply(event) && core.agentSessionId', 'true && core.agentSessionId', 'uses the actual Store ingress'],
  ['missing-seed', store, 'runServiceProjection.reconcile(useAppStore.getState().sessions)', 'void 0', 'uses the actual Store ingress'],
  ['lost-pending', store, 'set(state => bufferPendingAgentEvent(state, event, agentSessionId))', 'void agentSessionId', 'uses the actual Store ingress'],
  ['lost-resync', store, "if (pending.event.event.type === 'run-service') runServiceProjection.apply(pending.event)", 'void 0', 'replays in-flight service facts'],
  ['lost-directory-repair', store, 'startSessionMembershipResync(event)\n          return', 'return', 'resyncs an unknown Agent'],
  ['retained-listener', owner, 'subscribers.delete(listener)', 'void listener', 'retires the previous Run'],
  ['retained-membership-observer', store, 'return () => { dispose(); runServiceProjection.clear() }', 'return () => { runServiceProjection.clear() }', 'uses the actual Store ingress']
]
const hash = source => createHash('sha256').update(source).digest('hex')
const inputs = Object.fromEntries(await Promise.all([owner, store, test].map(async file => [file, hash(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.run-service-projection-unit.v1', passed: false, inputs, cases: [] }
await mkdir(evidence, { recursive: true })
try {
  for (const mutation of [null, ...mutations]) {
    const name = mutation?.[0] ?? 'candidate', config = join(temporary, name + '.mjs'), hit = join(temporary, name + '.hit')
    if (mutation) {
      const source = await readFile(join(root, mutation[1]), 'utf8')
      assert.equal(source.split(mutation[2]).length - 1, 1, 'Exact, nonempty mutation seam: ' + name)
    }
    await writeFile(config, `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};
import { mergeConfig } from 'vitest/config'; import { writeFileSync } from 'node:fs';
const mutation = ${JSON.stringify(mutation)};
export default mergeConfig(base, { plugins: [{ name: 'run-service-unit-mutant', enforce: 'pre',
  transform(source, id) { if (!mutation || id.split('?')[0] !== ${JSON.stringify(root + '/')} + mutation[1]) return null;
    if (source.split(mutation[2]).length !== 2) throw Error('Mutation seam mismatch');
    writeFileSync(${JSON.stringify(hit)}, 'consumed');
    return { code: source.replace(mutation[2], mutation[3]), map: null }; } }] });`)
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', test, '--config', config], {
      cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    })
    const output = result.stdout + result.stderr
    await writeFile(join(evidence, name + '.log'), output)
    const consumed = mutation ? await readFile(hit, 'utf8') === 'consumed' : true
    const passed = mutation
      ? consumed && result.status !== 0 && /AssertionError/.test(output) && output.includes(mutation[4]) && /Tests\s+.*failed/.test(output)
      : result.status === 0 && /8 tests/.test(output)
    receipt.cases.push({ name, passed, exitCode: result.status, consumed, expectedAssertion: mutation?.[4] ?? null })
    assert.ok(passed, name + ' did not meet its behavioral oracle; see ' + join(evidence, name + '.log'))
  }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, file))), digest, 'Source unchanged during unit proof: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = error.stack }
finally {
  await rm(temporary, { recursive: true, force: true })
  receipt.temporaryConfigRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, cases: receipt.cases.length, evidence, failure: receipt.failure }))
}
if (!receipt.passed) process.exitCode = 1
