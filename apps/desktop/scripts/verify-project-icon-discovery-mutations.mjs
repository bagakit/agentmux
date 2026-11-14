import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mutations } from '../test/vitest.project-appearance.config.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = resolve(root, process.argv[2] ?? '.bagakit/feature-tracker/focus-scan-refinement')
const logs = join(evidence, 'icon-behavior-logs')
await mkdir(logs, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['apps/desktop/src/main/project-appearance.ts', 'apps/desktop/src/main/project-icon-image.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/space-object-images.ts', 'apps/host/src/object-avatar-files.ts',
  'apps/desktop/test/project-appearance.test.ts', 'apps/desktop/test/fixtures/mote-identity-image.ts',
  'apps/desktop/test/vitest.project-appearance.config.mts', 'apps/desktop/scripts/verify-project-icon-discovery-mutations.mjs',
  'apps/desktop/resources/icon.png']
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
const assertions = {
  'small-input-cap': 'recognizes the actual large packaged project artwork',
  'unbounded-output': 'preserves aspect ratio and rejects a native decoder mismatch or oversized output',
  'unbounded-candidates': 'caps candidate attempts even in one directory',
  'unbounded-probe-bytes': 'shares one byte budget across the conventional probes and the walk',
  'filesystem-dependent-order': 'chooses a shallow conventional asset before a deeper mark and sorts sibling directories',
  'hidden-tool-data': 'does not borrow an identity from hidden tool data',
  'image-disconnected': 'hits a conventional prefix location',
  'ignore-encoded-size': 'checks encoded dimensions before decoding',
  'missing-decoder-wiring': 'publishes discovered artwork through the actual local object image consumer'
}
async function run(label, mutant) {
  const loaded = join(logs, `${label}-loaded.jsonl`), log = join(logs, `${label}.log`)
  await writeFile(loaded, '')
  const args = ['run', '--config', 'apps/desktop/test/vitest.project-appearance.config.mts']
  const result = await new Promise((yes, no) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), args, { cwd: root,
      env: { ...process.env, AGENTMUX_PROJECT_ICON_MUTANT: mutant ?? '', AGENTMUX_PROJECT_ICON_LOAD_LOG: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
  })
  await writeFile(log, result.output)
  const count = result.output.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \((\d+)\))?/)
  const observed = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(count, `Nonempty actual test results required: ${label}`)
  assert.ok(observed.length >= 3, `Actual owning sources must load: ${label}`)
  return { command: ['node_modules/.bin/vitest', ...args], exit: result.exit, signal: result.signal,
    tests: { failed: Number(count[1] ?? 0), passed: Number(count[2]), total: Number(count[3] ?? count[2]) },
    log: relative(evidence, log), output_sha256: hash(result.output), loaded: observed,
    loaded_log: relative(evidence, loaded), loaded_log_sha256: hash(await readFile(loaded)), output: result.output }
}
const receipt = { schema: 'agentmux.project-icon-behavior.v1', passed: false, source_sha256: inputs, shared_source_mutations: 0, cases: [] }
const baseline = await run('baseline')
assert.equal(baseline.exit, 0); assert.ok(baseline.tests.total > 0)
receipt.baseline = { ...baseline, output: undefined }
for (const [label, [file, before, after]] of Object.entries(mutations)) {
  const result = await run(label, label), source = await readFile(join(root, file), 'utf8')
  assert.ok(result.exit > 0 && result.tests.failed > 0, `Inverse must fail actual tests: ${label}`)
  assert.match(result.output, /AssertionError/)
  const targetFailure = result.output.split('\n').find(line => line.includes(' FAIL ') && line.includes(assertions[label]))
  assert.ok(targetFailure, `Target consumer assertion must fail: ${label}`)
  const expected = hash(source.replace(before, after))
  assert.ok(result.loaded.some(item => item.file === file && item.sha256 === expected && item.mutant === label), `Exact mutated consumer must load: ${label}`)
  receipt.cases.push({ label, file, assertion: assertions[label], target_failure: targetFailure.trim(), loaded_sha256: expected, ...result, output: undefined, restore: 'restored' })
}
const restored = await run('restored')
assert.equal(restored.exit, 0); assert.equal(restored.tests.total, baseline.tests.total)
receipt.restored = { ...restored, output: undefined }
for (const file of files) assert.equal(hash(await readFile(join(root, file))), inputs[file], `Source remains unchanged: ${file}`)
receipt.passed = true
await writeFile(join(evidence, 'icon-behavior.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, tests: baseline.tests.total, inverses: receipt.cases.length, receipt: join(evidence, 'icon-behavior.json') }))
