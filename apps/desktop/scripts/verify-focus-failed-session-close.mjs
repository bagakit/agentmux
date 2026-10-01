import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
assert.deepEqual(process.argv.slice(2), ['--slice', 'source'])
const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/focus-identity-consistency-artifacts/failed-close')
await mkdir(evidence, { recursive: true })
const panel = 'apps/desktop/src/renderer/src/components/AttentionRequestPanel.tsx'
const context = 'apps/desktop/src/renderer/src/lib/focus-context.ts'
const tests = ['apps/desktop/test/focus-failed-session-close.test.tsx', 'apps/desktop/test/attention-request-panel.test.tsx', 'apps/desktop/test/stopped-session-view-close.test.tsx']
const testDependencies = ['apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx']
const config = 'apps/desktop/scripts/fixtures/focus-failed-session-close/tsconfig.owning.json'
const command = ['node_modules/typescript/bin/tsc', '--project', config]
const type = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8' })
await writeFile(join(evidence, 'owning-types.log'), type.stdout + type.stderr)
assert.equal(type.status, 0, 'Scoped production and owning typecheck: ' + type.stdout + type.stderr)
const name = 'failed-close-mutants-' + globalThis.crypto.randomUUID()
const explicit = process.env.AGENTMUX_MUTATION_RECEIPTS ? JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS) : null
if (explicit) assert.ok(Array.isArray(explicit) && explicit.length === 1)
const mutationPath = explicit ? resolve(explicit[0]) : join(evidence, name, 'receipt.json')
await verifyRendererSourceMutations({ name, tests, sources: [panel, context, ...testDependencies], evidenceRoot: evidence, mutations: [
  { label: 'ended-qualification', file: panel, before: "session.status.state === 'error' && session.processState === 'exited'", after: "session.status.state === 'error' && session.processState !== 'exited'" },
  { label: 'wrong-Session-control', file: panel, before: 'stopSession(claim.sessionId)', after: "stopSession('failed-close-b')" },
  { label: 'old-Run-retirement', file: panel, before: 'core.run.runId !== claim.runId', after: 'false' },
  { label: 'stale-painted-Run-control', file: panel, before: 'runIdFor(latest) !== runIdFor(session)', after: 'false' },
  { label: 'missing-error-Review', file: context, before: " || session.kind === 'agent' && state === 'error', lastActivityAt", after: ', lastActivityAt' }
] })
const mutation = JSON.parse(await readFile(mutationPath, 'utf8'))
for (const log of ['baseline-green.log', ...mutation.cases.map(item => item.restore.log)]) {
  const content = await readFile(join(dirname(mutationPath), log), 'utf8')
  assert.match(content, /Test Files\s+3 passed/); assert.match(content, /Tests\s+28 passed/)
  assert.doesNotMatch(content, /\d+ skipped|no tests/)
}
const callers = {}
for (const [symbol, definition, searchRoot] of [
  ['<AttentionRequestPanel ', panel, 'apps/desktop/src'],
  ['createFocusProjectionSelector(', context, 'apps/desktop/src'],
  ['api.sessions.stop(session.control)', '', 'apps/desktop/src'],
  ["core.type !== 'run-removed'", '', 'apps/desktop/src/renderer/src/lib/session-state.ts']
]) {
  const result = spawnSync('rg', ['-n', '--fixed-strings', symbol, searchRoot], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  const hits = result.stdout.trim().split('\n').filter(line => !definition || !line.startsWith(definition + ':'))
  assert.ok(hits.length, 'Nonempty definition-external production/lifecycle consumer: ' + symbol)
  callers[symbol] = hits
}
const files = [panel, context, ...tests, ...testDependencies, config, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts', 'apps/desktop/src/renderer/src/lib/session-events.ts']
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.focus-failed-session-close-qualification.v1', passed: true, inputs, mutations: mutation, callers,
  typecheck: { command: [process.execPath, ...command], exitCode: type.status, log: 'owning-types.log' }, boundary: 'Actual Focus/Attention/Store and current public Main dependencies; twelve owning scenarios, original nine request cases, seven View-only close cases. Scoped mutation/type/caller proof does not certify real Runtime, restart, installation or visual quality.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualification: join(evidence, 'qualification.json') }))
