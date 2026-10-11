import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), at = args.indexOf('--output')
const deliveryOnly = args.includes('--delivery-only')
const directory = path.resolve(root, at >= 0 ? args[at + 1] : `.tmp/session-continuity-settings/${randomUUID()}`)
await fs.mkdir(directory, { recursive: true })
const digest = value => createHash('sha256').update(value).digest('hex')
const relative = {
  registration: 'apps/desktop/src/renderer/src/components/settings/settings-modules.ts',
  main: 'apps/desktop/src/main/settings/setting-catalog.ts',
  authored: 'apps/desktop/src/shared/config-edit.ts',
  adapter: 'apps/desktop/src/renderer/src/components/settings/modules/continuity.tsx',
  pane: 'apps/desktop/src/renderer/src/components/settings/ContinuitySettingsPane.tsx',
  schema: 'apps/desktop/src/main/config-store.ts',
  settingsEntry: 'apps/desktop/src/main/settings/modules/continuity.ts',
  policy: 'packages/core/src/agent-session-continuity.ts',
  owner: 'apps/desktop/src/main/config-owner.ts',
  handler: 'apps/desktop/src/main/settings-control.ts',
  uiCases: 'apps/desktop/test/session-continuity-settings.test.tsx',
  controlCases: 'apps/desktop/test/session-continuity-settings-control.test.ts',
  verifier: 'apps/desktop/scripts/verify-session-continuity-settings.mjs'
}
const sources = Object.fromEntries(await Promise.all(Object.entries(relative).map(async ([key, file]) => [key, await fs.readFile(path.join(root, file), 'utf8')])))
const replace = (text, before, after) => { assert.equal(text.split(before).length, 2, 'Exactly one owning mutation anchor: ' + before); return text.replace(before, after) }
const uiFile = 'apps/desktop/test/session-continuity-settings.test.tsx', controlFile = 'apps/desktop/test/session-continuity-settings-control.test.ts'
const mutants = [
  { id: 'retry-scalar', file: relative.settingsEntry, source: replace(sources.settingsEntry, "  numberSetting('retryInitialDelayMs'),\n", ''), test: 'public RPC discovers the complete Core policy and keeps absent effective defaults absent', suite: controlFile },
  { id: 'retry-complete-schema', file: relative.schema, source: replace(sources.schema, "try { normalizeAgentContinuityPolicy(authored as AppConfig['continuity']) }", 'try { void authored }'), test: 'retry settings reject invalid complete policies and preserve unrelated authored data', suite: controlFile },
  { id: 'retry-editor-binding', file: relative.pane, source: replace(sources.pane, 'retryInitialDelayMs: milliseconds(value.retryInitialDelayMs)', 'retryInitialDelayMs: milliseconds(value.retryMaxDelayMs)'), test: 'retry choices are discoverable, strictly authored and separate from rechecks without Session side effects', suite: uiFile },
  { id: 'registration', file: relative.registration, source: replace(sources.registration, '  continuitySettingsModule,\n', ''), test: 'the registered continuity module reaches Overview, search, narrow navigation and the real writable editor', suite: uiFile },
  { id: 'main-wiring', file: relative.main, source: replace(sources.main, '  ...continuitySettings,\n', ''), test: 'public RPC discovers the complete Core policy and keeps absent effective defaults absent', suite: controlFile },
  { id: 'authored-first-write', file: relative.authored, source: replace(sources.authored, " || path === 'continuity'", ''), test: 'concurrent first authored fields merge without materializing untouched defaults and conflicts keep disk intact', suite: controlFile },
  { id: 'expected-baseline', file: relative.adapter, source: replace(sources.adapter, '...current.continuity, ...expected', '...current.continuity, ...value'), test: 'the registered continuity module reaches Overview, search, narrow navigation and the real writable editor', suite: uiFile },
  { id: 'complete-preview', file: relative.pane, source: replace(sources.pane, 'const reminder = resolveAgentContinuityReminder({ ...saved, reminderMode: draft.value.reminderMode, reminderAppend: draft.value.reminderAppend })', "const reminder = 'Incomplete recovery reminder'"), test: 'reminder and continuation remain independent with complete effective preview and preserved custom text', suite: uiFile },
  { id: 'strict-schema', file: relative.schema, source: replace(sources.schema, 'continuationPrompt: z.string().optional()\n    }).strict().optional()', 'continuationPrompt: z.string().optional()\n    }).optional()'), test: 'all declared scalar types persist through the original owner with strict target and schema validation', suite: controlFile }
]
const sourceIdentity = Object.fromEntries(Object.entries(relative).map(([key, file]) => [file, digest(sources[key])]))
await fs.writeFile(path.join(directory, 'mutations.json'), JSON.stringify({ root, mutants }, null, 2))
const config = path.join(directory, 'vitest.config.mts')
await fs.writeFile(config, `
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import base from ${JSON.stringify(path.join(root, 'apps/desktop/scripts/fixtures/session-continuity-settings/vitest.config.mts'))}
const plan=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(directory, 'mutations.json'))},'utf8'))
const mutant=plan.mutants.find(m=>m.id===process.env.CONTINUITY_SETTINGS_MUTANT)
const capture={consumed:0,loaded:{},compiled:{}}
const sha=value=>createHash('sha256').update(value).digest('hex')
const publish=()=>fs.writeFileSync(process.env.CONTINUITY_SETTINGS_CAPTURE!,JSON.stringify(capture))
export default {...base,plugins:[{name:'actual-continuity-source',enforce:'pre',load(id){
 const file=path.relative(plan.root,id.split('?')[0]);if(!plan.mutants.some(m=>m.file===file))return
 const original=fs.readFileSync(path.join(plan.root,file),'utf8'),text=mutant?.file===file?mutant.source:original
 capture.loaded[file]={original:sha(original),loaded:sha(text)};if(mutant?.file===file)capture.consumed++;publish();return text
}},{name:'actual-continuity-compiled',enforce:'post',transform(code,id){
 const file=path.relative(plan.root,id.split('?')[0]);if(!plan.mutants.some(m=>m.file===file))return
 capture.compiled[file]=sha(code);publish()
}}]}
`)
const runs = []
async function run(id, mutation = '') {
  const report = path.join(directory, `${id}.tests.json`), captured = path.join(directory, `${id}.capture.json`), output = []
  await fs.rm(report, { force: true }); await fs.rm(captured, { force: true })
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile.json=' + report],
      { cwd: root, env: { ...process.env, CONTINUITY_SETTINGS_MUTANT: mutation, CONTINUITY_SETTINGS_CAPTURE: captured }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk)); child.on('error', reject); child.on('close', resolve)
  })
  const log = Buffer.concat(output).toString(); await fs.writeFile(path.join(directory, `${id}.log`), log)
  const result = JSON.parse(await fs.readFile(report, 'utf8')), capture = JSON.parse(await fs.readFile(captured, 'utf8'))
  assert.equal(result.testResults.length, 2); assert.equal(result.numTotalTests, 12)
  for (const suite of result.testResults) { assert.ok(suite.assertionResults.length > 0); assert.equal(suite.message, '', 'No setup/runtime errors may qualify') }
  const assertions = result.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(assertions.length, result.numTotalTests, 'Every declared case must exist in the fresh raw report')
  assert.equal(assertions.filter(test => test.status === 'passed').length, result.numPassedTests)
  assert.equal(assertions.filter(test => test.status === 'failed').length, result.numFailedTests)
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  if (!mutation) { assert.equal(exitCode, 0, log); assert.equal(result.numPassedTests, 12) }
  else {
    const mutant = mutants.find(m => m.id === mutation)
    assert.equal(exitCode, 1, 'Owning mutant must reach a business assertion: ' + mutation)
    assert.ok(capture.consumed > 0 && capture.compiled[mutant.file], 'Actual owning source was loaded and compiled')
    assert.equal(capture.loaded[mutant.file].loaded, digest(mutant.source))
    assert.notEqual(capture.loaded[mutant.file].loaded, capture.loaded[mutant.file].original)
    const suite = result.testResults.find(s => path.relative(root, s.name) === mutant.suite)
    const failed = suite?.assertionResults.find(test => test.fullName === mutant.test)
    assert.equal(failed?.status, 'failed', 'The owning business assertion must turn red')
    assert.ok(failed.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message)), 'A process failure cannot replace the owning assertion')
  }
  runs.push({ id, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, consumed: capture.consumed })
  process.stdout.write(JSON.stringify(runs.at(-1)) + '\n')
}
const callers = []
for (const [symbol, definition] of [
  ['ContinuitySettingsPane', relative.pane], ['continuitySettingsModule', relative.adapter],
  ['continuitySettings', 'apps/desktop/src/main/settings/modules/continuity.ts']
]) {
  const found = execFileSync('rg', ['-n', '-w', symbol, 'apps/desktop/src', '-g', '*.ts', '-g', '*.tsx'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(line => !line.startsWith(definition + ':'))
  assert.ok(found.length > 0, 'Nonempty definition-excluded production callers: ' + symbol); callers.push({ symbol, excludedDefinition: definition, found })
}
await fs.writeFile(path.join(directory, 'callers.json'), JSON.stringify(callers, null, 2))
if (!args.includes('--visual-only') && !deliveryOnly) {
  await run('control')
  for (const mutant of mutants) await run(mutant.id, mutant.id)
}
const mode = deliveryOnly ? 'session-continuity-delivery' : 'session-continuity-settings'
const native = await qualify(path.join(directory, 'native'), false, false, { modes: [mode], sources: [
  'apps/desktop/scripts/fixtures/session-continuity-settings/scenario.cjs',
  'apps/desktop/scripts/verify-session-continuity-settings.mjs'
] })
assert.equal(native.completed, true, JSON.stringify(native.failure))
const raw = JSON.parse(await fs.readFile(path.join(directory, `native/${mode}.json`), 'utf8'))
assert.ok(raw.settingsOnly && raw.surface.exact, 'Settings keep the original work surface')
if (deliveryOnly) assert.ok(raw.deliveryOnly && raw.savedContinuity && native.png.length === 2, 'Two complete delivery views consume the actual saved preferences')
else assert.ok(raw.cli?.length > 5, 'Actual CLI and mounted writable GUI share the original ConfigOwner')
for (const [file, sha] of Object.entries(sourceIdentity)) assert.equal(digest(await fs.readFile(path.join(root, file))), sha, 'Candidate source drift: ' + file)
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify({ completed: true, sourceIdentity, runs, native: { sourceIdentity: native.sourceIdentity, frames: native.png, boundary: native.boundary }, independentVisualReview: 'pending' }, null, 2))
console.log(JSON.stringify({ completed: true, directory, mutations: Math.max(0, runs.length - 1), frames: native.png.length, independentVisualReview: 'pending' }))
