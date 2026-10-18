import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const prefix = 'apps/desktop/src/renderer/src/'
const owners = ['store.ts', 'hooks/useAgentAttentionNotifications.ts', 'lib/notification-delivery-notice.ts',
  'lib/attention-notifier.ts', 'lib/a2a-message-notifier.ts', 'components/settings/NotificationSettingsPane.tsx',
  'components/settings/modules/notifications.tsx']
const tests = ['apps/desktop/test/notification-events.test.tsx', 'apps/desktop/test/attention-notifier.test.ts',
  'apps/desktop/test/notification-settings-control.test.ts']
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = new Map(owners.map(path => [prefix + path, readFileSync(join(root, prefix + path), 'utf8')]))
const testSources = new Map(tests.map(path => [path, readFileSync(join(root, path), 'utf8')]))
const evidenceRoot = join(root, '.local/state/notification-events')
const evidence = join(evidenceRoot, randomUUID())
const harnessPaths = ['apps/desktop/test/vitest.notification-events.config.mts', 'apps/desktop/test/performance-capture.config.mts',
  'apps/desktop/test/vitest.performance-reading.config.mts', 'pnpm-lock.yaml', 'package.json', 'apps/desktop/package.json',
  'node_modules/vitest/package.json', 'apps/desktop/node_modules/vite/package.json']
const publicArtifacts = ['packages/core/bin/amux', 'packages/core/dist/agentmux.js']
const fileSHA = path => sha(readFileSync(join(root, path)))
const receipt = { passed: false, root, candidateBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  verifierSHA256: sha(readFileSync(import.meta.filename)), sourceSHA256: Object.fromEntries([...sources].map(([path, value]) => [path, sha(value)])),
  reusedPublicArtifactSHA256: Object.fromEntries(publicArtifacts.map(path => [path, fileSHA(path)])),
  harnessSHA256: Object.fromEntries(harnessPaths.map(path => [path, fileSHA(path)])), candidateInputsSHA256: {}, evidenceSHA256: {},
  testSHA256: Object.fromEntries([...testSources].map(([path, value]) => [path, sha(value)])), variants: [], sourceWritten: false,
  consumers: ['Actual App → useAgentAttentionNotifications → reportError → window event owner',
    'Actual App → initialize → sessions.onEvent → A2A notifier → shared platform receipt → window event owner',
    'Actual openLauncher target validation → exact Tab Group receipt; healthy Session, layout and drafts preserved',
    'Actual Notifications settings module → Pane draft → api.config.save with original expected scope',
    'Executable amux settings → public Unix socket → Main settings module → isolated ConfigOwner/ConfigStore → reopened disk → banner/A2A presentation'],
  limitations: ['Native OS notification compositor is outside this fixture; typed IPC delivery receipts are injected',
    'DOM behavior and notification config only; no Session or layout lifecycle is changed',
    'No user preferences, user Sessions or live workfaces are modified'] }
function replace(file, needle, replacement, count = 1) {
  const path = prefix + file, source = sources.get(path)
  assert.ok(source); assert.equal(source.split(needle).length - 1, count, `Unique actual source anchor: ${file}`)
  return { path, source: source.replaceAll(needle, replacement) }
}
const variants = [
  ['unknown-operations-merged', replace('store.ts', "event: { source: 'operation', key: crypto.randomUUID() }", "event: { source: 'operation', key: 'same-unknown-operation' }")],
  ['exact-object-removed', replace('store.ts', 'event.object?.kind, event.object?.id, event.object?.hostId, event.object?.workspaceId,',
    'event.object?.kind, undefined, event.object?.hostId, event.object?.workspaceId,')],
  ['repeat-count-frozen', replace('store.ts', 'occurrences: prior?.id === id ? (prior.occurrences ?? 1) + 1 : 1', 'occurrences: 1')],
  ['receipt-time-restarted', replace('store.ts', 'const firstObservedAt = prior?.id === id ? prior.firstObservedAt : observedAt', 'const firstObservedAt = observedAt')],
  ['a2a-platform-identity-lost', replace('store.ts', 'if (notice) get().reportError(notice.message, notice.context)', 'if (notice) get().reportError(notice.message)')],
  ['attention-platform-identity-lost', replace('hooks/useAgentAttentionNotifications.ts', 'reportError(notice.message, notice.context)', 'reportError(notice.message)', 2)],
  ['dock-recurrence-stays-read', replace('hooks/useAgentAttentionNotifications.ts', 'badgeCount = count; badgeFailureKey = undefined', 'badgeCount = count')],
  ['cleared-platform-notice-recreated', replace('store.ts',
    "if (context?.event && !existing && current.noticeReadReceipts['global:events']?.[id] === 'read') return", '')],
  ['settings-draft-not-committed', replace('components/settings/modules/notifications.tsx',
    'await api.config.save({ ...current, notifications }, { ...current, notifications: expected })',
    'await api.config.save({ ...current, notifications: expected }, { ...current, notifications: expected })')]
]

