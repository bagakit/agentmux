import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; before: string; after: string }> = {
  target: { file: '/packages/core/src/public-rpc-native-desktop.ts', before: 'actual.pid !== expected.pid', after: 'false' },
  owner: { file: '/packages/core/src/public-rpc-service.ts', before: 'this.ports.nativeDesktop ? await this.ports.nativeDesktop.call', after: 'false ? await this.ports.nativeDesktop.call' },
  auth: { file: '/packages/core/src/public-rpc-service.ts', before: "throw new AgentMuxError('Native desktop operations require an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')", after: 'void 0' },
  action: { file: '/packages/core/src/public-rpc-native-desktop.ts', before: 'if (p.x !== undefined || p.y !== undefined)', after: 'if (false)' }
}
const mutation = process.env.NATIVE_PUBLIC_MUTATION ? mutations[process.env.NATIVE_PUBLIC_MUTATION] : undefined
if (process.env.NATIVE_PUBLIC_MUTATION && !mutation) throw new Error('Unknown native public mutation')
export default defineConfig({ root,
  resolve: { alias: [
    { find: /^@agentmux\/core$/, replacement: resolve(root, 'packages/core/src/index.ts') },
    { find: /^@agentmux\/native-desktop$/, replacement: resolve(root, 'packages/native-desktop/src/index.ts') }
  ] },
  plugins: mutation ? [{ name: 'native-public-behavior-mutation', enforce: 'pre', async load(id) {
    if (!id.endsWith(mutation.file)) return
    const source = await readFile(id, 'utf8')
    if (source.split(mutation.before).length !== 2) throw new Error('Native public mutation anchor is not unique')
    return source.replace(mutation.before, mutation.after)
  } }] : [],
  test: { include: ['apps/desktop/test/native-desktop-public.test.ts'], environment: 'node', maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
