import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutants: Record<string, [string, string, string]> = {
  'forget-observed-owner': ['packages/core/src/client.ts', 'append(session.observedNativeHandle, binding)', 'void session.observedNativeHandle'],
  'reject-created-composer': ['packages/core/src/agent-session-store.ts', 'const { run, retiredRuns, creation, terminalPromptReadiness, ...actual } = next', 'const { run, retiredRuns, creation, ...actual } = next; const terminalPromptReadiness = undefined'],
  'launch-new-conversation': ['packages/core/src/client.ts', ': nativeResumeSource ? provider.buildResumeLaunch({ ...launchContext, nativeHandle: nativeResumeSource.nativeHandle })', ': nativeResumeSource ? provider.buildLaunch(launchContext)'],
  'drop-native-preparation': ['packages/core/src/client.ts', '...(nativeResumeSource ? { nativeHandle: structuredClone(nativeResumeSource.nativeHandle) } : {}), ...(launchOptions ? { launchOptions } : {}) }', '...(launchOptions ? { launchOptions } : {}) }'],
  'skip-source-revalidation': ['packages/core/src/client.ts', 'await assertNativeSource?.()', 'void assertNativeSource'],
  'duplicate-prepared-native': ['packages/core/src/agent-session-store.ts', "if (source?.kind !== 'provider') return", 'if (true) return'],
  'accept-replaced-codex-file': ['packages/core/src/providers/codex-native-catalog.ts', 'actual.source.revision !== source.revision', 'false'],
  'accept-claude-child': ['packages/core/src/providers/claude-native-catalog.ts', 'if (row?.isSidechain === true) return null\n  if (!row || !id || row.isSidechain !== false ||', 'if (!row || !id ||']
}
export default defineConfig({ root, plugins: [{ name: 'native-resume-actual-source', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!path.startsWith('packages/core/src/')) return
  let code = source
  const mutation = process.env.AMX_NATIVE_RESUME_MUTATION, change = mutation && mutants[mutation]
  if (mutation && !change) throw new Error('Unknown native resume source mutant')
  if (change && path === change[0]) {
    const count = code.split(change[1]).length - 1
    if (count !== (mutation === 'skip-source-revalidation' ? 2 : 1)) throw new Error('Native resume mutation anchor is not exact: ' + mutation)
    code = code.replaceAll(change[1], change[2])
  }
  if (process.env.AMX_NATIVE_RESUME_LOADED) appendFileSync(process.env.AMX_NATIVE_RESUME_LOADED, JSON.stringify({ path,
    sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'),
    ...(code !== source ? { mutation } : {}) }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { include: ['packages/core/test/native-session-catalog-resume.test.ts'], passWithNoTests: false,
  fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 } })
