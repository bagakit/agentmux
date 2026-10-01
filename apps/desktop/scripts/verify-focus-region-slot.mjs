import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

export async function verifyFocusRegionSlot() {
  const root = resolve(import.meta.dirname, '../../..')
  const evidence = join(root, '.bagakit/feature-tracker/focus-identity-consistency-artifacts/region-slot')
  await mkdir(evidence, { recursive: true })
  const source = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
  const test = 'apps/desktop/test/focus-region-slot-switch.test.tsx'
  const dependencies = ['apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/fixtures/focus-workbench.tsx']
  const consumers = ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
    'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx', 'apps/desktop/src/renderer/src/lib/workbench-presentation.ts',
    'apps/desktop/src/renderer/src/lib/workbench-projection.ts', 'apps/desktop/src/renderer/src/lib/focus-tab-projection.ts']
  const config = 'apps/desktop/scripts/fixtures/focus-region-slot/tsconfig.owning.json'
  const mutations = [
    { label: 'collapsed-projection-slot-identity', file: source,
      before: 'const projectionSlotKey = projection && JSON.stringify([projection.entity, projection.selection])',
      after: "const projectionSlotKey = 'unscoped-slot'" },
    { label: 'duplicate-native-Region-secondary-slot', file: source,
      before: 'target.hostId !== nativeRegionTarget?.hostId', after: 'true' }
  ]
  const explicit = process.env.AGENTMUX_MUTATION_RECEIPTS ? JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS) : null
  if (explicit) assert.ok(Array.isArray(explicit) && explicit.length > 0)
  const matching = explicit ? (await Promise.all(explicit.map(async path => ({ path: resolve(path), saved: JSON.parse(await readFile(resolve(path), 'utf8')) })))).filter(({ saved }) =>
    JSON.stringify(saved.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations)) : []
  if (explicit) assert.equal(matching.length, 1, 'One receipt must match both exact implementation mutations; original verifier checks bytes and loaded RED/GREEN logs')
  const name = 'region-slot-mutants-' + globalThis.crypto.randomUUID()
  const receiptPath = explicit ? matching[0].path : join(evidence, name, 'receipt.json')
  const type = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], { cwd: root, encoding: 'utf8' })
  await writeFile(join(evidence, 'owning-types.log'), type.stdout + type.stderr)
  assert.equal(type.status, 0, 'Scoped current public Main production/test typecheck: ' + type.stdout + type.stderr)
  await verifyRendererSourceMutations({ name, tests: [test], sources: [source, ...dependencies, ...consumers], evidenceRoot: evidence, mutations })
  const mutation = JSON.parse(await readFile(receiptPath, 'utf8'))
  for (const log of ['baseline-green.log', ...mutation.cases.map(item => item.restore.log)]) {
    const text = await readFile(join(dirname(receiptPath), log), 'utf8')
    assert.match(text, /Test Files\s+1 passed/); assert.match(text, /Tests\s+2 passed/)
    assert.doesNotMatch(text, /\d+ skipped|no tests/)
  }
  const caller = spawnSync('rg', ['-n', '--fixed-strings', '<WorkspaceWorkbench', 'apps/desktop/src/renderer/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(caller.status, 0)
  const callers = caller.stdout.trim().split('\n').filter(line => !line.startsWith(source + ':'))
  assert.ok(callers.some(line => line.startsWith('apps/desktop/src/renderer/src/App.tsx:')))
  assert.ok(callers.some(line => line.startsWith('apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx:')))
  const inputs = Object.fromEntries(await Promise.all([source, test, ...dependencies, ...consumers, config].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  const qualification = { schema: 'agentmux.focus-region-slot-qualification.v1', passed: true, inputs, mutationReceipt: receiptPath,
    mutations: mutation, callers, types: { exitCode: type.status, log: 'owning-types.log' },
    boundary: 'Actual mounted Global/Workspace/Stable/SessionPane/input and public spatial owner, multi-Group same-Tab same-SID Regions, exact DOM/draft/Run/control retention and Browser/other stage preservation. Native paint is isolated; source tests do not sign physical geometry, Runtime, restart or visual quality.' }
  await writeFile(join(evidence, 'qualification.json'), JSON.stringify(qualification, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, qualification: join(evidence, 'qualification.json') }))
  return qualification
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--slice', 'source'])
  await verifyFocusRegionSlot()
}
