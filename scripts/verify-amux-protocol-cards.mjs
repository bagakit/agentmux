import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scope = process.argv[process.argv.indexOf('--scope') + 1]
const selections = { reader: ['drop-generic', 'allow-invalid-known', 'lose-opaque-body'],
  cards: ['ignore-body-boundary', 'skip-resource-reader', 'skip-special-card', 'lose-question-resource-boundary'],
  settings: ['unregister-settings', 'omit-search-target', 'eager-preview'] }
const folder = '.tmp/amux-protocol-cards'
const sha = value => createHash('sha256').update(value).digest('hex')
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const write = (path, value) => writeFileSync(resolve(root, path), JSON.stringify(value, null, 2) + '\n')

function current(inputs) {
  for (const [file, digest] of Object.entries(inputs)) assert(sha(readFileSync(resolve(root, file))) === digest, `Input changed: ${file}`)
}

if (scope === 'join') {
  const receipts = Object.keys(selections).map(key => read(read(`${folder}/${key}.json`).receipt))
  for (const receipt of receipts) { assert(receipt.sourcePassed, 'Missing source qualification'); current(receipt.inputs) }
  // Actual screenshots and independent visual review are deliberately not inferred from source tests.
  const visual = read('docs/reviews/amux-protocol-cards/visual-review.json')
  assert(visual.approved === true && visual.screenshots?.length > 0, 'Independent visual review is incomplete')
  assert(Object.keys(visual.inputs ?? {}).length > 0, 'Visual review has no bound source inputs')
  current(visual.inputs)
  console.log(JSON.stringify({ sourcePassed: true, visualApproved: true, buildPerformed: false }))
} else {
  assert(Object.hasOwn(selections, scope), 'Use --scope reader, cards, settings or join')
  assert(selections[scope].length > 0, 'This source slice has no implemented mutation qualification')
  mkdirSync(resolve(root, folder), { recursive: true })
  const directory = relative(root, mkdtempSync(resolve(root, `${folder}/${scope}-`)))
  const inputs = {}
  for (const file of ['scripts/verify-amux-protocol-cards.mjs', 'test/vitest.amux-protocol-cards.config.mts',
    'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts', 'packages/core/src/amux-protocol-definition.ts',
    'vitest.setup.ts', 'packages/core/package.json', 'packages/client-ui/package.json',
    'packages/client-ui/src/styles/conversation-protocol.css', 'packages/client-ui/src/styles/conversation-message.css']) inputs[file] = sha(readFileSync(resolve(root, file)))
  if (scope === 'settings') inputs['apps/desktop/src/renderer/src/styles/settings-amux-protocols.css'] = sha(readFileSync(resolve(root, 'apps/desktop/src/renderer/src/styles/settings-amux-protocols.css')))

  function run(label, mutation) {
    const report = `${directory}/${label}.json`, loaded = `${directory}/${label}.loaded.jsonl`
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'test/vitest.amux-protocol-cards.config.mts',
      '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`], {
      cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AMUX_PROTOCOL_SCOPE: scope, AMUX_PROTOCOL_MUTATION: mutation ?? '', AMUX_PROTOCOL_LOADED: resolve(root, loaded) }
    })
    writeFileSync(resolve(root, `${directory}/${label}.log`), (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''))
    const summary = read(report)
    assert(summary.testResults.length > 0 && summary.testResults.every(file => file.assertionResults.length > 0), 'Empty test file inventory')
    const facts = readFileSync(resolve(root, loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert(facts.length > 0, 'No actual source was loaded')
    for (const fact of facts) {
      assert(!(fact.file.includes('/dist/')), `Source proof loaded dist: ${fact.file}`)
      assert(inputs[fact.file] === undefined || inputs[fact.file] === fact.sourceSHA256, `Source drifted: ${fact.file}`)
      inputs[fact.file] = fact.sourceSHA256
    }
    const transformed = facts.filter(fact => fact.sourceSHA256 !== fact.compilerInputSHA256)
    if (mutation) {
      const failed = summary.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
      assert(result.status !== 0 && summary.numFailedTests > 0 && transformed.length > 0 && failed.length > 0 &&
        failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), `Mutation lacks actual assertion RED: ${mutation}`)
    }
    else assert(result.status === 0 && summary.numFailedTests === 0 && summary.numTotalTests > 0, 'Source consumer verification failed')
    return { report, loaded, tests: summary.numTotalTests, failed: summary.numFailedTests, transformed }
  }

  const baseline = run('baseline')
  const mutations = selections[scope].map(name => ({ name, red: run(name, name) }))
  const restored = run('restored')
  current(inputs)
  const receipt = `${directory}/receipt.json`
  write(receipt, { schema: 'agentmux.amux-protocol-source-proof.v1', scope, sourcePassed: true, buildPerformed: false,
    nodeVersion: process.version, visualQualified: false, inputs, baseline, mutations, restored })
  write(`${folder}/${scope}.json`, { receipt })
  console.log(JSON.stringify({ scope, sourcePassed: true, tests: baseline.tests, mutations: mutations.length, receipt, visualQualified: false }))
}
