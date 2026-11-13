import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const task = process.argv.find(value => value.startsWith('--task='))?.slice(7)
const common = 'apps/desktop/test/agent-operation-feedback.test.tsx'
const cases = {
  'T-001': [
    ['wrong-stop-receipt', common, 'a wrong original receipt'],
    ['repeat-stop-on-inspect', common, 'restored references remain static'],
    ['modal-waits-for-stop', 'apps/desktop/test/session-stop-dialog-operation.test.tsx', 'a pending Stop leaves'],
    ['missing-card-feedback', 'apps/desktop/test/session-stop-dialog-operation.test.tsx', 'a pending Stop leaves']
  ],
  'T-002': [],
  'T-003': [],
  'T-004': [['hidden-motion-runs', common, 'hiding the workface pauses']]
}[task]
assert.ok(cases?.length, 'Task has a nonempty actual-source mutation set')
const evidence = join(root, '.local/agent-card-operations/mutations', task)
await mkdir(evidence, { recursive: true })
const config = 'apps/desktop/test/vitest.agent-operation-feedback.config.mts'
const runs = []
async function check(name, files, mutant, testNamePattern) {
  const loaded = join(evidence, `${name}.loaded.jsonl`)
  await writeFile(loaded, '')
  const args = ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', config, ...files,
    ...(testNamePattern ? ['--testNamePattern', testNamePattern] : [])]
  const result = await new Promise((done, reject) => {
    const child = spawn('pnpm', args, { cwd: root, env: { ...process.env,
      pnpm_config_verify_deps_before_run: 'false', AGENTMUX_AGENT_OPERATION_MUTANT: mutant ?? '', AGENTMUX_AGENT_OPERATION_LOADED: loaded } })
    let log = ''
    child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
    child.once('error', reject); child.once('exit', code => done({ code, log }))
  })
  await writeFile(join(evidence, `${name}.log`), result.log)
  if (mutant) {
    assert.notEqual(result.code, 0, `${mutant} must fail its same consumer assertion`)
    assert.ok(result.log.includes(`MUTATION_APPLIED=${mutant}`), 'Actual production mutation loaded')
    assert.ok(result.log.includes(testNamePattern) && /Tests\s+\d+ failed/.test(result.log), 'A nonempty consumer test failed, not a missing suite or transform error')
    const inputs = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(inputs.length > 0 && inputs.every(input => input.source !== input.loaded))
    runs.push({ name, outcome: 'RED', command: ['pnpm', ...args], inputs })
  } else {
    assert.equal(result.code, 0, result.log)
    assert.match(result.log, /Tests\s+\d+ passed/, 'GREEN contains real executed consumers')
    runs.push({ name, outcome: 'GREEN', command: ['pnpm', ...args] })
  }
  process.stdout.write(`${task} ${name}: ${mutant ? 'RED' : 'GREEN'}\n`)
}
const files = [...new Set(cases.map(item => item[1]))]
await check('original-green', files)
for (const [mutant, file, test] of cases) await check(mutant, [file], mutant, test)
await check('restored-green', files)
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = [...new Set(runs.flatMap(run => run.inputs?.map(input => input.file) ?? []))]
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])))
assert.ok(sources.length > 0)
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ task, passed: true, sources: sourceHashes, runs }, null, 2) + '\n')
