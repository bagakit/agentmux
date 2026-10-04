import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Candidate authority follows this installed gate, never an invocation from an older evidence WT.
const root = resolve(import.meta.dirname, '../../..')
const prefix = 'apps/desktop/src/renderer/src/'
const owners = ['lib/use-observed-app-store.ts', 'lib/composer-resubmit-guard.ts', 'lib/session-presentation.ts',
  'components/AgentSessionComposer.tsx', 'components/SessionPane.tsx', 'components/WorkspaceWorkbench.tsx', 'store.ts']
const tests = ['apps/desktop/test/retained-consumer-notifications.test.tsx', 'apps/desktop/test/terminal-retained-derivation.test.tsx']
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = new Map(owners.map(path => [prefix + path, readFileSync(join(root, prefix + path), 'utf8')]))
const testSources = new Map(tests.map(path => [path, readFileSync(join(root, path), 'utf8')]))
const evidence = join(root, '.local/state/retained-consumer-notifications', String(globalThis.crypto.randomUUID()))
mkdirSync(evidence, { recursive: true })
const receipt = { passed: false, root, invocationCwd: process.cwd(), childCwd: root,
  verifierSHA256: sha(readFileSync(import.meta.filename)),
  mainHead: execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: root, encoding: 'utf8' }).trim(),
  candidateBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSHA256: Object.fromEntries([...sources].map(([path, value]) => [path, sha(value)])),
  testSHA256: Object.fromEntries([...testSources].map(([path, value]) => [path, sha(value)])),
  callers: [], variants: [], sourceWritten: false, userRunTouched: false,
  limitations: ['DOM fixture, not native IME or compositor proof', 'Shared admission follows changed factual domains; global configuration/navigation changes still legitimately notify the cohort',
    'Not original installed slow-click causality or restoration acceptance'] }
