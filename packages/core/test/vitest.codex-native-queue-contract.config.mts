import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'packages/providers/src/codex/native-queue.ts'
export const mutations: Record<string, [string, string]> = {
  'version-gate': ['  await assertFile(executable)\n', "  await assertFile(executable)\n  if ((await import('node:child_process')).execFileSync(executable.path, ['--version'], { encoding: 'utf8', signal }).trim() !== 'codex-cli 0.167.0') throw unavailable()\n"],
  'skip-queue-contract': ["const queue = await helper.request('thread/queue/list', { threadId: original.id, limit: 1 })", 'const queue = { data: [] }'],
  'require-peer-correlation': ['(item as Record<string, unknown>).clientUserMessageId != null && typeof (item as Record<string, unknown>).clientUserMessageId', 'typeof (item as Record<string, unknown>).clientUserMessageId'],
  'lose-correlation': ['item.clientUserMessageId !== frozen.clientCorrelation', 'false'],
  'lose-wire': ['!isDeepStrictEqual(item.input, input)', 'false'],
  'lose-frozen-target': ['!isDeepStrictEqual({ ...frozen, clientCorrelation: undefined }, { ...plan, clientCorrelation: undefined })', 'false'],
  'borrow-helper-queue': ['!sameFile(helperStores.queue, storage.queue)', 'false'],
  'lose-file-identity': ['a.device === b.device && a.inode === b.inode', 'true'],
  'ignore-birth': ['await nativeProcessBirth(processId, signal) !== rootBirth || await nativeProcessBirth(owner, signal) !== ownerBirth ||\n            await nativeProcessBirth(helper.processId, signal) !== helperBirth', 'false'],
}
const mutation = process.env.AGENTMUX_QUEUE_CONTRACT_MUTATION
if (mutation && !Object.hasOwn(mutations, mutation)) throw new Error('Unknown original Codex queue mutation')
export default defineConfig({ ...source,
  resolve: { ...source.resolve, alias: [
    { find: '@agentmux/providers/codex/native-queue', replacement: resolve(root, owner) },
    ...(Array.isArray(source.resolve?.alias) ? source.resolve.alias : [])
  ] },
  cacheDir: resolve(root, '.local/state/codex-native-queue-contract/cache', mutation ?? 'candidate'),
  plugins: [...(source.plugins ?? []), { name: 'actual-codex-queue-owner', enforce: 'pre', transform(original, id) {
    if (relative(root, id.split('?')[0]!) !== owner) return
    let code = original
    if (mutation) {
      const [anchor, replacement] = mutations[mutation]!
      if (code.split(anchor).length !== 2) throw new Error('Codex mutation requires one exact owner anchor: ' + mutation)
      code = code.replace(anchor, replacement)
    }
    const report = process.env.AGENTMUX_QUEUE_CONTRACT_LOADED
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
    'packages/core/test/codex-idle-queue.test.ts',
  ], fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 90_000, hookTimeout: 30_000 }
})
