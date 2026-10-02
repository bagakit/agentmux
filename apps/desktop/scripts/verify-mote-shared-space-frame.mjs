import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
// Shared process evidence belongs to the common repository, while Source
// identities always belong to this exact candidate worktree.
const commonRepository = dirname(resolve(repository, execFileSync('git', ['rev-parse', '--git-common-dir'],
  { cwd: repository, encoding: 'utf8', timeout: 10000 }).trim()))
let slice, requestedEvidence, requestedRenderer, requestedReview, prepareOnly = false
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--slice') slice = args[++index]
  else if (args[index] === '--evidence-dir') requestedEvidence = args[++index]
  else if (args[index] === '--renderer-evidence') requestedRenderer = args[++index]
  else if (args[index] === '--review-evidence') requestedReview = args[++index]
  else if (args[index] === '--prepare-only') prepareOnly = true
  else if (args[index] === '--help') {
    console.log('node apps/desktop/scripts/verify-mote-shared-space-frame.mjs --slice frame|content [--evidence-dir <fresh-directory>] [--renderer-evidence <receipt.json>] [--review-evidence <approved-review.json>] [--prepare-only]')
    console.log('Equivalent receipt selectors: AGENTMUX_SHARED_FRAME_RENDERER_EVIDENCE and AGENTMUX_SHARED_FRAME_REVIEW_EVIDENCE. Missing current Renderer/PID or independent image review can yield sourcePassed only; overall passed and exit 0 require both.')
    console.log('AGENTMUX_SHARED_FRAME_SOURCE_EVIDENCE consumes one unchanged original full Source matrix receipt, without copying Source or rerunning tests. Missing, incomplete or stale Source evidence fails; it never falls back to a new matrix.')
    process.exit(0)
  } else throw new Error('Unknown argument: ' + args[index])
}
assert.ok(slice === 'frame' || slice === 'content', 'Choose the original frame or content slice')
const requestedSource = process.env.AGENTMUX_SHARED_FRAME_SOURCE_EVIDENCE
assert.ok(!(prepareOnly && requestedSource), 'Prepare the original matrix separately from exact Source receipt consumption')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = requestedEvidence ? resolve(repository, requestedEvidence)
  : join(repository, '.tmp/mote-shared-space-frame-source', slice + '-' + globalThis.crypto.randomUUID())
await mkdir(evidence, { recursive: true })
// Never replace another attempt's proof, including a previous failed run.
assert.ok(!(await readdir(evidence)).includes('receipt.json'), 'Use a fresh evidence directory')
await mkdir(join(repository, '.tmp'), { recursive: true })
const isolated = requestedSource ? null : await mkdtemp(join(repository, '.tmp/mote-shared-space-source-'))
const prefix = 'apps/desktop/src/renderer/src/'
const proofTest = 'test/mote-shared-space-source-boundaries.test.tsx'
const testFiles = slice === 'frame' ? [
  'test/mote-shared-space-frame.test.tsx', 'test/mote-materials-exact-reference.test.tsx',
  'test/mote-hover-surface.test.tsx', 'test/workbench-projection-ownership.test.tsx',
  'test/workbench-presentation-wiring.integration.test.tsx', 'test/launcher-prewarm-failure.test.tsx',
  'test/new-tab-prewarm-visible-only.test.ts', 'test/warm-terminal-ownership.test.ts',
  'test/workbench-occurrence-selection.test.ts', 'test/survey-zone-reference.test.ts',
  'test/stable-workbench-reading-transition.test.tsx', 'test/workbench-parked-presentation.test.tsx', proofTest
] : ['test/mote-details-panel.test.tsx', 'test/mote-materials-exact-reference.test.tsx']
const config = 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.source-proof.config.mts'
const result = { schema: 'agentmux.mote-shared-space-source-proof.v1', slice, prepareOnly, prepared: false, sourcePassed: false, passed: false,
  scope: 'Bounded current Source tests, actual Source mutations, external production callers and strict App Source noEmit; overall result also consumes the exact separately produced Renderer/PID and independent image review.',
  limitations: ['This verifier creates no Chromium screenshots or processes. It consumes separately owned current receipts without rerunning unchanged layout proof. No Native/OS, actual Core/ctxmux/CLI Run, package or installation claim.'],
  userAppOrRunTouched: false, sharedSourceMutated: false, baseline: null, types: null, cases: [], callers: {},
  inputs: {}, sourceEvidence: null, cleanup: { isolatedSourceCreated: isolated !== null, isolatedSourceRemoved: false } }

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
    failed: report.numFailedTests, executed: executed.length, assertions: cases.map(test => ({ name: test.fullName, status: test.status })) } }
}

