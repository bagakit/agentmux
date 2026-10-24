const renderer = 'apps/desktop/src/renderer/src/'
// The same affected product chain qualifies both semantic proof reuse and the
// captured Renderer. App's other imports remain provenance, not this Task's gate.
export const productInputs = [
  ...['App.tsx', 'store.ts', 'styles/focus.css',
    'components/DesktopClientUiProvider.tsx', 'components/GlobalFocusSurface.tsx',
    'components/FocusFilters.tsx', 'components/HoverDropdownMenu.tsx',
    'components/FocusContextCards.tsx', 'components/FocusContextCardBody.tsx',
    'components/FocusContextRow.tsx', 'components/FocusContextState.tsx',
    'components/AgentContextContent.tsx',
    'components/FocusProjectLanes.tsx', 'components/FocusLaneGroups.tsx',
    'components/FocusToolbar.tsx', 'components/FocusHistorySearch.tsx',
    'components/FocusSearchLocations.tsx', 'components/FocusSourceStatus.tsx',
    'components/RecentFocusTimeline.tsx', 'components/WorkspaceWorkbench.tsx',
    'components/StableWorkbenchView.tsx',
    'lib/focus-context.ts', 'lib/focus-filters.ts', 'lib/focus-lane-origin.ts',
    'lib/focus-project-lanes.ts', 'lib/focus-search.ts', 'lib/focus-context-identity.ts',
    'lib/focus-tab-projection.ts', 'lib/focus-history-sources.ts', 'lib/api.ts',
    'lib/use-focus-history-search.ts', 'lib/history-read.ts', 'lib/history-observation.ts',
    'lib/search-read.ts', 'lib/use-focus-hierarchy.ts',
    'lib/use-focus-project-order.ts', 'lib/agent-focus.ts', 'lib/agent-observation.ts',
    'lib/activity-working-state.ts', 'lib/attention-vocabulary.ts',
    'lib/session-presentation.ts', 'lib/scratch-topic-snapshots.ts',
    'lib/desktop-focus-navigation.ts', 'lib/workbench-navigation-catalog.ts',
    'lib/workbench-projection.ts', 'lib/workbench-tabs.ts',
    'lib/workbench-session-subscriptions.ts', 'lib/mobile-presentation.ts',
    'lib/space-agent-control.ts', 'lib/survey-list.ts', 'lib/survey-exploration-name.ts',
    'lib/space-object-appearance.ts',
    'lib/pmo-teams-topic-floating.ts'].map(file => renderer + file),
  ...['contracts.ts', 'scratch-topics.ts', 'space-addresses.ts', 'focus-preferences.ts']
    .map(file => 'apps/desktop/src/shared/' + file),
  ...['agent-status-freshness.ts', 'conversation.ts', 'search.ts', 'search-metadata.ts',
    'search-contract.ts', 'search-codec.ts', 'survey-organization.ts'].map(file => 'packages/core/src/' + file),
  'packages/client-ui/src/lib/focus-state-mark.ts',
  'packages/client-ui/src/components/FocusStateMark.tsx'
]
export const captureInputs = ['apps/desktop/scripts/capture-focus-composable-filters.mjs',
  'apps/desktop/scripts/fixtures/focus-composable-filters/entry.mjs',
  'apps/desktop/scripts/fixtures/focus-composable-filters/main.cjs',
  'apps/desktop/scripts/fixtures/focus-composable-filters/inputs.mjs']
