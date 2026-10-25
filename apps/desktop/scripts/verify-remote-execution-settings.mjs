import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '../../..')
const task = resolve(root, '.bagakit/feature-tracker/remote-execution-settings')
export const mutations = ['navigation', 'wrong-project', 'hidden-reader', 'foreign-binding', 'late-refresh', 'null-erase',
  'narrow-detail', 'hidden-selection', 'project-search', 'prepare-identity', 'refresh-order', 'rejoin-owner']
const mutationTests = Object.fromEntries([
  ...['narrow-detail', 'hidden-selection', 'project-search', 'prepare-identity'].map(id => [id, 'apps/desktop/test/remote-execution-settings-navigation.test.tsx']),
  ...['refresh-order', 'rejoin-owner'].map(id => [id, 'apps/desktop/test/tool-execution-recovery.test.tsx'])
])
export const productFiles = [
  'apps/desktop/src/renderer/src/components/settings/RemoteExecutionSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/RemoteExecutionGuide.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/remote-execution.tsx',
  'apps/desktop/src/renderer/src/components/settings/settings-modules.ts',
  'apps/desktop/src/renderer/src/components/settings/settings-catalog.ts',
  'apps/desktop/src/renderer/src/components/settings/SettingsResourceLibrary.tsx',
  'apps/desktop/src/renderer/src/components/AgentToolExecutionNotice.tsx',
  'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
  'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/styles/remote-execution-settings.css',
  'apps/desktop/src/renderer/src/assets/settings/remote-execution.png'
]
// Presentation bytes bind independent visual approval; only executable component sources bind the component checks.
export const componentFiles = productFiles.filter(path => /\.tsx?$/u.test(path))
const verificationFiles = ['apps/desktop/test/vitest.remote-execution-settings.config.mts', 'apps/desktop/scripts/verify-remote-execution-settings.mjs']
export const sha = value => createHash('sha256').update(value).digest('hex')
export function sourceObservation(path, source, loaded) {
  // Vite's convert-source-map loader blanks map comments before the pre-transform hook.
  const mapComment = /(?:\/\/[@#][ \t]+?sourceMappingURL=([^\s'"`]+?)[ \t]*?$)|(?:\/\*[@#][ \t]+sourceMappingURL=([^*]+?)[ \t]*?(?:\*\/){1}[ \t]*?$)/gm
  const normalized = source.replace(mapComment, match => ' '.repeat(match.length))
  assert(loaded === source || loaded === normalized, 'Unaccounted loaded source differs from original repository bytes: ' + path)
  return { path, sha256: sha(source), loadedSHA256: sha(loaded), normalization: loaded === source ? 'none' : 'source-map-comment-blanking' }
}
export async function hashes(paths, directory = root) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(resolve(directory, path)))])))
}
export function parseArgs(argv) {
  const options = { checksOnly: false, plan: false }, seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    assert(['--output', '--visual-review', '--checks-report', '--checks-only', '--plan'].includes(flag) && !seen.has(flag), `Unknown or repeated flag: ${flag}`)
    seen.add(flag)
    if (flag === '--checks-only') options.checksOnly = true
    else if (flag === '--plan') options.plan = true
    else { const value = argv[++i]; assert(value && !value.startsWith('--'), `${flag} requires a path`); options[flag === '--output' ? 'output' : flag === '--checks-report' ? 'checksReport' : 'visualReview'] = resolve(value) }
  }
  assert(!(options.checksOnly && options.visualReview), 'checks-only cannot claim visual approval')
  if (!options.checksOnly) options.visualReview ??= resolve(task, 'visual-review.json')
  return options
}
async function reference(path) { return { path, sha256: sha(await readFile(path)) } }
async function original(ref) {
  assert(ref && typeof ref.path === 'string' && isAbsolute(ref.path), 'Original evidence path required')
  const bytes = await readFile(ref.path)
  assert.equal(sha(bytes), ref.sha256, 'Original evidence changed: ' + ref.path)
  return bytes
}
/** The original loader observations are the dependency boundary, not a manually maintained UI entry list. */
export function dependencyManifest(consumed, verificationHashes) {
  const entries = [...Object.entries(verificationHashes).map(([path, sha256]) => ({ path, sha256 })), ...consumed]
  const manifest = {}
  for (const entry of entries) {
    assert(typeof entry.path === 'string' && !isAbsolute(entry.path) && !entry.path.split('/').some(part => part === '..' || part === 'node_modules'), 'Exact repository dependency path required')
    // CSS and images have their own independent visual source contract.
    if (!/\.(?:[cm]?[jt]sx?|json)$/u.test(entry.path)) continue
    assert.match(entry.sha256 ?? '', /^[0-9a-f]{64}$/u)
    assert(manifest[entry.path] === undefined || manifest[entry.path] === entry.sha256, `Dependency changed while consumed: ${entry.path}`)
    manifest[entry.path] = entry.sha256
  }
  assert(Object.keys(manifest).length > 0, 'Actual consumed dependencies required')
  return manifest
}
export async function dependencyChanges(expected, directory = root) {
  const changes = []
  for (const [path, digest] of Object.entries(expected)) {
    let current
    try { current = sha(await readFile(resolve(directory, path))) } catch (error) { if (error?.code !== 'ENOENT') throw error; current = null }
    if (current !== digest) changes.push(path)
  }
  return changes
}
export async function validateVisual(review, expected) {
  assert(review?.schema === 'agentmux.remote-execution-settings.visual.v1' && review.status === 'approved', 'An independent approved visual review is required')
  assert(typeof review.reviewer === 'string' && review.reviewer.trim(), 'Identify the actual independent reviewer')
  assert(review.sourceHashes && Object.keys(expected).length > 0, 'Source-bound review required')
  for (const [path, digest] of Object.entries(expected)) assert.equal(review.sourceHashes[path], digest, `Visual source differs: ${path}`)
  assert(Array.isArray(review.frames) && review.frames.length > 0, 'Actual reviewed frames are required')
  const seen = new Set()
  for (const frame of review.frames) {
    assert(typeof frame.path === 'string' && isAbsolute(frame.path) && !seen.has(frame.path), 'Each reviewed frame needs an exact unique absolute path')
    seen.add(frame.path)
    assert.match(frame.sha256 ?? '', /^[0-9a-f]{64}$/u)
    assert.equal(sha(await readFile(frame.path)), frame.sha256, `Reviewed frame changed: ${frame.path}`)
  }
}
export function validateTests(report, mutant = false) {
  assert(report.numTotalTests > 0 && report.testResults?.length > 0, 'A nonempty test set must actually execute')
  if (!mutant) assert(report.success === true && report.numPassedTests === report.numTotalTests && report.numFailedTests === 0, 'All baseline assertions must pass')
  else {
    assert(report.success === false && report.numFailedTests > 0, 'A mutant must fail real assertions')
    assert(report.testResults.some(file => file.assertionResults?.some(test => test.status === 'failed' && test.failureMessages?.some(message => /AssertionError/u.test(message)))), 'Infrastructure errors and timeouts do not kill a mutant')
  }
}
async function execute(output, mutant, verificationHashes) {
  await mkdir(output)
  const env = { ...process.env, AGENTMUX_REMOTE_SETTINGS_EVIDENCE: output }
  delete env.AGENTMUX_REMOTE_SETTINGS_MUTANT
  if (mutant) env.AGENTMUX_REMOTE_SETTINGS_MUTANT = mutant
  const args = ['run', '--config', 'apps/desktop/test/vitest.remote-execution-settings.config.mts',
    ...(mutant ? [mutationTests[mutant] ?? 'apps/desktop/test/remote-execution-settings.test.tsx'] : []), '--reporter=json', '--outputFile=' + resolve(output, 'tests.json')]
  const child = spawn(resolve(root, 'packages/core/node_modules/.bin/vitest'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })) })
  await writeFile(resolve(output, 'run.log'), log)
  await writeFile(resolve(output, 'execution.json'), JSON.stringify({ executable: child.spawnfile, args, pid: child.pid, ...exit }, null, 2))
  assert.equal(exit.signal, null, 'No signal termination may pass')
  assert(mutant ? Number.isInteger(exit.code) && exit.code !== 0 : exit.code === 0, 'Unexpected test process exit')
  const report = JSON.parse(await readFile(resolve(output, 'tests.json'), 'utf8'))
  validateTests(report, Boolean(mutant))
  let mutation
  if (mutant) {
    const lines = (await readFile(resolve(output, 'mutation.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert(lines.length > 0 && lines.every(line => line.mutant === mutant && line.original !== line.consumed), 'The declared mutation must reach actual production source')
    for (const line of lines) assert.equal(sha(await readFile(resolve(root, line.path))), line.original, 'Mutation must target the original source bytes')
    mutation = await reference(resolve(output, 'mutation.jsonl'))
  }
  const consumption = await reference(resolve(output, 'consumed.jsonl'))
  const dependencies = dependencyManifest((await original(consumption)).toString().trim().split('\n').map(line => JSON.parse(line)), verificationHashes)
  assert.deepEqual(await dependencyChanges(dependencies), [], 'Consumed dependencies changed during this check')
  return { id: mutant ?? 'baseline', passed: true, ...exit, tests: report.numTotalTests, consumption, dependencies, verificationHashes,
    report: await reference(resolve(output, 'tests.json')), execution: await reference(resolve(output, 'execution.json')),
    ...(mutation ? { mutation } : {}) }
}
async function validateCheck(check) {
  assert(check.dependencies && check.verificationHashes && check.consumption, 'Original check lacks its actual source dependency boundary; run fresh component checks')
  assert.deepEqual(Object.keys(check.verificationHashes).sort(), [...verificationFiles].sort(), 'The original verifier and test configuration are required')
  const consumed = (await original(check.consumption)).toString().trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(check.dependencies, dependencyManifest(consumed, check.verificationHashes), 'Dependency manifest must exactly reflect the original consumption')
  const mutant = check.id !== 'baseline', execution = JSON.parse((await original(check.execution)).toString())
  assert.equal(execution.signal, null)
  assert(mutant ? Number.isInteger(execution.code) && execution.code !== 0 : execution.code === 0, 'Original process outcome must match its check')
  validateTests(JSON.parse((await original(check.report)).toString()), mutant)
  if (mutant) {
    const lines = (await original(check.mutation)).toString().trim().split('\n').map(line => JSON.parse(line))
    assert(lines.length > 0 && lines.every(line => line.mutant === check.id && line.original !== line.consumed), 'Original mutant must hit real source')
    for (const line of lines) assert.equal(check.dependencies[line.path], line.original, 'Mutant source differs from its original consumed candidate')
  } else {
    for (const path of componentFiles) assert(consumed.some(item => item.path === path && item.sha256 === check.dependencies[path]), `Original baseline did not consume product source: ${path}`)
  }
}
export async function reusableChecks(prior, directory = root) {
  assert(prior.schema === 'agentmux.remote-execution-settings.gate.v1' && prior.componentChecksPassed === true, 'Original component gate must have completed')
  assert.deepEqual(prior.checks.map(check => check.id), ['baseline', ...mutations], 'All original checks are required')
  const decisions = []
  for (const check of prior.checks) {
    await validateCheck(check)
    const changed = await dependencyChanges(check.dependencies, directory)
    decisions.push({ check, changed, reusable: changed.length === 0 })
  }
  assert.deepEqual(prior.inputs, dependencyManifest(prior.checks.flatMap(check => Object.entries(check.dependencies).map(([path, sha256]) => ({ path, sha256 }))), {}), 'Original combined inputs must contain every consumed check dependency')
  return decisions
}
export async function validateRetained(prior, inputs, directory = root) {
  assert.deepEqual(prior.inputs, inputs, 'Original checks must consume this exact current source and verifier')
  for (const result of await reusableChecks(prior, directory)) assert.deepEqual(result.changed, [], `Consumed dependencies changed for ${result.check.id}`)
}
export async function run(options) {
  const output = options.output ?? resolve(root, '.tmp/remote-execution-settings', `gate-${Date.now()}-${process.pid}`)
  await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output)
  const sourceHashes = await hashes(productFiles), verificationHashes = await hashes(verificationFiles)
  const report = { schema: 'agentmux.remote-execution-settings.gate.v1', passed: false, componentChecksPassed: false,
    scope: 'Settings component consumption and original Launcher/reader contracts; controlled native API data is not remote execution qualification.',
    sourceHashes, inputs: {}, checks: [], visual: { status: 'pending' } }
  const save = () => writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  await save()
  try {
    const retained = options.checksReport ?? (!options.checksOnly && existsSync(resolve(task, 'checks-report.json')) ? resolve(task, 'checks-report.json') : undefined)
    let reuse = []
    if (retained) {
      const bytes = await readFile(retained), prior = JSON.parse(bytes.toString())
      reuse = await reusableChecks(prior)
      report.retained = { path: retained, sha256: sha(bytes) }
    }
    for (const id of ['baseline', ...mutations]) {
      const old = reuse.find(result => result.check.id === id)
      report.checks.push(old?.reusable ? { ...old.check, reusedFrom: report.retained }
        : { ...await execute(resolve(output, id), id === 'baseline' ? undefined : id, verificationHashes), ...(old ? { replacedBecause: old.changed } : {}) })
      await save()
    }
    report.inputs = dependencyManifest(report.checks.flatMap(check => Object.entries(check.dependencies).map(([path, sha256]) => ({ path, sha256 }))), {})
    report.consumption = report.checks[0].consumption
    assert.deepEqual(await dependencyChanges(report.inputs), [], 'Consumed dependencies changed during this gate')
    report.componentChecksPassed = true
    if (options.visualReview) {
      const bytes = await readFile(options.visualReview), review = JSON.parse(bytes.toString())
      await validateVisual(review, sourceHashes)
      assert.deepEqual(await hashes(productFiles), sourceHashes, 'Visual source changed during approval consumption')
      report.visual = { status: 'approved', path: options.visualReview, sha256: sha(bytes), reviewer: review.reviewer }
      report.passed = true
    }
    await save()
    if (options.checksOnly) { await mkdir(task, { recursive: true }); await writeFile(resolve(task, 'checks-report.json'), JSON.stringify(report, null, 2)) }
    return { passed: report.passed, componentChecksPassed: true, report: resolve(output, 'report.json') }
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); await save(); throw error }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (options.plan) console.log(JSON.stringify({ checks: ['baseline', ...mutations], visualSourceFiles: productFiles, sourceHashes: await hashes(productFiles), noChecksExecuted: true }, null, 2))
  else console.log(JSON.stringify(await run(options)))
}
