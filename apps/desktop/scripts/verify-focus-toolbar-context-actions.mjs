import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

assert.deepEqual(process.argv.slice(2), ['--slice', 'source'])
const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(root, 'package.json'))
const evidenceRoot = join(root, '.bagakit/feature-tracker/focus-identity-consistency-artifacts/toolbar-context-actions')
await mkdir(evidenceRoot, { recursive: true })
const toolbar = 'apps/desktop/src/renderer/src/components/FocusToolbar.tsx'
const global = 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'
const test = 'apps/desktop/test/focus-toolbar-context-actions.test.tsx'
const name = 'context-actions-mutants-' + globalThis.crypto.randomUUID()
const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
  `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
await writeFile(join(evidenceRoot, 'freshness.log'), freshness.stdout + freshness.stderr)
assert.equal(freshness.status, 0, 'Original current source/dist boundary; preparation failure is not a product RED')
const reused = process.env.AGENTMUX_MUTATION_RECEIPTS ? JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS) : null
if (reused) assert.ok(Array.isArray(reused) && reused.length > 0)
const mutations = [
  { label: 'wrong-projection-occurrence', file: global,
    before: 'reference={projection?.selection.length === 1 ? projection.selection[0] : undefined}',
    after: "reference={projection?.selection.length === 1 ? { ...projection.selection[0]!, groupId: 'ordinary-group' } : undefined}" },
  { label: 'wrong-Tab-reference', file: toolbar, before: 'formatTabAddress(target.tabId)', after: "formatTabAddress('ordinary-decoy')" },
  { label: 'wrong-Mote-identity', file: toolbar, before: 'pmoTeamsTopicFloatingTargetTopicId(floating, state.tabs)', after: 'PMO_TEAMS_TOPIC_ID' },
  { label: 'duplicate-pending-discussion', file: toolbar, before: 'if (discussionFlight.current) return', after: 'if (false) return' }
]
const matching = reused ? (await Promise.all(reused.map(async path => ({ path: resolve(path), saved: JSON.parse(await readFile(resolve(path), 'utf8')) })))).filter(({ saved }) =>
  JSON.stringify(saved.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations)) : []
if (reused) assert.equal(matching.length, 1, 'Exactly one receipt must match all four mutation definitions; bytes and loaded logs are checked by their original verifier')
const receiptPath = reused ? matching[0].path : join(evidenceRoot, name, 'receipt.json')
await verifyRendererSourceMutations({ name, tests: [test], sources: [toolbar, global, 'apps/desktop/test/fixtures/mote-workface.ts'], evidenceRoot, mutations })
const mutation = JSON.parse(await readFile(receiptPath, 'utf8'))
for (const filename of ['baseline-green.log', ...mutation.cases.map(item => item.restore.log)]) {
  const log = await readFile(join(dirname(receiptPath), filename), 'utf8')
  assert.match(log, /Tests\s+7 passed/); assert.doesNotMatch(log, /\d+ skipped|no tests/)
}
const callers = {}
for (const [symbol, definition] of [['<FocusToolbar ', toolbar], ['focusRegion(target.displayWorkspaceId', ''], ['formatTabAddress(', 'apps/desktop/src/renderer/src/lib/agent-address.ts'], ['openScratchTopic(', 'apps/desktop/src/renderer/src/store.ts']]) {
  const result = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  const hits = result.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':') && !/^.*:\d+:\s*import\b/.test(line))
  assert.ok(hits.length > 0, 'Nonempty definition-external production consumption: ' + symbol)
  callers[symbol] = hits
}
const types = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', 'apps/desktop/tsconfig.json'], { cwd: root, encoding: 'utf8' })
await writeFile(join(evidenceRoot, 'production-types.log'), types.stdout + types.stderr)
const files = [toolbar, global, test, 'apps/desktop/src/renderer/src/styles/focus.css',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/agent-address.ts',
  'apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts', 'apps/desktop/src/renderer/src/lib/primary-mote-executor.ts']
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const qualification = { schema: 'agentmux.focus-toolbar-context-actions-qualification.v1', passed: false, inputs,
  mutations: mutation, callers, productionTypes: { command: 'node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json', exit: types.status, log: 'production-types.log' },
  earlyReturnClassification: 'Only an unconfirmed exact spatial target is refused. No Session, draft, healthy input, Run or existing capability is retired or disabled. Pending guard refuses duplicate action only.',
  boundary: 'Actual current Global/Toolbar/Store and Mote/Tab owners. Private source-copy RED -> restored GREEN, no shared-tree mutations or Run control. Types require current public Core/client-ui. Visual and actual private process restore are separate evidence, not implied by source tests.' }
await writeFile(join(evidenceRoot, 'qualification.json'), JSON.stringify(qualification, null, 2) + '\n')
assert.equal(types.status, 0, 'Production types failed; retain qualification as failed and inspect its exact log')
qualification.passed = true
await writeFile(join(evidenceRoot, 'qualification.json'), JSON.stringify(qualification, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualification: join(evidenceRoot, 'qualification.json') }))
