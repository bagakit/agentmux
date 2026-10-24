import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; before: string; after: string }> = {
  target: { file: '/packages/core/src/public-rpc-native-desktop.ts', before: 'actual.pid !== expected.pid', after: 'false' },
  owner: { file: '/packages/core/src/public-rpc-service.ts', before: 'this.ports.nativeDesktop ? await this.ports.nativeDesktop.call', after: 'false ? await this.ports.nativeDesktop.call' },
  auth: { file: '/packages/core/src/public-rpc-service.ts', before: "throw new AgentMuxError('Native desktop operations require an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')", after: 'void 0' },
  action: { file: '/packages/core/src/public-rpc-native-desktop.ts', before: 'if (p.x !== undefined || p.y !== undefined)', after: 'if (false)' },
  provenance: { file: '/packages/core/src/public-rpc-native-desktop.ts', before: 'text(result.engine, code)', after: 'void 0' },
  geometry: { file: '/packages/core/src/public-rpc-native-desktop.ts', before: "const rect = rpcRecord(result.selectionRect, ['x', 'y', 'width', 'height'], code)\n      number(rect.x, code); number(rect.y, code); number(rect.width, code, true); number(rect.height, code, true)", after: 'void 0' }
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
    const changed = source.replace(mutation.before, mutation.after)
    const prefix = process.env.NATIVE_PUBLIC_LOAD_PREFIX
    if (prefix) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      await writeFile(prefix + '-source.txt', source)
      await writeFile(prefix + '-mutated.txt', changed)
      await writeFile(prefix + '-load.json', JSON.stringify({ mutation: process.env.NATIVE_PUBLIC_MUTATION, file: mutation.file.slice(1), before: mutation.before, after: mutation.after, sourceSha256: hash(source), mutatedSha256: hash(changed) }, null, 2) + '\n')
    }
    return changed
  } }] : [],
  test: { include: ['apps/desktop/test/native-desktop-public.test.ts'], environment: 'node', maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
