import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'packages/core/src/providers/codex-native-queue.ts'
export const mutations: Record<string, [string, string]> = {
  'remove-0167': [", 'codex-cli 0.167.0'", ''],
  'accept-unqualified': ["'codex-cli 0.167.0'", "'codex-cli 0.167.0', 'codex-cli 0.168.0'"],
  'lose-correlation': ['item.clientUserMessageId !== frozen.clientCorrelation', 'false'],
  'lose-wire': ['!isDeepStrictEqual(item.input, input)', 'false'],
  'lose-frozen-target': ['!isDeepStrictEqual({ ...frozen, clientCorrelation: undefined }, { ...plan, clientCorrelation: undefined })', 'false'],
  'borrow-helper-queue': ['!sameFile(helperStores.queue, storage.queue)', 'false'],
  'lose-file-identity': ['a.device === b.device && a.inode === b.inode', 'true'],
  'ignore-birth': ['await nativeProcessBirth(processId, signal) !== rootBirth || await nativeProcessBirth(owner, signal) !== ownerBirth ||\n          await nativeProcessBirth(helper.processId, signal) !== helperBirth', 'false'],
}
const mutation = process.env.CODEX_0167_MUTATION
if (mutation && !Object.hasOwn(mutations, mutation)) throw new Error('Unknown original Codex queue mutation')
export default defineConfig({ ...source,
  cacheDir: resolve(root, '.local/state/mote-heartbeat-trust/implementation/codex-0167/cache', mutation ?? 'candidate'),
  plugins: [...(source.plugins ?? []), { name: 'actual-codex-queue-owner', enforce: 'pre', transform(original, id) {
    if (relative(root, id.split('?')[0]!) !== owner) return
    let code = original
    if (mutation) {
      const [anchor, replacement] = mutations[mutation]!
      if (code.split(anchor).length !== 2) throw new Error('Codex mutation requires one exact owner anchor: ' + mutation)
      code = code.replace(anchor, replacement)
    }
    const report = process.env.CODEX_0167_LOADED
    if (report) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const fact = { path: owner, originalSHA256: sha(original), loadedSHA256: sha(code), ...(mutation ? { mutation } : {}) }
      code = "import { appendFileSync as __codexQueueLoaded } from 'node:fs'; __codexQueueLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(fact) + '\n') + ');\n' + code
    }
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...source.test, globalSetup: [], include: [
    'packages/core/test/codex-durable-queue.test.ts',
    'packages/core/test/codex-durable-queue-native.test.ts',
  ], fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 90_000, hookTimeout: 30_000 }
})
