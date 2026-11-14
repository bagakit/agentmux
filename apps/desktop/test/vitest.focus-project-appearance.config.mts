import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '../../..')
const mutants = {
  'separate-checkouts': ['components/FocusProjectLanes.tsx', 'let frame = project ? projects.get(key) : undefined', 'let frame = undefined'],
  'fallback-watermark': ['components/ProjectIcon.tsx', 'backdrop && appearance?.icon ?', 'backdrop && appearance ?'],
  'stale-image': ['components/ProjectIcon.tsx', 'loaded?.workspaceId === workspaceId ? loaded.appearance : null', 'loaded?.appearance ?? null'],
  'extra-image-read': ['components/ProjectIcon.tsx', 'api.workspaces.appearance(workspaceId).then((value)', 'Promise.all([api.workspaces.appearance(workspaceId), api.workspaces.appearance(workspaceId)]).then(([value])'],
  'stale-save': ['components/FocusProjectPreferences.tsx', 'if (generation.current !== token) return', 'if (false) return'],
  'drop-newer-draft': ['components/FocusProjectPreferences.tsx', 'if (draftVersion.current !== version)', 'if (false)']
} as const
const selected = process.env.AGENTMUX_FOCUS_APPEARANCE_MUTANT as keyof typeof mutants | undefined
if (selected && !mutants[selected]) throw Error('Unknown project appearance mutation')
let applied = false

export default defineConfig({ ...source, cacheDir: '.tmp/focus-project-appearance-cache',
  plugins: [{ name: 'actual-focus-project-appearance-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (process.env.AGENTMUX_FOCUS_APPEARANCE_LOADED && path.startsWith('apps/desktop/src/')) appendFileSync(process.env.AGENTMUX_FOCUS_APPEARANCE_LOADED, path + '\n')
    if (!selected || path !== 'apps/desktop/src/renderer/src/' + mutants[selected][0]) return
    const [, before, after] = mutants[selected]
    if (code.split(before).length !== 2) throw Error('Unique project appearance source anchor required')
    applied = true; process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
    return { code: code.replace(before, after), map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual project appearance mutation was not loaded') } }],
  resolve: { ...source.resolve, alias: [
    { find: /^@agentmux\/capsule$/, replacement: resolve(root, 'packages/capsule/src/index.ts') },
    { find: /^@agentmux\/capsule\/node$/, replacement: resolve(root, 'packages/capsule/src/node.ts') },
    { find: /^@agentmux\/capsule\/runtime$/, replacement: resolve(root, 'packages/capsule/src/runtime.ts') },
    ...source.resolve!.alias as []
  ] },
  test: { ...source.test, environment: 'happy-dom', include: ['apps/desktop/test/focus-project-preferences-races.test.tsx', 'apps/desktop/test/focus-project-appearance.test.tsx'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
