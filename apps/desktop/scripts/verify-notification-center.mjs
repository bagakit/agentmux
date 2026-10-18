import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { captureNotificationCenter } from './fixtures/notification-center/capture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), exec = promisify(execFile)
const modes = process.argv.slice(2)
assert.ok(modes.length > 0 && modes.every(value => ['--behavior', '--events', '--visual'].includes(value)), 'Choose --behavior, --events and/or --visual')
const base = join(root, '.tmp/notification-center'), digest = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(join(base, 'run-'))
const src = 'apps/desktop/src/renderer/src/'
const owned = [src + 'components/GlobalSystemNotices.tsx', src + 'components/NotificationGroup.tsx', src + 'components/NotificationItem.tsx',
  src + 'components/AgentLifecycleFeedback.tsx', src + 'components/ServiceWindowNotice.tsx',
  src + 'lib/notification-center.ts', src + 'lib/use-service-notices.ts', src + 'lib/session-service-notices.ts',
  src + 'styles/base.css', src + 'styles/service-notice.css', src + 'store.ts',
  'apps/desktop/test/notification-center.test.tsx', 'apps/desktop/test/vitest.notification-center.config.mts', relative(root, fileURLToPath(import.meta.url))]
if (modes.includes('--events')) owned.push('apps/desktop/test/notification-center-events.test.tsx')
const pin = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))])))
const space = await statfs(root), git = await exec('git', ['rev-parse', 'HEAD'], { cwd: root })
const receipt = { schema: 'agentmux.notification-center-qualification.v1', passed: false, modes,
  sourceCommit: git.stdout.trim(), sourceBefore: await pin(owned), mutations: [], callers: [],
  freeDiskBytes: space.bavail * space.bsize, evidence: relative(root, evidence),
  boundary: 'Actual production Store and component interaction; private transforms only. Complete private Electron App capture; no user App, Agent Run, input, OS notification or durable recovery claim.' }
