import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const store = 'apps/desktop/src/renderer/src/store.ts'
const files = 'apps/desktop/src/renderer/src/lib/file-workbench-state.ts'
const root = resolve(import.meta.dirname, '../../..')
await verifyRendererSourceMutations({
  name: 'topic-file-scope', owningConfig: 'apps/desktop/test/topic-file-scope.config.mts',
  tests: ['apps/desktop/test/topic-file-scope.test.ts'],
  sources: [store, files, 'apps/desktop/src/renderer/src/lib/workface-file-open.ts',
    'apps/desktop/src/renderer/src/lib/desktop-presentation.ts', 'apps/desktop/src/renderer/src/components/FileExplorer.tsx',
    'apps/desktop/src/renderer/src/components/TopicKnowledgePanel.tsx', 'apps/desktop/src/renderer/src/lib/topic-knowledge-actions.ts',
    'apps/desktop/scripts/verify-topic-file-scope.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/test/vitest.mote-context.config.mts', 'vitest.config.ts', 'vitest.dist-freshness.ts',
    'apps/desktop/test/workface-file-open-control.test.tsx', 'apps/desktop/test/helpers/workface-file-fixture.ts',
    'apps/desktop/test/helpers/workface-control-fixture.ts'],
  mutations: [
    { label: 'selected-zone-before-shared-resource', file: store,
      before: '  const originalZoneId = localZone?.workspaceId === workspaceId ? localZone.zoneId\n    : choice?.workspaceId === workspaceId ? choice.zoneId : null',
      after: '  const originalZoneId = null' },
    { label: 'reuse-requires-same-zone', file: files,
      before: '    if (!tab || context?.space && tab.space &&\n      (tab.space.spaceId !== context.space.spaceId || tab.space.zoneId !== context.space.zoneId)) continue',
      after: '    if (!tab) continue' },
    { label: 'file-region-is-the-receipt', file: store,
      before: 'const reference = placement.reference && !bookmarkOpened ? placement.reference',
      after: 'const reference = placement.reference && !bookmarkOpened ? { ...placement.reference, regionId: tab.layout.activeRegionId }' },
    { label: 'existing-reference-keeps-unknown-parent', file: store,
      before: '    displayWorkspaceId, ...(groupId ? { groupId } : {})\n  }, mainRegionReference(originalChoice) ?? undefined)',
      after: '    displayWorkspaceId, ...(groupId ? { groupId } : {})\n  })' },
    { label: 'explicit-display-precedes-origin', file: 'apps/desktop/src/renderer/src/lib/workface-file-open.ts',
      before: 'location.groupId !== (destination.groupId ?? origin.groupId)',
      after: 'location.groupId !== origin.groupId' },
    { label: 'diff-keeps-original-result', file: store,
      before: "    await get().setEditorRegionMode(placed.regionId, workspaceId, path, 'diff')",
      after: "    await get().setEditorRegionMode(get().workbenchSpaceSelection?.regionId ?? placed.regionId, workspaceId, path, 'diff')" },
    { label: 'navigation-does-not-probe-dom', file: store,
      before: '    const overlays = readDesktopOverlays()',
      after: '    const { overlays } = readDesktopPresentation(desktopSelection(state, workbenchSelectionCatalog(state)), state.tabs)' }
  ]
})

// Reuse the actual public CLI consumer, including background navigation, input
// preservation, exact splits, partial results and the original File owner.
const report = resolve(root, '.tmp/topic-file-scope/public-cli.json')
const cli = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
  'apps/desktop/test/workface-file-open-control.test.tsx', '--testNamePattern', 'File open through compiled CLI',
  '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`],
{ cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 })
await writeFile(resolve(root, '.tmp/topic-file-scope/public-cli.log'), cli.stdout + cli.stderr)
assert.equal(cli.error, undefined, 'Public consumer setup/timeout is not behavioral evidence')
assert.equal(cli.status, 0, cli.stdout + cli.stderr)
const facts = JSON.parse(await readFile(report, 'utf8'))
assert.equal(facts.numPassedTests, 11); assert.equal(facts.numFailedTests, 0)
console.log(JSON.stringify({ passed: true, publicCliTests: facts.numPassedTests, report }))
