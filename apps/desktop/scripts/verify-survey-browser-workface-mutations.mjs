import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Task-specific private Renderer sources. Shared packages and installed dependencies are read-only.
const root = resolve(import.meta.dirname, '../../..')
const copy = await realpath(await mkdtemp('/tmp/amx-survey-zone-mutation-'))
const evidence = join(root, '.tmp', `survey-zone-caller-mutations-${Date.now()}`)
const renderer = 'apps/desktop/src/renderer/src/'
const survey = `${renderer}components/GlobalSurveySurface.tsx`, workbench = `${renderer}components/WorkspaceWorkbench.tsx`
const app = `${renderer}App.tsx`, projection = `${renderer}lib/workbench-projection.ts`, store = `${renderer}store.ts`
const tests = ['apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/test/survey-zone-controls.test.tsx', 'apps/desktop/test/browser-tools-density.test.tsx']
const sidebarSlice = process.argv[process.argv.indexOf('--slice') + 1] === 'sidebar'
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null
const mutations = [
  { slice: 'sidebar', label: 'sidebar-groups-by-display-instead-of-resource', file: survey, before: 'const resource = resourceWorkspaces.get(zone.workspaceId)', after: 'const resource = resourceWorkspaces.get(activeWorkspaceId!)' },
  { slice: 'sidebar', label: 'sidebar-project-opens-first-worktree', file: survey, before: 'project?.preferredWorkspaceId ?? null', after: 'project?.workspaces[0]?.id ?? null' },
  { slice: 'sidebar', label: 'sidebar-pointer-commit-disconnected', file: survey, before: 'setWidth: setSidebarWidth, deltaSign: 1', after: 'setWidth: () => {}, deltaSign: 1' },
  { slice: 'sidebar', label: 'sidebar-keyboard-disconnected', file: survey, before: 'if (next === null) return', after: 'if (true) return' },
  { slice: 'sidebar', label: 'sidebar-ignores-available-space', file: `${renderer}lib/survey-sidebar-width.ts`, before: 'availableWidth > 0 ?', after: 'false ?' },
  { slice: 'sidebar', label: 'sidebar-preference-not-restored', file: store, before: 'surveySidebarWidth: clampSurveySidebarWidth(persisted.surveySidebarWidth ?? SURVEY_SIDEBAR_DEFAULT_WIDTH)', after: 'surveySidebarWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH' },
  { slice: 'sidebar', label: 'sidebar-preference-not-saved', file: store, before: 'surveySidebarWidth: state.surveySidebarWidth,', after: 'surveySidebarWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH,' },
  { slice: 'sidebar', label: 'sidebar-save-failure-silenced', file: store, before: '// Commit only the finished presentation gesture through the existing save owner.\n    void saveWorkbenchSelection(false)', after: '// Mutated: no original save receipt is requested.\n    void 0' },
  { slice: 'sidebar', label: 'sidebar-operation-details-hidden', file: `${renderer}components/SurveyZoneItem.tsx`, before: '{activityDetails}</div>', after: '</div>' },
  { label: 'session-status-rebuilds-spatial-directory', file: app, before: 'const byId = sessionPresentationById(state.sessions)', after: 'return state.sessions\n    const byId = sessionPresentationById(state.sessions)' },
  { label: 'same-address-replaced-slot-loses-content', file: `${renderer}components/StableWorkbenchView.tsx`, before: '}) // The original layout can replace a slot without changing its exact address.', after: '}, [homeId, targetId, host, showHomeNotice])' },
  { label: 'direct-region-paints-parent-tab', file: projection, before: "if (scope.entity.kind === 'region') return { layout: null,", after: 'if (false) return { layout: null,' },
  { label: 'conflicting-unknown-selection-picks-winner', file: projection, before: 'if (references.length !== 1)', after: 'if (false)' },
  { label: 'retry-mints-another-zone', file: survey, before: 'let preparation = newItem ? null : failedCreation.current', after: 'let preparation = null' },
  { label: 'late-attached-browser-not-recognized', file: survey, before: 'if (!confirmedBrowser)', after: 'if (true)' },
  { label: 'new-item-query-lost', file: survey, before: 'if (query.trim()) void openBrowser(query)', after: "if (query.trim()) void openBrowser('about:blank')" },
  { label: 'pending-create-steals-selection', file: survey, before: "intent.current === startedIntent && current.mainSurface === 'survey' && current.surveyZoneSelection === before.surveyZoneSelection", after: "current.mainSurface === 'survey'" },
  { label: 'tab-selection-changes-space-layout', file: workbench, before: 'onClick={() => projection ? selectWorkbenchProjectionTab(projection, group.id, tab) : activateTab(workspaceId, group.id, tab.id)}', after: 'onClick={() => activateTab(workspaceId, group.id, tab.id)}' },
  { label: 'region-input-selection-disconnected', file: workbench, before: 'if (browserPresentation.onSelectRegion) browserPresentation.onSelectRegion(node.regionId)', after: 'if (browserPresentation.onSelectRegion) void node.regionId' },
  { label: 'foreign-tab-created-at-resource-display', file: workbench, before: 'displayWorkspaceId: projection.displayWorkspaceId, tabGroupId: groupId, zoneId: zone.zoneId', after: 'displayWorkspaceId: zone.workspaceId, tabGroupId: groupId, zoneId: zone.zoneId' },
  { label: 'new-tab-rejected-by-previous-catalog', file: app, before: 'if (!matches(surveyCatalog) && !matches(spatialCatalog(state, surveyTopics ?? []))) return', after: 'if (!matches(surveyCatalog)) return' },
  { label: 'content-tree-remounts-on-presentation', file: workbench, before: '<StableWorkbenchView key={tab.id}', after: '<StableWorkbenchView key={targetId ?? tab.id}' },
  { label: 'restart-zone-reference-erased', file: store, before: 'surveyZoneSelection: restoredSurveyZoneSelection(persisted.surveyZoneSelection)', after: 'surveyZoneSelection: null' },
  { label: 'topic-discovery-error-hidden-by-save', file: survey, before: '{topicSnapshot?.error ? <div>{topicSnapshot.error}</div> : null}', after: 'null' }
]
const selectedMutations = mutations.filter(mutation => (!only || only.has(mutation.label)) && (sidebarSlice ? mutation.slice === 'sidebar' : mutation.slice !== 'sidebar') && (!process.argv.includes('--region-only') || mutation.label === 'direct-region-paints-parent-tab') && (!process.argv.includes('--placement-only') || mutation.label === 'same-address-replaced-slot-loses-content') && (!process.argv.includes('--catalog-only') || mutation.label === 'session-status-rebuilds-spatial-directory'))
const sources = [app, survey, workbench, projection, store, `${renderer}lib/survey-workface.ts`, `${renderer}lib/survey-sidebar-width.ts`, `${renderer}lib/workbench-presentation.ts`, `${renderer}components/StableWorkbenchView.tsx`, `${renderer}components/SurveyTopicRelations.tsx`, `${renderer}components/SurveyZoneItem.tsx`, `${renderer}styles/survey.css`, 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/scripts/verify-survey-browser-workface-mutations.mjs']
const inputs = [...new Set([...sources, ...tests])]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const receipt = { schema: 'agentmux.renderer-source-mutation.v1', passed: false, sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
let observedSource = null
const run = async label => {
  await writeFile(join(copy, 'current-load.json'), JSON.stringify(observedSource ? { file: join(copy, observedSource), load: join(evidence, `${label}-loaded.json`) } : null))
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', ...tests, '--config', 'vitest.survey.mts', '--maxWorkers=1'], { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { code: result.code, signal: result.signal, output: result.output, log: `${label}.log` }
}
try {
  await mkdir(evidence, { recursive: true })
  assert.ok(selectedMutations.length > 0, 'The requested mutation selection must not be empty.')
  if (only) assert.deepEqual([...only].sort(), selectedMutations.map(mutation => mutation.label).sort(), 'Every --only name must match the actual selected mutation source.')
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts']) await cp(join(root, file), join(copy, file))
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  await symlink(join(root, 'packages'), join(copy, 'packages'))
  await mkdir(join(copy, 'apps/desktop/src'), { recursive: true })
  for (const directory of ['renderer', 'shared']) await cp(join(root, 'apps/desktop/src', directory), join(copy, 'apps/desktop/src', directory), { recursive: true })
  for (const file of ['package.json', 'tsconfig.json']) await cp(join(root, 'apps/desktop', file), join(copy, 'apps/desktop', file))
  await symlink(join(root, 'apps/desktop/node_modules'), join(copy, 'apps/desktop/node_modules'))
  await symlink(join(root, 'apps/desktop/resources'), join(copy, 'apps/desktop/resources'))
  for (const [file, bytes] of original) { await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes) }
  await writeFile(join(copy, 'vitest.survey.mts'), `import { defineConfig } from 'vitest/config';
import { readFileSync, writeFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
export default defineConfig({ server: { fs: { allow: ${JSON.stringify([root, copy])} } }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
plugins: [{ name: 'actual-private-source-load', enforce: 'pre', transform(source, id) { const target = JSON.parse(readFileSync(${JSON.stringify(join(copy, 'current-load.json'))}, 'utf8')); if (target && id === target.file) writeFileSync(target.load, JSON.stringify({ file: id, sha256: createHash('sha256').update(source).digest('hex') })); } }],
test: { include: ${JSON.stringify(tests)}, setupFiles: ['vitest.setup.ts'], globalSetup: [${JSON.stringify(join(root, 'vitest.dist-freshness.ts'))}] } });\n`)

  const baseline = await run('baseline-green'); assert.equal(baseline.code, 0, baseline.output)
  for (const mutation of selectedMutations) {
    const source = original.get(mutation.file).toString()
    assert.equal(source.split(mutation.before).length - 1, 1, `Unique actual Source anchor: ${mutation.label}`)
    observedSource = mutation.file
    try {
      await writeFile(join(copy, mutation.file), source.replace(mutation.before, mutation.after))
      const red = await run(`${mutation.label}-red`)
      assert.ok(red.code > 0 && red.signal === null, red.output); assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      const loaded = JSON.parse(await readFile(join(evidence, `${mutation.label}-red-loaded.json`), 'utf8'))
      assert.equal(loaded.file, join(copy, mutation.file)); assert.equal(loaded.sha256, digest(source.replace(mutation.before, mutation.after)))
      receipt.cases.push({ ...mutation, exit: red.code, log: red.log, loaded })
    } finally { await writeFile(join(copy, mutation.file), original.get(mutation.file)) }
    const restored = await run(`${mutation.label}-restore-green`); assert.equal(restored.code, 0, restored.output)
    const loaded = JSON.parse(await readFile(join(evidence, `${mutation.label}-restore-green-loaded.json`), 'utf8')); assert.equal(loaded.sha256, digest(original.get(mutation.file)))
    receipt.cases.at(-1).restore = { exit: restored.code, log: restored.log, loaded }
    console.log(`PASS ${mutation.label}: actual AssertionRED -> restoreGREEN`)
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore); receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally { await rm(copy, { recursive: true, force: true }); receipt.cleanup = { copyRemoved: true }; await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`) }
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