// Expensive proof may be reused only with its captured source input closure and
// intact assertion/mutation reports. HEAD alone, a prior green flag or source names cannot qualify.
if (existsSync(evidenceRoot)) for (const entry of readdirSync(evidenceRoot).reverse()) {
  const previousDirectory = join(evidenceRoot, entry), previousPath = join(previousDirectory, 'receipt.json')
  if (!existsSync(previousPath)) continue
  try {
    const previous = JSON.parse(readFileSync(previousPath, 'utf8'))
    assert.equal(previous.passed, true)
    assert.equal(previous.root, root)
    assert.deepEqual(previous.runtime, receipt.runtime)
    assert.equal(previous.verifierSHA256, receipt.verifierSHA256)
    assert.deepEqual(previous.sourceSHA256, receipt.sourceSHA256)
    assert.deepEqual(previous.testSHA256, receipt.testSHA256)
    assert.deepEqual(previous.reusedPublicArtifactSHA256, receipt.reusedPublicArtifactSHA256)
    assert.deepEqual(previous.harnessSHA256, receipt.harnessSHA256)
    assert.deepEqual(previous.variants.map(value => value.name), ['candidate', ...variants.map(([name]) => name)])
    assert.ok(previous.variants.every((value, index) => value.assertions >= 19 &&
      (index === 0 ? value.exitCode === 0 && value.failed.length === 0 : value.exitCode !== 0 && value.failed.length > 0)))
    assert.ok(Object.keys(previous.candidateInputsSHA256).length > sources.size + testSources.size)
    for (const path of [...sources.keys(), ...testSources.keys()]) assert.equal(previous.candidateInputsSHA256[path], fileSHA(path))
    for (const [path, hash] of Object.entries(previous.candidateInputsSHA256)) assert.equal(fileSHA(path), hash)
    assert.equal(Object.keys(previous.evidenceSHA256).length, (variants.length + 1) * 2)
    for (const [path, hash] of Object.entries(previous.evidenceSHA256)) assert.equal(sha(readFileSync(join(previousDirectory, path))), hash)
    console.log(JSON.stringify({ passed: true, reused: true, candidateBase: receipt.candidateBase, receipt: previousPath }))
    process.exit(0)
  } catch { /* A stale or incomplete receipt never replaces executing the proof below. */ }
}
mkdirSync(evidence, { recursive: true })

try {
  for (const [name, variant] of [['candidate', null], ...variants]) {
    const sourceMap = Object.fromEntries([...sources].map(([path, value]) => [path, variant?.path === path ? variant.source : value]))
    const mapPath = join(evidence, `${name}.sources.json`), loadedPath = join(evidence, `${name}.loaded.ndjson`), reportPath = join(evidence, `${name}.report.json`)
    writeFileSync(mapPath, JSON.stringify(sourceMap))
    const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.notification-events.config.mts',
      '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`], { cwd: root, encoding: 'utf8', timeout: 180000,
      env: { ...process.env, AGENTMUX_PERFORMANCE_SOURCES: mapPath, AGENTMUX_PERFORMANCE_LOADED: loadedPath } })
    writeFileSync(join(evidence, `${name}.log`), (child.stdout ?? '') + (child.stderr ?? ''))
    assert.ifError(child.error); assert.equal(child.signal, null, 'An interrupted child cannot certify assertions')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.deepEqual(report.testResults.map(test => resolve(test.name)).sort(), tests.map(path => join(root, path)).sort())
    const assertions = report.testResults.flatMap(test => test.assertionResults)
    assert.ok(assertions.length >= 19 && assertions.every(test => ['passed', 'failed'].includes(test.status)), 'No empty, skipped or uncollected tests')
    const failed = assertions.filter(test => test.status === 'failed')
    if (name === 'candidate') { assert.equal(child.status, 0); assert.equal(failed.length, 0) }
    else {
      assert.notEqual(child.status, 0, 'Actual source mutation must fail')
      assert.ok(failed.length > 0 && failed.every(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Only behavior assertion RED qualifies')
    }
    const loaded = new Map(readFileSync(loadedPath, 'utf8').trim().split('\n').map(line => { const entry = JSON.parse(line); return [entry.path, entry.sha256] }))
    for (const [path, source] of Object.entries(sourceMap)) assert.equal(loaded.get(path), sha(source), `Exact compiled input: ${path}`)
    if (name === 'candidate') receipt.candidateInputsSHA256 = Object.fromEntries(loaded)
    receipt.evidenceSHA256[`${name}.report.json`] = sha(readFileSync(reportPath))
    receipt.evidenceSHA256[`${name}.loaded.ndjson`] = sha(readFileSync(loadedPath))
    receipt.variants.push({ name, exitCode: child.status, assertions: assertions.length, failed: failed.map(test => test.fullName),
      consumedSHA256: Object.fromEntries([...loaded].filter(([path]) => sources.has(path))) })
    console.log(JSON.stringify({ name, assertions: assertions.length, failed: failed.length }))
  }
  for (const [path, source] of [...sources, ...testSources]) assert.equal(sha(readFileSync(join(root, path))), sha(source), `Source drift: ${path}`)
  for (const [path, hash] of Object.entries({ ...receipt.candidateInputsSHA256, ...receipt.harnessSHA256, ...receipt.reusedPublicArtifactSHA256 }))
    assert.equal(fileSHA(path), hash, `Consumed input drift: ${path}`)
  receipt.passed = true
} finally {
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json') }))
}
