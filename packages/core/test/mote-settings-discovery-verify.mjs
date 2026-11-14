import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { moteDiscoveryVariants } from './mote-settings-discovery-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/mote-settings-robustness')
const config = 'packages/core/test/mote-settings-discovery.config.mts'
const patterns = {
  'collapse-source-failure': 'catalog discovery failure retains',
  'lose-independent-executors': 'catalog discovery failure retains',
  'lose-independent-locations': 'Executor discovery failure retains',
  'save-full-discovery': 'both failed discovery sources cannot prevent',
  'skip-required-executor': 'a changed Executor still requires',
  'skip-required-main': 'a changed Main still requires',
  'ignore-file-conflict': 'an external file CAS conflict still refuses',
  'null-means-empty': 'a null catalog is scoped unknown',
  'accept-foreign-issue': 'public read codec rejects an unknown discovery issue',
  'accept-empty-issue': 'public read codec rejects empty or whitespace-only',
  'source-only-forges-choices': 'source-only public SDK and real CLI reads',
  'ignore-requested-projection': 'codec rejects source and candidate projections',
  'ignore-single-source-projection': 'codec preserves exact single-source null projections'
}
const sha = text => createHash('sha256').update(text).digest('hex')
async function sources() { return Object.fromEntries(await Promise.all([...new Set(Object.values(moteDiscoveryVariants).map(value => value.file))].map(async file => [file, sha(await readFile(resolve(root, file)))]))) }
async function run(name, mutation, pattern) {
  const before = await sources(), report = resolve(evidence, `owner-${name}-vitest.json`), loaded = resolve(evidence, `owner-${name}-loaded.jsonl`)
  const facts = resolve(evidence, `owner-${name}-facts.jsonl`), cliLoaded = resolve(evidence, `owner-${name}-cli-loaded.jsonl`)
  await Promise.all([loaded, facts, cliLoaded].map(path => writeFile(path, '')))
  const args = ['exec', 'vitest', 'run', '--config', config, '--reporter=json', '--outputFile=' + report, ...(pattern ? ['--testNamePattern', pattern] : [])]
  const env = { ...process.env, MOTE_DISCOVERY_LOADED: loaded, MOTE_SETTINGS_FACTS: facts, MOTE_SETTINGS_CLI_LOADED: cliLoaded }
  delete env.MOTE_DISCOVERY_MUTATION
  if (mutation) env.MOTE_DISCOVERY_MUTATION = mutation
  const result = await new Promise((accept, reject) => {
    const child = spawn('pnpm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', code => accept({ code, output }))
  })
  await writeFile(resolve(evidence, `owner-${name}.log`), result.output)
  let summary
  try { summary = JSON.parse(await readFile(report, 'utf8')) } catch { throw new Error('No completed evaluated test report: ' + name + '\n' + result.output.slice(-1800)) }
  const trace = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const changed = trace.filter(value => value.sourceSHA256 !== value.loadedSHA256)
  const failures = summary.testResults.flatMap(file => file.assertionResults.filter(value => value.status === 'failed').map(value => ({ name: value.fullName, messages: value.failureMessages })))
  const after = await sources()
  const verificationInputs = Object.fromEntries(await Promise.all(['mote-settings-discovery.test.ts', 'mote-settings-discovery.config.mts', 'mote-settings-discovery-mutations.mjs', 'mote-settings-discovery-verify.mjs'].map(async name => [name, sha(await readFile(resolve(root, 'packages/core/test', name)))])))
  const receipt = { name, mutation: mutation ?? null, command: ['pnpm', ...args], code: result.code, total: summary.numTotalTests,
    passed: summary.numPassedTests, failed: summary.numFailedTests, failures, before, after, evaluatedChanges: changed,
    candidateStable: JSON.stringify(before) === JSON.stringify(after), verificationInputs, report, loaded }
  await writeFile(resolve(evidence, `owner-${name}-receipt.json`), JSON.stringify(receipt, null, 2) + '\n')
  if (!receipt.candidateStable) throw new Error('Owner source changed during this proof: ' + name)
  if (mutation) {
    if (!changed.some(value => value.path === moteDiscoveryVariants[mutation].file && value.mutation === mutation) || result.code === 0 || summary.numFailedTests !== 1 || failures.length !== 1 || !failures[0].name.includes(pattern)) throw new Error('The selected source mutant did not fail its original consumer: ' + name)
    if (failures.some(value => value.messages.some(message => /One exact current discovery mutation anchor|SyntaxError|Failed to load url|Cannot find module|No test suite found|Missing code-owned guide fact|Cannot read properties of null|Test timed out|Hook timed out/u.test(message)))) throw new Error('Non-business failure cannot qualify a source mutant: ' + name)
  } else if (result.code !== 0 || summary.numPassedTests !== 16 || summary.numFailedTests !== 0) throw new Error('Owner baseline must pass all 16 actual consumers: ' + name)
  process.stdout.write(JSON.stringify({ name, code: receipt.code, passed: receipt.passed, failed: receipt.failed, candidateStable: receipt.candidateStable }) + '\n')
  return receipt
}

await mkdir(evidence, { recursive: true })
const mode = process.argv[2]
if (!['baseline', 'mutations', 'projections', 'restored'].includes(mode)) throw new Error('Use baseline, mutations, projections or restored')
if (mode === 'mutations' || mode === 'projections') {
  const receipts = []
  for (const [mutation, pattern] of Object.entries(patterns)) {
    if (mode === 'projections' && !['source-only-forges-choices', 'ignore-requested-projection', 'ignore-single-source-projection'].includes(mutation)) continue
    receipts.push(await run('mutant-' + mutation, mutation, pattern))
  }
  await writeFile(resolve(evidence, 'owner-' + mode + '-summary.json'), JSON.stringify({ valid: true, count: receipts.length, receipts }, null, 2) + '\n')
} else await run(mode, undefined, undefined)