// Small real Stable/App consumers for DOM-transition boundaries that happy-dom
// does not natively emulate. The old-slot removal reproduces Chromium blur/Range
// collapse; it does not implement the product repair or claim native input.
const boundaryTests = `// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { createMoteApp, moteClick, settleMoteApp } from './fixtures/mote-app'
import { readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
it('exact Region sibling home remains available during detached parent placement', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(Fragment, null,
      createElement('div', { id: 'private-region-home' }),
      createElement(StableWorkbenchView, { kind: 'region', homeId: 'private-region-home', targetId: null,
        active: true, retainedRegionId: 'original-region' }, createElement('textarea', { 'data-original-input': true, defaultValue: 'Original unsent' })))))
    const home = container.querySelector('#private-region-home')!
    expect(home.querySelector('textarea')?.value).toBe('Original unsent')
    expect(container.querySelector('.retained-workbench-parking textarea')).toBeNull()
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})
it.each([true, false])('Stable repairs original focus only while visible=%s', async visible => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), homeId = 'private-reading-home', nextId = 'private-reading-next'
  document.body.append(container); const root = createClientUiRoot(container)
  const tree = (targetId: string | null) => createElement(Fragment, null,
    createElement('div', { key: targetId ?? homeId, id: targetId ?? homeId }),
    createElement(StableWorkbenchView, { homeId, targetId, active: true, visible, retainedRegionId: null },
      createElement('p', { contentEditable: true }, 'Original unsent reading')))
  let restoreRemoval: ReturnType<typeof vi.spyOn> | undefined
  try {
    await act(async () => root.render(tree(null)))
    const home = container.querySelector('#' + homeId)!
    const input = home.querySelector<HTMLElement>('p')!, text = input.firstChild!
    input.focus(); const range = document.createRange(); range.setStart(text, 4); range.collapse(true)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    const removeChild = container.removeChild.bind(container)
    restoreRemoval = vi.spyOn(container, 'removeChild').mockImplementation(node => {
      const removed = removeChild(node)
      if (node === home) {
        input.blur(); const collapsed = document.createRange(); collapsed.setStart(container, 0); collapsed.collapse(true)
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(collapsed)
      }
      return removed
    })
    await act(async () => root.render(tree(nextId)))
    expect(restoreRemoval).toHaveBeenCalledWith(home)
    const next = container.querySelector('#' + nextId)!
    expect(next.querySelector('p')).toBe(input)
    expect(document.activeElement).toBe(visible ? input : document.body)
    if (visible) { expect(document.getSelection()!.anchorNode).toBe(text); expect(document.getSelection()!.anchorOffset).toBe(4) }
  } finally { restoreRemoval?.mockRestore(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
it('preview then pin keeps the unique original visible Activity input', async () => {
  const app = createMoteApp()
  try {
    await app.mount(); const input = app.container.querySelector('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); await app.hover()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    await moteClick(app.entry()); await settleMoteApp()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(readPmoTeamsTopicFloatingState().open).toBe(true)
  } finally { await app.dispose() }
})
it('an inner toggle never closes the original pinned Mote Panel', async () => {
  const app = createMoteApp()
  try {
    await app.mount(); await moteClick(app.entry())
    const input = app.panel().querySelector('[aria-label="Message Agent"]')!, inner = document.createElement('div')
    expect(input).not.toBeNull(); app.panel().append(inner)
    const event = new Event('toggle', { bubbles: true }); Object.defineProperty(event, 'newState', { value: 'closed' })
    await act(async () => inner.dispatchEvent(event)); await settleMoteApp()
    expect(readPmoTeamsTopicFloatingState().open).toBe(true)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
  } finally { await app.dispose() }
})
`

