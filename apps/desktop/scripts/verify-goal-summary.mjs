import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const summary = 'apps/desktop/src/renderer/src/components/GoalResponsibilitySummary.tsx'
const patrol = 'apps/desktop/src/renderer/src/components/GoalPatrolControl.tsx'
const css = 'apps/desktop/src/renderer/src/styles/goal-responsibility.css'
const product = 'apps/desktop/test/goal-summary-product.test.tsx'
const helper = 'apps/desktop/test/helpers/goal-responsibility-product.tsx'
const evidence = join(root, '.tmp/goal-summary'), name = 'mutations-' + randomUUID()
const mutations = [
  { label: 'compact-next-responsibility-disappears', file: summary,
    before: '<span className="goal-responsibility__next-action">{row.nextOwner.action}</span>',
    after: '{!compact ? <span className="goal-responsibility__next-action">{row.nextOwner.action}</span> : null}' },
  { label: 'compact-alert-reason-disappears', file: summary,
    before: '{!compact || row.alert ? <p className="goal-responsibility__reason"',
    after: '{!compact ? <p className="goal-responsibility__reason"' },
  { label: 'saved-original-input-is-requested-again', file: patrol,
    before: 'void run(pending ? () => refreshGoalDelegations(demand.id) : () => request(entry), entry)',
    after: 'void run(() => request(entry), entry)' },
  { label: 'compact-business-report-summary-is-hidden', file: patrol,
    before: '<span className="goal-patrol__report-summary">{patrol.report.summary}</span>',
    after: '{!compact ? <span className="goal-patrol__report-summary">{patrol.report.summary}</span> : null}' },
  { label: 'compact-manager-recovery-action-disappears', file: patrol,
    before: '{needsSupervisor ? <button type="button" className="goals-button"',
    after: '{!compact && needsSupervisor ? <button type="button" className="goals-button"' }
]
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, tests: [product], sources: [summary, patrol, helper], mutations })
let proofPath = join(evidence, name, 'receipt.json')
if (process.env.AGENTMUX_MUTATION_RECEIPTS) {
  const paths = JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS)
  const records = await Promise.all(paths.map(async path => ({ path: resolve(path), value: JSON.parse(await readFile(resolve(path), 'utf8')) })))
  const matching = records.filter(({ value }) => JSON.stringify(value.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
  assert.equal(matching.length, 1, 'Choose the one exact original semantic mutation receipt.')
  proofPath = matching[0].path
}
const proof = JSON.parse(await readFile(proofPath, 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
const baseline = await readFile(join(dirname(proofPath), 'baseline-green.log'), 'utf8')
assert.match(baseline, /Tests\s+[1-9]\d* passed/)
assert.doesNotMatch(baseline, /Tests\s+[1-9]\d* failed|Failed Suites|Unhandled Error/)
const consumer = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'
const consumerSource = await readFile(join(root, consumer), 'utf8')
assert.match(consumerSource, /<GoalResponsibilitySummary demand=\{demand\} compact/)
assert.match(await readFile(join(root, product), 'utf8'), /mount\(createElement\(GlobalBoardSurface\)\)/)
const candidateFiles = [summary, patrol, css, product, helper, consumer, 'apps/desktop/scripts/verify-goal-summary.mjs']
const candidate = Object.fromEntries(await Promise.all(candidateFiles.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const receipt = { schema: 'agentmux.goal-summary-qualification.v1', passed: true, candidate,
  consumers: [{ file: consumer, component: 'GlobalBoardSurface', test: product,
    boundary: 'Mounted production Board -> compact responsibility summary -> original Host/Store/Core public CLI/RPC and patrol callbacks. Native transport/status are isolated fixtures.' }],
  mutationReceipt: proofPath, mutations: proof.cases.map(item => ({ label: item.label, red: item.log, restoredGreen: item.restore.log })),
  runtimeControl: [], sharedTreeMutations: 0,
  limitations: ['Private Renderer imagery and independent visual review are separate evidence.', 'This receipt does not claim live Provider, installed app or Native lifecycle acceptance.'] }
await mkdir(evidence, { recursive: true })
const output = join(evidence, 'qualified-receipt.json')
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: output, mutants: mutations.length, consumer }))
