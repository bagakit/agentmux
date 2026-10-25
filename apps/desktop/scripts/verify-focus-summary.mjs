import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/plans/ui-process-status-summary/focus-summary')
await mkdir(evidence, { recursive: true })
const content = 'apps/desktop/src/renderer/src/components/AgentContextContent.tsx'
const row = 'apps/desktop/src/renderer/src/components/FocusContextRow.tsx'
const tests = ['apps/desktop/test/focus-summary.test.tsx', 'apps/desktop/test/focus-card-markdown.test.tsx', 'apps/desktop/test/focus-service-recap.test.tsx']
const css = 'apps/desktop/src/renderer/src/styles/focus.css'
const name = 'focus-summary-' + globalThis.crypto.randomUUID()
const mutations = [
  { label: 'interrupted-loses-held-excerpt', file: content,
    before: " || presentation === 'card' && context.processState === 'interrupted'", after: '' },
  { label: 'unknown-reason-hidden-behind-status', file: content,
    before: " || presentation === 'card' && context.detailKind === 'observation'", after: '' },
  { label: 'same-name-selects-another-Agent', file: row,
    before: 'onSelect(context.id)', after: "onSelect('summary-first')" }
]
const fixtureInputs = ['test/fixture-values.mjs', 'apps/desktop/scripts/lib/fixture-values.mjs',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/agent-information-root.tsx']
await verifyRendererSourceMutations({ name, tests, sources: [content, row, css, ...fixtureInputs], mutations, evidenceRoot: evidence })
const paths = process.env.AGENTMUX_MUTATION_RECEIPTS ? JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS) : []
const records = await Promise.all(paths.map(async path => ({ path, proof: JSON.parse(await readFile(path, 'utf8')) })))
const matching = records.filter(({ proof }) => JSON.stringify(proof.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
if (paths.length) assert.equal(matching.length, 1, 'Exactly one explicit receipt must prove these Focus mutation definitions.')
const mutationReceipt = paths.length ? matching[0].path : join(evidence, name, 'receipt.json')
const proof = JSON.parse(await readFile(mutationReceipt, 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
const callers = {}
for (const [symbol, definition] of [['<AgentContextContent ', content], ['<FocusContextRow ', row], ['<FocusContextCardBody ', 'apps/desktop/src/renderer/src/components/FocusContextCardBody.tsx']]) {
  const found = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src/renderer/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(found.status, 0)
  const actual = found.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':') && !/^.*:\d+:\s*import\b/.test(line))
  assert.ok(actual.length > 0, 'Actual production invocation: ' + symbol)
  callers[symbol] = actual
}
const sourceFiles = [content, row, css, ...tests]
const inputs = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const qualification = join(evidence, 'qualification.json')
await writeFile(qualification, JSON.stringify({ schema: 'agentmux.focus-summary-qualification.v1', passed: true, inputs, callers, mutationReceipt,
  verified: ['original interrupted excerpt with separate cause', 'visible unconfirmed activity explanation', 'unknown Run stays unknown', 'same-name exact target selection', 'original keyboard reader keeps complete reason', 'related-only Global card bodies and recap cost'],
  boundary: 'Actual Focus row/content/projection and window reader, plus actual Global card body/cost consumer. Avatar paint and native transport are controlled in tests. Capture and independent visual review are separate; no user Run or installation.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualification, mutations: proof.cases.length }))
