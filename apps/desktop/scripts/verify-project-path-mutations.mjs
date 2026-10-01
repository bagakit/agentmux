import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const scope = process.argv[process.argv.indexOf('--scope') + 1]
if (!['adjacent-paths', 'metadata-paths'].includes(scope)) throw new Error(`Unsupported path scope: ${scope}`)
const base = 'apps/desktop/src/renderer/src/'
const formatter = `${base}lib/copy-path-display.ts`
const adapter = `${base}hooks/usePathDisplay.ts`
const sidebar = `${base}components/WorkspaceSidebar.tsx`
const top = `${base}components/TopRowChrome.tsx`
const launcher = `${base}components/LauncherEnvironment.tsx`
if (scope === 'metadata-paths') {
  const component = name => `${base}components/${name}.tsx`
  const mutations = [
    ['focus-row-hover', 'FocusContextRow', 'displayPath(context.workspacePath, context.hostId)', 'context.workspacePath'],
    ['focus-lane-hover', 'FocusProjectLanes', 'displayPath(lane.path, lane.hostId)', 'lane.path'],
    ['recent-retained-hover', 'RecentFocusTimeline', 'displayPath(identity.workspacePath, identity.hostId)', 'identity.workspacePath'],
    ['board-row-body', 'WorkspaceBoard', ">{row.path ? displayPath(row.path, hostId) : meta.emptyPathLabel}</small>", ">{row.path ? row.path : meta.emptyPathLabel}</small>"],
    ['board-discussion-body', 'BoardDiscussionCanvas', ">{row.path ? displayPath(row.path, hostId) : 'No worktree'}</small>", ">{row.path ? row.path : 'No worktree'}</small>"],
    ['activity-context-hover', 'ProjectActivity', 'const path = group.path ? displayPath(group.path, group.hostId ?? undefined) : null', 'const path = group.path'],
    ['sender-project-hover', 'DesktopClientUiProvider', 'title={displayPath(project.path, hostId)}', 'title={project.path}'],
    ['goals-project-hover', 'GoalsCommonActions', 'displayPath(action.project.path, action.project.hostId)', 'action.project.path'],
    ['survey-project-action', 'SurveyItemOptions', 'aria-label={`Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${displayPath(workspace.path, workspace.hostId)}`}', 'aria-label={`Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${workspace.path}`}'],
    ['survey-topic-action', 'SurveyTopicRelations', 'aria-label={`Link Topic: ${topic.name}, ${topic.hostId}, ${displayPath(topic.directoryPath, topic.hostId)}`}', 'aria-label={`Link Topic: ${topic.name}, ${topic.hostId}, ${topic.directoryPath}`}'],
    ['resume-directory-hover', 'LauncherResumePicker', 'title={displayPath(selected.candidate.workspacePath, selected.candidate.hostId)}', 'title={selected.candidate.workspacePath}'],
    ['progress-target-body', 'ContinuousProgressControl', '>{displayPath(target.workspacePath, target.hostId)}</dd>', '>{target.workspacePath}</dd>'],
    ['request-workspace-body', 'AttentionRequestPanel', '>{displayPath(session.workspacePath, session.hostId)}</small>', '>{session.workspacePath}</small>'],
    ['settings-workspace-body', 'settings/WorkspaceSettingsPane', '>{displayPath(workspace.path, workspace.hostId)}</small>', '>{workspace.path}</small>'],
    ['space-topic-hover', 'SpaceTopicsTree', 'displayPath(topic.directoryPath, workspace.hostId)', 'topic.directoryPath'],
    ['topic-directory-body', 'WorkspaceTopicsPanel', 'topic.summary || displayPath(topic.directoryPath, workspace.hostId)', 'topic.summary || topic.directoryPath']
  ].map(([label, name, before, after]) => ({ label, file: component(name), before, after }))
  // Target the actual mounted gutter; the same formatter also serves opened observations.
  mutations.find(value => value.label === 'recent-retained-hover').before = "title={`${name} · ${identity?.workspacePath ? displayPath(identity.workspacePath, identity.hostId) : context?.workspacePath ? displayPath(context.workspacePath, context.hostId) : 'Historical identity not recorded'}"
  mutations.find(value => value.label === 'recent-retained-hover').after = "title={`${name} · ${identity?.workspacePath ?? context?.workspacePath ?? 'Historical identity not recorded'}"
  await verifyRendererSourceMutations({
    name: ("explorer-" + (scope) + "-" + (globalThis.crypto.randomUUID()) + "-" + (randomUUID().slice(0, 8)) + ""),
    tests: ['apps/desktop/test/project-path-metadata-consumers.test.tsx'],
    sources: [...new Set(mutations.map(value => value.file)), 'packages/client-ui/package.json', 'packages/client-ui/src/components/ConversationInputDetails.tsx', 'packages/client-ui/src/platform.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
    mutations
  })
} else await verifyRendererSourceMutations({
  name: ("explorer-" + (scope) + "-" + (globalThis.crypto.randomUUID()) + "-" + (randomUUID().slice(0, 8)) + ""),
  tests: ['apps/desktop/test/copy-path-display.test.ts', 'apps/desktop/test/project-path-adjacent-consumers.test.tsx'],
  sources: [formatter, adapter, sidebar, top, launcher, 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'home-segment-boundary', file: formatter, before: 'path.startsWith(`${home}/`)', after: 'path.startsWith(home)' },
    { label: 'absolute-preference', file: formatter, before: 'options.copyPathsAsAbsolute === true ? path', after: 'false ? path' },
    { label: 'host-ownership', file: adapter, before: "hosts?.find(host => host.id === hostId)?.kind === 'local'", after: 'true' },
    { label: 'project-hover', file: sidebar, before: 'displayPath(project.repoPath, project.hostId)', after: 'project.repoPath' },
    { label: 'group-hover', file: sidebar, before: 'group.groupPath ? displayPath(group.groupPath, group.hostId) : null', after: 'group.groupPath' },
    { label: 'branch-hover', file: top, before: 'displayPath(workspace.path, workspace.hostId)', after: 'workspace.path' },
    { label: 'launcher-hover', file: launcher,
      before: 'className="launcher-environment__path" title={displayPath || undefined}',
      after: 'className="launcher-environment__path" title={workspace?.path}' }
  ]
})
