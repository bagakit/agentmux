import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const changes: Record<string, [string, string, string]> = {
  'durable-after-cas-witness': ['packages/core/src/client.ts', 'if (!transient) assertWitness = undefined\n      else await assertWitness()', 'await assertWitness()'],
  'durable-needs-runtime': ['packages/core/src/client.ts', 'if (!transient) assertWitness = undefined', 'if (false) assertWitness = undefined'],
  'accept-truncated-frame': ['packages/core/src/agent-native-process.ts', " || !output.stdout.endsWith('\\0\\n')", ''],
  'skip-discovery': ['packages/core/src/client.ts', 'const discovered = await provider.discoverNativeSession({ processId: firstRun.pid,', 'const discovered = await (async () => null)({ processId: firstRun.pid,'],
  'child-as-main': ['packages/core/src/providers/codex-native-session.ts', "if (payload!.source === 'cli') main.push({ file, id })", 'if (payload!.source) main.push({ file, id })'],
  'ignore-pid-change': ['packages/core/src/client.ts', 'run.pid !== firstRun.pid', 'false'],
  'ignore-run-change': ['packages/core/src/client.ts', '!sameRun(current.run, expected.run)', 'false'],
  'fail-save-read': ['packages/core/src/client.ts', 'await assertWitness()\n            transient = latest.nativeHandle === undefined', 'throw error\n            transient = latest.nativeHandle === undefined'],
  'ignore-handle-change': ['packages/core/src/client.ts', '(current.nativeHandle !== undefined && !matchesHandle(current.nativeHandle))', 'false']
}
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/native-discovery-vite'), plugins: [{ name: 'native-discovery-loaded', enforce: 'pre', transform(code, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path)) return
  const before=code, mutation=process.env.AMX_NATIVE_DISCOVERY_MUTATION
  if (mutation) { const change=changes[mutation]; if (!change) throw new Error('Unknown mutation'); if (path===change[0]) {
    if (code.split(change[1]).length!==2) throw new Error('Mutation anchor is not unique: '+mutation)
    code=code.replace(change[1],change[2])
  } }
  if (process.env.AMX_NATIVE_DISCOVERY_LOADED) appendFileSync(process.env.AMX_NATIVE_DISCOVERY_LOADED, JSON.stringify({path, originalSHA256:createHash('sha256').update(before).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),...(before!==code?{mutation}:{})})+'\n')
  if (before!==code) return {code,map:null}
} }], test: { include: ['packages/core/test/native-session-discovery.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers:1, testTimeout:15000, hookTimeout:15000 } })