const materials = prefix + 'lib/mote-materials-actions.ts'
const frameVariants = [
  { name: 'compact-original-sidebars-exclusive', path: prefix + 'components/TopRowChrome.tsx',
    anchor: "const projectRailOpen = compact ? choice === 'projects' : preferredProjects\n  const toolsOpen = compact ? choice === 'tools' : preferredTools",
    replacement: 'const projectRailOpen = preferredProjects\n  const toolsOpen = preferredTools',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'keeps one original sidebar in a narrow Space' },
  { name: 'retained-known-unknown-original-frame', path: prefix + 'components/WorkspaceWorkbench.tsx',
    anchor: '{bodyLayout ? <SplitNode', replacement: '{bodyLayout && !retainUnplacedTab ? <SplitNode',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'keeps a healthy original View when its saved reference is wrong' },
  { name: 'ambiguous-resolver', path: prefix + 'lib/mote-workbench-projection.ts',
    anchor: 'held === undefined && choices.length === 1', replacement: 'held === undefined && choices.length > 0',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'explicit occurrence choice' },
  { name: 'exact-region-sibling-home', path: prefix + 'components/StableWorkbenchView.tsx',
    anchor: 'const destination = siblingHome ?? document.getElementById(destinationId)',
    replacement: 'const destination = document.getElementById(destinationId)', tests: [proofTest], pattern: 'exact Region sibling' },
  { name: 'unique-visible-preview-primary', path: prefix + 'components/WorkspaceWorkbench.tsx',
    anchor: 'const projection = (visibleExternal.length === 1 ? visibleExternal[0] : undefined) ??',
    replacement: 'const projection =', tests: [proofTest], pattern: 'preview then pin' },
  { name: 'stable-original-focus-repair', path: prefix + 'components/StableWorkbenchView.tsx',
    anchor: 'activeElement.focus({ preventScroll: true })', replacement: 'void activeElement',
    tests: [proofTest], pattern: 'Stable repairs original focus' },
  { name: 'stable-visible-repair-boundary', path: prefix + 'components/StableWorkbenchView.tsx',
    anchor: 'if (this.props.visible && !snapshot.interrupted)',
    replacement: 'if (!snapshot.interrupted)', tests: [proofTest], pattern: 'Stable repairs original focus' },
  { name: 'inner-panel-toggle-owner', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: 'event.target === event.currentTarget && event.newState', replacement: 'event.newState',
    tests: [proofTest], pattern: 'inner toggle' },
  { name: 'inner-popover-native-escape-owner', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: "if (Array.from(panel?.querySelectorAll('[popover]') ?? []).some(owner => owner.matches(':popover-open'))) return true",
    replacement: '/* Mutation removes the open inner surface Escape owner. */',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'open inner popover own Escape' },
  { name: 'retained-service-details-readable-geometry', path: prefix + 'components/ServiceNoticeDisclosure.tsx',
    anchor: 'if (bottom - top < 128) {\n      top = Math.max(8, bounds.top + 8)\n      bottom = Math.min(document.documentElement.clientHeight || window.innerHeight, bounds.bottom) - 8\n    }',
    replacement: '/* Mutation removes the original surface readable-area repair. */',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'retained-reference details readable' },
  { name: 'floating-aba-full-reference', path: materials,
    anchor: 'reference === null, reference?.displayWorkspaceId, reference?.groupId, reference?.tabId, reference?.regionId',
    replacement: 'reference === null', tests: ['test/mote-materials-exact-reference.test.tsx'], pattern: 'same-Tab occurrence A-B-A' },
  { name: 'launcher-failed-automatic-request-boundary', path: prefix + 'components/NewTabSurface.tsx',
    anchor: '(warmSlotHeld || automaticWarmAttempt.current !== warmKey)', replacement: 'true',
    tests: ['test/launcher-prewarm-failure.test.tsx'], pattern: 'bounds the failed automatic request' },
  { name: 'launcher-successful-warm-slot-reset', path: prefix + 'components/NewTabSurface.tsx',
    anchor: 'if (warmSlotHeld && warmTerminal?.session) automaticWarmAttempt.current = null',
    replacement: '/* Mutation leaves a successful warm attempt permanently held. */',
    tests: ['test/launcher-prewarm-failure.test.tsx'], pattern: 'can fill an empty slot again after the original warm successfully became available' },
  { name: 'mote-exact-occurrence-selection-mode', path: prefix + 'lib/mote-workbench-projection.ts',
    anchor: "selectionMode: 'occurrence',", replacement: '/* Mutation borrows Zone composition selection for an exact Mote address. */',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'shows the healthy original input at its second exact Group' },
  { name: 'public-explicit-occurrence-click-validation', path: prefix + 'lib/workbench-projection.ts',
    anchor: "if (scope.entity.kind === 'zone' && scope.selectionMode !== 'occurrence' ||",
    replacement: "if (scope.entity.kind === 'zone' ||",
    tests: ['test/workbench-occurrence-selection.test.ts'], pattern: 'checks explicit clicks against the exact original occurrence' },
  { name: 'stable-moved-original-text-collapse-repair', path: prefix + 'components/StableWorkbenchView.tsx',
    anchor: 'restoreReadingRanges(host, snapshot.ranges, snapshot.activeElement, this.props.active, reparentedWithoutInput)',
    replacement: 'restoreReadingRanges(host, snapshot.ranges, snapshot.activeElement, this.props.active)',
    tests: ['test/stable-workbench-reading-transition.test.tsx'], pattern: 'preserving later none intent' },
  { name: 'stable-later-original-input-intent-boundary', path: prefix + 'components/StableWorkbenchView.tsx',
    anchor: 'if (this.props.visible && !snapshot.interrupted)', replacement: 'if (this.props.visible)',
    tests: ['test/stable-workbench-reading-transition.test.tsx'], pattern: 'preserving later (keydown|pointerdown|beforeinput) intent' },
  { name: 'retained-input-keeps-unconfirmed-raw-reference', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: 'if (!groupId && current.targetTabId === tabId) return',
    replacement: '/* Mutation lets retained input focus guess a new placement. */',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'keeps a healthy original View when its saved reference is wrong' },
  { name: 'fresh-original-catalog-keeps-new-discussion-tuple', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: 'spatialCatalog(state, topics ?? []).locations',
    replacement: '(projectionState?.catalog?.locations ?? [])',
    tests: ['test/mote-shared-space-frame.test.tsx'],
    pattern: 'selects the newly created discussion at its exact original Group before the next catalog render|recovers an unknown placement through the original Group Tab button' },
  { name: 'retained-group-tab-rendered-display-scope', path: prefix + 'components/PmoTeamsTopicFloatingPanel.tsx',
    anchor: 'location.displayWorkspaceId === displayWorkspaceId &&',
    replacement: '/* Mutation makes a foreign display with the same Group ID ambiguous. */',
    tests: ['test/mote-shared-space-frame.test.tsx'], pattern: 'recovers an unknown placement through the original Group Tab button' },
  { name: 'retained-readable-split-ratio-address-boundary', path: prefix + 'components/WorkspaceWorkbench.tsx',
    anchor: 'if (surfaceVisible && projection?.placementConfirmed !== false) updateSplitRatio(workspaceId, nodePath, ratio)',
    replacement: 'if (surfaceVisible) updateSplitRatio(workspaceId, nodePath, ratio)',
    tests: ['test/workbench-parked-presentation.test.tsx'],
    pattern: 'does not let the original unconfirmed Split callback overwrite a background durable ratio' },
  { name: 'retained-cached-selection-current-entity-scope', path: prefix + 'components/WorkspaceWorkbench.tsx',
    anchor: 'current.scope !== bodyScope || current.retainedBodyScope !== retainedBodyScope ||',
    replacement: 'current.scope !== bodyScope ||',
    tests: ['test/workbench-parked-presentation.test.tsx'],
    pattern: 'refuses a held cached selection after its public (target|prefix) scope changes with the same callback' },
  { name: 'stable-actual-placement-host-metadata', path: prefix + 'components/StableWorkbenchView.tsx',
    anchor: 'const presentation = useMemo(() => ({ active, retainedRegionId, tabHostId: placedHostId, surface, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference }),\n    [active, retainedRegionId, placedHostId, surface, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference])',
    replacement: 'const presentation = useMemo(() => ({ active, retainedRegionId, tabHostId: targetId ?? homeId, surface, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference }),\n    [active, retainedRegionId, targetId, homeId, surface, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference])',
    tests: ['test/stable-workbench-reading-transition.test.tsx'],
    pattern: 'keeps the actual placed host while a later destination is unavailable' }
]
const contentVariants = [
  { name: 'ideas-host-resource-identity', path: prefix + 'components/MoteDetailsPanel.tsx',
    anchor: 'scope.workspace.id, scope.workspace.hostId, scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath',
    replacement: 'scope.workspace.id, scope.topic.id', tests: ['test/mote-details-panel.test.tsx'], pattern: 'old Host' },
  { name: 'new-note-original-file-owner', path: prefix + 'components/SurfaceToolDock.tsx',
    anchor: 'setCreateFileRequest({ requestId: ++explorerRevealRequestId.current, parentPath: mote.rootPath })',
    replacement: 'void mote.rootPath', tests: ['test/mote-details-panel.test.tsx'], pattern: 'creates a note through the shared FileExplorer' },
  { name: 'directory-terminal-public-callback-order', path: prefix + 'components/FileExplorer.tsx',
    anchor: 'if (onOpenTerminal) { await onOpenTerminal(node.path); return }\n    if (!workspace || !activePaneId) return',
    replacement: 'if (!workspace || !activePaneId) return\n    if (onOpenTerminal) { await onOpenTerminal(node.path); return }',
    tests: ['test/mote-details-panel.test.tsx'], pattern: 'resource layout is absent' },
  { name: 'file-placement-full-display-reference', path: materials,
    anchor: 'displayWorkspaceId, groupId, tabId: result.placement.tabId, regionId: result.placement.regionId',
    replacement: 'displayWorkspaceId: workspaceId, groupId, tabId: result.placement.tabId, regionId: result.placement.regionId',
    tests: ['test/mote-materials-exact-reference.test.tsx'], pattern: 'actual new File tuple|selected second occurrence' },
  { name: 'explicit-object-section-scroll-reset', path: prefix + 'components/MoteDetailsPanel.tsx',
    anchor: '<div key={section} className="mote-details__content" role="tabpanel"',
    replacement: '<div className="mote-details__content" role="tabpanel"',
    tests: ['test/mote-details-panel.test.tsx'],
    pattern: 'starts each explicitly selected object section at its beginning and keeps the original workbench' }
]

