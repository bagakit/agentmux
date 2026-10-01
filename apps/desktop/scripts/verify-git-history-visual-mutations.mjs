import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const panel = 'apps/desktop/src/renderer/src/components/GitHistoryPanel.tsx'
await verifyRendererSourceMutations({
  name: 'git-history-visual-mutations',
  tests: ['apps/desktop/test/git-history-panel.test.tsx'],
  sources: [panel, 'apps/desktop/src/renderer/src/styles/git-history.css'],
  mutations: [
    { label: 'collapse-real-branch-hues', file: panel,
      before: 'speakerColorHue(name)', after: '288' },
    { label: 'restore-tall-history-rows', file: panel,
      before: 'const ROW_HEIGHT = 40', after: 'const ROW_HEIGHT = 58' },
    { label: 'kink-cross-lane-continuity', file: panel,
      before: 'C ${x(before.indexOf(oid))} ${middle}, ${x(after.indexOf(oid))} ${middle}, ${x(after.indexOf(oid))} ${bottom}',
      after: 'L ${x(before.indexOf(oid))} ${middle} L ${x(after.indexOf(oid))} ${bottom}' }
  ]
})
