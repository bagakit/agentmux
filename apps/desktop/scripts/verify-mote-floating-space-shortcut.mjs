import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

// Reuse the established private Source proof contract for this small Closure.
// No Renderer compilation, application launch or user Run belongs to this command.
const repository = resolve(import.meta.dirname, '../../..')
const commonRepository = dirname(resolve(repository, execFileSync('git', ['rev-parse', '--git-common-dir'],
  { cwd: repository, encoding: 'utf8', timeout: 10000 }).trim()))
let requestedEvidence, requestedRenderer, requestedReview, requestedIntegrationBaseline, requestedIntegrationReview, prepareOnly = false, baselineOnly = false
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--evidence-dir') requestedEvidence = args[++index]
  else if (args[index] === '--renderer-evidence') requestedRenderer = args[++index]
  else if (args[index] === '--review-evidence') requestedReview = args[++index]
  else if (args[index] === '--integration-baseline') requestedIntegrationBaseline = args[++index]
  else if (args[index] === '--integration-review') requestedIntegrationReview = args[++index]
  else if (args[index] === '--prepare-only') prepareOnly = true
  else if (args[index] === '--baseline-only') baselineOnly = true
  else if (args[index] === '--help') {
    console.log('node apps/desktop/scripts/verify-mote-floating-space-shortcut.mjs [--evidence-dir <fresh-directory>] [--renderer-evidence <receipt.json>] [--review-evidence <approved-review.json>] [--prepare-only|--baseline-only] [--integration-baseline <receipt.json> --integration-review <approved-review.json>]')
    console.log('AGENTMUX_MOTE_FLOAT_SPACE_SOURCE_EVIDENCE consumes one exact unchanged full Source receipt. Renderer and independent review selectors: AGENTMUX_MOTE_FLOAT_SPACE_RENDERER_EVIDENCE / AGENTMUX_MOTE_FLOAT_SPACE_REVIEW_EVIDENCE. Missing or stale evidence fails; Source-only success is never overall acceptance.')
    process.exit(0)
  } else throw new Error('Unknown argument: ' + args[index])
}
const requestedSource = process.env.AGENTMUX_MOTE_FLOAT_SPACE_SOURCE_EVIDENCE
requestedIntegrationBaseline ??= process.env.AGENTMUX_MOTE_FLOAT_SPACE_INTEGRATION_BASELINE
requestedIntegrationReview ??= process.env.AGENTMUX_MOTE_FLOAT_SPACE_INTEGRATION_REVIEW
assert.equal(Boolean(requestedIntegrationBaseline), Boolean(requestedIntegrationReview), 'Integration requires both current baseline and independent review')
assert.ok(!requestedIntegrationBaseline || requestedSource, 'Integration consumes an original full Source receipt')
assert.ok(!(prepareOnly && requestedSource), 'Prepare separately from exact Source receipt consumption')
assert.ok(!(baselineOnly && (prepareOnly || requestedSource)), 'Baseline preparation cannot claim or consume complete Source qualification')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = requestedEvidence ? resolve(repository, requestedEvidence) : join(repository, '.tmp/mote-floating-space-shortcut-proof-' + globalThis.crypto.randomUUID())
await mkdir(evidence, { recursive: true })
assert.ok(!(await readdir(evidence)).includes('receipt.json'), 'Use a fresh evidence directory; never replace an earlier proof')
await mkdir(join(repository, '.tmp'), { recursive: true })
const isolated = requestedSource ? null : await mkdtemp(join(repository, '.tmp/mote-floating-space-source-'))
const prefix = 'apps/desktop/src/renderer/src/'
const testFiles = ['test/mote-floating-space-shortcut.test.tsx', 'test/mote-details-panel.test.tsx', 'test/mote-file-scope.test.tsx', 'test/workbench-hidden-resize-handles.test.tsx', 'test/workspace-file-modification-time.test.ts']
const listingConsumers = { files: ['test/workspace-files.test.ts'], pattern: 'pins a directory listing to the directory it already checked|uses directory-scoped argv operations for remote file management' }
const motionConsumers = { files: ['test/mote-avatar-motion.test.tsx'], pattern: 'the default dragon and loaded original image|image pointer work excludes|all static image, dragon|ambient glyphs and images|neutral waiting and unknown|historical message identities|nearby sleeping, waiting|a saved face joins|eighty hidden faces' }
const strictConfig = 'apps/desktop/scripts/fixtures/mote-navigation-footer/tsconfig.shortcut-proof.json'
const config = 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.shortcut-proof.config.mts'
const result = { schema: 'agentmux.mote-floating-space-source-proof.v1', prepareOnly, baselineOnly, prepared: false, sourcePassed: false, passed: false,
  scope: 'Current small floating-to-Space vertical slice: real App/public tool cases, actual Source withdrawals, external production consumers and strict App Source graph. Exact separately owned private two-PID Renderer and independent images are required for overall acceptance.',
  limitations: ['No Chromium, Native/OS input, live Core/ctxmux/CLI Run, formal build/package/install or user App operation is performed by this Source command.'],
  userAppOrRunTouched: false, sharedSourceMutated: false, baseline: null, types: null, cases: [], callers: {}, inputs: {}, sourceEvidence: null,
  listingConsumers: null, motionConsumers: null,
  cleanup: { isolatedSourceCreated: isolated !== null, isolatedSourceRemoved: false } }
