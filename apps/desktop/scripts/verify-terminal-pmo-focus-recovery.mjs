import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(resolve(root, 'package.json'))
const ts = require('typescript')
const evidence = resolve(root, '.local/state/terminal-pmo-focus-verification')
mkdirSync(evidence, { recursive: true })
const store = 'apps/desktop/src/renderer/src/store.ts'
const focus = 'apps/desktop/src/renderer/src/lib/agent-focus.ts'
const test = 'apps/desktop/test/terminal-pmo-restore.test.tsx'
const mutations = [
  { name: 'unknown-as-execution', path: store,
    from: 'return workspace ? focusLaneForSession(topicIdForSession(config, session, topics),\n            scratchTopicsForWorkspace(persistedState.scratchTopicSnapshots, workspace)) : null',
    to: 'return focusLaneForSession(topicIdForSession(config, session, topics),\n            scratchTopicsForWorkspace(persistedState.scratchTopicSnapshots, workspace))',
    red: 'retains durable healthy PMO focus while its hashed Mote directory identity is unobserved' },
  { name: 'all-lanes-unknown', path: store,
    from: 'return workspace ? focusLaneForSession(topicIdForSession(config, session, topics),\n            scratchTopicsForWorkspace(persistedState.scratchTopicSnapshots, workspace)) : null',
    to: 'return null', red: 'clears a wrongly stored PMO reference for a confirmed ordinary project execution Agent' },
  { name: 'revive-absent-reference', path: focus,
    from: '? context.pmo.sessionId : null', to: '? context.pmo.sessionId : context.pmo.sessionId',
    red: 'does not resurrect an absent Session with no retained projection' }
]
// The normal mounted App must still pass its actual Store action to the real startup owner.
const appPath = 'apps/desktop/src/renderer/src/App.tsx'
const appText = readFileSync(resolve(root, appPath), 'utf8')
const app = ts.createSourceFile(appPath, appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callers = []
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(app) === 'beginRendererStartup' && node.arguments[0]?.getText(app) === 'initialize') callers.push(node.getText(app))
  ts.forEachChild(node, visit)
}
visit(app)
assert.ok(callers.length > 0, 'Nonempty production App startup consumer')
assert.match(readFileSync(resolve(root, 'apps/desktop/src/renderer/src/lib/startup-progress.ts'), 'utf8'), /initialize\(\)/)

function run(mutation) {
  const name = mutation?.name ?? 'baseline'
  const config = resolve(evidence, name + '.config.mjs')
  const report = resolve(evidence, name + '.json')
  rmSync(report, { force: true })
  const plugin = mutation ? `plugins: [{ name: 'private-pmo-production-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== ${JSON.stringify(resolve(root, mutation.path))}) return;
    const from = ${JSON.stringify(mutation.from)};
    if (code.split(from).length !== 2) throw new Error('Mutation target must occur exactly once');
    console.log('MUTATION_APPLIED=${name}');
    return { code: code.replace(from, ${JSON.stringify(mutation.to)}), map: null };
  } }],` : ''
  writeFileSync(config, `import base from ${JSON.stringify(resolve(root, 'vitest.config.ts'))};\nexport default { ...base, ${plugin} };\n`)
  const result = spawnSync(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', config, test, '--reporter=json', '--outputFile', report],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(evidence, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.ifError(result.error)
  assert.equal(result.signal, null, 'A signalled process cannot qualify a mutation')
  assert.ok(Number.isInteger(result.status), 'The test process must finish normally')
  const proof = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(proof.numTotalTests, 8, 'The exact eight behavioral tests must execute')
  const assertions = proof.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(assertions.length, 8, 'No empty collection or startup failure can qualify')
  if (mutation) {
    assert.match(result.stdout + result.stderr, new RegExp('MUTATION_APPLIED=' + name))
    assert.notEqual(result.status, 0, 'Production mutation must fail')
    const failed = assertions.find(test => test.title === mutation.red)
    assert.equal(failed?.status, 'failed', 'The declared behavioral counterexample must turn red')
    assert.ok(failed.failureMessages.some(message => message.includes('AssertionError')), 'Only behavioral assertion failure qualifies')
  } else {
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(proof.numPassedTests, 8)
  }
  return { name, passed: mutation ? 'expected-assertion-red' : '8-green', report: relative(root, report) }
}
const results = [run(null), ...mutations.map(run)]
const receipt = { schema: 'agentmux.terminal-pmo-focus-verification.v1', productionCallers: [{ path: appPath, count: callers.length }], results }
writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
