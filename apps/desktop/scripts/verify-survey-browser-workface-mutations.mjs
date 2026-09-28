import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = 'apps/desktop/src/renderer/src/'
const app = `${root}App.tsx`
const survey = `${root}components/GlobalSurveySurface.tsx`
const tools = `${root}components/SurveyBrowserTools.tsx`
const pane = `${root}components/BrowserPane.tsx`
const workbench = `${root}components/WorkspaceWorkbench.tsx`
const pages = `${root}lib/survey-browser.ts`
const budget = `${root}lib/surface-memory-budget-candidates.ts`
const browserState = `${root}lib/browser-state.ts`
const persistence = `${root}lib/workbench-persistence.ts`
const store = `${root}store.ts`
const css = `${root}styles/survey.css`
const preferences = `${root}components/BrowserToolbarPreferences.tsx`
await verifyRendererSourceMutations({
  name: `survey-browser-workface-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/test/browser-tools-density.test.tsx', 'apps/desktop/test/browser-toolbar-overflow.test.tsx'],
  sources: [app, survey, tools, pane, workbench, pages, budget, browserState, persistence, `${root}lib/workbench-tabs.ts`, store, css, preferences,
    `${root}lib/workbench-presentation.ts`, `${root}lib/surface-memory-budget-coordinator.tsx`,
    'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/scripts/verify-survey-browser-workface-mutations.mjs'],
  mutations: [
    { label: 'global-directory-filtered-to-first-project', file: pages,
      before: 'return workspaces.flatMap(({ id: workspaceId }) => {', after: 'return workspaces.slice(0, 1).flatMap(({ id: workspaceId }) => {' },
    { label: 'directory-live-placement-collection-empty', file: pages,
      before: 'const tabIds = new Set(layouts[workspaceId]?.groups.flatMap(group => group.tabOrder) ?? [])', after: 'const tabIds = new Set<string>()' },
    { label: 'project-action-wrong-workspace', file: survey,
      before: 'await selectWorkspace(reference.workspaceId)', after: 'await selectWorkspace(workspace!.id)' },
    { label: 'central-query-lost', file: survey,
      before: 'if (query.trim()) void openBrowser(query)', after: "if (query.trim()) void openBrowser('about:blank')" },
    { label: 'exact-create-disconnected', file: survey,
      before: 'await before.createBrowser(group.id, { tabId: reference.tabId, regionId: reference.regionId }, input)', after: 'await Promise.resolve()' },
    { label: 'failed-launcher-retry-accumulates-tabs', file: survey,
      before: 'const tabId = reusable ? retry.reference.tabId : before.openLauncher(', after: 'const tabId = before.openLauncher(' },
    { label: 'pending-create-steals-later-choice', file: survey,
      before: "intent.current === startedIntent && current.mainSurface === 'survey' && current.surveyBrowserSelection === before.surveyBrowserSelection", after: "current.mainSurface === 'survey'" },
    { label: 'same-browser-navigation-disconnected', file: pane,
      before: 'void run(() => api.browser.navigate(tab.browserId, address), cause => {', after: 'void run(() => Promise.resolve(tab), cause => {' },
    { label: 'second-browser-input-guesses-first-region', file: survey,
      before: '.find(region => region.dataset.workbenchRegionId === selection?.regionId)', after: '.find(() => true)' },
    { label: 'survey-app-consumer-disconnected', file: app,
      before: '<GlobalSurveySurface visible={surveyVisible} controlsCoverPage={surveyToolsOpen && narrowControls} unconfirmedBrowserRegionIds={unconfirmedBrowserRegionIds} />', after: 'null' },
    { label: 'visited-survey-drafts-unmounted', file: app,
      before: "{surveyVisited || mainSurface === 'survey' ?", after: "{mainSurface === 'survey' ?" },
    { label: 'whole-tab-projection-disconnected', file: app,
      before: 'viewTargets={viewTargets}', after: 'viewTargets={moteViewTargets}' },
    { label: 'tab-host-remounts-on-presentation', file: workbench,
      before: '<StableWorkbenchView key={tab.id}', after: '<StableWorkbenchView key={targetId ?? tab.id}' },
    { label: 'complete-tab-siblings-hidden', file: workbench,
      before: 'surfaceVisible={tabVisible}', after: "surfaceVisible={tabVisible && projection?.surface !== 'survey'}" },
    { label: 'browser-portal-pointer-steals-space-focus', file: workbench,
      before: "if (!(browserPresentation.survey && surface?.kind === 'browser')) focusRegion", after: 'focusRegion' },
    { label: 'only-selected-tab-resource-projection-disconnected', file: app,
      before: 'projectedVisibleTabIds={projectedVisibleTabIds}', after: 'projectedVisibleTabIds={undefined}' },
    { label: 'narrow-management-keeps-tab-siblings-visible', file: app,
      before: "visible: !(surveyToolsOpen && narrowControls), surface: 'survey' as const", after: "visible: true, surface: 'survey' as const" },
    { label: 'hidden-space-dock-parks-survey-native-page', file: pane,
      before: '(controlPanelOpen ?? toolsOpen) && window.innerWidth <= (inSurvey ? 1100 : 900)', after: 'toolsOpen && window.innerWidth <= 1100' },
    { label: 'tab-target-geometry-observer-not-rebound', file: pane,
      before: 'queueMicrotask(() => { if (!cancelled) rebindBoundsObserverRef.current?.() })', after: 'queueMicrotask(() => {})' },
    { label: 'single-browser-close-stops-before-all-placements', file: pages,
      before: "throw new Error('The page could not close. Its work surface is kept; retry here.')\n      }", after: "throw new Error('The page could not close. Its work surface is kept; retry here.')\n      }\n      break" },
    { label: 'single-browser-close-ignores-changed-owner', file: pages,
      before: 'live.browserId !== surface.browserId || Object.keys(current.tabs[selection.tabId]!.regions).length !== 1', after: 'false' },
    { label: 'explicit-close-leaves-false-restoring-selection', file: pages,
      before: 'return surveyBrowserSurface(before, selection) && !surveyBrowserSurface(after, selection) ? null : selection', after: 'return selection' },
    { label: 'ui-promote-keeps-old-page-tuple', file: store,
      before: '...(sameSurveyBrowserSelection(state.surveyBrowserSelection, { workspaceId, tabId, regionId }) ? { surveyBrowserSelection: result.target } : {}),', after: '' },
    { label: 'public-promote-keeps-old-page-tuple', file: store,
      before: '...(sameSurveyBrowserSelection(current.surveyBrowserSelection, region) ? { surveyBrowserSelection: result.target } : {}),', after: '' },
    { label: 'public-background-create-steals-survey', file: store,
      before: "set((current) => ({ ...(current.mainSurface === 'survey' ? {} : { activeWorkspaceId: workspace.id, mainSurface: 'workbench' as const }), tabs: plan.tabs, layouts: plan.layouts }))",
      after: "set({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: plan.tabs, layouts: plan.layouts })" },
    { label: 'survey-restoration-disconnected', file: store,
      before: "if (candidate === 'survey') return 'survey'", after: "if (candidate === 'survey') return 'workbench'" },
    { label: 'survey-restored-tuple-disconnected', file: store,
      before: 'surveyBrowserSelection: restoredSurveyBrowserSelection(persisted.surveyBrowserSelection)', after: 'surveyBrowserSelection: null' },
    { label: 'historical-agent-control-misreported-as-driving', file: survey,
      before: "page.surface.driving ? 'agent'", after: "page.surface.activity?.control === 'agent' ? 'agent'" },
    { label: 'human-control-misreported-as-unknown', file: survey,
      before: "page.surface.activity?.control === 'human' ? 'human'", after: "page.surface.activity?.control === 'human' ? 'unknown'" },
    { label: 'restore-unconfirmed-notice-disconnected', file: app,
      before: 'onBrowserControlConfirmation={onBrowserControlConfirmation}', after: 'onBrowserControlConfirmation={undefined}' },
    { label: 'live-driving-browser-owner-released', file: budget,
      before: 'protected: surface.loading || (surface.driving && !surface.nativeOwnerUnavailable)', after: 'protected: surface.loading' },
    { label: 'native-unavailable-fact-disconnected', file: browserState,
      before: 'error: event.error, nativeOwnerUnavailable: true', after: 'error: event.error' },
    { label: 'fresh-equal-snapshot-keeps-native-unavailable', file: browserState,
      before: 'if (!surface.nativeOwnerUnavailable && Object.entries(event.browser).every(', after: 'if (Object.entries(event.browser).every(' },
    { label: 'fresh-snapshot-keeps-native-unavailable', file: browserState,
      before: 'regions[surface.regionId] = { ...availableSurface, ...event.browser, regionId: surface.regionId }', after: 'regions[surface.regionId] = { ...surface, ...event.browser, regionId: surface.regionId }' },
    { label: 'unavailable-transient-fact-persisted', file: persistence,
      before: "function reduceBrowserSurfaceForPersistence(surface: BrowserWorkbenchSurface): PersistedBrowserSurface {\n  return {", after: "function reduceBrowserSurfaceForPersistence(surface: BrowserWorkbenchSurface): PersistedBrowserSurface {\n  return {\n    nativeOwnerUnavailable: surface.nativeOwnerUnavailable," },
    { label: 'mote-target-wins-visible-survey', file: app,
      before: "visible: !(surveyToolsOpen && narrowControls), surface: 'survey' as const, controlsOpen: surveyToolsOpen\n    } } : {})",
      after: "visible: !(surveyToolsOpen && narrowControls), surface: 'survey' as const, controlsOpen: surveyToolsOpen\n    } } : {}), ...moteViewTargets" },
    { label: 'glass-material-disconnected', file: css,
      before: 'backdrop-filter: blur(20px) saturate(120%);', after: 'backdrop-filter: none;' },
    { label: 'survey-stylesheet-scanning-surface-empty', file: css,
      before: readFileSync(css, 'utf8'), after: '' },
    { label: 'selected-whole-row-fill-disconnected', file: css,
      before: '.survey-page-row[data-selected="true"] { background: color-mix(in srgb, var(--surface-3) 92%, var(--green-2)); box-shadow: var(--hl); }',
      after: '.survey-page-row[data-selected="true"] { background: transparent; }' },
    { label: 'original-bar-save-disconnected', file: preferences,
      before: 'saveState.run(() => onSave(submitted.value, submitted.expected))', after: 'saveState.run(() => Promise.resolve())' },
    { label: 'original-annotation-composer-consumer-disconnected', file: tools,
      before: 'appendAgentComposerDraft(sessionId, formatBrowserAnnotationsContext(currentAnnotations))', after: 'void sessionId' },
    { label: 'annotation-runtime-collection-empty', file: tools,
      before: 'const browserAnnotations = useMemo(() => Object.values(browserAnnotationsByBrowserId).flat()\n    .filter((annotation) => annotation.workspaceId === workspace.id), [browserAnnotationsByBrowserId, workspace.id])', after: 'const browserAnnotations = []' }
  ]
})
