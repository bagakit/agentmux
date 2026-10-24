import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const renderer = 'apps/desktop/src/renderer/src/components/'
const main = 'apps/desktop/src/main/'
const directory = path.join(root, '.tmp/settings-modules-proof', ("run-" + (globalThis.crypto.randomUUID()) + "-" + (randomUUID()) + ""))
await fs.mkdir(directory, { recursive: true })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const runs = []
const inputs = new Map()

async function bind(relative) {
  const filename = path.join(root, relative)
  const bytes = await fs.readFile(filename), stat = await fs.stat(filename)
  const record = { sha256: digest(bytes), bytes: bytes.length, mode: stat.mode & 0o777 }
  if (inputs.has(relative)) assert.deepEqual(record, inputs.get(relative), `Proof input changed: ${relative}`)
  else {
    inputs.set(relative, record)
    const destination = path.join(directory, 'source', relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, bytes)
    await fs.chmod(destination, record.mode)
  }
  return bytes.toString('utf8')
}

const owners = {
  registration: renderer + 'settings/settings-modules.ts',
  pane: renderer + 'SettingsPanel.tsx',
  summary: renderer + 'settings/modules/general.tsx',
  main: main + 'settings/setting-catalog.ts'
}
const source = Object.fromEntries(await Promise.all(Object.entries(owners).map(async ([key, file]) => [key, await bind(file)])))
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, `Exactly one nonempty mutation anchor: ${before}`)
  return text.replace(before, after)
}
const mutants = [
  { id: 'registration', file: owners.registration,
    expectedFailure: { file: 'apps/desktop/test/settings-modules.test.tsx', fullName: 'keeps the contributed draft, component identity and reading position while its summary follows only saved configuration' },
    source: replaceOnce(source.registration, '  generalSettingsModule,\n', ''),
    proves: 'Removing the real General contribution disconnects its original Overview DOM consumer; the separate contributed-module test still covers generic navigation.' },
  { id: 'pane', file: owners.pane,
    expectedFailure: { file: 'apps/desktop/test/settings-modules.test.tsx', fullName: 'a contributed module reaches Overview, sidebar, compact menu, search and its actual Pane through the generic shell' },
    source: replaceOnce(source.pane, 'const Pane = settingsModules.find((module) => module.id === pane)!.Pane', 'const Pane = () => null'),
    proves: 'A generic editor wired to an empty component cannot deliver real controls.' },
  { id: 'summary', file: owners.summary,
    expectedFailure: { file: 'apps/desktop/test/settings-modules.test.tsx', fullName: 'keeps the contributed draft, component identity and reading position while its summary follows only saved configuration' },
    source: replaceOnce(source.summary, "config.copyPathsAsAbsolute === true ? 'Absolute paths' : 'Home paths (~)'", "'Wrong saved summary'"),
    proves: 'Published summaries are actually read from their feature contribution.' },
  { id: 'expected', file: owners.summary,
    expectedFailure: { file: 'apps/desktop/test/settings-structure.test.tsx', fullName: 'General saves only copied paths through the existing config owner with its captured expected value' },
    source: replaceOnce(source.summary, 'copyPathsAsAbsolute: expected.copyPathsAsAbsolute', 'copyPathsAsAbsolute: value.copyPathsAsAbsolute'),
    proves: 'The moved General adapter preserves the authored baseline instead of its new value.' },
  { id: 'main-fields', file: owners.main,
    expectedFailure: { file: 'apps/desktop/test/settings-modules-control.test.ts', fullName: 'composes every durable scalar once, groups the public list and keeps the original target contract' },
    source: replaceOnce(source.main, '  ...generalSettings,\n', ''),
    proves: 'Main registration supplies real scalar get/set and the durable owner.' }
]

// Capture the complete affected modules and their existing owner/draft/CLI consumers.
for (const subdirectory of [renderer + 'settings/modules', main + 'settings/modules']) {
  for (const entry of await fs.readdir(path.join(root, subdirectory))) await bind(`${subdirectory}/${entry}`)
}
for (const relative of [
  renderer + 'settings/settings-catalog.ts', renderer + 'settings/SettingsOverviewPane.tsx',
  renderer + 'settings/use-setting-draft.ts', renderer + 'settings/use-resource-drafts.ts',
  renderer + 'settings/SettingsSaveBar.tsx', renderer + 'SettingsNavigation.tsx',
  'apps/desktop/src/renderer/src/App.tsx', main + 'settings/scalar-setting.ts', main + 'settings-control.ts',
  main + 'config-owner.ts', main + 'config-store.ts', 'apps/desktop/src/shared/config-edit.ts',
  'apps/desktop/src/shared/focus-map-preferences.ts', 'apps/desktop/src/shared/focus-preferences.ts',
  'apps/desktop/test/helpers/settings-schema-keys.ts',
  'apps/desktop/src/shared/contracts.ts', 'packages/core/src/settings-cli.ts',
  'apps/desktop/scripts/fixtures/settings-modules/vitest.config.mts',
  'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
  'apps/desktop/scripts/verify-settings-modules.mjs', 'vitest.setup.ts'
]) await bind(relative)
for (const name of ['modules', 'overview', 'structure', 'workbench', 'draft-conflict', 'search', 'modules-control', 'control', 'preferences-control']) {
  await bind(`apps/desktop/test/settings-${name}.test.${['modules', 'overview', 'structure', 'workbench', 'draft-conflict'].includes(name) ? 'tsx' : 'ts'}`)
}

