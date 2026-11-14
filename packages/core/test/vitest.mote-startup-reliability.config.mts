import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'trust-descendants': ['packages/core/src/client.ts', 'if (await realpath(resolve(root)) === target)', 'if (target.startsWith(await realpath(resolve(root))))'],
  'trust-spelled-path': ['packages/core/src/client.ts', 'const target = await realpath(resolve(workspacePath))', 'const target = resolve(workspacePath)'],
  'drop-retained-resume-start': ['packages/core/src/client.ts', 'Object.values(session.continuityOperations ?? {}).some(operation =>', 'Object.values({}).some(operation =>'],
  'expire-start-gate': ['packages/core/src/client.ts', "if (intent.kind === 'manual-actor' || intent.kind === 'native-conversation') return false", 'return false'],
  'block-explicit-tty': ['packages/core/src/client.ts', "if (intent.kind === 'manual-actor' || intent.kind === 'native-conversation') return false", "if (intent.kind === 'native-conversation') return false"],
  'block-typed': ['packages/core/src/client.ts', "if (provider.prepareNativeInput && session.nativeHandle?.kind === 'provider') return false", "if (provider.prepareNativeInput && session.nativeHandle?.kind === 'provider') return true"],
  'drop-create-trust-receipt': ['packages/core/src/client.ts', "createOperationId,\n        ...(workspaceTrust ? { workspaceTrust } : {}),", 'createOperationId,'],
  'drop-resume-trust-receipt': ['packages/core/src/agent-session-recovery/lifecycle.ts', 'if (continuity && workspaceTrust) continuity.workspaceTrust = workspaceTrust', 'void workspaceTrust'],
  'cursor-drop-home-boundary': ['packages/core/src/providers/cursor-workspace-trust.ts', 'if (trustKey !== await realpath(resolve(context.ownedRoot)))', 'if (false)'],
  'claude-drop-home-boundary': ['packages/providers/src/claude/workspace-trust.ts', 'if (trustKey !== await claudeTrustKey(context.ownedRoot))', 'if (false)'],
  'cursor-drop-seam': ['packages/core/src/providers/cursor-adapter.ts', 'prepareOwnedWorkspaceTrust: prepareCursorOwnedWorkspaceTrust,', ''],
  'bypass-postlaunch-startup': ['packages/core/src/client.ts', "if (!nativeSource && this.nativeSessionStarting(current, { kind: 'session-conversation', expectedRun: current.run }))", 'if (false)'],
  'cursor-spelled-namespace': ['packages/providers/src/cursor/native-history.ts', 'try { return await realpath(resolve(workspacePath)) }', 'try { return resolve(workspacePath) }'],
  'cursor-spelled-transcript': ['packages/providers/src/cursor/native-history.ts', 'const slug = cursorWorkspaceSlug(workspace)', 'const slug = cursorWorkspaceSlug(workspacePath)'],
}
export default defineConfig({ ...source,
  resolve: { ...source.resolve, alias: [
    { find: '@agentmux/providers/cursor/native-history', replacement: resolve(root, 'packages/providers/src/cursor/native-history.ts') },
    { find: '@agentmux/providers/claude/workspace-trust', replacement: resolve(root, 'packages/providers/src/claude/workspace-trust.ts') },
    ...(Array.isArray(source.resolve?.alias) ? source.resolve.alias : [])
  ] },
  plugins: [...(source.plugins ?? []), { name: 'mote-startup-actual-owner-mutation', enforce: 'pre', transform(code, id) {
  const name = process.env.AGENTMUX_MOTE_STARTUP_MUTATION
  if (!name) return
  const mutation = mutations[name]
  if (!mutation) throw new Error('Unknown Mote startup mutation: ' + name)
  if (relative(root, id.split('?')[0]!) !== mutation[0]) return
  if (code.split(mutation[1]).length !== 2) throw new Error('Mote startup mutation requires exactly one actual source anchor')
  const changed = code.replace(mutation[1], mutation[2])
  if (process.env.AGENTMUX_MOTE_STARTUP_LOADED) appendFileSync(process.env.AGENTMUX_MOTE_STARTUP_LOADED,
    JSON.stringify({ name, path: mutation[0], originalSHA256: createHash('sha256').update(code).digest('hex'),
      loadedSHA256: createHash('sha256').update(changed).digest('hex') }) + '\n')
  return { code: changed, map: null }
} }], test: { ...source.test, environment: 'node', fileParallelism: false, maxWorkers: 1, include: [
  'packages/core/test/owned-workspace-trust-launch.test.ts',
  'packages/core/test/providers/claude-workspace-trust.test.ts',
  'packages/core/test/providers/cursor.test.ts',
  'packages/core/test/providers/cursor-workspace-trust.test.ts',
  'packages/core/test/providers/cursor-native-history.test.ts',
  'packages/core/test/native-session-start-input-guard.test.ts',
  'apps/host/test/mote-owned-workspace-home.test.ts',
  'packages/core/test/agent-session-initialization-recovery.test.ts',
  'packages/core/test/providers/post-launch-prompt-delivery.test.ts',
], passWithNoTests: false, testTimeout: 20000 } })
