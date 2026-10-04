import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../../../..')
const changes: Record<string, [string, string, string]> = {
  'drop-provider-phase': ['packages/core/src/providers/app-server-native-history.ts',
    '...(messagePhase === undefined ? {} : { messagePhase }),', '...{},'],
  'drop-normalized-metadata': ['packages/core/src/session-history.ts',
    '...(item.collaboration === undefined ? {} : { collaboration: collaboration(item.collaboration) }),', '...{},'],
  'receiver-as-host-session': ['packages/core/src/providers/app-server-native-history.ts',
    'const target = reference(id)\n      return target ? [target] : []',
    "const target = reference('private-main-session')\n      return target ? [target] : []"],
  'target-completes-operation': ['packages/core/src/providers/app-server-native-history.ts',
    '...(status === undefined ? {} : { status }),', "...{ status: 'completed' as const },"],
  'drop-normalized-phase': ['packages/core/src/session-history.ts',
    "...(item.messagePhase === undefined ? {} : { messagePhase: choice(item.messagePhase, ['progress', 'final']) }),", '...{},']
}

export default defineConfig({ ...original, root, cacheDir: resolve(root, '.local/cache/native-process-vite'),
  plugins: [...(original.plugins ?? []), { name: 'native-process-actual-loaded', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_NATIVE_PROCESS_MUTATION
    if (mutation) {
      const change = changes[mutation]
      if (!change) throw new Error('Unknown native process mutation: ' + mutation)
      if (path === change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Missing unique native process mutation anchor: ' + mutation)
        code = code.replace(change[1], change[2])
      }
    }
    const output = process.env.AGENTMUX_NATIVE_PROCESS_LOADED
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (output) appendFileSync(output, JSON.stringify({ path, originalSHA256: sha(before), sha256: sha(code), bytes: Buffer.byteLength(code),
      ...(before !== code ? { mutation } : {}) }) + '\n')
    if (before !== code) return { code, map: null }
  } }],
  // Imports the production public Client/Provider from Source; no dist, alias or GUI qualification.
  test: { ...original.test, globalSetup: [], include: ['packages/core/test/native-conversation-process.test.ts'],
    passWithNoTests: false, fileParallelism: false }
})
