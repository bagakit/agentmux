import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), at = process.argv.indexOf('--evidence')
assert.ok(at >= 0 && process.argv[at + 1], 'Supply a fresh --evidence directory; preserve earlier runs')
const evidence = resolve(root, process.argv[at + 1]); await mkdir(evidence, { recursive: false })
const hash = data => createHash('sha256').update(data).digest('hex')
const files = ['apps/desktop/src/shared/focus-zone-presentation.ts', 'apps/desktop/src/shared/focus-preferences.ts', 'apps/desktop/src/shared/config-edit.ts',
  'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/settings/modules/focus.ts', 'apps/desktop/src/renderer/src/lib/focus-collection-lanes.ts',
  ...['FocusProjectLanes', 'FocusScanLaneContent', 'FocusContextCards', 'FocusProjectPreferences', 'GlobalFocusSurface'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`),
  'apps/desktop/src/renderer/src/styles/focus-context.css', 'apps/desktop/test/focus-zone-organization.test.tsx', 'apps/desktop/test/focus-zone-organization-control.test.ts',
  'apps/desktop/test/vitest.focus-zone-organization.config.mts', 'apps/desktop/test/vitest.focus-project-appearance.config.mts', 'apps/desktop/test/vitest.mote-context.config.mts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/config-owner-fixture.ts', 'apps/desktop/test/helpers/spatial-control-owner-fixture.ts',
  'packages/identity/dist/runtime-source.js', 'apps/desktop/scripts/verify-focus-zone-organization-mutations.mjs']
const bindings = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.focus-zone-organization-behavior.v1', passed: false, source_before: await bindings(), runs: [], boundary: 'Actual current source aliases and original mounted Global/scan/cards/preferences plus ConfigOwner/settings validation and durable readback; no App package/install or user Run operation. Whole-App image and ordinary restart gates remain separate.' }
const inverseCases = [
  ['project-default', 'actual project scan defaults to sections'], ['container-override', 'actual project scan defaults to sections'],
  ['mode-consumer', 'actual project scan defaults to sections'], ['container-delta', 'ConfigOwner merges different container deltas'],
  ['late-save', 'an older Zone save cannot close'], ['multiple-zones', 'one original Context in two worktree Zones']
]
async function run(name, mutant, testName) {
  const loaded = join(evidence, `${name}-loaded.ndjson`), report = join(evidence, `${name}.json`)
  const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.focus-zone-organization.config.mts', '--reporter=json', '--outputFile', report, ...(testName ? ['-t', testName] : [])]
  const outcome = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, AGENTMUX_FOCUS_ZONE_MUTANT: mutant ?? '', AGENTMUX_FOCUS_ZONE_LOADED: loaded, AGENTMUX_FOCUS_ZONE_ADJACENT: '' }, maxBuffer: 4 * 1024 * 1024 })
  const log = `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`; await writeFile(join(evidence, `${name}.log`), log)
  assert.equal(outcome.signal, null, `${name}: original test process must exit normally`); if (outcome.error) throw outcome.error
  const result = JSON.parse(await readFile(report, 'utf8')), entries = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const assertions = result.testResults.flatMap(file => file.assertionResults)
  const passed = assertions.filter(item => item.status === 'passed'), failed = assertions.filter(item => item.status === 'failed')
  if (mutant) {
    assert.equal(outcome.status, 1, `${name} must fail`); assert.ok(entries.some(entry => entry.mutant === mutant && entry.original_sha256 !== entry.loaded_sha256), 'Exact product mutant must load')
    assert.ok(failed.some(item => item.fullName.includes(testName) && item.failureMessages.some(message => message.includes('AssertionError'))), 'The targeted real consumer must reject changed behavior')
  } else { assert.equal(outcome.status, 0, log); assert.equal(failed.length, 0); assert.equal(passed.length, 10, 'The exact nonempty baseline/restored collection must run') }
  const item = { name, mutant, testName: testName ?? null, exit_code: outcome.status, passed: passed.length, failed: failed.map(item => ({ name: item.fullName, messages: item.failureMessages })),
    report: { file: `${name}.json`, sha256: hash(await readFile(report)) }, loaded: { file: `${name}-loaded.ndjson`, sha256: hash(await readFile(loaded)) }, log: { file: `${name}.log`, sha256: hash(await readFile(join(evidence, `${name}.log`))) } }
  receipt.runs.push(item); process.stdout.write(`${name}: ${mutant ? 'targeted assertion red' : `${passed.length} green`}\n`)
}
try {
  await run('baseline'); for (const [mutant, testName] of inverseCases) await run(`inverse-${mutant}`, mutant, testName); await run('restored')
  receipt.source_after = await bindings(); assert.deepEqual(receipt.source_after, receipt.source_before, 'Source inputs changed during the bounded proof')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