await writeFile(join(evidence, 'candidate.diff'), (await exec('git', ['diff', '--binary'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout)
console.log('notification-center-evidence=' + relative(root, evidence))

async function run(label, command, args, env = {}) {
  let result
  try { const outcome = await exec(command, args, { cwd: root, env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 20 * 1024 * 1024 }); result = { code: 0, signal: null, text: outcome.stdout + outcome.stderr } }
  catch (error) { result = { code: error.code, signal: error.signal ?? null, killed: error.killed, text: (error.stdout ?? '') + (error.stderr ?? '') } }
  await writeFile(join(evidence, label + '.log'), result.text)
  return result
}
async function test(label, mutation, events = false) {
  const report = join(evidence, label + '.json'), loaded = join(evidence, label + '-loaded.jsonl'), replacements = join(evidence, label + '-inputs.json')
  await writeFile(replacements, JSON.stringify(mutation ? { [mutation.file]: mutation.variant } : {}))
  const result = await run(label, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.notification-center.config.mts',
    '--reporter=json', '--outputFile=' + report], { AGENTMUX_PERFORMANCE_SOURCES: replacements, AGENTMUX_PERFORMANCE_LOADED: loaded,
    AGENTMUX_NOTIFICATION_CENTER_EVENTS: events ? '1' : '0' })
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  const assertions = parsed.testResults.flatMap(file => file.assertionResults).filter(item => !['pending', 'skipped'].includes(item.status))
  assert.ok(assertions.length > 0, 'The original production interactions actually execute')
  assert.equal(result.signal, null, 'A killed or timed-out process is not a semantic assertion result')
  const loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(loads.length > 0, 'Loaded production input set cannot be empty')
  for (const required of ['components/GlobalSystemNotices.tsx', 'components/NotificationGroup.tsx', 'components/NotificationItem.tsx', 'store.ts'])
    assert.ok(loads.some(input => input.path === src + required), 'Real consumer is loaded: ' + required)
  const files = Object.fromEntries(loads.map(input => [input.path, input.sha256]))
  for (const [file, hash] of Object.entries(files)) assert.equal(hash, file === mutation?.file ? digest(mutation.variant) : digest(await readFile(join(root, file))), 'Actual unchanged or privately mutated input: ' + file)
  return { code: result.code, total: assertions.length, passed: assertions.filter(item => item.status === 'passed').length, files,
    assertionRed: assertions.filter(item => item.status === 'failed' && item.failureMessages.some(message => /AssertionError|expected .* to /su.test(message))).map(item => item.fullName) }
}
async function consumeEventsReceipt() {
  const directory = join(root, '.local/state/notification-events')
  const explicit = process.env.AGENTMUX_NOTIFICATION_EVENTS_RECEIPT
  const candidates = explicit ? [resolve(root, explicit)] : (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name, 'receipt.json'))
  const rejected = [], accepted = []
  for (const file of candidates) {
    try {
      const bytes = await readFile(file), value = JSON.parse(bytes)
      assert.equal(value.passed, true, 'Event qualification completed')
      assert.equal(value.sourceWritten, false, 'Mutations never changed the original source')
      const hashes = { ...value.sourceSHA256, ...value.testSHA256, ...value.reusedPublicArtifactSHA256, ...value.harnessSHA256,
        'apps/desktop/scripts/verify-notification-events.mjs': value.verifierSHA256 }
      for (const path of ['apps/desktop/src/shared/notification-presentation.ts', 'apps/desktop/src/shared/a2a-preferences.ts']) {
        assert.ok(value.candidateInputsSHA256[path], 'Shared banner and A2A semantics were actually consumed: ' + path)
        hashes[path] = value.candidateInputsSHA256[path]
      }
      for (const group of ['sourceSHA256', 'testSHA256', 'reusedPublicArtifactSHA256', 'harnessSHA256', 'evidenceSHA256'])
        assert.ok(Object.keys(value[group] ?? {}).length > 0, 'Original event evidence group cannot be empty: ' + group)
      assert.deepEqual(await pin(Object.keys(hashes)), hashes, 'Every event owner, test, verifier and reused public artifact matches this candidate')
      for (const [path, hash] of Object.entries(value.evidenceSHA256))
        assert.equal(digest(await readFile(join(dirname(file), path))), hash, 'Original assertion and compiled-input reports are intact: ' + path)
      assert.ok(value.consumers.length > 0, 'Original production consumer evidence is present')
      const green = value.variants.find(variant => variant.name === 'candidate'), red = value.variants.filter(variant => variant.name !== 'candidate')
      assert.ok(green?.assertions > 0 && green.exitCode === 0 && green.failed.length === 0, 'Original nonempty green assertions passed')
      assert.deepEqual(red.map(variant => variant.name), ['unknown-operations-merged', 'exact-object-removed', 'repeat-count-frozen',
        'receipt-time-restarted', 'a2a-platform-identity-lost', 'attention-platform-identity-lost', 'dock-recurrence-stays-read',
        'cleared-platform-notice-recreated', 'settings-draft-not-committed'])
      assert.ok(red.every(variant => variant.assertions === green.assertions && variant.exitCode !== 0 && variant.failed.length > 0), 'Original nonempty semantic mutation assertions failed')
      assert.deepEqual(green.consumedSHA256, value.sourceSHA256, 'Original green actually consumed all unchanged event owner sources')
      accepted.push({ file, value, sha256: digest(bytes), modified: (await stat(file)).mtimeMs })
    } catch (error) { rejected.push({ file: relative(root, file), reason: error.message }) }
  }
  accepted.sort((a, b) => b.modified - a.modified)
  assert.ok(accepted.length > 0, 'Run the independent T-002 gate for this source before joining metadata; no matching receipt: ' + JSON.stringify(rejected))
  const original = accepted[0]
  await writeFile(join(evidence, 'reused-notification-events-receipt.json'), JSON.stringify(original.value, null, 2) + '\n')
  return { original: relative(root, original.file), sha256: original.sha256, candidateBase: original.value.candidateBase,
    sourceSHA256: original.value.sourceSHA256, assertions: original.value.variants[0].assertions,
    mutants: original.value.variants.filter(variant => variant.name !== 'candidate').map(variant => variant.name),
    reused: true, reexecuted: false }
}
async function callers() {
  for (const [file, wanted] of [
    [src + 'App.tsx', ['GlobalSystemNotices']],
    [src + 'components/GlobalSystemNotices.tsx', ['NotificationGroup', 'useServiceNotices', 'groupNotifications']],
    [src + 'components/NotificationGroup.tsx', ['NotificationItem']],
    [src + 'components/ServiceNoticeDisclosure.tsx', ['useServiceNotices']]
  ]) {
    const source = await readFile(join(root, file), 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), found = new Set()
    function visit(node) {
      const name = ts.isCallExpression(node) ? node.expression.getText(ast)
        : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName.getText(ast) : null
      if (wanted.includes(name)) found.add(name)
      ts.forEachChild(node, visit)
    }
    visit(ast); assert.equal(found.size, wanted.length, 'Nonempty actual outside-definition consumer group: ' + file)
    receipt.callers.push({ file, names: [...found], sha256: digest(source) })
  }
}
try {
  if (modes.includes('--behavior')) {
    await callers()
    receipt.green = await test('candidate-green')
    assert.equal(receipt.green.code, 0, 'Candidate interactions must be green before mutation'); assert.equal(receipt.green.passed, receipt.green.total)
    const mutations = [
      { name: 'popover-detached-from-bell', file: src + 'components/GlobalSystemNotices.tsx',
        from: 'computePosition(trigger, details,',
        to: "computePosition({ contextElement: trigger, getBoundingClientRect: () => document.querySelector('.agent-input-stack')!.getBoundingClientRect() }, details,",
        expected: 'positions the original popover from its invoking bell' },
      { name: 'opening-marks-unseen-read', file: src + 'components/GlobalSystemNotices.tsx',
        from: "onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.newState === 'open') }}",
        to: "onToggle={(event) => { if (event.target === event.currentTarget) { setOpen(event.newState === 'open'); if (event.newState === 'open') { for (const inbox of inboxes) inbox.acknowledge(inbox.notices); eventInbox.acknowledge(events.map(event => event.id)) } } }}",
        expected: 'opening, closing and changing filters never mark unseen' },
      { name: 'different-objects-merged', file: src + 'lib/notification-center.ts',
        from: 'const key = JSON.stringify([entry.category, entry.subject.key])', to: 'const key = JSON.stringify([entry.category])',
        expected: 'groups 98 current facts by exact objects' },
      { name: 'local-read-disconnected', file: src + 'lib/use-service-notices.ts',
        from: "const targetScope = item.readKey ? item.readScope ?? 'global:sessions' : scope", to: 'const targetScope = scope',
        expected: 'local and global views share one exact original service read receipt' }
    ]
    for (const mutation of mutations) {
      const original = await readFile(join(root, mutation.file), 'utf8')
      assert.equal(original.split(mutation.from).length, 2, 'One original production mutation seam: ' + mutation.name)
      const variant = original.replace(mutation.from, mutation.to)
      assert.notEqual(variant, original)
      const red = await test(mutation.name, { ...mutation, variant })
      assert.notEqual(red.code, 0); assert.ok(red.assertionRed.some(name => name.includes(mutation.expected)), 'The exact behavioral assertion must kill this mutation: ' + mutation.name)
      receipt.mutations.push({ name: mutation.name, file: mutation.file, originalSha256: digest(original), loadedSha256: digest(variant), productionWritten: false, red })
      console.log('PASS private mutation: ' + mutation.name)
    }
    receipt.restored = await test('restored-green')
    assert.equal(receipt.restored.code, 0); assert.equal(receipt.restored.passed, receipt.restored.total)
    assert.deepEqual(receipt.restored.files, receipt.green.files, 'Restored candidate uses the exact same loaded source set')
  }
  if (modes.includes('--events')) {
    receipt.events = await consumeEventsReceipt()
    receipt.metadata = { green: await test('event-metadata-green', undefined, true) }
    assert.equal(receipt.metadata.green.code, 0); assert.equal(receipt.metadata.green.passed, receipt.metadata.green.total)
    const file = src + 'components/GlobalSystemNotices.tsx', original = await readFile(join(root, file), 'utf8')
    const seam = /historyEntries\.push\(\{\s*\.\.\.eventPresentation\(event\),/gu
    assert.equal([...original.matchAll(seam)].length, 1, 'One actual event presentation consumer is mutated')
    const variant = original.replace(seam, match => match + ' timestamp: undefined, occurrences: undefined,')
    const red = await test('event-metadata-disconnected', { file, variant }, true)
    assert.notEqual(red.code, 0)
    assert.ok(red.assertionRed.some(name => name.includes('event metadata: repeat receipt time and observations')), 'The UI receipt metadata assertion must kill removed metadata consumption')
    receipt.metadata.mutation = { name: 'event-metadata-disconnected', file, originalSha256: digest(original), loadedSha256: digest(variant), productionWritten: false, red }
    receipt.metadata.restored = await test('event-metadata-restored', undefined, true)
    assert.equal(receipt.metadata.restored.code, 0); assert.equal(receipt.metadata.restored.passed, receipt.metadata.restored.total)
    assert.deepEqual(receipt.metadata.restored.files, receipt.metadata.green.files, 'Restored event metadata reads the original candidate inputs')
  }
  if (modes.includes('--visual')) {
    receipt.product = await captureNotificationCenter({ root, evidence: join(evidence, 'product') })
    await writeFile(join(evidence, 'review.md'), '# Notification center candidate review\n\nSource identity: `' + receipt.product.sourceIdentity + '`\n\nCapture only; independent aesthetic review is not performed by this command.\n\n' +
      receipt.product.render.frames.map(frame => `- [${frame.file}](product/${frame.file})`).join('\n') + '\n')
  }
  receipt.sourceAfter = await pin(owned)
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Candidate source must remain unchanged throughout qualification')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure?.message }))
if (!receipt.passed) process.exitCode = 1
