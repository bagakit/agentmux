import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const activity = 'apps/desktop/src/renderer/src/lib/space-folder-icon-recency.ts'
const sidebar = 'apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx'
const identity = 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx'
const image = 'apps/desktop/src/renderer/src/components/ProjectIcon.tsx'
const rail = 'apps/desktop/src/renderer/src/components/ProjectRail.tsx'
const app = 'apps/desktop/src/renderer/src/App.tsx'
const css = 'apps/desktop/src/renderer/src/styles/chrome.css'

await verifyRendererSourceMutations({
  name: `space-folder-icon-recency-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/space-folder-icon-recency.test.tsx'],
  sources: [activity, sidebar, identity, image, rail, app, css],
  mutations: [
    // Empty the whole owned collection, rather than one predicate invocation.
    { label: 'owned-facts-block-empty', file: activity,
      before: 'for (const session of sessions)', after: 'for (const session of [] as readonly SessionSnapshot[])' },
    { label: 'untrusted-source-accepted', file: activity,
      before: '!isAgentActivityStatusSource(session.semanticStatus.source)', after: 'false' },
    { label: 'retained-semantic-disconnected', file: activity,
      before: "if (session.kind !== 'agent' || !session.semanticStatus || !isAgentActivityStatusSource(session.semanticStatus.source)) continue\n    const observedAt = session.semanticStatus.observedAt",
      after: "if (session.kind !== 'agent' || !isAgentActivityStatusSource(session.status.source)) continue\n    const observedAt = session.status.observedAt" },
    { label: 'invalid-times-enter-max', file: activity,
      before: 'if (!Number.isFinite(observedAt) || observedAt <= 0 || observedAt > now) continue', after: 'if (false) continue' },
    { label: 'oldest-observation-chosen', file: activity,
      before: 'latest === null || observedAt > latest', after: 'latest === null || observedAt < latest' },
    { label: 'neutral-retained-state-excluded', file: activity,
      before: 'const observedAt = session.semanticStatus.observedAt',
      after: "if (session.semanticStatus.state === 'running') continue\n    const observedAt = session.semanticStatus.observedAt" },
    { label: 'one-hour-exclusive', file: activity,
      before: 'if (age <= HOUR)', after: 'if (age < HOUR)' },
    { label: 'twelve-hours-exclusive', file: activity,
      before: 'if (age <= 12 * HOUR)', after: 'if (age < 12 * HOUR)' },
    { label: 'all-projects-share-activity', file: sidebar,
      before: 'folderLastActivityAt(owned, now)', after: 'folderLastActivityAt(sessions, now)' },
    { label: 'collapse-borrows-descendant-activity', file: sidebar,
      before: 'lastActivityByProject.get(project.id) ?? null',
      after: 'folderLastActivityAt((collapsedProjectGroups[projectCollapseKey(project.id)] ? [project.id, ...(projectRelations.descendants.get(project.id) ?? [])] : [project.id]).flatMap((id) => sessionsByProject.get(id) ?? []), Date.now())' },
    { label: 'sidebar-activity-disconnected', file: sidebar,
      before: 'lastActivityAt={manualIcon === null ? lastActivityByProject.get(project.id) ?? null : undefined}',
      after: 'lastActivityAt={null}' },
    { label: 'folder-identity-activity-disconnected', file: identity,
      before: 'lastActivityAt={lastActivityAt}', after: 'lastActivityAt={undefined}' },
    { label: 'primitive-identity-memo-removed', file: identity,
      before: 'export const SpaceObjectIcon = memo(function SpaceObjectIcon(',
      after: 'export const SpaceObjectIcon = ((component) => component)(function SpaceObjectIcon(' },
    { label: 'boundary-clock-disconnected', file: image,
      before: 'if (nextBoundaryAt !== null) timer = setTimeout', after: 'if (false) timer = setTimeout' },
    { label: 'hidden-document-clock-keeps-running', file: image,
      before: "if (document.visibilityState !== 'visible') return", after: 'if (false) return' },
    { label: 'app-settings-visibility-disconnected', file: app,
      before: '<ProjectRail visible={!settingsRoute} />', after: '<ProjectRail />' },
    { label: 'rail-visibility-disconnected', file: rail,
      before: '<WorkspaceSidebar visible={visible} />', after: '<WorkspaceSidebar />' },
    { label: 'actual-image-tone-disconnected', file: image,
      before: 'data-folder-icon-recency={recency?.tone}', after: 'data-folder-icon-recency={undefined}' },
    { label: 'full-color-rule-disconnected', file: css,
      before: '.project-rail-row__icon img[data-folder-icon-recency="full"] { filter: none; opacity: 1; }', after: '' },
    { label: 'subdued-color-rule-disconnected', file: css,
      before: '.project-rail-row__icon img[data-folder-icon-recency="subdued"] { filter: saturate(.65) brightness(.92); opacity: .95; }', after: '' }
  ]
})
