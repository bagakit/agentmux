import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const sidebar = 'apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx'
const identity = 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx'
const project = 'apps/desktop/src/renderer/src/components/ProjectIcon.tsx'
const css = 'apps/desktop/src/renderer/src/styles/conversation-avatar.css'

await verifyRendererSourceMutations({
  name: `space-folder-monogram-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/space-folder-icon-recency.test.tsx'],
  sources: [sidebar, identity, project, css],
  mutations: [
    { label: 'sidebar-durable-identity-disconnected', file: sidebar,
      before: 'folderIdentityKey={target.key}', after: 'folderIdentityKey={undefined}' },
    { label: 'automatic-folder-identity-disconnected', file: identity,
      before: 'folderIdentityKey={folderIdentityKey}', after: 'folderIdentityKey={undefined}' },
    { label: 'preferred-workspace-borrows-identity', file: project,
      before: 'speakerColorHue(folderIdentityKey!)', after: 'speakerColorHue(workspaceId)' },
    { label: 'actual-monogram-tone-disconnected', file: project,
      before: 'data-folder-icon-recency={coloredMonogram ? recency?.tone : undefined}',
      after: 'data-folder-icon-recency={undefined}' },
    { label: 'monogram-boundary-clock-disconnected', file: project,
      before: 'if (!(appearance?.icon || coloredMonogram)', after: 'if (!(appearance?.icon)' },
    { label: 'full-monogram-color-disconnected', file: css,
      before: 'color: hsl(var(--folder-icon-hue) 52% 74%);', after: 'color: var(--text-3);' },
    { label: 'subdued-monogram-color-disconnected', file: css,
      before: 'color: hsl(var(--folder-icon-hue) 42% 70%);', after: 'color: hsl(var(--folder-icon-hue) 28% 66%);' },
    { label: 'light-monogram-color-disconnected', file: css,
      before: 'color: hsl(var(--folder-icon-hue) 40% 36%);', after: 'color: hsl(var(--folder-icon-hue) 52% 74%);' },
    { label: 'folder-color-leaks-to-other-monograms', file: css,
      before: '\n.project-rail-row__icon[data-monogram][data-folder-icon-recency] {',
      after: '\n.project-rail-row__icon[data-monogram] {' }
  ]
})
