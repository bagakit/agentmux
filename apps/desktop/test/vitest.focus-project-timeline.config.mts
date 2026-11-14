import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
const mutants = {
  'ignore-scope': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'groupedProjects.filter(project => !projectScope?.projects.length', 'groupedProjects.filter(project => true || !projectScope?.projects.length'],
  'ignore-explicit': ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'filters.projects.length ? filters.projects : !allTimelineProjects', 'false ? filters.projects : !allTimelineProjects'],
  'checkout-project': ['apps/desktop/src/renderer/src/lib/focus-project-lanes.ts', 'id: focusProjectKey(workspace.hostId, projectId)', 'id: focusProjectKey(workspace.hostId, workspace.id)'],
  'outside-scope-read': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', '&& (inputInProjectScope || readingContextId !== null || Boolean(preview?.interactive))', '&& true'],
  'close-on-project': ['apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', '.recent-focus__message, [data-focus-project-scope-control]', '.recent-focus__message'],
  'no-message-selection': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'if (recipient) selectContext(recipient.id, recipient)', 'if (false && recipient) selectContext(recipient.id, recipient)'],
  'unstable-visits': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'retainedWork?.items, visitVersion, messageGroupVersion', 'retainedWork?.items, segments, messageGroupVersion'],
  'no-name-entry': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'inlineLabel={name}', 'inlineLabel={undefined}'],
  'unknown-source-close': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'inspected.recipient.id === currentSessionId && inspected.recipient.hostId === context?.hostId', 'false'],
  'borrow-host-name': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'get(sessionId)?.hostId === trackHost && trackHost !== undefined', 'has(sessionId)']
} as const
const selected = process.env.AGENTMUX_FOCUS_PROJECT_TIMELINE_MUTANT as keyof typeof mutants | undefined
if (selected && !mutants[selected]) throw Error('Unknown project timeline mutation')
let applied = false
export default defineConfig({ ...source, cacheDir: '.tmp/focus-project-timeline-cache',
  plugins: [{ name: 'actual-project-timeline-source', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (process.env.AGENTMUX_FOCUS_PROJECT_TIMELINE_LOADED && path.startsWith('apps/desktop/src/')) appendFileSync(process.env.AGENTMUX_FOCUS_PROJECT_TIMELINE_LOADED, path + '\n')
    if (!selected || mutants[selected][0] !== path) return
    const [, before, after] = mutants[selected]
    if (source.split(before).length !== 2) throw Error('Unique actual timeline mutation anchor required')
    applied = true; process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    return { code: source.replace(before, after), map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual timeline mutation was not loaded') } }],
  test: { ...source.test, environment: 'happy-dom', include: ['apps/desktop/test/focus-timeline-project-scope.test.tsx', 'apps/desktop/test/focus-timeline-project-selection.test.tsx', 'apps/desktop/test/focus-timeline-original-source.test.tsx', 'apps/desktop/test/focus-timeline-current-main.test.tsx'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
