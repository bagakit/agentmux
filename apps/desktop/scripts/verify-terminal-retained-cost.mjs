import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The retained Feature worktree invokes this Main-owned entry point by relative path.
// Neither production imports nor child cwd may come from that old evidence worktree.
const root = resolve(import.meta.dirname, '../../..')
const slice = process.argv.find(arg => arg.startsWith('--slice='))?.slice(8)
assert.ok(['derivation', 'presentation'].includes(slice), 'Choose a nonempty owning slice')
const prefix = 'apps/desktop/src/renderer/src/'
const owners = slice === 'derivation'
  ? ['lib/session-presentation.ts', 'lib/conversation-sender-details.ts', 'components/AgentSessionComposer.tsx', 'components/SessionPane.tsx']
  : ['components/StableWorkbenchView.tsx', 'components/LiquidSelectionSurface.tsx']
const testPath = `apps/desktop/test/terminal-retained-${slice}.test.tsx`
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = new Map(owners.map(path => [prefix + path, readFileSync(join(root, prefix + path), 'utf8')]))
const testSource = readFileSync(join(root, testPath), 'utf8')
const evidence = join(root, '.local/state/terminal-retained-cost', slice, String(globalThis.crypto.randomUUID()))
mkdirSync(evidence, { recursive: true })
const receipt = { passed: false, root, invocationCwd: process.cwd(), childCwd: root, slice,
  verifierSHA256: sha(readFileSync(import.meta.filename)),
  mainHead: execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSHA256: Object.fromEntries([...sources].map(([path, source]) => [path, sha(source)])),
  testPath, testSHA256: sha(testSource), callers: [], variants: [], sourceWritten: false, userRunTouched: false }
