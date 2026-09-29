import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
assert.equal(resolve(process.env.AGENTMUX_CLI_QUALITY_SNAPSHOT ?? ''), root, 'Use the exclusive CLI quality SourceCopy.')
const sourcePath = 'apps/desktop/src/renderer/src/store.ts'
const testPath = 'apps/desktop/test/display-name-cli-control.test.ts'
const source = readFileSync(join(root, sourcePath), 'utf8')
const owning = readFileSync(join(root, testPath), 'utf8')
assert.ok(source.length > 0 && owning.length > 0)
const sha = text => createHash('sha256').update(text).digest('hex')
const proof = join(root, 'display-name-mutations-' + Date.now())
mkdirSync(proof)
const begin = source.indexOf("    if (request.operation === 'agent.inspect') {")
const end = source.indexOf("    if (request.operation === 'inspect.client') {", begin)
assert.ok(begin >= 0 && end > begin)
const block = source.slice(begin, end)
assert.ok(block.includes("request.operation === 'space.rename'"))
const replace = (text, needle, replacement, count = 1) => {
  assert.equal(text.split(needle).length - 1, count, 'Exact product mutation anchor count')
  return text.replaceAll(needle, replacement)
}
const variants = [
  ['agent-owner-withdrawn', replace(block, 'get().renameAgent(request.agentSessionId, request.name)', 'void request.name')],
  ['tab-owner-withdrawn', replace(block, 'get().renameTab(request.tabId, request.name)', 'void request.name')],
  ['save-boundary-withdrawn', replace(block, 'const save = await saveWorkbenchSelection(false)',
    "const save = { layoutApplied: false, localStorageWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed' as const, reason: null }", 2)],
  ['alias-read-withdrawn', replace(block, 'override: agentDisplayOverride(get().agentNames, request.agentSessionId)', 'override: null')]
].map(([name, replacement]) => [name, source.slice(0, begin) + replacement + source.slice(end)])
variants.push(
  ['alias-own-entry-guard-withdrawn', replace(source,
    'return Object.hasOwn(names, sessionId) ? names[sessionId] ?? null : null', 'return names[sessionId] ?? null')],
  ['tab-own-entity-guard-withdrawn', replace(source,
    'const tab = Object.hasOwn(tabs, request.tabId) ? tabs[request.tabId] : undefined', 'const tab = tabs[request.tabId]')],
  ['restored', source]
)
const receipts = []
for (const [name, changed] of variants) {
  const configPath = join(proof, name + '.config.mts')
  const jsonPath = join(proof, name + '.vitest.json')
  const config = `import { mergeConfig } from 'vitest/config'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
const source = ${JSON.stringify(changed)}
const config = mergeConfig(base, { plugins: [{ name: 'private-display-name-product-mutation', enforce: 'pre',
  transform(_, id) { if (id.split('?')[0] === ${JSON.stringify(join(root, sourcePath))}) return { code: source, map: null } }
}] })
config.test = { ...config.test, include: [${JSON.stringify(testPath)}], maxWorkers: 1 }
export default config
`
  writeFileSync(configPath, config)
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', configPath, testPath,
    '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + jsonPath]
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8' })
  writeFileSync(join(proof, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
  assert.deepEqual(report.testResults.map(item => resolve(item.name)), [join(root, testPath)], 'Only the owning file may run.')
  const assertions = report.testResults.flatMap(item => item.assertionResults)
  assert.ok(assertions.length > 0 && report.numTotalTests > 0, 'Actual collection must be nonempty.')
  const failed = assertions.filter(item => item.status === 'failed')
  if (name === 'restored') {
    assert.equal(result.status, 0, 'Same Source restore must be GREEN.')
    assert.equal(failed.length, 0)
    assert.equal(report.numPassedTests, assertions.length)
  } else {
    assert.notEqual(result.status, 0, 'Withdrawing the actual product block must be RED.')
    assert.ok(failed.length > 0)
    for (const failure of failed) assert.ok(failure.failureMessages.some(message => message.includes('AssertionError')),
      'Setup/import/timeouts are not Assertion RED: ' + failure.fullName)
  }
  receipts.push({ name, exitCode: result.status, sourceSha256: sha(changed), owningSha256: sha(owning),
    configSha256: sha(config), assertionCount: assertions.length, failedAssertions: failed.map(item => item.fullName),
    passed: report.numPassedTests, report: jsonPath })
  console.log(JSON.stringify({ name, exitCode: result.status, assertions: assertions.length, failed: failed.length }))
}
assert.equal(sha(readFileSync(join(root, sourcePath), 'utf8')), sha(source), 'Mutation never rewrites product Source.')
assert.equal(sha(readFileSync(join(root, testPath), 'utf8')), sha(owning), 'Mutation never rewrites owning assertions.')
writeFileSync(join(proof, 'receipt.json'), JSON.stringify({ root, sourcePath, sourceSha256: sha(source), testPath,
  owningSha256: sha(owning), variants: receipts, sourceWritten: false, sharedRuntimeUsed: false }, null, 2) + '\n')
console.log(JSON.stringify({ receipt: join(proof, 'receipt.json') }))
