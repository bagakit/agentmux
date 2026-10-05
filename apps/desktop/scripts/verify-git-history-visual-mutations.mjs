import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const panel = 'apps/desktop/src/renderer/src/features/git/history/GitHistoryPanel.tsx'
const details = 'apps/desktop/src/renderer/src/features/git/history/GitHistoryDetails.tsx'
await verifyRendererSourceMutations({
  name: 'git-history-visual-mutations',
  tests: ['apps/desktop/test/git-history-panel.test.tsx'],
  sources: [panel, details, 'apps/desktop/src/renderer/src/styles/git-history.css'],
  mutations: [
    { label: 'collapse-real-branch-hues', file: panel,
      before: 'speakerColorHue(name)', after: '288' },
    { label: 'restore-tall-history-rows', file: panel,
      before: 'const ROW_HEIGHT = 24', after: 'const ROW_HEIGHT = 40' },
    { label: 'restore-stacked-history-layout', file: panel,
      before: 'height: ROW_HEIGHT, top: index * ROW_HEIGHT', after: "height: ROW_HEIGHT, flexDirection: 'column', top: index * ROW_HEIGHT" },
    { label: 'drop-hover-author', file: details,
      before: "{opened.commit.author || '(Not recorded)'}", after: "{''}" },
    { label: 'misalign-commit-nodes', file: panel,
      before: 'cy={middle}', after: 'cy={top}' },
    { label: 'kink-cross-lane-continuity', file: panel,
      before: 'C ${x(index)} ${middle}, ${x(afterIndexes.get(oid)!)} ${middle}, ${x(afterIndexes.get(oid)!)} ${bottom}',
      after: 'L ${x(index)} ${middle} L ${x(afterIndexes.get(oid)!)} ${bottom}' }
  ]
})
