import assert from 'node:assert/strict'
import { fixturePath } from './lib/fixture-values.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp/browser-use-settings', randomUUID())
await mkdir(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const owners = {
  registration: 'apps/desktop/src/renderer/src/components/settings/settings-modules.ts',
  scalar: 'apps/desktop/src/main/settings/modules/browser.ts',
  merge: 'apps/desktop/src/shared/config-edit.ts',
  effects: 'apps/desktop/src/shared/browser-agent-control.ts',
  schema: 'apps/desktop/src/main/config-store.ts'
}
const inputs = Object.fromEntries(await Promise.all([...new Set([...Object.values(owners),
  'apps/desktop/src/main/settings/modules/browser-agent-control.ts',
  'apps/desktop/src/main/settings-control.ts',
  'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/renderer/src/components/settings/BrowserAgentControlPreview.tsx',
  'apps/desktop/src/renderer/src/components/settings/BrowserAgentControlSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/browser-agent-control.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/browser.tsx',
  'apps/desktop/src/renderer/src/components/settings/settings-catalog.ts',
  'apps/desktop/src/renderer/src/styles/browser-agent-control-settings.css',
  'apps/desktop/test/settings-browser-agent-control.test.tsx'
])].map(async file => [file, await readFile(join(root, file), 'utf8')])) )
const test = 'apps/desktop/test/settings-browser-agent-control.test.tsx'
const mutations = [
  { id: 'module', file: owners.registration, before: '  browserAgentControlSettingsModule,', after: '', assertion: 'mounts the Browser use contribution and previews an unsaved draft through the shared effects without a Browser operation' },
  { id: 'scalar', file: owners.scalar, before: '  ...browserAgentControlSettings,', after: '', assertion: 'actual CLI reads and persists the same preferences through public RPC and rejects invalid values before writing' },
  { id: 'authored-merge', file: owners.merge, before: " || path === 'browser.agentControl') {", after: ') {', assertion: 'merges concurrent first edits and keeps a later draft while persistence is pending' },
  { id: 'shared-effects', file: owners.effects, before: '--amux-agent-color:${p.glowColor}', after: '--amux-agent-color:#123456', assertion: 'mounts the Browser use contribution and previews an unsaved draft through the shared effects without a Browser operation' },
  { id: 'durable-bounds', file: owners.schema, before: '.max(EFFECT_LIMITS.glowWidth.max)', after: '', assertion: 'rejects invalid effect values at the durable GUI save boundary and keeps the original bytes' }
]
for (const mutant of mutations) assert.equal(inputs[mutant.file].split(mutant.before).length, 2, 'Unique production mutation anchor: ' + mutant.id)
const plan = { root, owners, mutations, inputs: Object.fromEntries(Object.entries(inputs).map(([file, source]) => [file, hash(source)])) }
await writeFile(join(evidence, 'plan.json'), JSON.stringify(plan, null, 2))
const config = join(evidence, 'vitest.config.mts')
await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/scripts/fixtures/browser-use-settings/vitest.config.mts'))};
import { readFileSync,writeFileSync } from 'node:fs';import { createHash } from 'node:crypto';import { relative } from 'node:path';
const plan=JSON.parse(readFileSync(${JSON.stringify(join(evidence, 'plan.json'))},'utf8'));
const mutation=plan.mutations.find(item=>item.id===process.env.BROWSER_USE_MUTATION);
const loaded={};const h=text=>createHash('sha256').update(text).digest('hex');
export default {...base,plugins:[...(base.plugins??[]),{name:'private-browser-use-production-mutation',enforce:'pre',load(id){
 const file=relative(plan.root,id.split('?')[0]);if(!plan.inputs[file])return;
 const original=readFileSync(id.split('?')[0],'utf8');if(h(original)!==plan.inputs[file])throw new Error('Proof input changed: '+file);
 const source=mutation?.file===file?original.replace(mutation.before,mutation.after):original;
 loaded[file]={original:h(original),loaded:h(source)};writeFileSync(process.env.BROWSER_USE_LOADS,JSON.stringify(loaded));return source;
}}],test:{...base.test,include:[${JSON.stringify(test)}]}};
`)
async function execute(command, args, label, env = {}) {
  const logs = [], code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data))
    child.on('error', reject); child.on('close', (code, signal) => { assert.equal(signal, null); resolve(code) })
  })
  await writeFile(join(evidence, label + '.log'), Buffer.concat(logs))
  return code
}
const runs = []
async function run(label, mutant) {
  const loads = join(evidence, label + '.loads.json'), reportFile = join(evidence, label + '.tests.json')
  const scratch = await mkdtemp(fixturePath('tmp/amx-browser-use-'))
  let code
  try { code = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '--reporter=json', '--reporter=default', '--outputFile.json=' + reportFile], label,
    { TMPDIR: scratch, BROWSER_USE_MUTATION: mutant?.id ?? '', BROWSER_USE_LOADS: loads }) }
  finally { await rm(scratch, { recursive: true, force: true }) }
  const report = JSON.parse(await readFile(reportFile, 'utf8')), loaded = JSON.parse(await readFile(loads, 'utf8'))
  assert.equal(report.testResults.length, 1); assert.equal(report.numTotalTests, 6)
  assert.equal(report.numPendingTests, 0); assert.equal(report.testResults[0].assertionResults.length, 6)
  assert.equal(report.testResults[0].message, '', 'Setup/runtime failure is not assertion RED')
  assert.doesNotMatch(await readFile(join(evidence, label + '.log'), 'utf8'), /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  assert.ok(Object.keys(loaded).length >= 10, 'Actual production consumers loaded')
  if (mutant) {
    assert.notEqual(code, 0)
    const assertion = report.testResults[0].assertionResults.find(item => item.fullName === mutant.assertion)
    assert.equal(assertion?.status, 'failed', 'Corresponding real behavior must turn RED')
    assert.ok(assertion.failureMessages.some(message => message.includes('AssertionError') || (mutant.id === 'durable-bounds' && /promise resolved .* instead of rejecting/s.test(message))), 'Only the owning behavioral assertion qualifies as RED')
    assert.equal(loaded[mutant.file].loaded, hash(inputs[mutant.file].replace(mutant.before, mutant.after)))
    assert.notEqual(loaded[mutant.file].loaded, loaded[mutant.file].original)
  } else { assert.equal(code, 0, label + ': inspect its log'); assert.equal(report.numFailedTests, 0) }
  runs.push({ label, exit: code, assertions: report.numTotalTests, failures: report.numFailedTests, mutation: mutant?.id ?? null })
  console.log(label + ': ' + (mutant ? 'AssertionRED' : 'GREEN'))
}
const receipt = { schema: 'agentmux.browser-use-settings-proof.v1', passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources: plan.inputs, runs, sharedTreeMutations: 0,
  scope: 'Real mounted Settings/Store→ConfigOwner→durable ConfigStore and actual amux CLI→public RPC→same owner; simulation uses shared effects. Native live Browser consumption belongs to the subsequent feedback slice. Independent visual review is separate.' }
try {
  const typecheck = await execute('pnpm', ['--filter', '@agentmux/desktop', 'typecheck'], 'desktop-typecheck')
  assert.equal(typecheck, 0, 'Desktop typecheck: inspect desktop-typecheck.log')
  await run('baseline')
  for (const mutant of mutations) { await run(mutant.id + '-red', mutant); await run(mutant.id + '-restored') }
  const visualRoot = join(root, '.tmp/browser-use-visual')
  const renderInputs = Object.keys(plan.inputs).filter(file => file.includes('/renderer/') || file === owners.effects)
  async function matchingVisual(variant) {
    for (const name of await readdir(visualRoot).catch(() => [])) {
      const file = join(visualRoot, name, 'source.json')
      let proof
      try { proof = JSON.parse(await readFile(file, 'utf8')) } catch { continue }
      if (proof.variant !== variant || !renderInputs.every(input => proof.sources[input]?.file === plan.inputs[input])) continue
      if (!renderInputs.every(input => proof.sources[input].consumed === (variant === 'shared-effect-cut' && input === owners.effects
        ? hash(inputs[input].replace('  const p = preferences', "  return ''; // private mutation: remove shared drawing\n  const p = preferences")) : plan.inputs[input]))) continue
      if (variant === 'control' && proof.exit === 0 && proof.capture.complete && proof.capture.screenshots.length === 8 && proof.capture.blend?.changedActualPixels) return file
      if (variant === 'shared-effect-cut' && !proof.capture.complete && /AssertionError/.test(proof.capture.failure?.stack ?? '') && /Blend changes actual page-edge pixels/.test(proof.capture.failure?.message ?? '')) return file
    }
  }
  let control = await matchingVisual('control')
  if (!control) { assert.equal(await execute(process.execPath, ['apps/desktop/scripts/capture-browser-use-settings.mjs'], 'native-control'), 0); control = await matchingVisual('control') }
  assert.ok(control, 'Exact-source actual native Settings control must pass')
  let mutant = await matchingVisual('shared-effect-cut')
  if (!mutant) { assert.notEqual(await execute(process.execPath, ['apps/desktop/scripts/capture-browser-use-settings.mjs', '--effect-mutant'], 'native-effects-red'), 0); mutant = await matchingVisual('shared-effect-cut') }
  assert.ok(mutant, 'Cutting the shared production drawing must fail the actual native pixel assertion')
  receipt.nativeEffects = { control: relative(root, control), mutant: relative(root, mutant), restored: 'Private source substitution only; exact control source preserved' }
  for (const [file, source] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, file))), hash(source), 'Shared source preserved: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, join(evidence, 'receipt.json')) }))
assert.equal(receipt.passed, true, receipt.failure?.message)