function replace(path, needle, replacement, count = 1) {
  const source = sources.get(prefix + path)
  assert.ok(source)
  assert.equal(source.split(needle).length - 1, count, 'Unique real Source anchor: ' + path)
  return { path: prefix + path, source: source.replaceAll(needle, replacement) }
}
const variants = slice === 'derivation' ? [
  ['prompt-cache-withdrawn', replace('lib/session-presentation.ts',
    'const facts = [timeline, timeline?.revision, timeline?.items, timeline?.items.length]',
    'const facts = [timeline, timeline?.revision, timeline?.items, timeline?.items.length, {}]')],
  ['prompt-revision-withdrawn', replace('lib/session-presentation.ts',
    'const facts = [timeline, timeline?.revision, timeline?.items, timeline?.items.length]', 'const facts = [timeline]')],
  ['view-cache-withdrawn', replace('lib/session-presentation.ts',
    'const facts = [state.config, state.scratchTopicSnapshots, session?.kind, session?.hostId, session?.workspacePath]',
    'const facts = [state.config, state.scratchTopicSnapshots, session?.kind, session?.hostId, session?.workspacePath, {}]')],
  ['view-observation-withdrawn', replace('lib/session-presentation.ts',
    'const facts = [state.config, state.scratchTopicSnapshots, session?.kind, session?.hostId, session?.workspacePath]',
    'const facts = [state.config, null, session?.kind, session?.hostId, session?.workspacePath]')],
  ['speaker-cache-withdrawn', replace('lib/conversation-sender-details.ts',
    'if (previous && facts.every((fact, i) => fact === previous![i])) return value', 'if (false) return value')],
  ['composer-workspace-invalidation-withdrawn', replace('components/AgentSessionComposer.tsx',
    '[config, topics, session?.kind, session?.hostId, session?.workspacePath]', '[]')],
  ['composer-prompt-caller-withdrawn', replace('components/AgentSessionComposer.tsx',
    "useObservedAppStore('composer', visible, consumerScope, firstPromptSelector)",
    "useObservedAppStore('composer', visible, consumerScope, state => createFirstPromptSelector(sessionId)(state))")]
] : [
  ['hidden-reading-guard-withdrawn', replace('components/StableWorkbenchView.tsx', 'if (!previous.visible) return null', '')],
  ['outgoing-reading-guard-reversed', replace('components/StableWorkbenchView.tsx', 'if (!previous.visible) return null', 'if (!this.props.visible) return null')],
  ['visible-reading-withdrawn', replace('components/StableWorkbenchView.tsx', 'if (!previous.visible) return null', 'return null')],
  ['inactive-target-guard-withdrawn', replace('components/LiquidSelectionSurface.tsx', 'if (!active || document.hidden) {', 'if (false) {')],
  ['inactive-host-guard-withdrawn', replace('components/LiquidSelectionSurface.tsx',
    'const rect = watch ? host.getBoundingClientRect() : null', 'const rect = host.getBoundingClientRect()')],
  ['disposed-sync-fence-withdrawn', replace('components/LiquidSelectionSurface.tsx',
    'const sync = () => {\n      if (!alive) return', 'const sync = () => {')]
]
const consumers = slice === 'derivation' ? [
  ['components/AgentSessionComposer.tsx', 'createFirstPromptSelector(sessionId)'],
  ['components/SessionPane.tsx', 'createSessionViewModeSelector(sessionId)'],
  ['components/SessionPane.tsx', 'createConversationSpeakerFactsSelector(speakerIds, activityDemand)']
] : [
  ['components/WorkspaceWorkbench.tsx', '<StableWorkbenchView'],
  ['components/TopicChatsPanel.tsx', "from './LiquidSelectionSurface'"],
  ['components/SurfaceModeSwitch.tsx', '<LiquidSelectionSurface']
]
try {
  if (slice === 'presentation') assert.equal(existsSync(join(root, prefix, 'components/settings/LiquidSelectionSurface.tsx')), false, 'One production selection owner')
  for (const [path, anchor] of consumers) {
    const source = readFileSync(join(root, prefix + path), 'utf8')
    const count = source.split(anchor).length - 1
    assert.ok(count > 0, 'Nonempty external production consumer: ' + path)
    receipt.callers.push({ path: prefix + path, anchor, count, sha256: sha(source) })
  }
  for (const [name, replacement] of [['candidate', null], ...variants]) {
    const config = join(evidence, name + '.config.mts'), reportPath = join(evidence, name + '.vitest.json')
    const loaded = join(evidence, name + '.loaded.json')
    const sourceMap = Object.fromEntries([...sources].map(([path, source]) => [join(root, path),
      replacement?.path === path ? replacement.source : source]))
    // Capture the actual Vite input for every owner, including the mutated module.
    const configText = `import { mergeConfig } from 'vitest/config'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
const sources = ${JSON.stringify(sourceMap)}, loaded = {}
const config = mergeConfig(base, { root: ${JSON.stringify(root)}, plugins: [{ name: 'actual-retained-source', enforce: 'pre',
  transform(code, id) { const path = id.split('?')[0]; if (!(path in sources)) return
    const source = sources[path]; loaded[path] = createHash('sha256').update(source).digest('hex')
    writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(loaded))
    return { code: source, map: null }
  } }] })
config.test = { ...config.test, include: [${JSON.stringify(testPath)}], maxWorkers: 1 }
export default config
`
    writeFileSync(config, configText)
    rmSync(reportPath, { force: true })
    rmSync(loaded, { force: true })
    const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      '--reporter=default', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, encoding: 'utf8', timeout: 60000 })
    writeFileSync(join(evidence, name + '.log'), (child.stdout ?? '') + (child.stderr ?? ''))
    assert.ifError(child.error)
    assert.equal(child.signal, null, 'Interrupted runs cannot certify assertions')
    assert.ok(Number.isInteger(child.status), 'Only a completed child exit qualifies')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.deepEqual(report.testResults.map(test => resolve(test.name)), [join(root, testPath)])
    const assertions = report.testResults.flatMap(test => test.assertionResults)
    assert.ok(assertions.length > 0 && assertions.every(test => ['passed', 'failed'].includes(test.status)), 'No empty or skipped tests')
    const failed = assertions.filter(test => test.status === 'failed')
    if (name === 'candidate') { assert.equal(child.status, 0); assert.equal(failed.length, 0) }
    else {
      assert.notEqual(child.status, 0, 'Real mutation must fail')
      assert.ok(failed.length > 0 && failed.every(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Only behavior Assertion RED qualifies')
    }
    const consumed = JSON.parse(readFileSync(loaded, 'utf8'))
    for (const [path, source] of Object.entries(sourceMap)) assert.equal(consumed[path], sha(source), 'Exact actual compiler input: ' + path)
    receipt.variants.push({ name, exitCode: child.status, assertions: assertions.length,
      failed: failed.map(test => test.fullName), consumedSHA256: consumed, configSHA256: sha(configText) })
    console.log(JSON.stringify({ slice, name, assertions: assertions.length, failed: failed.length }))
  }
  for (const [path, source] of sources) assert.equal(sha(readFileSync(join(root, path))), sha(source), 'Source changed during verification')
  assert.equal(sha(readFileSync(join(root, testPath))), sha(testSource))
  receipt.passed = true
} finally {
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json') }))
}
