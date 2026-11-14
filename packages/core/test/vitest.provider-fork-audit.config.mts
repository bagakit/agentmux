import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'traex-wrong-target': ['providers/traex.ts', "['resume', sessionId, ...(prompt ? [prompt] : []), ...args]", "['resume', 'another-native-session', ...(prompt ? [prompt] : []), ...args]"],
  'codex-unbracketed-input': ['providers/codex.ts', 'payload: buildPromptInputPayload(prompt)', 'payload: sanitizeBracketedPasteText(prompt)'],
  'codex-locator-as-witness': ['providers/app-server-native-session.ts', "  const originals = await locate(context, mainRole, 'run-group')", "  if (context.nativeHandle?.kind === 'provider') return { handle: context.nativeHandle, assertCurrent: async () => {} }\n  const originals = await locate(context, mainRole, 'run-group')"]
}
const mutation = process.env.AGENTMUX_PROVIDER_FORK_AUDIT_MUTATION
if (mutation && !mutations[mutation]) throw new Error('Unknown Provider audit mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/provider-fork-audit/cache'),
  plugins: [{ name: 'provider-fork-audit-counterexamples', enforce: 'pre', transform(source, file) {
    if (!mutation) return
    const [path, before, after] = mutations[mutation]!
    if (!file.endsWith('/packages/core/src/' + path)) return
    if (source.split(before).length !== 2) throw new Error('Production mutation anchor must be unique: ' + mutation)
    process.stderr.write('PROVIDER_FORK_AUDIT_MUTANT_HIT ' + mutation + '\n')
    return { code: source.replace(before, after), map: null }
  } }],
  test: { include: ['packages/core/test/provider-native-session-candidates.test.ts', 'packages/core/test/provider-contract.test.ts',
    'packages/core/test/agent-provider.test.ts', 'packages/core/test/providers/antigravity-native-source.test.ts',
    'packages/core/test/providers/cursor-native-history.test.ts'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000, hookTimeout: 15000 }
})
