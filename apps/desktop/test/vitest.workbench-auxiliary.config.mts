import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_AUXILIARY_MUTATION
const mutations = {
  'disconnect-native': ['apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', 'await root.setItem(WORKBENCH_USER_STATE_KEY, JSON.stringify(submitted))', 'await Promise.resolve()'],
  'omit-action-ack': ['apps/desktop/src/renderer/src/lib/launcher-state.ts', "await desktopUserFragments.checkpoint('launcher')", 'await Promise.resolve()'],
  'omit-avatar-ack': ['apps/desktop/src/renderer/src/lib/mote-avatar-save-draft.ts', "await desktopUserFragments.checkpoint('moteAvatarSaveDrafts')", 'await Promise.resolve()'],
  'omit-patrol-ack': ['apps/desktop/src/renderer/src/lib/global-goal-patrol-state.ts', "await desktopUserFragments.checkpoint('globalGoalPatrolOperation')", 'await Promise.resolve()'],
  'omit-note-read': ['apps/desktop/src/renderer/src/store.ts', 'try { await initializeLauncherState() }', 'try { await Promise.resolve() }'],
  'omit-schedule-read': ['apps/desktop/src/renderer/src/lib/schedule-controller.ts', 'try { await initializeLauncherState() }', 'try { await Promise.resolve() }'],
  'omit-progress-read': ['apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx', 'try { await initializeLauncherState() }', 'try { await Promise.resolve() }'],
  'unknown-is-absent': ['apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', "if (!ready.has(name)) throw new Error('Original ' + name + ' data is not yet readable. Current input and original bytes are retained.')", "if (!ready.has(name)) return null as DesktopFragmentValues[N]"],
  'drop-fragments': ['apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', "? { ...current, ...captured, ...(Object.hasOwn(current, 'desktopFragments') ? { desktopFragments: current.desktopFragments } : {}) }", '? captured'],
  'ignore-native-ack': ['apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', "throw new Error('Native Desktop write acknowledgement did not confirm the submitted document. Current input and original bytes are retained.')", 'return']
} as const
if (mutation && !Object.hasOwn(mutations, mutation)) throw new Error('Unknown auxiliary source mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/workbench-auxiliary-' + (mutation ?? 'candidate')),
  plugins: [...base.plugins ?? [], { name: 'native-auxiliary-consumers', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    let code = source
    if (file.startsWith('apps/desktop/src/renderer/') && !file.endsWith('/api.ts')) code = code.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    if (mutation) {
      const [owner, before, after] = mutations[mutation as keyof typeof mutations]
      if (file === owner) {
        const count = code.split(before).length - 1
        if (count < 1) throw new Error('Missing actual auxiliary mutation anchor: ' + mutation)
        code = code.replaceAll(before, after)
        if (process.env.AGENTMUX_AUXILIARY_LOADED) {
          const sha = (value: string) => createHash('sha256').update(value).digest('hex')
          appendFileSync(process.env.AGENTMUX_AUXILIARY_LOADED, JSON.stringify({ file, mutation, count,
            originalSHA256: sha(source), loadedSHA256: sha(code) }) + '\n')
        }
      }
    }
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/workbench-auxiliary.test.tsx'], passWithNoTests: false, testTimeout: 15000 } })