const callers = []
for (const [symbol, definitions] of [
  ['createSettingsCatalog', [renderer + 'settings/settings-catalog.ts']],
  ['settingsModules', [owners.registration]],
  ['savedSummary', [...inputs.keys()].filter(file => file.startsWith(renderer + 'settings/modules/'))],
  ['scalarSettings', [owners.main]]
]) {
  const found = execFileSync('rg', ['-n', '-w', symbol, 'apps/desktop/src', '-g', '*.ts', '-g', '*.tsx'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(line => !definitions.some(file => line.startsWith(file + ':')))
  assert.ok(found.length > 0, `No definition-excluded product caller for ${symbol}`)
  callers.push({ symbol, excludedDefinitions: definitions, found })
}
assert.match(source.pane, /<Pane\s+config=\{config\}/, 'Actual generic editor product caller')
const paneHits = execFileSync('rg', ['-n', '<Pane\\s', owners.pane], { cwd: root, encoding: 'utf8' }).trim().split('\n')
assert.ok(paneHits.length > 0, 'Nonempty actual generic editor caller')
callers.push({ symbol: 'Pane', excludedDefinitions: 'settings/modules/*', found: paneHits })
const scalarAliasCalls = execFileSync('rg', ['-n', 'settings\\.(filter|find)\\(', main + 'settings-control.ts'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
assert.ok(scalarAliasCalls.length >= 2, 'The imported scalar alias is actually consumed by get/set')
callers.push({ symbol: 'settings (current scalarSettings snapshot)', excludedDefinitions: owners.main, found: scalarAliasCalls })
await fs.writeFile(path.join(directory, 'callers.json'), JSON.stringify(callers, null, 2) + '\n')

const monitored = [...inputs.keys()].filter(file => file.startsWith('apps/desktop/src/'))
await fs.writeFile(path.join(directory, 'mutations.json'), JSON.stringify({ root, monitored, mutants }, null, 2) + '\n')
const configFile = path.join(directory, 'vitest.config.mts')
// These plugins observe actual Vite loading and transpilation. Mutants never write product files.
await fs.writeFile(configFile, `
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import base from ${JSON.stringify(path.join(root, 'apps/desktop/scripts/fixtures/settings-modules/vitest.config.mts'))}
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(directory, 'mutations.json'))}, 'utf8'))
const mutant = plan.mutants.find(item => item.id === process.env.SETTINGS_MODULES_MUTANT)
const sha = text => createHash('sha256').update(text).digest('hex')
const capture = { consumed: 0, loaded: {}, compiled: {} }
const publish = () => fs.writeFileSync(process.env.SETTINGS_MODULES_CAPTURE!, JSON.stringify(capture, null, 2))
const relative = id => path.relative(plan.root, id.split('?')[0])
const compiledDirectory = path.join(path.dirname(process.env.SETTINGS_MODULES_CAPTURE!), 'compiled')
fs.mkdirSync(compiledDirectory, { recursive: true })
export default {
  ...base,
  // A single worker keeps the same original tests while avoiding the forks
  // pool's additional on-disk copy of every transformed application module.
  test: { ...base.test, pool: 'threads' },
  plugins: [
    { name: 'settings-modules-actual-source', enforce: 'pre', load(id) {
      const file = relative(id)
      if (!plan.monitored.includes(file)) return
      const original = fs.readFileSync(path.join(plan.root, file), 'utf8')
      const text = mutant?.file === file ? mutant.source : original
      capture.loaded[file] = { original: sha(original), loaded: sha(text) }
      if (mutant?.file === file) capture.consumed += 1
      publish()
      return text
    } },
    { name: 'settings-modules-actual-compiled', enforce: 'post', transform(code, id, options) {
      const file = relative(id)
      if (!plan.monitored.includes(file)) return
      // The same owner can be compiled by both happy-dom/client and node/SSR.
      // Record every real context and output, rather than letting whichever
      // transform finishes last replace the other environment's evidence.
      const context = { environment: this.environment?.name ?? null,
        consumer: this.environment?.config.consumer ?? null, ssr: options?.ssr ?? null }
      const contexts = capture.compiled[file] ??= {}
      const observed = contexts[JSON.stringify(context)] ??= { context, ids: [], hashes: [] }
      const hash = sha(code), fullId = path.relative(plan.root, id)
      if (!observed.ids.includes(fullId)) observed.ids.push(fullId)
      if (!observed.hashes.includes(hash)) observed.hashes.push(hash)
      observed.ids.sort(); observed.hashes.sort()
      // Keep exact bytes for a future mismatch; no broad normalization of
      // compiled code and no per-module exclusions qualify strict restoration.
      const filename = path.join(compiledDirectory, hash + '.js')
      if (!fs.existsSync(filename)) fs.writeFileSync(filename, code)
      publish()
    } }
  ]
}
`)

let control
async function run(id, mutant = '') {
  for (const file of inputs.keys()) await bind(file)
  const logFile = path.join(directory, id + '.log')
  const jsonFile = path.join(directory, id + '.tests.json')
  const captureFile = path.join(directory, id + '.capture.json')
  const output = []
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', configFile, '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile.json=' + jsonFile], {
      cwd: root, env: { ...process.env, SETTINGS_MODULES_MUTANT: mutant, SETTINGS_MODULES_CAPTURE: captureFile }, stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => output.push(chunk))
    child.on('error', reject)
    child.on('close', resolve)
  })
  await fs.writeFile(logFile, Buffer.concat(output))
  const report = JSON.parse(await fs.readFile(jsonFile, 'utf8'))
  const capture = JSON.parse(await fs.readFile(captureFile, 'utf8'))
  assert.equal(report.testResults.length, 9, 'All nine declared suites actually ran')
  assert.ok(report.numTotalTests > 0, 'Nonempty actual behavior tests')
  for (const suite of report.testResults) {
    assert.ok(suite.assertionResults.length > 0, `Suite did not execute behavior: ${suite.name}`)
    assert.equal(suite.message, '', `Suite setup/runtime error: ${suite.name}`)
  }
  if ('numRuntimeErrorTestSuites' in report) assert.equal(report.numRuntimeErrorTestSuites, 0)
  assert.doesNotMatch(Buffer.concat(output).toString(), /Unhandled Errors|Unhandled Rejection|Uncaught Exception/, 'Framework unhandled errors cannot qualify a mutation')
  assert.ok(Object.keys(capture.compiled).length > 10, 'Nonempty actual production compilation')
  for (const [file, contexts] of Object.entries(capture.compiled)) {
    assert.ok(Object.keys(contexts).length > 0, `${id}: no actual compilation context for ${file}`)
    for (const [key, observed] of Object.entries(contexts)) {
      assert.equal(key, JSON.stringify(observed.context), `${id}: compilation context identity changed for ${file}`)
      assert.ok(observed.ids.length > 0 && observed.hashes.length > 0, `${id}: empty compilation evidence for ${file}`)
      for (const hash of observed.hashes) assert.equal(digest(await fs.readFile(path.join(directory, 'compiled', hash + '.js'))), hash, `${id}: compiled diagnostic bytes changed for ${file}`)
    }
  }
  if (mutant) {
    assert.notEqual(exitCode, 0, `${id}: mutation was white-green`)
    assert.ok(capture.consumed > 0, `${id}: owning Source was not actually loaded`)
    const owner = mutants.find(item => item.id === mutant)
    assert.equal(capture.loaded[owner.file].loaded, digest(owner.source))
    assert.notEqual(capture.loaded[owner.file].original, capture.loaded[owner.file].loaded)
    const suite = report.testResults.find(suite => path.relative(root, suite.name) === owner.expectedFailure.file)
    assert.ok(suite, `${id}: required owning test suite did not execute`)
    const target = suite.assertionResults.find(test => test.fullName === owner.expectedFailure.fullName)
    assert.ok(target, `${id}: required owning behavior assertion was not collected`)
    assert.equal(target.status, 'failed', `${id}: the corresponding behavior did not turn RED`)
    assert.ok(target.failureMessages.some(message => message.includes('AssertionError')), `${id}: expected behavior failed only through setup/runtime, not its assertion`)

  } else {
    assert.equal(exitCode, 0, `${id}: restored behavior did not pass; read ${logFile}`)
    assert.equal(report.numFailedTests, 0)
    assert.equal(capture.consumed, 0)
    if (!control) control = capture
    else assert.deepEqual(capture, control, `${id}: original loaded and compiled modules were not precisely restored`)
  }
  runs.push({ id, exitCode, tests: report.numTotalTests, failed: report.numFailedTests,
    consumed: capture.consumed, log: path.relative(root, logFile), capture: path.relative(root, captureFile) })
  console.log(`${id}: ${mutant ? 'AssertionRED' : 'GREEN'}; ${report.numTotalTests} tests, ${capture.consumed} owning loads`)
}

try {
  await run('control')
  for (const mutant of mutants) {
    await run(mutant.id + '-red', mutant.id)
  }
  // Variants are served strings in independent processes and never write the
  // original files. Each run still binds all source bytes and runs all nine
  // suites; one final complete restore also compares every compiled module.
  await run('all-restored')
  for (const file of inputs.keys()) await bind(file)
  const receipt = { schema: 'settings-modules-proof.v1', source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    inputs: Object.fromEntries(inputs), callers, runs, mutants: mutants.map(({ source, ...metadata }) => metadata),
    compiledCode: path.relative(root, path.join(directory, 'compiled')),
    boundary: 'Actual Source/Vite compiled mounted UI and durable ConfigOwner fixtures; exact distinct outputs per observed environment/SSR context, with original compiled bytes; no user App, Native or installation.' }
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log('Settings module proof:', path.relative(root, directory))
} catch (error) {
  await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ message: String(error), stack: error.stack, runs }, null, 2) + '\n')
  throw error
}
