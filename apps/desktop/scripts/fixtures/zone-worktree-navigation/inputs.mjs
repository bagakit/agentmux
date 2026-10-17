export const products = [
  'components/WorkspaceZonesPanel.tsx', 'components/ProjectFilesTool.tsx',
  'components/TopicFilesTool.tsx', 'components/WorkspaceGitTool.tsx',
  'components/BranchesPanel.tsx', 'lib/copy-path-display.ts',
  'styles/workspace-zones.css', 'styles/workspace-git.css', 'hooks/useZoneWorktrees.ts'
].map(file => 'apps/desktop/src/renderer/src/' + file)

export const mutations = [
  { label: 'zone-kind-is-authoritative', file: products[0],
    before: 'KIND_LABELS[kind]', after: 'KIND_LABELS.directory' },
  { label: 'arrow-focus-does-not-navigate', file: products[0],
    before: 'rows[next]?.focus({ preventScroll: true })', after: 'rows[next]?.click()' },
  { label: 'summary-targets-current-resource', file: products[1],
    before: '<WorkspaceChangesSummary workspace={context.resource}', after: '<WorkspaceChangesSummary workspace={workspace}' }
]
