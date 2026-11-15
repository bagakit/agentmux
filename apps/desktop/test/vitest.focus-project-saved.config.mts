import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import base from './vitest.mote-context.config.mts'

const board = 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'
const lanes = 'apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx'
const saved = 'apps/desktop/src/renderer/src/components/FocusSavedTaskRow.tsx'
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'restore-on-another-host': {
    path: saved,
    before: 'const source = sources.get(key)',
    after: 'const source = [...sources.values()].find(item => item?.agentSessionId === entry.sessionId)',
  },
  'duplicate-past': {
    path: board,
    before: 'const pastProjects = filteredRetainedProjects.filter(item => !item.recent && !currentProjectKeys.has(item.key))',
    after: 'const pastProjects = filteredRetainedProjects.filter(item => !item.recent)',
  },
  'drop-current-history': {
    path: board,
    before: 'const boardHistory = filteredRetainedProjects.filter(item => item.recent || currentProjectKeys.has(item.key))',
    after: 'const boardHistory = filteredRetainedProjects.filter(item => item.recent)',
  },
  'borrow-other-host': {
    path: lanes,
    before: 'boardHistory.filter(project => !projects.has(project.key))',
    after: 'boardHistory.filter(project => !frames.some(frame => frame.project && frame.lanes[0]?.projectId === project.projectId))',
  },
  'drop-history-use': {
    path: lanes,
    before: 'onFocusCapture={keepRecentHistoryOpen} onPointerDownCapture={keepRecentHistoryOpen}',
    after: '',
  },
  'prefill-history-expansion': {
    path: lanes,
    before: 'const [expanded, setExpanded] = useState(false)\n  const showHistory',
    after: 'const [expanded, setExpanded] = useState(!withinProject)\n  const showHistory',
  },
}
const mode = process.env.AGENTMUX_PROJECT_HISTORY_MUTATION
const mutation = mode ? mutations[mode] : undefined
if (mode) assert.ok(mutation, 'Known project history mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({
  ...base,
  cacheDir: resolve(base.root!, '.tmp/project-saved-' + (mode ?? 'baseline')),
  plugins: [...base.plugins ?? [], {
    name: 'focus-project-saved-mutation',
    enforce: 'pre',
    transform(source, id) {
      const path = relative(base.root!, id.split('?')[0]!)
      if (path !== board && path !== lanes && path !== saved) return
      let code = source
      if (mutation?.path === path) {
        assert.equal(code.split(mutation.before).length, 2, 'Unique production mutation anchor')
        code = code.replace(mutation.before, mutation.after)
      }
      const destination = process.env.AGENTMUX_PROJECT_HISTORY_LOADED
      if (destination) appendFileSync(destination, JSON.stringify({
        path, mutation: code === source ? null : mode, originalSHA256: hash(source), loadedSHA256: hash(code)
      }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/focus-project-zone-grouping.test.tsx'], passWithNoTests: false },
})
