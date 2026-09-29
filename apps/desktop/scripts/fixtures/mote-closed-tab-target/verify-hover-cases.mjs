import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const desktop = resolve(import.meta.dirname, '../../..'), repository = resolve(desktop, '../..')
const source = await readFile(join(desktop, 'test/mote-hover-surface.test.tsx'), 'utf8')
const names = ['keeps an empty Mote', 'retains the exact saved Tab', 'creates a projected New tab']
for (const name of names) assert.ok(source.includes(name), 'Actual named contract entry exists: ' + name)
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-closed-tab-hover-gate-'))
try {
  const output = join(privateRoot, 'results.json')
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', join(desktop, 'scripts/fixtures/mote-closed-tab-target/vitest.owning.config.mts'),
    'test/mote-hover-surface.test.tsx', '--maxWorkers=1', '-t', names.join('|'), '--reporter=json', '--outputFile='+output],
    { cwd: repository, encoding:'utf8', timeout:60000 })
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
  assert.equal(result.signal, null, 'Completed selected contract cases, not timeout')
  assert.equal(result.status, 0, 'All named owning contract cases pass')
  const facts = JSON.parse(await readFile(output, 'utf8'))
  const passed = facts.testResults.flatMap(file=>file.assertionResults).filter(one=>one.status==='passed')
  assert.equal(passed.length, 8, 'Eight actual nonempty named cases: four exact retained targets, three projected New Tab cases, one deferred empty prepare/retry')
  assert.ok(passed.every(one=>names.some(name=>one.fullName.includes(name))), 'No unrelated case substitutes for the named scope')
  console.log(JSON.stringify({schema:'agentmux.closed-tab-hover-maintenance-cases.v1',passed:true,count:passed.length,
    cases:passed.map(one=>one.fullName),scope:'This closure only; complete legacy hover runs remain independent historical evidence.'}))
} finally { await rm(privateRoot, { recursive:true }) }
