import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), index = process.argv.indexOf('--evidence')
assert.ok(index >= 0 && process.argv[index + 1], 'Use --evidence <private evidence directory>')
const evidence = resolve(process.argv[index + 1])
const prefix = 'apps/desktop/src/'
const sources = [
  'shared/focus-preferences.ts', 'shared/config-edit.ts', 'main/config-store.ts', 'main/settings/modules/focus.ts',
  'renderer/src/components/settings/FocusSettingsPane.tsx', 'renderer/src/components/settings/FocusSettingsPreview.tsx',
  'renderer/src/components/settings/modules/focus.tsx'
].map(file => prefix + file)
await verifyRendererSourceMutations({ name: 'focus-topic-presentation-setting', evidenceRoot: evidence,
  owningConfig: 'apps/desktop/test/vitest.focus-topic-presentation.config.mts',
  tests: ['apps/desktop/test/focus-topic-presentation-control.test.ts', 'apps/desktop/test/focus-topic-presentation-settings.test.tsx'],
  sources: ['vitest.config.ts', 'vitest.dist-freshness.ts', 'test/fixture-values.mjs', 'apps/desktop/test/vitest.mote-context.config.mts', ...sources],
  mutations: [
    { label: 'schema-must-reject-unknown-topic-mode', file: prefix + 'main/config-store.ts',
      before: 'topicPresentation: z.enum(FOCUS_TOPIC_PRESENTATIONS).optional()', after: 'topicPresentation: z.string().optional()' },
    { label: 'public-writer-must-preserve-the-authored-mode', file: prefix + 'main/settings/modules/focus.ts',
      before: '...config.focus, topicPresentation }', after: "...config.focus, topicPresentation: 'cards' }" },
    { label: 'first-gui-edit-must-normalize-the-default', file: prefix + 'shared/config-edit.ts',
      before: "if (path === 'focus.topicPresentation') return resolveFocusTopicPresentation(value)", after: "if (path === 'focus.topicPresentation') return value" },
    { label: 'gui-choice-must-author-the-selected-mode', file: prefix + 'renderer/src/components/settings/FocusSettingsPane.tsx',
      before: "change('topicPresentation', value, 'board')", after: "change('topicPresentation', 'cards', 'board')" },
    { label: 'preview-must-consume-the-authored-mode', file: prefix + 'renderer/src/components/settings/FocusSettingsPreview.tsx',
      before: 'topicPresentation={values.topicPresentation}', after: 'topicPresentation="cards"' }
  ] })

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const processEvidence = join(evidence, 'config-process')
await mkdir(processEvidence, { recursive: true })
const critical = [...sources, 'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/settings-control.ts',
  'apps/desktop/test/focus-topic-presentation-restart.test.ts', 'apps/desktop/test/vitest.focus-topic-presentation.config.mts']
const inputHashes = Object.fromEntries(await Promise.all(critical.map(async file => [file, digest(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.focus-topic-presentation-config-process.v1', passed: false, userRuntimeTouched: false,
  inputHashes, originalLoadedOwners: [], boundary: 'Private original ConfigStore/ConfigOwner/public settings only. Independent process write/read and explicit private filenames; no Session, Run, workspace lifecycle, external service or installed app is operated.' }
if (process.env.AGENTMUX_TOPIC_SETTINGS_PROCESS_RECEIPT) {
  const path = resolve(process.env.AGENTMUX_TOPIC_SETTINGS_PROCESS_RECEIPT), saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.schema, receipt.schema); assert.equal(saved.passed, true); assert.equal(saved.userRuntimeTouched, false)
  assert.deepEqual(saved.inputHashes, inputHashes); assert.equal(saved.phases.length, 2); assert.notEqual(saved.phases[0].pid, saved.phases[1].pid)
  assert.deepEqual(saved.phases.map(phase => [phase.phase, phase.topicPresentation]), [['write', 'sections'], ['read', 'sections']])
  assert.deepEqual(saved.phases[0].coreFields, saved.phases[1].coreFields); assert.ok(saved.originalLoadedOwners.length >= 6); assert.equal(saved.logs.length, 2)
  assert.equal(saved.cleanup.privateRootRemoved, true)
  for (const owner of saved.originalLoadedOwners) { assert.equal(owner.originalSHA256, owner.loadedSHA256); assert.equal(owner.originalSHA256, inputHashes[owner.path]) }
  for (const log of saved.logs) assert.equal(digest(await readFile(join(dirname(path), log.file))), log.sha256)
  console.log(JSON.stringify({ passed: true, exactConfigProcessEvidenceReused: true, receipt: path })); process.exit(0)
}
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-topic-setting-')), run = promisify(execFile)
try {
  receipt.phases = []; receipt.logs = []
  for (const phase of ['write', 'read']) {
    const phaseReceipt = join(processEvidence, phase + '.json'), loaded = join(processEvidence, phase + '-loaded.ndjson')
    await writeFile(loaded, '')
    const outcome = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.focus-topic-presentation.config.mts', 'apps/desktop/test/focus-topic-presentation-restart.test.ts'], {
      cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AGENTMUX_TOPIC_SETTINGS_PHASE: phase, AGENTMUX_TOPIC_SETTINGS_FILE: join(privateRoot, 'agentmux.config.json'),
        AGENTMUX_TOPIC_SETTINGS_DIRECTORY: privateRoot, AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'),
        AGENTMUX_TOPIC_SETTINGS_PROCESS_RECEIPT: phaseReceipt, AGENTMUX_TOPIC_SETTINGS_LOADED: loaded }
    })
    const log = outcome.stdout + outcome.stderr, file = phase + '-process.log'
    await writeFile(join(processEvidence, file), log); assert.match(log, /Tests\s+1 passed/)
    receipt.logs.push({ file, sha256: digest(log) })
    receipt.phases.push(JSON.parse(await readFile(phaseReceipt, 'utf8')))
    const loadedOwners = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (const path of ['apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/settings/modules/focus.ts']) assert.ok(loadedOwners.some(owner => owner.path === path), 'Actual original process owner loaded: ' + path)
    for (const owner of loadedOwners) { assert.equal(owner.originalSHA256, owner.loadedSHA256); assert.equal(owner.originalSHA256, inputHashes[owner.path]); receipt.originalLoadedOwners.push(owner) }
  }
  assert.notEqual(receipt.phases[0].pid, receipt.phases[1].pid)
  assert.equal(receipt.phases[0].topicPresentation, 'sections'); assert.equal(receipt.phases[1].topicPresentation, 'sections')
  assert.deepEqual(receipt.phases[0].coreFields, receipt.phases[1].coreFields)
  for (const [path, hash] of Object.entries(inputHashes)) assert.equal(digest(await readFile(join(root, path))), hash)
  receipt.passed = true
} finally {
  await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup = { privateRootRemoved: true }
  await writeFile(join(processEvidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, userRuntimeTouched: false, receipt: join(processEvidence, 'receipt.json') }))
