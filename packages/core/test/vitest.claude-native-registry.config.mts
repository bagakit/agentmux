import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'skip-registry': ['providers/claude-native-session.ts', 'if (registered) return registered', 'if (false) return registered'],
  'ignore-session': ['providers/claude-native-registry.ts', 'if (registered.sessionId !== handle.sessionId)', 'if (false)'],
  'ignore-pid': ['providers/claude-native-registry.ts', 'record.pid !== processId || ', ''],
  'ignore-start': ['providers/claude-native-registry.ts', 'registered.start !== process.start || ', 'false || '],
  'skip-refresh-hint': ['client.ts', 'processId: firstRun.pid, nativeHandle: retained,', 'processId: firstRun.pid,'],
  'skip-fork-hint': ['client.ts', 'processId: sourceRun.pid, nativeHandle: source.nativeHandle,', 'processId: sourceRun.pid,']
}
const mutation = process.env.AMX_CLAUDE_REGISTRY_MUTATION
if (mutation && !mutations[mutation]) throw new Error('Unknown registry mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/current-fork-source-confirmation/vite'),
  plugins: [{ name: 'claude-native-registry-counterexamples', enforce: 'pre', transform(source, file) {
    if (!mutation) return
    const [path, before, after] = mutations[mutation]!
    if (!file.endsWith('/packages/core/src/' + path)) return
    if (source.split(before).length !== 2) throw new Error('Mutation must touch exactly one production branch: ' + mutation)
    process.stderr.write('CLAUDE_REGISTRY_MUTANT_HIT ' + mutation + '\n')
    return { code: source.replace(before, after), map: null }
  } }],
  test: { include: ['packages/core/test/claude-native-registry.test.ts',
    'packages/core/test/providers/claude.test.ts', 'packages/core/test/claude-native-input.test.ts'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000, hookTimeout: 15000 }
})
