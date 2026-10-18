import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

export const focusMapMotionMutations = [
  { name: 'first-edit-default', file: 'shared/config-edit.ts', before: "if (path === 'focus.mapMotion') return resolveFocusMapMotion(value)", after: '', assertion: 'merges a first GUI motion edit with a concurrent first Focus edit without writing other defaults' },
  { name: 'explicit-on', file: 'renderer/src/lib/use-collaboration-motion.ts', before: "preference === 'on' || preference === 'system' && !reduced.matches", after: "preference !== 'off' && !reduced.matches", assertion: 'follows the current document system preference, lets explicit choices override it and releases hidden motion observation' },
  { name: 'hidden-observation', file: 'renderer/src/lib/use-collaboration-motion.ts', before: '!active || !visible', after: '!visible', assertion: 'follows the current document system preference, lets explicit choices override it and releases hidden motion observation' },
  { name: 'workbench-document', file: 'renderer/src/lib/use-collaboration-motion.ts', before: 'const document = useWorkbenchDocument()', after: 'const document = globalThis.document', assertion: 'moves motion observation with the actual workbench document and honors exact native window visibility' },
  { name: 'save-issue', file: 'renderer/src/lib/use-collaboration-motion.ts', before: 'setIssue(presentError(cause))', after: 'setIssue(null)', assertion: 'shows an actual rejected or unconfirmed motion save without false success, and permits a scoped retry' },
  { name: 'authored-save', file: 'renderer/src/lib/focus-preferences.ts', before: 'focus: expectedFocus', after: 'focus: nextFocus', assertion: 'finds map motion in the original settings catalogue and restores system through the real Focus editor' },
  { name: 'durable-validation', file: 'main/config-store.ts', before: 'mapMotion: z.enum(FOCUS_MAP_MOTION).optional()', after: 'mapMotion: z.any().optional()', assertion: 'validates persisted motion values and retains original truth after a genuine file save failure' },
] as const
const selected = process.env.AGENTMUX_FOCUS_MAP_MOTION_MUTATION
const mutation = focusMapMotionMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown map motion mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let applied = false
const identityRuntimeModule = '\0focus-map-motion:identity-runtime-source'
let identityRuntime: ReturnType<typeof bundleIdentityRuntime> | undefined
export default defineConfig({ root, cacheDir: '.cache/focus-map-motion', define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: [{ find: /^@agentmux\/identity\/runtime-source$/u, replacement: identityRuntimeModule }, ...aliases] },
  plugins: [{ name: 'focus-map-motion-source', enforce: 'pre',
  resolveId(source, importer) { return source === identityRuntimeModule ? source : installedDependency(source, importer) },
  async load(id) {
    if (id !== identityRuntimeModule) return
    const { source } = await (identityRuntime ??= bundleIdentityRuntime())
    const code = `export const identityRuntimeSource = ${JSON.stringify(source)};\n`
    if (process.env.AGENTMUX_FOCUS_MAP_MOTION_GENERATED) appendFileSync(process.env.AGENTMUX_FOCUS_MAP_MOTION_GENERATED,
      JSON.stringify({ id, sourceSHA256: hash(code) }) + '\n')
    return code
  }, transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    let code = source
    const changed = mutation && path === 'apps/desktop/src/' + mutation.file
    if (changed) {
      if (code.split(mutation.before).length !== 2) throw Error('Exactly one real map motion mutation anchor is required')
      code = code.replace(mutation.before, mutation.after); applied = true
    }
    if (process.env.AGENTMUX_FOCUS_MAP_MOTION_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_MAP_MOTION_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutant: changed ? selected : null }) + '\n')
    if (code !== source) return { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The real map motion mutation owner must load') } }],
  test: { include: ['apps/desktop/test/focus-map-motion.test.tsx', 'apps/desktop/test/focus-map-motion-control.test.ts', 'apps/desktop/test/focus-settings.test.tsx', 'apps/desktop/test/focus-personalization-settings.test.tsx', 'apps/desktop/test/settings-modules-control.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 30000 }
})