function replace(path, needle, replacement, count = 1) {
  const source = sources.get(prefix + path)
  assert.ok(source)
  assert.equal(source.split(needle).length - 1, count, 'Unique actual Source anchor: ' + path)
  return { path: prefix + path, source: source.replaceAll(needle, replacement) }
}
const variants = [
  ['unrelated-broadcast-restored', replace('lib/use-observed-app-store.ts',
    "if (current.sessions !== previous.sessions) {", "for (const scope of listenersByScope.keys()) changed.add(scope)\n  if (current.sessions !== previous.sessions) {")],
  ['shared-service-notification-withdrawn', replace('lib/use-observed-app-store.ts',
    'const composerChanged = sharedFacts.composer.some(key => current[key] !== previous[key])', 'const composerChanged = false')],
  ['hidden-navigation-broadcast-restored', replace('lib/use-observed-app-store.ts',
    'scope.navigation && navigationChanged', 'navigationChanged')],
  ['own-notification-withdrawn', replace('lib/use-observed-app-store.ts',
    'for (const scope of scopesBySession.get(id) ?? []) changed.add(scope)', '')],
  ['hidden-facts-frozen', replace('lib/use-observed-app-store.ts',
    'const value = selector(useAppStore.getState())', 'if (!visibility.current && initialized.current) return previous.current\n    const value = selector(useAppStore.getState())')],
  ['speaker-scope-withdrawn', replace('components/SessionPane.tsx',
    "useObservedAppStore('sessionPane', observationVisible, speakerScope, useShallow(speakerFactsSelector))",
    "useObservedAppStore('sessionPane', observationVisible, consumerScope, useShallow(speakerFactsSelector))")],
  ['timeline-revision-withdrawn', replace('lib/use-observed-app-store.ts',
    " || key === 'timelines' && timelineRevisions.get(id) !== current.timelines[id]?.revision", '')],
  ['first-recovery-observation-replaced', replace('lib/use-observed-app-store.ts',
    'if (!before.has(candidate.agentSessionId)) before.set(candidate.agentSessionId, candidate)', 'before.set(candidate.agentSessionId, candidate)')],
  ['workbench-cache-bypassed', replace('components/WorkspaceWorkbench.tsx',
    "mode(state) !== 'terminal'", "effectiveSessionViewMode(state, id) !== 'terminal'")],
  ['expiry-release-withdrawn', replace('lib/composer-resubmit-guard.ts',
    'if (expires <= now) this.submissions.delete(id)', 'if (expires <= now) {}')],
  ['duplicate-protection-withdrawn', replace('lib/composer-resubmit-guard.ts',
    'return isDuplicateResubmit(this.submissions.get(sessionId) ?? null, text, performance.now(), RESUBMIT_WINDOW_MS)', 'return false')],
  ['refusal-recorded-as-accepted', replace('components/AgentSessionComposer.tsx',
    "if (!send(sessionId, value, feedback.report, 'manual')) return",
    "lastSubmitBySession.record(sessionId, value)\n    if (!send(sessionId, value, feedback.report, 'manual')) return")],
  ['final-subscription-leaked', replace('lib/use-observed-app-store.ts',
    'if (listenersByScope.size === 0) { unsubscribe?.(); unsubscribe = undefined }', '')]
]
try {
  // These source sites are necessary but do not certify reachability alone. The tests mount
  // actual Workbench→Pane→Composer→rich editor; the mutants below cut those exact consumers.
  for (const [path, anchor] of [
    ['components/AgentSessionComposer.tsx', "useObservedAppStore('composer', visible, consumerScope,"],
    ['components/SessionPane.tsx', "useObservedAppStore('sessionPane', observationVisible,"],
    ['components/WorkspaceWorkbench.tsx', '<SessionPane'],
    ['components/SessionPane.tsx', '<AgentSessionComposer'],
    ['components/WorkspaceWorkbench.tsx', 'mode(state)']
  ]) {
    const source = sources.get(prefix + path)
    const count = source.split(anchor).length - 1
    assert.ok(count > 0, 'Nonempty actual product caller ' + path)
    receipt.callers.push({ path: prefix + path, anchor, count, sha256: sha(source),
      proof: 'Runtime mounted product and changed-owner assertions in retained-consumer-notifications.test.tsx; symbol presence alone is not acceptance' })
  }
  assert.ok(testSources.get(tests[0]).includes('for (const count of [1, 32, 100])'))
  for (const [name, replacement] of [['candidate', null], ...variants]) {
    const config = join(evidence, name + '.config.mts'), reportPath = join(evidence, name + '.vitest.json')
    const loaded = join(evidence, name + '.loaded.json')
    const sourceMap = Object.fromEntries([...sources].map(([path, value]) => [join(root, path), replacement?.path === path ? replacement.source : value]))
    const configText = `import { mergeConfig } from 'vitest/config'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
const sources = ${JSON.stringify(sourceMap)}, loaded = {}
const config = mergeConfig(base, { root: ${JSON.stringify(root)}, plugins: [{ name: 'actual-retained-consumer-source', enforce: 'pre',
  transform(code, id) { const path = id.split('?')[0]; if (!(path in sources)) return
    const source = sources[path]; loaded[path] = createHash('sha256').update(source).digest('hex')
    writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(loaded)); return { code: source, map: null }
  } }] })
config.test = { ...config.test, include: ${JSON.stringify(tests)}, maxWorkers: 1 }
export default config
`
    writeFileSync(config, configText)
    const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      '--reporter=default', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, encoding: 'utf8', timeout: 60000 })
    writeFileSync(join(evidence, name + '.log'), (child.stdout ?? '') + (child.stderr ?? ''))
    assert.ifError(child.error)
    assert.equal(child.signal, null, 'An interrupted child cannot certify assertions')
    assert.ok(Number.isInteger(child.status))
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.deepEqual(report.testResults.map(test => resolve(test.name)).sort(), tests.map(path => join(root, path)).sort())
    const assertions = report.testResults.flatMap(test => test.assertionResults)
    assert.ok(assertions.length >= 16 && assertions.every(test => ['passed', 'failed'].includes(test.status)), 'No empty or skipped tests')
    const failed = assertions.filter(test => test.status === 'failed')
    if (name === 'candidate') { assert.equal(child.status, 0); assert.equal(failed.length, 0) }
    else {
      assert.notEqual(child.status, 0, 'Real Source mutation must fail')
      assert.ok(failed.length > 0 && failed.every(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Only behavior Assertion RED qualifies')
    }
    const consumed = JSON.parse(readFileSync(loaded, 'utf8'))
    for (const [path, value] of Object.entries(sourceMap)) assert.equal(consumed[path], sha(value), 'Exact actual compiler input: ' + path)
    receipt.variants.push({ name, exitCode: child.status, assertions: assertions.length,
      failed: failed.map(test => test.fullName), consumedSHA256: consumed, configSHA256: sha(configText) })
    console.log(JSON.stringify({ name, assertions: assertions.length, failed: failed.length }))
  }
  for (const [path, value] of sources) assert.equal(sha(readFileSync(join(root, path))), sha(value), 'Source drift during verification')
  for (const [path, value] of testSources) assert.equal(sha(readFileSync(join(root, path))), sha(value), 'Test drift during verification')
  receipt.passed = true
} finally {
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json') }))
}
