import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, [string, string, string]> = {
  'lose-native-correlation': ['prompt-submission.ts', 'const frozenPlan = { ...prepared.plan, clientCorrelation: createNativeInputCorrelation(inputKey) }', 'const frozenPlan = { ...prepared.plan }'],
  'leak-private-actor': ['agent-session-identity.ts', 'nativeActor: _nativeActor, ', ''],
  'forget-native-target': ['agent-global-message-queue.ts', '!isDeepStrictEqual(existing.intent.source, intent.source) || !isDeepStrictEqual(existing.intent.admissionIntent, intent.admissionIntent) || existing.intent.execution !== intent.execution', '!isDeepStrictEqual(existing.intent.source, intent.source)'],
  'reject-native-descriptor': ['agent-native-process.ts', "else if (field[0] === 'f' && /^\\d+$/u.test(field.slice(1))) { /* lsof's original socket descriptor boundary */ }", "else if (field[0] === 'f') throw unavailable('Original descriptor rejected by mutant')"]
}
export default defineConfig({ root, cacheDir: resolve(root, '.local/state/conversation-unified-timeline/T-019-vitest-cache', process.env.AGENTMUX_NATIVE_INPUT_MUTATION ?? 'positive'),
  plugins: [{ name: 'actual-native-input-source', enforce: 'pre',
    resolveId(source, importer) {
      if (process.env.AGENTMUX_NATIVE_INPUT_COMPILED === '1') return
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
        const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
        if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
      }
      if (!importer || !source.startsWith('.')) return
      const path = resolve(dirname(importer), source)
      const match = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
      if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
    },
    transform(code, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
      const original = code, mutation = process.env.AGENTMUX_NATIVE_INPUT_MUTATION
      const change = mutation ? mutants[mutation] : undefined
      if (mutation && !change) throw new Error('Unknown native input source mutation')
      if (change && path === 'packages/core/src/' + change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Native input mutation anchor is not unique: ' + mutation)
        code = code.replace(change[1], change[2])
      }
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      if (process.env.AGENTMUX_NATIVE_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_INPUT_LOADED, JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation } : {}) }) + '\n')
      if (code !== original) return { code, map: null }
    }
  }], test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/native-conversation-input.test.ts', 'packages/core/test/native-managed-launch.test.ts', 'packages/connectors/test/native-input-ingress.test.ts'], testTimeout: 20_000 } })
