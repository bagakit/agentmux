import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), at = args.indexOf('--output')
const output = path.resolve(root, at >= 0 ? args[at + 1] : `.tmp/automation-defaults/${randomUUID()}`)
await fs.mkdir(output, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const files = {
  preferences: 'apps/desktop/src/shared/automation-preferences.ts', contracts: 'apps/desktop/src/shared/contracts.ts',
  schema: 'apps/desktop/src/main/config-store.ts', authored: 'apps/desktop/src/shared/config-edit.ts',
  scalar: 'apps/desktop/src/main/settings/modules/automation.ts', catalog: 'apps/desktop/src/main/settings/setting-catalog.ts',
  dispatcher: 'apps/desktop/src/main/settings-control.ts', pane: 'apps/desktop/src/renderer/src/components/settings/AutomationDefaultsSettingsPane.tsx',
  module: 'apps/desktop/src/renderer/src/components/settings/modules/automation.tsx',
  progress: 'apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx', calendar: 'apps/desktop/src/renderer/src/components/CalendarScheduleControl.tsx',
  mote: 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx', styles: 'apps/desktop/src/renderer/src/styles/settings-continuity.css',
  controlTests: 'apps/desktop/test/automation-defaults-control.test.ts', editorTests: 'apps/desktop/test/automation-defaults.test.tsx',
  calendarTests: 'apps/desktop/test/calendar-schedule-control.test.tsx', productTests: 'apps/desktop/test/continuous-progress-product.test.tsx',
  moteTests: 'apps/desktop/test/mote-daily-ideas.test.tsx', fixture: 'apps/desktop/scripts/fixtures/automation-defaults/vitest.config.mts'
}
const originals = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(path.join(root, file), 'utf8')])))
function replace(key, from, to) { assert.equal(originals[key].split(from).length, 2, 'Unique production anchor: ' + from); return originals[key].replace(from, to) }
const control = 'apps/desktop/test/automation-defaults-control.test.ts', ui = 'apps/desktop/test/automation-defaults.test.tsx'
const product = 'apps/desktop/test/continuous-progress-product.test.tsx', calendar = 'apps/desktop/test/calendar-schedule-control.test.tsx'
const mutants = [
  { id: 'scalar-registration', file: files.catalog, text: replace('catalog', '  ...automationSettings,', ''), suite: control, test: 'discovers eight effective automation scalars without authoring absent defaults' },
  { id: 'authored-first-write', file: files.authored, text: replace('authored', " || path === 'automation'", ''), suite: control, test: 'merges concurrent first authored defaults and retains conflicting drafts and unrelated policy' },
  { id: 'policy-validation', file: files.schema, text: replace('schema', "try { validateAutomationPreferences(value as AppConfig['automation']) }", 'try { void value }'), suite: control, test: 'strict validation reuses the actual calendar and quiet policy while keeping original config' },
  { id: 'editor-value', file: files.pane, text: replace('pane', "progressIntervalMs: duration('progressIntervalMs')", 'progressIntervalMs: 1_800_000'), suite: ui, test: 'the registered Automation editor saves only authored defaults and keeps continuation and tasks intact' },
  { id: 'periodic-consumer', file: files.progress, text: replace('progress', 'api.continuousProgress.create(target, Number(interval) * 60_000, prompt,', 'api.continuousProgress.create(target, 1_800_000, prompt,'), suite: product, test: 'saved defaults reach both original Composer creation routes and durable tasks without automatic input' },
  { id: 'timezone-consumer', file: files.calendar, text: replace('calendar', 'const calendar = parseAgentScheduleCalendar({ kind, timezone, time,', "const calendar = parseAgentScheduleCalendar({ kind, timezone: 'UTC', time,"), suite: product, test: 'saved defaults reach both original Composer creation routes and durable tasks without automatic input' },
  { id: 'quiet-consumer', file: files.calendar, text: replace('calendar', 'automationCheckInPolicy(occurrence.current.defaults)', 'automationCheckInPolicy(resolveAutomationPreferences())'), suite: calendar, test: 'freezes saved timezone and quiet defaults for a new original creation while preserving explicit message and pending operation' },
  { id: 'expected-baseline', file: files.module, text: replace('module', '...current.automation, ...expected', '...current.automation, ...value'), suite: ui, test: 'the registered Automation editor saves only authored defaults and keeps continuation and tasks intact' }
]
await fs.writeFile(path.join(output, 'mutations.json'), JSON.stringify({ root, mutants }, null, 2))
const config = path.join(output, 'vitest.config.mts')
await fs.writeFile(config, `
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import base from ${JSON.stringify(path.join(root, 'apps/desktop/scripts/fixtures/automation-defaults/vitest.config.mts'))}
const plan=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(output, 'mutations.json'))},'utf8'))
const mutant=plan.mutants.find(m=>m.id===process.env.AUTOMATION_MUTANT),capture={loaded:{},compiled:{},consumed:0}
const sha=text=>createHash('sha256').update(text).digest('hex')
const publish=()=>fs.writeFileSync(process.env.AUTOMATION_CAPTURE!,JSON.stringify(capture))
export default {...base,test:{...base.test,...(mutant?{include:[mutant.suite]}:{})},plugins:[{
 name:'automation-owning-source',enforce:'pre',load(id){const file=path.relative(plan.root,id.split('?')[0]);if(!plan.mutants.some(m=>m.file===file))return
 const original=fs.readFileSync(path.join(plan.root,file),'utf8'),text=mutant?.file===file?mutant.text:original
 capture.loaded[file]={original:sha(original),loaded:sha(text)};if(mutant?.file===file)capture.consumed++;publish();return text
}},{name:'automation-owning-compiled',enforce:'post',transform(code,id){const file=path.relative(plan.root,id.split('?')[0]);if(!plan.mutants.some(m=>m.file===file))return;capture.compiled[file]=sha(code);publish()}}]}
`)
const runs = []
async function run(mutant) {
  const id = mutant?.id ?? 'positive', report = path.join(output, id + '.tests.json'), capturePath = path.join(output, id + '.capture.json'), chunks = []
  const argv = [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile.json=' + report,
    ...(mutant ? ['--testNamePattern', mutant.test] : [])]
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, AUTOMATION_MUTANT: mutant?.id ?? '', AUTOMATION_CAPTURE: capturePath }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk)); child.on('error', reject); child.on('close', resolve)
  })
  const log = Buffer.concat(chunks).toString(); await fs.writeFile(path.join(output, id + '.log'), log)
  const result = JSON.parse(await fs.readFile(report, 'utf8')), capture = JSON.parse(await fs.readFile(capturePath, 'utf8'))
  assert.ok(result.testResults.length > 0 && result.numTotalTests > 0, 'Nonempty real tests')
  for (const suite of result.testResults) { assert.ok(suite.assertionResults.length > 0); assert.equal(suite.message, '', 'No setup failure may qualify') }
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  if (!mutant) { assert.equal(code, 0, log); assert.equal(result.numFailedTests, 0); assert.ok(result.numPassedTests >= 10) }
  else {
    assert.equal(code, 1, log); assert.ok(capture.consumed > 0 && capture.compiled[mutant.file], 'Original owning source was loaded and compiled')
    assert.equal(capture.loaded[mutant.file].loaded, sha(mutant.text)); assert.notEqual(capture.loaded[mutant.file].loaded, capture.loaded[mutant.file].original)
    const suite = result.testResults.find(suite => path.relative(root, suite.name) === mutant.suite)
    const failure = suite?.assertionResults.find(test => test.title === mutant.test)
    assert.equal(failure?.status, 'failed', 'Owning business assertion must turn red: ' + mutant.test)
    assert.ok(failure.failureMessages.some(message => /AssertionError|expected .* to |__VITEST_(?:REJECTS|RESOLVES)__/su.test(message)), 'Semantic assertion, not process/setup red')
  }
  runs.push({ id, code, passed: result.numPassedTests, failed: result.numFailedTests, semanticRed: !!mutant, report: path.relative(root, report), capture: path.relative(root, capturePath) })
  process.stdout.write(JSON.stringify(runs.at(-1)) + '\n')
}
await run()
for (const mutant of mutants) await run(mutant)
const sourceIdentity = Object.fromEntries(Object.entries(files).map(([key, file]) => [file, sha(originals[key])]))
for (const [file, identity] of Object.entries(sourceIdentity)) assert.equal(sha(await fs.readFile(path.join(root, file))), identity, 'Candidate source drift: ' + file)
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ passed: true, boundary: 'Source product owners and private Electron/native seams; not installed Desktop or PTY acceptance', sourceIdentity, runs }, null, 2))
console.log(JSON.stringify({ passed: true, output, mutations: mutants.length }))
