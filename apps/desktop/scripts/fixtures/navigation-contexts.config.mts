import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../..')
// Mutate the loaded production module, never the checkout or a test double.
const changes = {
  'focus-preview-execution-label': ['components/FocusNavigationPreview.tsx', '>Focused</small>', '>Viewing</small>'],
  'work-selection': ['store.ts', 'set({ workbenchSpaceSelection: choice, activeWorkspaceId: choice.workspaceId, retainedSpatialFocus: null,', 'set({ workbenchSpaceSelection: state.workbenchSpaceSelection, activeWorkspaceId: choice.workspaceId, retainedSpatialFocus: null,'],
  'http-local-domain': ['store.ts', "const local = presentation?.surface === 'mote' || presentation?.surface === 'survey'", "const local = presentation?.surface === 'mote'"],
  'http-late-navigation': ['store.ts', "destination !== 'tab' && !navigationChanged &&", "destination !== 'tab' &&"],
  'execution-reference-identity': ['lib/focus-tab-projection.ts', 'choices.some(choice => sameWorkbenchProjectionSelection(choice, reference))', 'catalog.locations.some(choice => sameWorkbenchProjectionSelection(choice, reference))'],
  'goal-ambiguity': ['store.ts', "mainSurface === 'board' && linked.length === 1", "mainSurface === 'board' && linked.length > 0"],
  'survey-follows-work': ['store.ts', 'set({ surveyZoneSelection })', 'if (selection?.active) get().selectMainRegion({ displayWorkspaceId: get().activeWorkspaceId!, groupId: get().layouts[get().activeWorkspaceId!]!.activeGroupId, ...selection.active }); set({ surveyZoneSelection })'],
  'survey-agent-navigates': ['App.tsx', 'reference, { navigate: false })', 'reference)'],
  'mote-first-discussion': ['lib/pmo-teams-topic-floating.ts', 'candidates.length === 1 ? candidates[0]!.id', 'candidates.length > 0 ? candidates[0]!.id'],
  'mote-shared-region': ['lib/pmo-teams-topic-target.ts', 'reference ? reference.tabId === tabId ? reference.regionId : undefined', 'reference ? tab?.layout.activeRegionId'],
  'mote-shared-observation': ['lib/desktop-presentation.ts', 'owner.floating.regionId ?? null', 'tab?.layout.activeRegionId'],
  'session-local-callback': ['components/SessionPane.tsx', 'if (primaryPresentation.onSelectRegion) primaryPresentation.onSelectRegion(linkOrigin.regionId)', 'if (primaryPresentation.onSelectRegion) {}'],
  'session-local-fallback': ['components/SessionPane.tsx', "else if (mailboxOrigin.tabId && !primaryPresentation.survey && (!primaryPresentation.surface || primaryPresentation.surface === 'space'))", 'else if (mailboxOrigin.tabId)'],
  'session-exact-group': ['components/SessionPane.tsx', "'pointer', mailboxOrigin.tabGroupId)", "'pointer')"],
  'history-late-context': ['components/SessionPane.tsx', 'historyReturnContextRef.current !== historyReturnContext || ', '']
} as const
const mutation = process.env.AGENTMUX_NAVIGATION_MUTATION as keyof typeof changes | undefined
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.tmp/navigation-contexts/cache'),
  plugins: [...original.plugins ?? [], { name: 'navigation-context-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    const [file, before, after] = changes[mutation]
    const owner = resolve(root, 'apps/desktop/src/renderer/src', file)
    if (id.split('?')[0] !== owner) return
    assert.equal(source.split(before).length - 1, 1, 'Unique actual production mutation anchor: ' + mutation)
    const code = source.replace(before, after)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.AGENTMUX_NAVIGATION_WITNESS!, JSON.stringify({ mutation, owner,
      original: hash(source), loaded: hash(code) }) + '\n')
    return { code, map: null }
  } }], test: { ...original.test, passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