function productionCallers() {
  const callers = [
    ['mote address resolver', prefix + 'lib/mote-workbench-projection.ts', /\bmoteWorkbenchProjection\(/, prefix + 'App.tsx'],
    ['original stable View', prefix + 'components/StableWorkbenchView.tsx', /<StableWorkbenchView\b/, prefix + 'components/WorkspaceWorkbench.tsx'],
    ['original shared files', prefix + 'components/SurfaceToolDock.tsx', /<WorkspaceFilesTool\b/, prefix + 'components/MoteWorkface.tsx'],
    ['original exact file action', materials, /\buseMoteMaterialsActions\(/, prefix + 'components/MoteWorkface.tsx'],
    ['original FileExplorer', prefix + 'components/FileExplorer.tsx', /<FileExplorer\b/, prefix + 'components/SurfaceToolDock.tsx']
  ]
  if (slice === 'content') callers.push(['original secondary details', prefix + 'components/MoteDetailsPanel.tsx', /<MoteDetailsPanel\b/, prefix + 'components/SurfaceToolDock.tsx'])
  if (slice === 'frame') callers.push(
    ['original public projection consumer', prefix + 'lib/workbench-projection.ts', /\bprojectWorkbenchProjection\(/, prefix + 'components/WorkspaceWorkbench.tsx'],
    ['original public occurrence selection action', prefix + 'lib/workbench-projection.ts', /\bselectWorkbenchProjectionTab\(/, prefix + 'components/WorkspaceWorkbench.tsx'],
    ['original group ratio committer consumer', prefix + 'lib/split-ratio-commit.ts', /\bnew SplitRatioCommitter\(/, prefix + 'components/WorkspaceWorkbench.tsx'],
    ['original group layout ratio writer', prefix + 'store.ts', /\bupdateSplitRatio\(workspaceId, nodePath, ratio\)/, prefix + 'components/WorkspaceWorkbench.tsx'],
    ['original placed host namespace consumer', prefix + 'components/StableWorkbenchView.tsx', /\bparent\.tabHostId\b/, prefix + 'components/WorkspaceWorkbench.tsx'],
    ['fresh original spatial catalog action', prefix + 'lib/space-agent-control.ts', /\bspatialCatalog\(state, topics \?\? \[\]\)/, prefix + 'components/PmoTeamsTopicFloatingPanel.tsx'],
    ['original Launcher in public workbench', prefix + 'components/NewTabSurface.tsx', /<NewTabSurface\b/, prefix + 'components/WorkspaceWorkbench.tsx'],
    ['original workbench in floating Mote', prefix + 'components/WorkspaceWorkbench.tsx', /<WorkspaceWorkbench\b/, prefix + 'components/PmoTeamsTopicFloatingPanel.tsx'],
    ['original warm store request consumer', prefix + 'store.ts', /\bprewarmTerminal\(/, prefix + 'components/NewTabSurface.tsx'],
    ['original compact sidebar owner', prefix + 'components/TopRowChrome.tsx', /\buseWindowSidebarLayout\(/, prefix + 'App.tsx'],
    ['shared sidebar layout consumer', prefix + 'components/TopRowChrome.tsx', /\buseContext\(WindowSidebarLayoutContext\)/, prefix + 'components/SurfaceToolDock.tsx'],
    ['original retained workbench frame', prefix + 'components/WorkspaceWorkbench.tsx', /<WorkspaceWorkbench\b/, prefix + 'App.tsx'],
    ['original shared service disclosure', prefix + 'components/ServiceNoticeDisclosure.tsx', /<ServiceNoticeDisclosure\b/, prefix + 'components/ServiceWindowNotice.tsx'],
    ['original workbench service notice', prefix + 'components/ServiceWindowNotice.tsx', /<ServiceWindowNotice\b/, prefix + 'components/WorkspaceWorkbench.tsx'])
  return callers
}
async function consumeSource(file) {
  const bytes = await readFile(file), cached = JSON.parse(bytes), directory = dirname(file)
  assert.equal(cached.schema, result.schema); assert.equal(cached.slice, slice)
  assert.equal(cached.prepareOnly, false); assert.equal(cached.prepared, true); assert.equal(cached.sourcePassed, true)
  assert.ok(!cached.sourceEvidence?.used, 'Consume the original full matrix receipt, not another consumption receipt')
  assert.equal(cached.userAppOrRunTouched, false); assert.equal(cached.sharedSourceMutated, false)
  assert.equal(cached.cleanup?.isolatedSourceRemoved, true)
  assert.ok(Object.keys(cached.inputs ?? {}).length > 100 && cached.inputs[prefix + 'App.tsx'] &&
    cached.inputs[relative(repository, import.meta.filename)], 'Original current App and verifier inputs must be nonempty')
  for (const [path, digest] of Object.entries(cached.inputs)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Source input must be repository relative')
    assert.equal(hash(await readFile(join(repository, path))), digest, 'Source receipt is stale; run a fresh explicit matrix: ' + path)
  }
  const logOf = async receipt => {
    assert.ok(typeof receipt?.log === 'string' && !receipt.log.startsWith('/') && !receipt.log.split('/').includes('..'))
    const log = await readFile(join(directory, receipt.log), 'utf8')
    assert.ok(log.length > 0); assert.equal(hash(log), receipt.sha256, 'Original proof log SHA must agree: ' + receipt.log)
    assert.equal(receipt.timedOut, false)
    return log
  }
  const green = receipt => {
    assert.equal(receipt.exit, 0); assert.equal(receipt.report?.failed, 0)
    assert.ok(receipt.report?.passed > 0 && receipt.report?.executed > 0 &&
      receipt.report?.assertions?.some(test => test.status === 'passed'), 'Original actual GREEN cases must be nonempty')
  }
  assert.equal(cached.types?.exit, 0)
  assert.ok(['--noEmit', '--strict', '--listFiles'].every(flag => cached.types.command?.includes(flag)))
  assert.match(await logOf(cached.types), /\/apps\/desktop\/src\/renderer\/src\/App\.tsx$/mu, 'Original strict type graph must consume actual App')
  green(cached.baseline); await logOf(cached.baseline)
  assert.ok(cached.baseline.report.fileCount >= testFiles.length, 'Original owning baseline files must be nonempty')
  const variants = slice === 'frame' ? frameVariants : contentVariants
  assert.equal(cached.cases?.length, variants.length, 'Every current actual Source mutant must have an original receipt')
  assert.equal(new Set(cached.cases.map(entry => entry.name)).size, variants.length)
  for (const variant of variants) {
    const entry = cached.cases.find(entry => entry.name === variant.name)
    assert.ok(entry); assert.equal(entry.path, variant.path); assert.equal(entry.anchor, variant.anchor); assert.equal(entry.replacement, variant.replacement)
    assert.equal(entry.restored, true); assert.equal(entry.originalSha256, cached.inputs[variant.path])
    const original = await readFile(join(directory, 'owning-source', variant.name + '.original.txt'), 'utf8')
    const mutant = await readFile(join(directory, 'owning-source', variant.name + '.mutant.txt'), 'utf8')
    assert.equal(hash(original), entry.originalSha256); assert.equal(hash(mutant), entry.mutatedSha256)
    assert.equal(original.split(variant.anchor).length - 1, 1); assert.equal(mutant, original.replace(variant.anchor, variant.replacement))
    assert.ok(Number.isInteger(entry.red?.exit) && entry.red.exit !== 0 && entry.red.report?.failed > 0 && entry.red.report?.executed > 0)
    const redLog = await logOf(entry.red)
    assert.match(redLog, /AssertionError:/u)
    assert.doesNotMatch(redLog, /No test files found|Failed to load url|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/iu)
    green(entry.green); await logOf(entry.green)
  }
  for (const [name, definition, pattern, expected] of productionCallers()) {
    const hits = cached.callers?.[name]
    assert.ok(Array.isArray(hits) && hits.length > 0 && hits.some(hit => hit.path === expected && hit.path !== definition), 'Original external production caller is missing: ' + name)
    const lines = (await readFile(join(repository, expected), 'utf8')).split('\n')
    assert.ok(hits.some(hit => hit.path === expected && Number.isInteger(hit.line) && pattern.test(lines[hit.line - 1] ?? '') &&
      !/^\s*(?:import|export\s+(?:type|\{|\*)|\/\/)/u.test(lines[hit.line - 1] ?? '')), 'Original definition-outside caller must remain actual Source: ' + name)
  }
  result.inputs = cached.inputs; result.types = cached.types; result.baseline = cached.baseline
  result.cases = cached.cases; result.callers = cached.callers; result.prepared = true; result.sourcePassed = true
  result.sourceEvidence = { used: true, receipt: requestedSource, sha256: hash(bytes), evidenceDirectory: relative(repository, directory),
    testsRerun: false, mutantsRerun: false, verifiedInputs: Object.keys(cached.inputs).length }
}

try {
  if (requestedSource) await consumeSource(await selectedEvidence(requestedSource))
  else {
  const trees = ['apps/desktop/src', 'apps/desktop/resources', 'apps/desktop/test/helpers', 'apps/desktop/test/fixtures',
    'packages/core/src', 'packages/demand/src', 'packages/layout/src', 'packages/client-ui/src']
  const paths = ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'docs/design/presentation/spaces-and-layout.md',
    'docs/design/behavior/spaces-and-layout.md', 'docs/design/behavior/motes-and-coordination.md', 'apps/desktop/package.json',
    'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json', 'packages/client-ui/tsconfig.json', ...['core', 'demand', 'layout', 'client-ui'].map(name => 'packages/' + name + '/package.json'),
    ...['vitest.owning.config.mts', 'vitest.chat.config.mts', 'vitest.frame.config.mts', 'tsconfig.frame.json', 'atomic-move.setup.ts'].map(name => 'apps/desktop/scripts/fixtures/mote-navigation-footer/' + name),
    ...testFiles.filter(file => file !== proofTest).map(file => 'apps/desktop/' + file)]
  for (const path of [...trees, ...paths]) {
    const destination = join(isolated, path); await mkdir(dirname(destination), { recursive: true })
    await cp(join(repository, path), destination, { recursive: true })
    const copied = trees.includes(path) ? await files(destination) : [destination]
    for (const file of copied) {
      const rel = relative(isolated, file), digest = hash(await readFile(file))
      assert.equal(hash(await readFile(join(repository, rel))), digest, 'Source changed during snapshot: ' + rel)
      result.inputs[rel] = digest
    }
  }
  assert.ok(Object.keys(result.inputs).length > 100, 'The actual current App Source graph must be nonempty')
  result.inputs[relative(repository, import.meta.filename)] = hash(await readFile(import.meta.filename))
  for (const path of ['node_modules', 'apps/desktop/node_modules', ...['core', 'demand', 'layout', 'client-ui'].map(name => 'packages/' + name + '/node_modules')]) {
    await mkdir(dirname(join(isolated, path)), { recursive: true })
    await symlink(join(repository, path), join(isolated, path), 'dir')
  }
  await writeFile(join(isolated, config), `import { defineConfig } from 'vitest/config'\nimport owning from './vitest.frame.config.mts'\nexport default defineConfig({ ...owning, cacheDir: ${JSON.stringify(join(isolated, '.tmp/vite-cache'))}, test: { ...owning.test, include: ${JSON.stringify(testFiles)}, passWithNoTests: false, maxWorkers: 1 } })\n`)
  if (slice === 'frame') await writeFile(join(isolated, 'apps/desktop/' + proofTest), boundaryTests)

  const productFiles = (await files(join(isolated, 'apps/desktop/src'))).filter(file => /\.[cm]?[jt]sx?$/.test(file))
  assert.ok(productFiles.length > 0, 'Production caller scan is nonempty')
  for (const [name, definition, pattern, expected] of productionCallers()) {
    const hits = []
    for (const file of productFiles) if (relative(isolated, file) !== definition) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (!/^\s*(?:import|export\s+(?:type|\{|\*))/u.test(line) && !/^\s*\/\//u.test(line) && pattern.test(line))
          hits.push({ path: relative(isolated, file), line: index + 1, text: line.trim() })
      })
    }
    assert.ok(hits.length > 0 && hits.some(row => row.path === expected), 'Missing actual external production caller: ' + name)
    result.callers[name] = hits
  }

  const variants = slice === 'frame' ? frameVariants : contentVariants
  assert.ok(variants.length > 0)
  for (const variant of variants) {
    const source = await readFile(join(isolated, variant.path), 'utf8')
    assert.equal(source.split(variant.anchor).length - 1, 1, 'One exact actual Source mutation anchor: ' + variant.name)
  }
  result.prepared = true
  if (!prepareOnly) {
  const types = await run('strict-app-source-noemit', ['node_modules/typescript/bin/tsc', '--project',
    'apps/desktop/scripts/fixtures/mote-navigation-footer/tsconfig.frame.json', '--noEmit', '--strict', '--listFiles'])
  result.types = receiptOf(types)
  assert.equal(types.timedOut, false); assert.equal(types.exit, 0, 'Strict actual App Source noEmit failed')
  assert.ok(types.output.split('\n').some(line => line.trim() === join(isolated, prefix + 'App.tsx')), 'Strict noEmit must consume the real nonempty App graph')
  const baseline = await vitest('original-baseline-green'); result.baseline = receiptOf(baseline)
  assert.equal(baseline.exit, 0, 'Current isolated original Source must pass its nonempty owning cases')
  assert.equal(baseline.report.failed, 0); assert.ok(baseline.report.passed > 0)
  for (const variant of variants) {
    const path = join(isolated, variant.path), original = await readFile(path), source = original.toString('utf8')
    assert.equal(source.split(variant.anchor).length - 1, 1, 'One exact actual Source mutation anchor: ' + variant.name)
    const changed = source.replace(variant.anchor, variant.replacement)
    await mkdir(join(evidence, 'owning-source'), { recursive: true })
    await writeFile(join(evidence, 'owning-source', variant.name + '.original.txt'), original)
    await writeFile(join(evidence, 'owning-source', variant.name + '.mutant.txt'), changed)
    let red
    try {
      await writeFile(path, changed)
      red = await vitest(variant.name + '.red', variant.tests, variant.pattern)
      assert.notEqual(red.exit, 0, 'Actual broken behavior survived: ' + variant.name)
      assert.ok(red.report.failed > 0, 'No failed behavior case: ' + variant.name)
      assert.match(red.output, /AssertionError:/u, 'Mutation RED requires an actual assertion: ' + variant.name)
      assert.doesNotMatch(red.output, /No test files found|Failed to load url|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/iu,
        'Setup failure cannot kill a behavior mutant: ' + variant.name)
    } finally { await writeFile(path, original) }
    assert.equal(hash(await readFile(path)), hash(original), 'Exact Source restoration: ' + variant.name)
    const green = await vitest(variant.name + '.restored-green', variant.tests, variant.pattern)
    assert.equal(green.exit, 0); assert.equal(green.report.failed, 0); assert.ok(green.report.passed > 0)
    result.cases.push({ name: variant.name, path: variant.path, anchor: variant.anchor, replacement: variant.replacement,
      originalSha256: hash(original), mutatedSha256: hash(changed), restored: true, red: receiptOf(red), green: receiptOf(green) })
    console.log(variant.name + ': actual Assertion RED -> exact restored GREEN')
  }
  // A concurrent edit cannot turn a previous isolated snapshot into current acceptance.
  for (const [path, digest] of Object.entries(result.inputs))
    assert.equal(hash(await readFile(join(repository, path))), digest, 'Current Source changed; rerun after its stable node: ' + path)
  result.sourcePassed = true
  }
  }
  if (!prepareOnly) {
  const rendererPath = requestedRenderer ?? process.env.AGENTMUX_SHARED_FRAME_RENDERER_EVIDENCE
  const reviewPath = requestedReview ?? process.env.AGENTMUX_SHARED_FRAME_REVIEW_EVIDENCE
  assert.ok(rendererPath && reviewPath, 'Source passed only: provide exact Renderer/PID and independent image review receipts for Closure acceptance')
  const rendererFile = await selectedEvidence(rendererPath), reviewFile = await selectedEvidence(reviewPath)
  const rendererBytes = await readFile(rendererFile), renderer = JSON.parse(rendererBytes)
  assert.equal(renderer.schema, 'agentmux.mote-shared-frame-renderer-proof.v1', 'Consume the original shared-frame Renderer receipt')
  assert.equal(renderer.passed, true, 'Actual Renderer interactions and restoration must pass')
  assert.equal(renderer.userRunTouched, false, 'The original user Run must remain untouched')
  assert.ok(Object.keys(renderer.inputs ?? {}).length > 100 && Object.keys(renderer.compiled ?? {}).length > 0,
    'Actual Source/compiled Renderer binding must be nonempty')
  for (const [path, digest] of Object.entries(renderer.inputs)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Renderer Source input must be repository relative')
    assert.equal(hash(await readFile(join(repository, path))), digest, 'Renderer receipt is stale for current Source: ' + path)
  }
  assert.equal(renderer.phases?.length, 2, 'Consume two real original fixture processes')
  assert.deepEqual(renderer.phases.map(phase => phase.phase), ['seed', 'restore'])
  const pids = renderer.phases.map(phase => {
    assert.equal(phase.exit?.timedOut, false); assert.equal(phase.exit?.exitCode, 0)
    assert.equal(phase.app?.passed, true); assert.equal(phase.app?.phase, phase.phase)
    assert.ok(Number.isInteger(phase.app?.pid) && phase.app.pid > 0)
    assert.ok(phase.app.frames?.length > 0 && phase.app.checks?.length > 0, 'Original actual process cases and frames must be nonempty')
    assert.ok(phase.app.checks.every(check => check.passed === true), 'Original actual process checks must pass')
    return phase.app.pid
  })
  assert.equal(new Set(pids).size, 2, 'Same-profile restart must have distinct actual PIDs')
  assert.ok(typeof renderer.privateProfile === 'string' && renderer.privateProfile.length > 0)
  assert.deepEqual(renderer.cleanup?.remaining, []); assert.equal(renderer.cleanup?.privateRootRemoved, true)
  const reviewBytes = await readFile(reviewFile), review = JSON.parse(reviewBytes)
  assert.equal(review.status, 'approved', 'Independent full image review must be approved')
  assert.ok(typeof review.reviewer === 'string' && review.reviewer.length > 0 &&
    typeof review.independence === 'string' && review.independence.length > 0, 'Independent reviewer attribution and scope required')
  const reviewedReceipt = typeof review.receipt === 'string' && evidenceCandidates(review.receipt, dirname(reviewFile))
  assert.ok(reviewedReceipt && reviewedReceipt.includes(rendererFile), 'Review must identify this exact Renderer receipt')
  assert.equal(review.receiptSha256, hash(rendererBytes), 'Independent review must bind the final exact Renderer receipt SHA')
  assert.ok(Array.isArray(review.actuallyViewed) && review.actuallyViewed.length > 0, 'No images actually reviewed')
  const viewedPaths = new Set(review.actuallyViewed.flatMap(path => {
    assert.equal(typeof path, 'string'); return evidenceCandidates(path, dirname(reviewFile))
  }))
  const frames = renderer.phases.flatMap(phase => phase.app.frames)
  assert.ok(frames.length > 0)
  for (const frame of frames) {
    assert.ok(typeof frame.file === 'string' && !frame.file.split('/').includes('..'), 'Actual frame file identity required')
    const image = resolve(dirname(rendererFile), frame.file), bytes = await readFile(image)
    assert.ok(bytes.length > 100); assert.equal(hash(bytes), frame.sha256, 'Actual complete frame identity agrees: ' + frame.file)
    assert.ok(viewedPaths.has(image), 'Independent reviewer did not consume this final actual frame: ' + frame.file)
  }
  assert.ok(!(review.findings ?? []).some(finding => finding.severity === 'must-fix' && finding.status !== 'resolved'), 'Independent image review still has an open must-fix')
  result.renderer = { receipt: rendererPath, sha256: hash(rendererBytes), pids, frameCount: frames.length }
  result.visualReview = { receipt: reviewPath, sha256: hash(reviewBytes), reviewer: review.reviewer }
  for (const [path, digest] of Object.entries(result.inputs))
    assert.equal(hash(await readFile(join(repository, path))), digest, 'Current Source changed during external proof binding: ' + path)
  result.passed = true
  }
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  if (isolated) await rm(isolated, { recursive: true, force: true })
  result.cleanup.isolatedSourceRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify({ prepared: result.prepared, prepareOnly, sourcePassed: result.sourcePassed, passed: result.passed, slice, receipt: relative(repository, join(evidence, 'receipt.json')),
  actualMutations: result.cases.length, sourceEvidence: result.sourceEvidence, scope: result.scope, cleanup: result.cleanup, failure: result.failure }))
if (!(prepareOnly ? result.prepared && !result.failure : result.passed)) process.exitCode = 1
