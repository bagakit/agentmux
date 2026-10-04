import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

assert.deepEqual(process.argv.slice(2), ['--slice', 'source'])
const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/codex-provider-failure-artifacts/focus')
await mkdir(evidence, { recursive: true })
const state = 'apps/desktop/src/renderer/src/lib/session-state.ts'
const notice = 'apps/desktop/src/renderer/src/lib/session-service-notices.ts'
const context = 'apps/desktop/src/renderer/src/lib/focus-context.ts'
const config = 'apps/desktop/scripts/fixtures/provider-failure-focus/tsconfig.owning.json'
const owningConfig = 'apps/desktop/scripts/fixtures/provider-failure-focus/vitest.owning.config.mts'
const tests = ['apps/desktop/test/provider-failure-focus.test.tsx', 'apps/desktop/test/focus-context-cost.test.ts']
const sources = [state, notice, context, 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx']
const type = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', config], { cwd: root, encoding: 'utf8' })
await writeFile(join(evidence, 'owning-types.log'), type.stdout + type.stderr)
const typeDiagnostics = (type.stdout + type.stderr).split('\n').filter(line => /^.*\([0-9]+,[0-9]+\): error TS/.test(line))
const owningDiagnostics = typeDiagnostics.filter(line => [state, notice, 'apps/desktop/src/shared/contracts.ts', tests[0]].some(file => line.startsWith(file + '(')))
assert.deepEqual(owningDiagnostics, [], 'No owning source/test type diagnostics: ' + owningDiagnostics.join('\n'))
assert.ok(type.status === 0 || typeDiagnostics.length > 0, 'A compiler startup failure cannot qualify source types')
await verifyRendererSourceMutations({ name: 'source-mutations', tests, sources, owningConfig, evidenceRoot: evidence, mutations: [
  { label: 'live-event-drops-failure', file: state,
    before: '...(core.failure ? { failure: structuredClone(core.failure) } : {})', after: '// Native request failure was silently dropped.' },
  { label: 'request-failure-notice-removed', file: notice,
    before: 'if (failure) notices.push({', after: 'if (false && failure) notices.push({' },
  { label: 'later-turn-failure-stays-read', file: notice,
    before: 'JSON.stringify([...identity, failure.nativeTurnId])', after: 'JSON.stringify(identity)' },
  { label: 'unknown-run-masquerades-as-available', file: notice,
    before: "kind: session.processState === 'interrupted' ? 'indeterminate' : 'process-degraded'",
    after: "kind: 'process-degraded'" }
] })
const callers = {}
for (const [symbol, definition] of [['sessionServiceNotices(', notice], ['projectRuntimeEvent(', state], ['createFocusProjectionSelector', context]]) {
  const search = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(search.status, 0)
  const hits = search.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':'))
  assert.ok(hits.length > 0, `Nonempty production consumer outside definition: ${symbol}`)
  callers[symbol] = hits
}
const mutation = JSON.parse(await readFile(join(evidence, 'source-mutations/receipt.json'), 'utf8'))
assert.equal(mutation.passed, true)
const inputs = Object.fromEntries(await Promise.all([...tests, ...sources, config, owningConfig].map(async file =>
  [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.provider-failure-focus.v1', passed: true,
  inputs, callers, typecheck: { exitCode: type.status, log: 'owning-types.log', owningDiagnostics,
    completeGraphPassed: type.status === 0, externalDiagnostics: typeDiagnostics.filter(line => !owningDiagnostics.includes(line)) }, mutations: mutation,
  boundary: 'Real Renderer Store event reduction, Focus/Preview/Attention and Composer Notices. Unused native conversation and file-zone leaves throw in the private fixture. PTY, native protocol, restart and visual quality are separate; existing external compiler errors are retained and do not certify a complete build.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualification: join(evidence, 'qualification.json') }))
