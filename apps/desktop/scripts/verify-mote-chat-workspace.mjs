import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2), slice = args[0] === '--slice' ? args[1] : 'workspace'
assert.ok(args.length === 0 || args.length === 2 && ['overlays', 'identity-actions'].includes(slice), 'Use [--slice overlays|identity-actions]')
const evidence = join(repository, '.tmp/mote-chat-workspace', slice + '-' + Date.now())
await mkdir(join(repository, '.tmp'), { recursive: true }); await mkdir(evidence, { recursive: true })
const clone = await mkdtemp(join(repository, '.tmp/mote-chat-source-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const src = 'apps/desktop/src/renderer/src/'
const tests = slice === 'overlays' ? ['mote-floating-actions.test.tsx', 'window-overlay-host-cost.test.tsx', 'native-overlay-regions.test.ts', 'native-overlay-pointer.test.tsx', 'window-overlay-layer-contract.test.tsx'] : slice === 'identity-actions' ? ['mote-identity-actions.test.tsx'] : ['mote-chat-workspace.test.tsx', 'mote-file-scope.test.tsx', 'mote-conversation-identity.test.tsx', 'mote-navigation-rail.test.tsx', 'mote-closed-tab-target.test.tsx', 'mote-default-dialogue.test.tsx']
const result = { schema: 'agentmux.mote-chat-workspace-owning.v1', passed: false, slice,
  userAppOrRunTouched: false, callers: {}, cases: [], limitations: [
    'Actual App/Workbench/Composer and file/close owners with controlled external APIs. DOM popover transport is controlled; actual Chromium top-layer hit testing and independent visual review remain separate evidence.',
    'This bounded mutation command does not start, stop or recover a real Run. Maintained two-process App and real Core/PTY restart commands are recorded separately; no mock is signed as live Runtime evidence.'
  ] }
async function run(name, chosen = tests) {
  const command = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.chat.config.mts', ...chosen.map(file => 'test/' + file), '--maxWorkers=1', '--reporter=verbose']
  const child = spawn(process.execPath, command, { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60000)
  const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) }); clearTimeout(timeout)
  const log = name + '.log'; await writeFile(join(evidence, log), output)
  return { exit, output, log, sha256: hash(output) }
}
async function sources(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await sources(path))
    else if (/\.[jt]sx?$/.test(entry.name)) found.push(path)
  }
  return found
}
const mutations = slice === 'overlays' ? [
  ['native-top-layer-route', 'components/WindowOverlayHost.tsx', 'host.showPopover()', 'void host', 'mote-floating-actions.test.tsx'],
  ['cancel-does-not-close', 'components/WorkspaceWorkbench.tsx', 'onCancel={() => !closing && setPendingClose(null)}', 'onCancel={() => void closing}', 'mote-floating-actions.test.tsx'],
  ['original-close-target', 'components/WorkspaceWorkbench.tsx', 'closeTabs(pendingClose.tabIds, keepAgentSessions)', "closeTabs(['neighbor-tab'], keepAgentSessions)", 'mote-floating-actions.test.tsx'],
  ['original-focus-return', 'components/ConfirmationDialog.tsx', 'original.focus({ preventScroll: true })', 'void original', 'mote-floating-actions.test.tsx']
  ,['native-child-layer-crop', 'lib/native-overlay-regions.ts', ' && nativeOwner(parent) === nativeOwner(node)', '', 'native-overlay-regions.test.ts']
] : slice === 'identity-actions' ? [
  ['original-mote-rename-owner', 'components/MoteRenameDialog.tsx', 'renameScratchTopic(captured.topic.id, title, captured.workspace.id)', 'renameScratchTopic(captured.topic.id, title)', 'mote-identity-actions.test.tsx'],
  ['rename-menu-consumer', 'components/SpaceObjectContextMenu.tsx', 'moteActions?.onRename ?', 'false ?', 'mote-identity-actions.test.tsx'],
  ['shared-title-input-limit', 'components/MoteRenameDialog.tsx', 'maxLength={SCRATCH_TOPIC_TITLE_MAX_LENGTH}', 'maxLength={200}', 'mote-identity-actions.test.tsx'],
  ['shared-title-submit-limit', 'components/MoteRenameDialog.tsx', 'if (title.length > SCRATCH_TOPIC_TITLE_MAX_LENGTH)', 'if (false)', 'mote-identity-actions.test.tsx']
] : [
  ['mote-chat-consumer', 'lib/mote-workface.ts', "if (!workspace || !topic || scratchTopicKind(topic.id, topics) !== 'mote') return null", 'if (workspace || !topic) return null', 'mote-chat-workspace.test.tsx'],
  ['original-topic-isolation', 'components/WorkspaceWorkbench.tsx', 'tabs, topicId ?? (retainedSpatialFocus', 'tabs, undefined ?? (retainedSpatialFocus', 'mote-chat-workspace.test.tsx'],
  ['material-root-admission', 'components/file-tree/useWorkspaceFileTree.ts', 'entries.filter(entry => fileExplorerContains(rootPath, entry.path)).map', 'entries.map', 'mote-file-scope.test.tsx'],
  ['late-original-resource-fence', 'components/file-tree/useWorkspaceFileTree.ts', 'if (!loadTrackerRef.current.isCurrent(token)) return false', 'if (false) return false', 'mote-file-scope.test.tsx'],
  ['retained-unsent-draft', 'components/MoteWorkface.tsx', 'useEffect(() => { setMaterials(false); setAllFiles(false) }', 'useEffect(() => { useAppStore.setState({ agentComposerDrafts: {} }); setMaterials(false); setAllFiles(false) }', 'mote-chat-workspace.test.tsx'],
  ['late-material-display-intent', 'lib/mote-materials-actions.ts', '(!revealed && controller.signal.aborted)', 'false', 'mote-file-scope.test.tsx'],
  ['original-file-reveal-cancellation', 'store.ts', '!navigationSignal?.aborted && intentVersion', 'intentVersion', 'mote-file-scope.test.tsx'],
  ['exact-mote-session-author', 'lib/mote-conversation-identity.ts', 'session.hostId !== owner.hostId || session.workspacePath !== owner.directoryPath ||', '', 'mote-conversation-identity.test.tsx'],
  ['persistent-mote-message-avatar', 'components/ConversationMessage.tsx', 'mote={described?.mote}', 'mote={undefined}', 'mote-conversation-identity.test.tsx']
]
try {
  for (const path of ['apps/desktop/src', 'apps/desktop/resources', 'apps/desktop/test', 'apps/desktop/scripts/fixtures/mote-navigation-footer', 'packages/core/src', 'packages/layout/src']) await cp(join(repository, path), join(clone, path), { recursive: true })
  await cp(join(repository, 'packages/demand'), join(clone, 'packages/demand'), { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/dist') })
  for (const path of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json', 'packages/core/package.json', 'packages/layout/package.json']) {
    await mkdir(resolve(clone, path, '..'), { recursive: true }); await cp(join(repository, path), join(clone, path))
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/layout/node_modules']) {
    await mkdir(resolve(clone, path, '..'), { recursive: true }); await symlink(join(repository, path), join(clone, path), 'dir')
  }
  const product = await sources(join(repository, 'apps/desktop/src')); assert.ok(product.length > 0, 'The actual product caller source set is nonempty')
  const definitions = slice === 'overlays' ? [['resolveOverlayContainer', 'components/WindowOverlayHost.tsx'], ['ConfirmationDialog', 'components/ConfirmationDialog.tsx']] : slice === 'identity-actions' ? [['MoteRenameDialog', 'components/MoteRenameDialog.tsx'], ['renameScratchTopic', 'store.ts'], ['SpaceObjectContextMenu', 'components/SpaceObjectContextMenu.tsx']] : [['MoteWorkface', 'components/MoteWorkface.tsx'], ['useMoteMaterialsActions', 'lib/mote-materials-actions.ts'], ['useMoteWorkfaceScope', 'lib/mote-workface.ts'], ['fileExplorerContains', 'lib/file-explorer-scope.ts'], ['useMoteConversationOwner', 'lib/mote-conversation-identity.ts'], ['moteConversationIdentity', 'lib/mote-conversation-identity.ts'], ['fileNavigationSelection', 'store.ts'], ['subscribePmoTeamsTopicFloatingState', 'lib/pmo-teams-topic-floating.ts']]
  for (const [symbol, definition] of definitions) {
    const hits = []
    for (const file of product) if (relative(repository, file) !== src + definition) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => { if (!/^\s*(?:import|export|\/\/|\*)\b/.test(line) && new RegExp('(?:<|\\b)' + symbol + '(?:\\b|\\()').test(line)) hits.push({ path: relative(repository, file), line: index + 1, text: line.trim() }) })
    }
    assert.ok(hits.length > 0, 'A definition-only capability cannot pass: ' + symbol); result.callers[symbol] = hits
  }
  const baseline = await run('baseline-green'); assert.equal(baseline.exit, 0, 'Actual nonempty owning baseline must pass')
  assert.match(baseline.output, /Tests\s+\d+ passed/); result.baseline = { ...baseline, output: undefined }
  for (const [name, owner, anchor, replacement, test] of mutations) {
    const path = src + owner, original = await readFile(join(clone, path), 'utf8')
    assert.ok(original.includes(anchor), 'The real owning mutation anchor is nonempty: ' + name)
    const changed = original.replaceAll(anchor, replacement); assert.notEqual(changed, original)
    await writeFile(join(clone, path), changed)
    const red = await run(name + '-red', [test]); assert.notEqual(red.exit, 0, 'Broken behavior must fail: ' + name)
    assert.match(red.output, /AssertionError:/, 'A mutant must fail behavior assertions')
    assert.doesNotMatch(red.output, /No test files found|Failed to load url|failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/)
    await writeFile(join(clone, path), original)
    const green = await run(name + '-restored-green', [test]); assert.equal(green.exit, 0, 'Restored original behavior must pass')
    assert.equal(hash(await readFile(join(repository, path))), hash(original), 'The shared candidate source was never mutated')
    result.cases.push({ name, path, originalSha256: hash(original), mutatedSha256: hash(changed), red: { ...red, output: undefined }, green: { ...green, output: undefined } })
  }
  assert.ok(result.cases.length > 0); result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { await rm(clone, { recursive: true, force: true }); result.temporarySourceRemoved = true; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n') }
console.log(JSON.stringify({ passed: result.passed, slice, cases: result.cases.length, receipt: relative(repository, join(evidence, 'receipt.json')), limitations: result.limitations }))
if (!result.passed) process.exitCode = 1
