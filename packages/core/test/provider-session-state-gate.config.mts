import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import initializationConfig from './provider-initialization-state.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const hostExports = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports as Record<string, { import?: string }>
const hostAliases = Object.entries(hostExports).flatMap(([key, entry]) => entry.import?.startsWith('./dist/') ? [{
  find: new RegExp('^@agentmux/host' + (key === '.' ? '' : key.slice(1).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')) + '$'),
  replacement: resolve(root, 'apps/host', entry.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
}] : [])
const mode = process.env.AMX_SESSION_STATE_MODE ?? 'activity'
const mutation = process.env.AMX_SESSION_STATE_MUTATION
const edits: Record<string, [string, string, string]> = {
  'omit-codex-child-completion': ['packages/providers/src/codex/turn-evidence.ts',
    'return { nativeSessionId, nativeAgentId, observedAt }', 'return undefined'],
  'child-not-active': ['packages/core/src/agent-status-freshness.ts', ": childWorking ? 'active'", ": childWorking ? 'unknown'"],
  'child-not-saved': ['packages/core/src/client.ts', '...(childState ? { nativeSubagents: childState } : {}),', '/* omit the durable child contribution */'],
  'old-child-end': ['packages/core/src/hook-normalizer.ts', 'before.sourceId !== identity.sourceId || before.nativeTurnId !== identity.nativeTurnId', 'before.sourceId !== identity.sourceId'],
  'source-gap-ignored': ['packages/core/src/client.ts', 'childState = invalidateSubagentSource(current.nativeSubagents, nativeActivity) ?? childState', 'childState = childState'],
  'desktop-child-detached': ['apps/desktop/src/renderer/src/lib/agent-observation.ts', '? { subagentSessions: session.nativeSubagents } : {}', '? {} : {}'],
  'ignore-process-generation': ['packages/core/src/agent-native-process.ts',
    "await nativeProcessBirth(processId, signal) !== birth) throw unavailable('The original process environment receipt is incomplete.')",
    "false) throw unavailable('The original process environment receipt is incomplete.')"],
  'startup-bypass': ['packages/core/src/client.ts', 'if (!this.nativeSessionStarting(session, intent)) return null', 'if (true) return null']
}
const tests = mode === 'mutation' ? ['packages/core/test/provider-session-state.test.ts']
  : mode === 'desktop-mutation' ? ['packages/core/test/provider-session-state-desktop.test.ts']
  : mode === 'completion' ? ['packages/core/test/native-completion-authority.test.ts']
  : mode === 'native-environment' ? ['packages/core/test/native-process-environment.test.ts']
  : mode === 'process-environment' ? ['packages/core/test/provider-initialization-process.test.ts']
  : mode === 'startup-mutation' ? ['packages/core/test/platform-initialization-input.test.ts']
  : mode === 'initialization' ? [
    'packages/core/test/platform-initialization-input.test.ts',
    'packages/core/test/platform-initialization-diagnostic-lifetime.test.ts',
    'packages/core/test/native-process-environment.test.ts',
    'packages/core/test/native-process-environment-linux.test.ts',
    'packages/core/test/provider-initialization-process.test.ts',
    'packages/core/test/providers/claude-input-initialization.test.ts'
  ] : mode === 'codex-authentication' ? ['packages/core/test/codex-managed-initialization.test.ts']
  : mode === 'integration' ? ['packages/core/test/provider-session-state-integration.test.ts',
    'packages/core/test/provider-initialization-process.test.ts',
    'packages/core/test/provider-session-state-desktop.test.ts',
    'packages/core/test/claude-native-child-protocol.test.ts', 'packages/core/test/claude-native-request-lifecycle.test.ts',
    'packages/core/test/stop-background-tasks-idle.test.ts']
  : ['packages/core/test/provider-session-state.test.ts', 'packages/core/test/provider-session-state-scope.test.ts',
    'packages/core/test/provider-session-state-desktop.test.ts',
    'packages/core/test/provider-session-state-integration.test.ts', 'packages/core/test/provider-observation-contract.test.ts',
    'packages/core/test/stop-background-tasks-idle.test.ts', 'packages/core/test/claude-native-current-activity.test.ts']

export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: {
  alias: [...(initializationConfig.resolve!.alias as []), ...hostAliases,
    { find: '@agentmux/providers/codex/session-status', replacement: resolve(root, 'packages/providers/src/codex/session-status.ts') }]
},
  cacheDir: resolve(root, '.local/provider-session-state/gate-cache'), plugins: [{
  name: 'provider-session-state-actual-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('packages/core/src/') && ![
      'packages/providers/src/codex/turn-evidence.ts', 'packages/providers/src/codex/session-status.ts',
      'apps/desktop/src/renderer/src/lib/agent-observation.ts',
      'apps/desktop/src/renderer/src/lib/session-state.ts', 'apps/desktop/src/shared/contracts.ts',
      'packages/client-ui/src/lib/agent-presentation.ts'
    ].includes(path)) || !path.endsWith('.ts')) return
    const original = code
    if (mutation) {
      const edit = edits[mutation]
      if (!edit) throw new Error('Unknown Provider Session mutation: ' + mutation)
      if (path === edit[0]) {
        if (code.split(edit[1]).length !== 2) throw new Error('Provider Session mutation anchor must exist exactly once: ' + mutation)
        code = code.replace(edit[1], edit[2])
      }
    }
    if (process.env.AMX_SESSION_STATE_LOADED) appendFileSync(process.env.AMX_SESSION_STATE_LOADED, JSON.stringify({ path,
      originalSHA256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      ...(original === code ? {} : { mutation }) }) + '\n')
    if (original !== code) return { code, map: null }
  }
}], test: { include: tests, setupFiles: [resolve(root, 'vitest.setup.ts')],
  ...(mode === 'codex-authentication' ? { testNamePattern: 'reports a native authentication prerequisite and retries the original initialization without any Prompt or duplicate thread' } : {}),
  ...(mode === 'completion' ? { testNamePattern: 'unique machine IDs|missing unique child identity|generic unknown preserves child|native main success preserves live children|original native outcome|Codex (observed completion|retained completion|Stop and SubagentStop)' } : {}),
  ...(mode === 'startup-mutation' ? { testNamePattern: 'actual Mote setup keeps first-query|post-resume login keeps' } : {}),
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000, hookTimeout: 15000 } })
