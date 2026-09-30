import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const sha256 = text => createHash('sha256').update(text).digest('hex')
export function exactReplace(source, needle, replacement) {
  assert.equal(source.split(needle).length - 1, 1, 'One exact product bearing must be withdrawn.')
  return source.replace(needle, replacement)
}

/** The Workface owning verifiers use one private Vite transform, never rewrite Source. */
export function verifyWorkfaceMutations({ operation, testPath, sourcePaths, variants, callers }) {
  const root = process.cwd()
  assert.equal(resolve(process.env.AGENTMUX_WORKFACE_SNAPSHOT ?? ''), root, 'Use the exclusive Workface Source snapshot.')
  const read = path => readFileSync(join(root, path), 'utf8')
  const inputs = [...new Set([...sourcePaths, testPath, 'apps/desktop/test/helpers/workface-control-fixture.ts',
    'apps/desktop/test/helpers/spatial-control-owner-fixture.ts', 'vitest.config.ts'])]
  const original = Object.fromEntries(inputs.map(path => [path, read(path)]))
  for (const [path, source] of Object.entries(original)) assert.ok(source.length > 0, 'Nonempty input: ' + path)
  const proof = join(root, '.tmp', 'workface-' + operation + '-mutations-' + Date.now()); mkdirSync(proof, { recursive: true })
  const callerFacts = callers.map(({ symbol, definition }) => {
    const scan = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
    assert.equal(scan.status, 0, 'Nonempty product caller scan: ' + symbol)
    const hits = scan.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':') &&
      !/^.*:\d+:\s*import\b/.test(line))
    assert.ok(hits.length > 0, 'A product call outside the definition is required: ' + symbol)
    return { symbol, definition, hits }
  })
  const receipts = []
  for (const { name, changes } of [...variants, { name: 'restored', changes: {} }]) {
    const configPath = join(proof, name + '.config.mts'), reportPath = join(proof, name + '.vitest.json')
    const code = `import { mergeConfig } from 'vitest/config'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
const changed = ${JSON.stringify(Object.fromEntries(Object.entries(changes).map(([path, source]) => [join(root, path), source])))}
const config = mergeConfig(base, { plugins: [{ name: 'private-workface-product-mutation', enforce: 'pre',
  transform(_, id) { const source = changed[id.split('?')[0]]; if (source !== undefined) return { code: source, map: null } }
}] })
config.test = { ...config.test, include: [${JSON.stringify(testPath)}], maxWorkers: 1 }
export default config
`
    writeFileSync(configPath, code)
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
      AGENTMUX_WORKFACE_SNAPSHOT: root, AGENTMUX_WORKFACE_MUTATION_CONFIG: configPath }
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', configPath, testPath,
      '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, env, encoding: 'utf8' })
    writeFileSync(join(proof, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
    assert.equal(result.signal, null, 'A killed process is not an Assertion RED.')
    assert.equal(typeof result.status, 'number', 'A setup failure is not an Assertion RED.')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.deepEqual(report.testResults.map(item => resolve(item.name)), [join(root, testPath)], 'Exact owning file only.')
    const assertions = report.testResults.flatMap(item => item.assertionResults)
    assert.ok(assertions.length > 0 && report.numTotalTests > 0, 'Actual collection must be nonempty.')
    const failed = assertions.filter(item => item.status === 'failed')
    if (name === 'restored') {
      assert.equal(result.status, 0, 'Same Source restore must be GREEN.')
      assert.equal(failed.length, 0); assert.equal(report.numPassedTests, assertions.length)
    } else {
      assert.notEqual(result.status, 0, 'The withdrawn product bearing must be RED.')
      assert.ok(failed.length > 0)
      for (const failure of failed) assert.ok(failure.failureMessages.some(message => message.includes('AssertionError')),
        'Setup/import/timeouts do not prove product causality: ' + failure.fullName)
    }
    receipts.push({ name, exitCode: result.status, assertionCount: assertions.length, passed: report.numPassedTests,
      failedAssertions: failed.map(item => item.fullName), changedSources: Object.fromEntries(Object.entries(changes).map(([path, source]) => [path, sha256(source)])),
      owningSha256: sha256(original[testPath]), configSha256: sha256(code), reportPath })
    console.log(JSON.stringify({ operation, name, exitCode: result.status, assertions: assertions.length, failed: failed.length }))
  }
  for (const [path, source] of Object.entries(original)) assert.equal(sha256(read(path)), sha256(source), 'Source/input drift: ' + path)
  const receiptPath = join(proof, 'receipt.json')
  writeFileSync(receiptPath, JSON.stringify({ root, operation, testPath, inputs: Object.fromEntries(Object.entries(original).map(([path, source]) =>
    [path, { sha256: sha256(source), bytes: Buffer.byteLength(source) }])), callers: callerFacts, variants: receipts,
    sourceWritten: false, productionEndpointUsed: false, ordinaryProcessRestore: 'Actual owning parent/child tests run with this same mutation config.' }, null, 2) + '\n')
  console.log(JSON.stringify({ operation, receipt: receiptPath }))
}
