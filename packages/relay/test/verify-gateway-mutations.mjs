import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gatewayMutations } from './gateway-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), output = resolve(root, '.local/state/outbound-hub-access')
mkdirSync(output, { recursive: true })
const results = []
for (const [name, variant] of Object.entries(gatewayMutations)) {
  const loaded = resolve(output, `t1-${name}.loaded.jsonl`), report = resolve(output, `t1-${name}.report.json`)
  writeFileSync(loaded, '')
  const run = spawnSync(resolve(root, 'node_modules/.bin/vitest'), ['run', '--config', 'packages/relay/test/gateway-mutant.config.mts', '--reporter=json', '--outputFile', report], {
    cwd: root, env: { ...process.env, RELAY_GATEWAY_MUTATION: name, RELAY_GATEWAY_LOADED: loaded }, encoding: 'utf8', timeout: 60000,
  })
  writeFileSync(resolve(output, `t1-${name}.log`), run.stdout + run.stderr)
  const facts = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const expected = createHash('sha256').update(readFileSync(resolve(root, variant.file))).digest('hex')
  const implementation = facts.find(fact => fact.path === variant.file && fact.mutation === name && fact.originalSHA256 === expected && fact.loadedSHA256 !== expected)
  const testLoaded = facts.some(fact => fact.path === variant.test)
  const result = JSON.parse(readFileSync(report, 'utf8'))
  const failed = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  const assertion = failed.some(test => test.fullName.includes(variant.target) && test.failureMessages.some(message => /AssertionError|_Assertion\.__VITEST_RESOLVES__/u.test(message)))
  const passed = run.status === 1 && Boolean(implementation) && testLoaded && assertion
  results.push({ name, passed, exitCode: run.status, loadedImplementation: Boolean(implementation), loadedTest: testLoaded, semanticAssertion: assertion, failedTests: failed.map(test => test.fullName) })
  if (!passed) throw Error('Relay gateway mutation did not produce its loaded behavior assertion: ' + name)
}
writeFileSync(resolve(output, 't1-mutations.json'), JSON.stringify({ results }, null, 2) + '\n')
process.stdout.write('PASS: four Relay gateway mutations loaded and failed their behavior assertions.\n')