async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await files(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}
async function run(name, command, timeoutMs = 120000) {
  const child = spawn(process.execPath, command, { cwd: isolated, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
  let output = '', timedOut = false
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  let hardStop
  const timeout = setTimeout(() => {
    timedOut = true
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* The private command already ended. */ }
    hardStop = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Ended. */ } }, 1000)
  }, timeoutMs)
  const exit = await new Promise((accept, reject) => {
    child.once('error', reject); child.once('close', code => accept(code))
  }).finally(() => { clearTimeout(timeout); clearTimeout(hardStop) })
  const log = name + '.log'; await writeFile(join(evidence, log), output)
  return { exit, timedOut, output, log, sha256: hash(output), command: ['node', ...command] }
}
function receiptOf(run) { const { output, ...receipt } = run; return receipt }
function evidenceCandidates(path, artifactDirectory) {
  return [...new Set([repository, commonRepository, artifactDirectory].filter(Boolean).map(base => resolve(base, path)))]
}
async function selectedEvidence(path) {
  const found = []
  for (const candidate of evidenceCandidates(path)) {
    try { found.push(await realpath(candidate)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const selected = [...new Set(found)]
  assert.equal(selected.length, 1, 'Select one existing exact evidence file: ' + path)
  return selected[0]
}
async function vitest(name, selected = testFiles, pattern) {
  const output = join(evidence, name + '.json')
  const command = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, ...selected,
    '--maxWorkers=1', '--reporter=verbose', '--reporter=json', '--outputFile=' + output]
  if (pattern) command.push('--testNamePattern', pattern)
  const attempt = await run(name, command)
  assert.equal(attempt.timedOut, false, 'Finite Vitest did not finish: ' + name)
  // JSON result is mandatory: no-tests, setup/transform failures and missing output fail closed.
  const report = JSON.parse(await readFile(output, 'utf8'))
  const cases = report.testResults.flatMap(file => file.assertionResults ?? [])
  const executed = cases.filter(test => test.status === 'passed' || test.status === 'failed')
  assert.ok(executed.length > 0, 'No actual behavior cases executed: ' + name)
  for (const file of selected) {
    const actual = report.testResults.find(row => row.name.endsWith('/' + file))
    assert.ok(actual && actual.assertionResults.some(test => test.status === 'passed' || test.status === 'failed'),
      'Each requested owning file must execute actual cases: ' + file)
  }
  return { ...attempt, report: { fileCount: report.testResults.length, passed: report.numPassedTests,
    failed: report.numFailedTests, executed: executed.length, owningFiles: selected, assertions: cases.map(test => ({ name: test.fullName, status: test.status })) } }
}

const variants = [
  { name: 'original-active-group-tab-action-withdrawal', path: prefix + 'components/WorkspaceWorkbench.tsx',
    anchor: '{layout.activeGroupId === group.id ? presentationAction : null}', replacement: '{null}',
    tests: [testFiles[0]], pattern: 'uses the second complete occurrence' },
  { name: 'full-occurrence-focus-withdrawal', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: '...(destination ?? { zoneId: zone.zoneId })',
    replacement: '...(destination ? { tabId: destination.tabId, regionId: destination.regionId } : { zoneId: zone.zoneId })',
    tests: [testFiles[0]], pattern: 'uses the second complete occurrence' },
  { name: 'same-target-tab-guard-withdrawal', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: 'destination.tabId !== tabId || ', replacement: '',
    tests: [testFiles[0]], pattern: 'rejects a raw reference that is another Tab' },
  { name: 'full-current-navigation-admission-withdrawal', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: 'navigationPosition(state) === beforePosition',
    replacement: 'state.mainSurface === navigation.mainSurface && state.activeWorkspaceId === navigation.activeWorkspaceId',
    tests: [testFiles[0]], pattern: 'keeps a later same-workspace Region selection' },
  { name: 'synchronous-floating-intent-latch-withdrawal', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: 'if (floatingIntent() !== intent) controller.abort()', replacement: '/* Withdrawal loses the original synchronous Group A-B-A intent. */',
    tests: [testFiles[0]], pattern: 'latches a same-Tab Group A→B→A' },
  { name: 'original-empty-space-active-pane-withdrawal', path: prefix + 'lib/mote-materials-actions.ts',
    anchor: 'choice.groupId ?? state.layouts[choice.workspaceId]?.activeGroupId', replacement: 'choice.groupId',
    tests: [testFiles[1]], pattern: 'opens an empty Mote self-setting in its original Space active Group' },
  { name: 'hidden-public-resize-registration-withdrawal', path: prefix + 'components/WorkspaceWorkbench.tsx',
    anchor: 'disabled={!surfaceVisible || projection?.placementConfirmed === false}',
    replacement: 'disabled={projection?.placementConfirmed === false}',
    tests: [testFiles[3]], pattern: 'unregisters hidden public Group and Region resize handles' },
  { name: 'local-regular-file-time-withdrawal', path: 'apps/desktop/src/main/workspace-files.ts',
    anchor: 'if (metadata.isFile() && Number.isFinite(metadata.mtimeMs)) result.mtimeMs = metadata.mtimeMs',
    replacement: '/* Withdrawal retains the entry but loses its confirmed regular-file timestamp. */',
    tests: [testFiles[4]], pattern: 'returns actual local regular-file mtime' },
  { name: 'ssh-time-unit-withdrawal', path: 'apps/desktop/src/main/workspace-files.ts',
    anchor: 'Number(timestamp) * 1000', replacement: 'Number(timestamp)',
    tests: [testFiles[4]], pattern: 'executes the original single SSH listing batch' },
  { name: 'profile-recent-order-withdrawal', path: prefix + 'components/MoteDetailsPanel.tsx',
    anchor: '.sort((a, b) => b.mtimeMs! - a.mtimeMs!).slice(0, 3)', replacement: '.slice(0, 3)',
    tests: [testFiles[1]], pattern: 'uses finite authoritative times' },
  { name: 'profile-recent-exact-path-withdrawal', path: prefix + 'components/MoteDetailsPanel.tsx',
    anchor: 'setSelected(entry.path); onShowIdeas()', replacement: 'setSelected(null); onShowIdeas()',
    tests: [testFiles[1]], pattern: 'uses finite authoritative times' },
  { name: 'profile-name-target-capture-withdrawal', path: prefix + 'components/MoteDetailsPanel.tsx',
    anchor: 'target={rename}', replacement: 'target={rename ? { topic: scope.topic, workspace: scope.workspace } : null}',
    tests: [testFiles[1]], pattern: 'keeps an opened rename draft bound' },
  { name: 'avatar-close-later-focus-withdrawal', path: prefix + 'components/SpaceIconPicker.tsx',
    anchor: '(active === document.body || active === row || !active?.isConnected || content.current?.contains(active))', replacement: 'true',
    tests: [testFiles[1]], pattern: 'lets later original input focus win' },
  { name: 'profile-avatar-trigger-withdrawal', path: prefix + 'components/MoteDetailsPanel.tsx',
    anchor: 'setAvatar({ ...iconTarget, name: scope.topic.title })', replacement: 'setAvatar(null)',
    tests: [testFiles[1]], pattern: 'uses the original avatar and name modal targets' },
  { name: 'profile-avatar-target-capture-withdrawal', path: prefix + 'components/MoteDetailsPanel.tsx',
    anchor: 'target={avatar}', replacement: 'target={avatar ? { ...iconTarget, name: scope.topic.title } : null}',
    tests: [testFiles[1]], pattern: 'keeps an opened avatar choice' },
  { name: 'explicit-avatar-return-null-withdrawal', path: prefix + 'components/SpaceIconPicker.tsx',
    anchor: "const row = returnFocus ? returnFocus() : [...document.querySelectorAll<HTMLElement>('[data-space-icon-target]')]\n            .find(node => node.dataset.spaceIconTarget === returnKey.current)",
    replacement: "const row = returnFocus?.() ?? [...document.querySelectorAll<HTMLElement>('[data-space-icon-target]')]\n            .find(node => node.dataset.spaceIconTarget === returnKey.current)",
    tests: [testFiles[1]], pattern: 'keeps an opened avatar choice' },
  { name: 'image-rig-admission-withdrawal', path: prefix + 'lib/mote-face-motion.ts',
    anchor: "if (enabled && identity.node.querySelector('.mote-face, .mote-image-follow')) rigs.add(identity)",
    replacement: "if (enabled && identity.node.querySelector('.mote-face')) rigs.add(identity)",
    tests: motionConsumers.files, pattern: 'the default dragon and loaded original image' },
  { name: 'image-rig-paint-withdrawal', path: prefix + 'lib/mote-face-motion.ts',
    anchor: "const rig = identity.node.querySelector('.mote-face, .mote-image-follow'), rect = rig?.getBoundingClientRect()",
    replacement: "const rig = identity.node.querySelector('.mote-face'), rect = rig?.getBoundingClientRect()",
    tests: motionConsumers.files, pattern: 'the default dragon and loaded original image' },
  { name: 'image-offscreen-work-withdrawal', path: prefix + 'lib/mote-face-motion.ts',
    anchor: 'identity.visible && identity.inView && !document.hidden && !reduced.matches',
    replacement: 'identity.visible && !document.hidden && !reduced.matches',
    tests: motionConsumers.files, pattern: 'image pointer work excludes' },
  { name: 'sleep-visible-presentation-withdrawal', path: prefix + 'styles/space-object-appearance.css',
    anchor: '.mote-identity-motion[data-mote-expression="sleep"] .mote-face__awake-eyes { display: none; transform-box: fill-box; transform-origin: center; transform: scaleY(.55); }',
    replacement: '.mote-identity-motion[data-mote-expression="sleep"] .mote-face__awake-eyes { display: none; transform-box: fill-box; transform-origin: center; transform: scaleY(.55); }\n.mote-identity-motion[data-mote-expression="sleep"][data-mote-gaze="near"] .mote-face__awake-eyes { display: block; }\n.mote-identity-motion[data-mote-expression="sleep"][data-mote-gaze="near"] .mote-face__sleep-eyes { display: none; }',
    tests: motionConsumers.files, pattern: 'nearby sleeping, waiting' }
]
const callerSpecs = [
  ['Mote context owner', prefix + 'components/MoteWorkface.tsx', /<MoteWorkface\b/, prefix + 'App.tsx'],
  ['floating context consumer', prefix + 'components/MoteWorkface.tsx', /<MoteWorkface\b/, prefix + 'components/PmoTeamsTopicFloatingPanel.tsx'],
  ['public Workbench action consumer', prefix + 'components/WorkspaceWorkbench.tsx', /presentationAction=\{/, prefix + 'components/PmoTeamsTopicFloatingPanel.tsx'],
  ['original public focus resolution consumer', prefix + 'lib/desktop-focus-navigation.ts', /resolveDesktopSpaceSelection\(/, prefix + 'store.ts'],
  ['public focus owner', prefix + 'store.ts', /\.executeControl\(/, prefix + 'components/PmoTeamsTopicFloatingPanel.tsx'],
  ['original object details consumer', prefix + 'components/MoteDetailsPanel.tsx', /<MoteDetailsPanel\b/, prefix + 'components/SurfaceToolDock.tsx'],
  ['original Space materials consumer', prefix + 'lib/mote-materials-actions.ts', /useMoteMaterialsActions\(/, prefix + 'components/SurfaceToolDock.tsx'],
  ['retained exact file context-menu consumer', prefix + 'lib/mote-materials-actions.ts', /useMoteMaterialsActions\(/, prefix + 'components/PmoTeamsTopicFloatingPanel.tsx'],
  ['original FileExplorer consumer', prefix + 'components/FileExplorer.tsx', /<FileExplorer\b/, prefix + 'components/SurfaceToolDock.tsx'],
  ['original avatar Picker consumer', prefix + 'components/SpaceIconPicker.tsx', /<SpaceIconPicker\b/, prefix + 'components/MoteDetailsPanel.tsx'],
  ['original name Dialog consumer', prefix + 'components/MoteRenameDialog.tsx', /<MoteRenameDialog\b/, prefix + 'components/MoteDetailsPanel.tsx'],
  ['original Main directory service consumer', 'apps/desktop/src/main/workspace-files.ts', /\.readDirectory\(/, 'apps/desktop/src/main/ipc.ts'],
  ['original IPC preload transport consumer', 'apps/desktop/src/main/ipc.ts', /ipcRenderer\.invoke\('files:readDirectory',\s*workspaceId,\s*path\)/, 'apps/desktop/src/preload/index.ts'],
  ['original directory API consumer', prefix + 'lib/api.ts', /api\.files\.readDirectory\(/, prefix + 'components/file-tree/useWorkspaceFileTree.ts'],
  ['original notes tree consumer', prefix + 'components/file-tree/useWorkspaceFileTree.ts', /useWorkspaceFileTree\(/, prefix + 'components/MoteDetailsPanel.tsx'],
  ['original public identity motion consumer', prefix + 'components/MoteIdentityMotion.tsx', /<MoteIdentityMotion\b/, prefix + 'components/SpaceObjectIcon.tsx'],
  ['original single motion event owner consumer', prefix + 'lib/mote-face-motion.ts', /observeMoteMotion\(/, prefix + 'components/MoteIdentityMotion.tsx'],
  ['original public entry identity consumer', prefix + 'components/SpaceObjectIcon.tsx', /<SpaceObjectIcon\b/, prefix + 'components/PmoTeamsTopicEntry.tsx'],
  ['original floating identity consumer', prefix + 'components/SpaceObjectIcon.tsx', /<SpaceObjectIcon\b/, prefix + 'components/PmoTeamsTopicFloatingPanel.tsx'],
  ['original Profile identity consumer', prefix + 'components/SpaceObjectIcon.tsx', /<SpaceObjectIcon\b/, prefix + 'components/MoteDetailsPanel.tsx']
]
// These are the existing narrow producer's actual Source inputs, check IDs and
// frame roles. A matching label alone cannot replace any required interaction.
const rendererRequiredInputs = [prefix + 'App.tsx', ...['PmoTeamsTopicFloatingPanel', 'WorkspaceWorkbench', 'MoteWorkface'].map(name => prefix + 'components/' + name + '.tsx'),
  ...['MoteDetailsPanel', 'SpaceIconPicker', 'MoteRenameDialog', 'SpaceObjectIcon', 'MoteIdentityMotion'].map(name => prefix + 'components/' + name + '.tsx'),
  prefix + 'lib/mote-face-motion.ts', prefix + 'styles/space-object-appearance.css',
  prefix + 'lib/mote-materials-actions.ts', prefix + 'styles/mote-workface.css', 'apps/desktop/scripts/verify-mote-shared-space-frame-renderer.mjs',
  ...['main.cjs', 'entry.mjs', 'index.html', 'scenario.md', 'float-space-shortcut.cjs'].map(name => 'apps/desktop/scripts/fixtures/mote-shared-space-frame/' + name)]
const rendererRequiredChecks = {
  seed: ['Original-initialize-exact-call-baseline-one-denied-optional-warm-no-created-Run-no-later-launch',
    'Native-compact-shared-Tab-action-and-resize-preserve-original-input-caret-and-fulltuple',
    'Native-visible-original-Space-split-remains-interactive-with-identities-and-drafts-preserved',
    'Native-Space-shortcut-retains-exact-occurrence-and-full-Space-profile-files-self-setting-ideas',
    'Native-empty-Mote-enters-original-Space-with-no-new-Tab-Session-or-Run',
    'Original-public-spatial-port-writer-flush-and-no-extra-Agent-or-terminal-actions',
    'Native-Profile-single-avatar-name-icon-wide-narrow-light-dark-and-original-modal-keyboard-return',
    'Native-Profile-Self-setting-opens-original-right-Editor-and-Recent-ideas-select-original-mtime-note',
    'Native-default-Mote-image-original-motion-idle-pointer-gaze-and-hidden-reduced-sleep-facts'],
  restore: ['Original-initialize-exact-call-baseline-one-denied-optional-warm-no-created-Run-no-later-launch',
    'Real-PID-restart-ordinary-durable-Space-fulltuple-draft-and-original-Run-identities',
    'Original-public-spatial-port-writer-flush-and-no-extra-Agent-or-terminal-actions']
}
const rendererRequiredFrames = {
  seed: ['wide-floating-compact-Space-shortcut', 'narrow-floating-compact-Space-shortcut', 'narrow-full-Space-profile-and-original-files',
    'wide-full-Space-self-setting-and-original-Editor', 'wide-full-Space-durable-ideas', 'wide-empty-floating-compact-Space-shortcut',
    'wide-empty-full-Space-with-original-files-and-profile',
    'wide-dark-Profile-single-avatar-and-name-icon', 'wide-light-Profile-single-avatar-and-name-icon',
    'narrow-light-long-name-Profile-single-avatar-and-name-icon', 'wide-dark-original-avatar-picker-from-Profile-avatar',
    'wide-dark-original-rename-dialog-from-name-icon'],
  restore: ['wide-second-PID-restored-compact-floating-and-original-draft']
}
async function verifyInputs(inputs) {
  assert.ok(Object.keys(inputs ?? {}).length > 100 && inputs[prefix + 'App.tsx'] && inputs[relative(repository, import.meta.filename)], 'Actual App and verifier input graph must be nonempty')
  for (const [path, digest] of Object.entries(inputs)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Source input is repository relative')
    assert.equal(hash(await readFile(join(repository, path))), digest, 'Evidence is stale for current Source: ' + path)
  }
}
async function publishedSdkIdentity() {
  const manifestPath = 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json'
  const manifestBytes = await readFile(join(repository, manifestPath)), manifest = JSON.parse(manifestBytes)
  const contract = JSON.parse(await readFile(join(repository, 'packages/core/src/ctxmux-artifact-contract.json'), 'utf8'))
  assert.equal(hash(manifestBytes), contract.manifests['darwin-arm64'])
  assert.equal(manifest.source.commit, contract.sources['darwin-arm64'].commit); assert.equal(manifest.source.tree, contract.sources['darwin-arm64'].tree)
  assert.equal(manifest.source.worktree_clean, true); assert.equal(manifest.sdk.protocol, contract.protocol)
  const archivePath = 'packages/core/vendor/ctxmux/darwin-arm64/' + manifest.sdk.archive.path
  const archive = join(repository, archivePath), archiveBytes = await readFile(archive)
  assert.equal(hash(archiveBytes), manifest.sdk.archive.sha256); assert.equal(archiveBytes.length, manifest.sdk.archive.bytes)
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 10000 }).split('\n').filter(Boolean)
  assert.equal(entries.length, manifest.sdk.entry_count)
  for (const entry of entries) assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..') && !entry.endsWith('/'), 'Published SDK contains only bounded package files')
  const comparison = await mkdtemp(join(repository, '.tmp/mote-sdk-identity-'))
  const packageDirectory = join(repository, 'packages/core/node_modules/@ctxmux/sdk'), files = {}
  try {
    execFileSync('tar', ['-xzf', archive, '-C', comparison], { timeout: 10000 })
    for (const entry of entries) {
      const path = entry.slice('package/'.length), digest = hash(await readFile(join(comparison, entry)))
      assert.equal(hash(await readFile(join(packageDirectory, path))), digest, 'Installed SDK file must be the published original: ' + path)
      files[path] = digest
    }
  } finally { await rm(comparison, { recursive: true, force: true }) }
  return { manifestPath, manifestSha256: hash(manifestBytes), archivePath, archiveSha256: hash(archiveBytes),
    protocol: manifest.sdk.protocol, fileCount: entries.length, files,
    declarationPath: relative(repository, await realpath(join(packageDirectory, 'dist/index.d.ts'))),
    declarationSha256: files['dist/index.d.ts'], comparisonCopyRemoved: true }
}
function requireSdkInputs(inputs) {
  for (const [path, digest] of [[result.sdkIdentity.manifestPath, result.sdkIdentity.manifestSha256], [result.sdkIdentity.archivePath, result.sdkIdentity.archiveSha256]])
    assert.equal(inputs[path], digest, 'The actual published SDK identity must belong to the complete Source graph')
}
async function consumeSource(path) {
  const bytes = await readFile(path), cached = JSON.parse(bytes), directory = dirname(path)
  assert.equal(cached.schema, result.schema); assert.equal(cached.prepareOnly, false); assert.equal(cached.sourcePassed, true)
  assert.equal(cached.baselineOnly, false)
  if (!requestedIntegrationBaseline) {
    await verifyInputs(cached.inputs); requireSdkInputs(cached.inputs)
    assert.deepEqual(cached.sdkIdentity, result.sdkIdentity, 'Cached strict proof must consume the exact published SDK')
  }
  assert.equal(cached.baseline?.exit, 0); assert.equal(cached.baseline?.timedOut, false)
  assert.equal(cached.baseline?.report?.failed, 0); assert.ok(cached.baseline?.report?.passed > 0)
  for (const file of testFiles) assert.ok(cached.baseline.report.owningFiles?.includes(file) && cached.baseline.report.assertions.some(test => test.status === 'passed' && test.name.length > 0), 'Original nonempty owning assertions required: ' + file)
  assert.equal(cached.types?.exit, 0); assert.equal(cached.types?.timedOut, false)
  assert.ok(['--noEmit', '--strict', '--listFiles'].every(flag => cached.types.command?.includes(flag)))
  assert.equal(cached.cases?.length, variants.length)
  assert.equal(cached.listingConsumers?.exit, 0); assert.equal(cached.listingConsumers?.timedOut, false)
  assert.equal(cached.listingConsumers?.report?.failed, 0); assert.ok(cached.listingConsumers?.report?.passed >= 2)
  assert.ok(listingConsumers.files.every(file => cached.listingConsumers.report.owningFiles.includes(file)))
  assert.equal(cached.motionConsumers?.exit, 0); assert.equal(cached.motionConsumers?.timedOut, false)
  assert.equal(cached.motionConsumers?.report?.failed, 0); assert.ok(cached.motionConsumers?.report?.passed > 0)
  assert.ok(motionConsumers.files.every(file => cached.motionConsumers.report.owningFiles.includes(file)))
  const logs = [cached.baseline, cached.types, cached.listingConsumers, cached.motionConsumers]
  for (const variant of variants) {
    const entry = cached.cases.find(row => row.name === variant.name)
    assert.ok(entry); assert.equal(entry.path, variant.path); assert.equal(entry.anchor, variant.anchor); assert.equal(entry.replacement, variant.replacement)
    for (const run of [entry.red, entry.green]) {
      assert.ok(variant.tests.every(file => run.command?.includes(file)), 'Original actual withdrawal test selection must be unchanged')
      assert.equal(run.command?.[run.command.indexOf('--testNamePattern') + 1], variant.pattern, 'Original actual withdrawal oracle must be unchanged')
    }
    assert.equal(entry.originalSha256, cached.inputs[variant.path]); assert.equal(entry.restored, true)
    assert.notEqual(entry.red?.exit, 0); assert.equal(entry.red?.timedOut, false); assert.ok(entry.red?.report?.failed > 0)
    assert.equal(entry.green?.exit, 0); assert.equal(entry.green?.timedOut, false); assert.equal(entry.green?.report?.failed, 0); assert.ok(entry.green?.report?.passed > 0)
    const red = await readFile(join(directory, entry.red.log), 'utf8')
    assert.match(red, /AssertionError:/u); assert.doesNotMatch(red, /No test files found|Failed to load url|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/iu)
    logs.push(entry.red, entry.green)
  }
  for (const log of logs) {
    assert.ok(log.log && !log.log.split('/').includes('..'))
    assert.equal(hash(await readFile(join(directory, log.log))), log.sha256, 'Original log bytes must be preserved')
  }
  const strictLog = await readFile(join(directory, cached.types.log), 'utf8')
  for (const path of [prefix + 'App.tsx', 'apps/desktop/src/main/workspace-files.ts'])
    assert.ok(strictLog.split('\n').some(line => line.trim().endsWith('/' + path)), 'Original strict log must contain actual Source: ' + path)
  for (const [name, definition, , expected] of callerSpecs) {
    const hits = cached.callers?.[name]
    assert.ok(hits?.length > 0 && hits.some(hit => hit.path === expected && hit.path !== definition && hit.line > 0 && hit.text.length > 0), 'Missing original external consumer: ' + name)
  }
  const integrated = requestedIntegrationBaseline ? await consumeIntegration(cached, bytes) : null
  const current = integrated?.baseline ?? cached
  result.inputs = current.inputs; result.baseline = current.baseline; result.types = current.types; result.cases = cached.cases; result.callers = current.callers; result.listingConsumers = current.listingConsumers; result.motionConsumers = current.motionConsumers
  result.prepared = true; result.sourcePassed = true
  result.sourceEvidence = { used: true, receipt: relative(commonRepository, path), sha256: hash(bytes), testsRerun: false, mutantsRerun: false, verifiedInputs: Object.keys(current.inputs).length,
    ...(integrated ? { integration: integrated.receipt, scope: 'Unchanged original Mote withdrawals plus current baseline, external callers and strict App/Main integration. Public Core and Conversation features remain owned by their own acceptance.' } : {}) }
}
async function consumeIntegration(original, originalBytes) {
  const baselinePath = await selectedEvidence(requestedIntegrationBaseline), baselineBytes = await readFile(baselinePath)
  const baseline = JSON.parse(baselineBytes), baselineDirectory = dirname(baselinePath)
  const reviewPath = await selectedEvidence(requestedIntegrationReview), reviewBytes = await readFile(reviewPath), review = JSON.parse(reviewBytes)
  assert.equal(baseline.schema, result.schema); assert.equal(baseline.prepared, true)
  assert.equal(baseline.prepareOnly, false); assert.equal(baseline.baselineOnly, true)
  assert.equal(baseline.sourcePassed, false); assert.equal(baseline.passed, false); assert.ok(!baseline.failure)
  assert.deepEqual(baseline.cases, []); assert.equal(baseline.cleanup?.isolatedSourceRemoved, true)
  await verifyInputs(baseline.inputs)
  requireSdkInputs(baseline.inputs); assert.deepEqual(baseline.sdkIdentity, result.sdkIdentity)
  const delta = [...new Set([...Object.keys(original.inputs), ...Object.keys(baseline.inputs)])].sort()
    .filter(path => original.inputs[path] !== baseline.inputs[path])
    .map(path => ({ path, beforeSha256: original.inputs[path] ?? null, afterSha256: baseline.inputs[path] ?? null }))
  assert.ok(delta.length > 0, 'Integration must describe an actual complete input change')
  const unchanged = new Set([...variants.map(row => row.path),
    ...[...testFiles, ...listingConsumers.files, ...motionConsumers.files].map(file => 'apps/desktop/' + file),
    ...callerSpecs.flatMap(([, definition, , expected]) => [definition, expected]),
    ...Object.values(original.callers).flatMap(hits => hits.map(hit => hit.path))])
  for (const path of unchanged) {
    assert.ok(original.inputs[path] && baseline.inputs[path], 'A reused producer, test or caller must exist in both exact input graphs: ' + path)
    assert.equal(baseline.inputs[path], original.inputs[path], 'Changed producer, owning test or original caller cannot reuse a withdrawal: ' + path)
  }
  for (const [key, minimum] of [['baseline', 41], ['listingConsumers', 2], ['motionConsumers', 9]]) {
    const run = baseline[key], old = original[key]
    assert.equal(run?.exit, 0); assert.equal(run?.timedOut, false); assert.equal(run?.report?.failed, 0)
    assert.equal(run.report.executed, minimum); assert.equal(run.report.passed, minimum)
    assert.deepEqual(run.report.owningFiles, old.report.owningFiles)
    const byName = rows => [...rows].sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(byName(run.report.assertions), byName(old.report.assertions), 'Integration must retain every original case and assertion')
    const log = await readFile(join(baselineDirectory, run.log), 'utf8')
    assert.equal(hash(log), run.sha256)
    assert.doesNotMatch(log, /No test files found|Failed to load url|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/iu)
    const actual = JSON.parse(await readFile(join(baselineDirectory, run.log.replace(/\.log$/u, '.json')), 'utf8'))
    assert.equal(actual.numPassedTests, minimum); assert.equal(actual.numFailedTests, 0)
    assert.deepEqual(actual.testResults.flatMap(file => file.assertionResults ?? []).map(test => ({ name: test.fullName, status: test.status })), run.report.assertions)
  }
  assert.equal(baseline.types?.exit, 0); assert.equal(baseline.types?.timedOut, false)
  assert.ok(['--noEmit', '--strict', '--listFiles'].every(flag => baseline.types.command?.includes(flag)))
  const strictLog = await readFile(join(baselineDirectory, baseline.types.log), 'utf8')
  assert.equal(hash(strictLog), baseline.types.sha256)
  for (const path of [prefix + 'App.tsx', 'apps/desktop/src/main/workspace-files.ts'])
    assert.ok(strictLog.split('\n').some(line => line.trim().endsWith('/' + path)), 'Current strict graph must include actual App and Main Source')
  assert.ok(strictLog.split('\n').some(line => line.trim() === join(repository, result.sdkIdentity.declarationPath)), 'Current strict proof must actually read the published SDK declaration')
  for (const [name, definition, , expected] of callerSpecs) {
    const hits = baseline.callers?.[name]
    assert.ok(hits?.length > 0 && hits.some(hit => hit.path === expected && hit.path !== definition && hit.line > 0 && hit.text.length > 0))
    for (const hit of hits) assert.equal((await readFile(join(repository, hit.path), 'utf8')).split('\n')[hit.line - 1]?.trim(), hit.text, 'Current external consumer must be actual Source')
  }
  const verifier = relative(repository, import.meta.filename)
  assert.equal(review.schema, 'agentmux.mote-floating-space-integration-review.v1'); assert.equal(review.status, 'approved')
  assert.ok(typeof review.independence === 'string' && review.independence.trim().length > 0)
  assert.equal(review.originalSourceSha256, hash(originalBytes)); assert.equal(review.currentBaselineSha256, hash(baselineBytes))
  assert.equal(review.originalVerifierSha256, original.inputs[verifier]); assert.equal(review.currentVerifierSha256, baseline.inputs[verifier])
  assert.deepEqual(review.delta, delta, 'Independent integration review must bind every added, removed and changed input')
  assert.equal(review.scope, 'mote-floating-space-shortcut'); assert.deepEqual(review.mustFix, [])
  return { baseline, receipt: { baseline: relative(commonRepository, baselinePath), baselineSha256: hash(baselineBytes),
    review: relative(commonRepository, reviewPath), reviewSha256: hash(reviewBytes), delta,
    baselineCases: 52, baselineAndTypesRerun: true, mutantsRerun: false,
    unchangedProducerTestAndCallerCount: unchanged.size, originalVerifierSha256: original.inputs[verifier], currentVerifierSha256: baseline.inputs[verifier] } }
}
try {
  result.sdkIdentity = await publishedSdkIdentity()
  if (requestedSource) await consumeSource(await selectedEvidence(requestedSource))
  else {
    const trees = ['apps/desktop/src', 'apps/desktop/resources', 'apps/desktop/test/helpers', 'apps/desktop/test/fixtures',
      'packages/core/src', 'packages/demand/src', 'packages/layout/src', 'packages/client-ui/src']
    const paths = [result.sdkIdentity.manifestPath, result.sdkIdentity.archivePath, 'package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'docs/design/behavior/motes-and-coordination.md',
      'docs/design/presentation/motes-and-coordination.md', 'docs/design/presentation/spaces-and-layout.md',
      'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json',
      'packages/client-ui/tsconfig.json', ...['core', 'demand', 'layout', 'client-ui'].map(name => 'packages/' + name + '/package.json'),
      ...['vitest.owning.config.mts', 'vitest.chat.config.mts', 'vitest.frame.config.mts', 'tsconfig.frame.json', 'atomic-move.setup.ts'].map(name => 'apps/desktop/scripts/fixtures/mote-navigation-footer/' + name),
      ...[...testFiles, ...listingConsumers.files, ...motionConsumers.files].map(file => 'apps/desktop/' + file)]
    for (const path of [...trees, ...paths]) {
      const destination = join(isolated, path); await mkdir(dirname(destination), { recursive: true }); await cp(join(repository, path), destination, { recursive: true })
      for (const file of trees.includes(path) ? await files(destination) : [destination]) {
        const rel = relative(isolated, file), digest = hash(await readFile(file))
        assert.equal(hash(await readFile(join(repository, rel))), digest, 'Source changed during snapshot: ' + rel); result.inputs[rel] = digest
      }
    }
    result.inputs[relative(repository, import.meta.filename)] = hash(await readFile(import.meta.filename))
    await verifyInputs(result.inputs)
    for (const path of ['node_modules', 'apps/desktop/node_modules', ...['core', 'demand', 'layout', 'client-ui'].map(name => 'packages/' + name + '/node_modules')]) {
      await mkdir(dirname(join(isolated, path)), { recursive: true }); await symlink(join(repository, path), join(isolated, path), 'dir')
    }
    await writeFile(join(isolated, config), `import { defineConfig } from 'vitest/config'\nimport owning from './vitest.frame.config.mts'\nexport default defineConfig({ ...owning, cacheDir: ${JSON.stringify(join(isolated, '.tmp/vite-cache'))}, test: { ...owning.test, include: ${JSON.stringify([...testFiles, ...listingConsumers.files, ...motionConsumers.files])}, passWithNoTests: false, maxWorkers: 1 } })\n`)
    const originalStrict = JSON.parse(await readFile(join(isolated, 'apps/desktop/scripts/fixtures/mote-navigation-footer/tsconfig.frame.json'), 'utf8'))
    await writeFile(join(isolated, strictConfig), JSON.stringify({ extends: './tsconfig.frame.json', include: [...originalStrict.include, '../../../src/main/workspace-files.ts'] }))
    const productFiles = (await files(join(isolated, 'apps/desktop/src'))).filter(file => /\.[cm]?[jt]sx?$/.test(file))
    assert.ok(productFiles.length > 0, 'Production scan must be nonempty')
    for (const [name, definition, pattern, expected] of callerSpecs) {
      const hits = []
      for (const file of productFiles) if (relative(isolated, file) !== definition) {
        const lines = (await readFile(file, 'utf8')).split('\n')
        lines.forEach((line, index) => {
          if (!/^\s*(?:import|export\s+(?:type|\{|\*))/u.test(line) && !/^\s*\/\//u.test(line) && pattern.test(line))
            hits.push({ path: relative(isolated, file), line: index + 1, text: line.trim() })
        })
      }
      assert.ok(hits.length > 0 && hits.some(hit => hit.path === expected), 'Missing actual external production caller: ' + name); result.callers[name] = hits
    }
    for (const variant of variants) assert.equal((await readFile(join(isolated, variant.path), 'utf8')).split(variant.anchor).length - 1, 1, 'One exact actual Source withdrawal anchor: ' + variant.name)
    result.prepared = true
    if (!prepareOnly) {
      const types = await run('strict-app-source-noemit', ['node_modules/typescript/bin/tsc', '--project', strictConfig, '--noEmit', '--strict', '--listFiles'])
      result.types = receiptOf(types); assert.equal(types.timedOut, false); assert.equal(types.exit, 0, 'Strict actual App Source failed')
      assert.ok(types.output.split('\n').some(line => line.trim() === join(isolated, prefix + 'App.tsx')), 'Strict must consume the actual nonempty App graph')
      assert.ok(types.output.split('\n').some(line => line.trim() === join(isolated, 'apps/desktop/src/main/workspace-files.ts')), 'Strict must consume the actual Main directory implementation')
      assert.ok(types.output.split('\n').some(line => line.trim() === join(repository, result.sdkIdentity.declarationPath)), 'Strict must consume the actual published SDK declaration')
      const baseline = await vitest('original-baseline-green'); result.baseline = receiptOf(baseline)
      assert.equal(baseline.exit, 0); assert.equal(baseline.report.failed, 0); assert.ok(baseline.report.passed > 0)
      const related = await vitest('original-fs-listing-consumers-green', listingConsumers.files, listingConsumers.pattern)
      result.listingConsumers = receiptOf(related); assert.equal(related.exit, 0); assert.equal(related.report.failed, 0); assert.ok(related.report.passed >= 2)
      const motion = await vitest('original-motion-consumers-green', motionConsumers.files, motionConsumers.pattern)
      result.motionConsumers = receiptOf(motion); assert.equal(motion.exit, 0); assert.equal(motion.report.failed, 0); assert.ok(motion.report.passed > 0)
      if (!baselineOnly) for (const variant of variants) {
        const path = join(isolated, variant.path), original = await readFile(path), changed = original.toString('utf8').replace(variant.anchor, variant.replacement)
        await mkdir(join(evidence, 'owning-source'), { recursive: true })
        await writeFile(join(evidence, 'owning-source', variant.name + '.original.txt'), original)
        await writeFile(join(evidence, 'owning-source', variant.name + '.mutant.txt'), changed)
        let red
        try {
          await writeFile(path, changed); red = await vitest(variant.name + '.red', variant.tests, variant.pattern)
          assert.notEqual(red.exit, 0, 'Broken behavior survived: ' + variant.name); assert.ok(red.report.failed > 0)
          assert.match(red.output, /AssertionError:/u)
          assert.doesNotMatch(red.output, /No test files found|Failed to load url|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/iu, 'Setup failure cannot kill a behavior mutant')
        } finally { await writeFile(path, original) }
        assert.equal(hash(await readFile(path)), hash(original))
        const green = await vitest(variant.name + '.restored-green', variant.tests, variant.pattern)
        assert.equal(green.exit, 0); assert.equal(green.report.failed, 0); assert.ok(green.report.passed > 0)
        result.cases.push({ name: variant.name, path: variant.path, anchor: variant.anchor, replacement: variant.replacement,
          originalSha256: hash(original), mutatedSha256: hash(changed), restored: true, red: receiptOf(red), green: receiptOf(green) })
        console.log(variant.name + ': actual Assertion RED -> exact restored GREEN')
      }
      await verifyInputs(result.inputs); result.sourcePassed = !baselineOnly
    }
  }
  if (!prepareOnly && !baselineOnly) {
    const rendererPath = requestedRenderer ?? process.env.AGENTMUX_MOTE_FLOAT_SPACE_RENDERER_EVIDENCE
    const reviewPath = requestedReview ?? process.env.AGENTMUX_MOTE_FLOAT_SPACE_REVIEW_EVIDENCE
    assert.ok(rendererPath && reviewPath, 'Source passed only: exact shortcut Renderer/PID and independent images are still required')
    const rendererFile = await selectedEvidence(rendererPath), reviewFile = await selectedEvidence(reviewPath)
    const rendererBytes = await readFile(rendererFile), renderer = JSON.parse(rendererBytes)
    assert.equal(renderer.schema, 'agentmux.mote-shared-frame-renderer-proof.v1'); assert.equal(renderer.acceptanceScope, 'floating-space-shortcut-two-process-journey')
    assert.equal(renderer.passed, true); assert.equal(renderer.userRunTouched, false)
    assert.ok(Object.keys(renderer.inputs ?? {}).length > 100 && Object.keys(renderer.compiled ?? {}).length > 0)
    assert.ok(Object.hasOwn(renderer.compiled, 'index.html') && Object.keys(renderer.compiled).some(path => /^assets\/index-.*\.js$/.test(path)) &&
      Object.keys(renderer.compiled).some(path => /^assets\/index-.*\.css$/.test(path)), 'Original compiled App entry, JS and CSS identities required')
    assert.ok(Object.values(renderer.compiled).every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)))
    for (const path of rendererRequiredInputs) assert.ok(typeof renderer.inputs[path] === 'string' && /^[a-f0-9]{64}$/.test(renderer.inputs[path]), 'Required actual Renderer Source input is absent: ' + path)
    assert.equal(renderer.sourceReadback?.status, 'exact'); assert.deepEqual(renderer.sourceReadback?.drift, [])
    assert.equal(renderer.sourceReadback?.count, Object.keys(renderer.inputs).length)
    for (const [path, digest] of Object.entries(renderer.inputs)) {
      assert.ok(!path.startsWith('/') && !path.split('/').includes('..')); assert.equal(hash(await readFile(join(repository, path))), digest, 'Renderer Source is stale: ' + path)
    }
    assert.ok(Object.keys(renderer.privateInterventions ?? {}).length > 0 && Object.values(renderer.privateInterventions).every(value => value === false), 'Acceptance may not use diagnostic interventions')
    assert.deepEqual(renderer.phases?.map(phase => phase.phase), ['seed', 'restore'])
    const pids = renderer.phases.map(phase => {
      assert.equal(phase.exit?.timedOut, false); assert.equal(phase.exit?.exitCode, 0)
      assert.equal(phase.app?.passed, true); assert.equal(phase.app?.phase, phase.phase); assert.equal(phase.app?.scenario, 'floating-space-shortcut')
      assert.ok(Number.isInteger(phase.app?.pid) && phase.app.pid > 0 && phase.app.checks?.length > 0 && phase.app.frames?.length > 0)
      for (const name of rendererRequiredChecks[phase.phase]) assert.ok(phase.app.checks.some(check => check.name === name && check.passed === true), 'Required actual interaction is absent: ' + phase.phase + '/' + name)
      for (const name of rendererRequiredFrames[phase.phase]) assert.ok(phase.app.frames.some(frame => frame.name === name), 'Required actual image is absent: ' + phase.phase + '/' + name)
      assert.ok(phase.app.checks.every(check => check.passed === true)); return phase.app.pid
    })
    assert.equal(new Set(pids).size, 2); assert.ok(typeof renderer.privateProfile === 'string' && renderer.privateProfile.length > 0)
    assert.deepEqual(renderer.cleanup?.remaining, []); assert.equal(renderer.cleanup?.privateRootRemoved, true)
    const reviewBytes = await readFile(reviewFile), review = JSON.parse(reviewBytes)
    assert.equal(review.status, 'approved'); assert.ok(typeof review.reviewer === 'string' && review.reviewer.length > 0 && typeof review.independence === 'string' && review.independence.length > 0)
    assert.ok(typeof review.receipt === 'string' && evidenceCandidates(review.receipt, dirname(reviewFile)).includes(rendererFile))
    assert.equal(review.receiptSha256, hash(rendererBytes)); assert.ok(Array.isArray(review.actuallyViewed) && review.actuallyViewed.length > 0)
    const viewed = new Set(review.actuallyViewed.flatMap(path => { assert.equal(typeof path, 'string'); return evidenceCandidates(path, dirname(reviewFile)) }))
    const frames = renderer.phases.flatMap(phase => phase.app.frames)
    for (const frame of frames) {
      assert.ok(typeof frame.file === 'string' && !frame.file.split('/').includes('..'))
      const path = resolve(dirname(rendererFile), frame.file), bytes = await readFile(path)
      assert.ok(bytes.length > 100); assert.equal(hash(bytes), frame.sha256); assert.ok(viewed.has(path), 'Actual final image was not independently viewed: ' + frame.file)
    }
    assert.ok(!(review.findings ?? []).some(finding => finding.severity === 'must-fix' && finding.status !== 'resolved'))
    const dynamic = review.dynamicReview
    assert.equal(dynamic?.status, 'approved', 'The current motion requires independent actual dynamic observation')
    assert.equal(dynamic.receiptSha256, hash(rendererBytes))
    assert.ok(typeof dynamic.independence === 'string' && dynamic.independence.length > 0)
    assert.ok(typeof dynamic.sampleFile === 'string' && !dynamic.sampleFile.startsWith('/') && !dynamic.sampleFile.split('/').includes('..'))
    const sampleFile = resolve(dirname(reviewFile), dynamic.sampleFile), sampleBytes = await readFile(sampleFile)
    assert.equal(dirname(sampleFile), dirname(rendererFile), 'Dynamic observations must consume this exact Renderer artifact')
    assert.equal(hash(sampleBytes), dynamic.sampleSha256)
    assert.deepEqual(JSON.parse(sampleBytes), renderer.phases.find(phase => phase.phase === 'seed').app,
      'Independent dynamic review must read the actual complete seed facts, not a substituted motion summary')
    for (const fact of ['idle', 'left', 'right', 'far', 'hiddenFloating', 'reduced', 'detached', 'sleep', 'ordinaryTopic']) {
      assert.ok(dynamic.actuallyObserved?.includes(fact) && typeof dynamic.observations?.[fact] === 'string' && dynamic.observations[fact].length > 0,
        'Required independently observed dynamic fact is absent: ' + fact)
    }
    result.renderer = { receipt: rendererPath, sha256: hash(rendererBytes), pids, frameCount: frames.length }
    result.visualReview = { receipt: reviewPath, sha256: hash(reviewBytes), reviewer: review.reviewer }
    result.dynamicReview = { sampleFile: dynamic.sampleFile, sampleSha256: dynamic.sampleSha256, actuallyObserved: dynamic.actuallyObserved }
    await verifyInputs(result.inputs); result.passed = true
  }
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  if (isolated) await rm(isolated, { recursive: true, force: true })
  result.cleanup.isolatedSourceRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify({ prepared: result.prepared, prepareOnly, baselineOnly, sourcePassed: result.sourcePassed, passed: result.passed,
  receipt: relative(repository, join(evidence, 'receipt.json')), actualMutations: result.cases.length,
  inputs: Object.keys(result.inputs).length, sourceEvidence: result.sourceEvidence, cleanup: result.cleanup, failure: result.failure }))
if (!(prepareOnly || baselineOnly ? result.prepared && !result.failure : result.passed)) process.exitCode = 1
