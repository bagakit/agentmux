import original from './vitest.conversation-resilience.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, cacheDir: '.cache/conversation-source-isolation', plugins: [...original.plugins ?? [], {
  name: 'source-isolation-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'packages/core/src/conversation-reader.ts') return
    const mutation = process.env.AGENTMUX_ISOLATION_MUTATION
    const edits: Record<string, [string, string]> = {
      'restore-native-throw': ['port.signal?.throwIfAborted(); coverage[at] = unavailable(source, error, cut.checkpoint.cursor)', 'port.signal?.throwIfAborted(); throw error; coverage[at] = unavailable(source, error, cut.checkpoint.cursor)'],
      'restore-captured-throw': ['port.signal?.throwIfAborted(); coverage[at] = unavailable(source, error, String(cut.sequence))', 'port.signal?.throwIfAborted(); throw error; coverage[at] = unavailable(source, error, String(cut.sequence))'],
      'advance-failed-native': ['coverage[at] = unavailable(source, error, cut.checkpoint.cursor)', "cuts[cuts.indexOf(cut)] = { kind: 'native', checkpoint: { ...cut.checkpoint, cursor: 'unconfirmed-cut' } }; coverage[at] = unavailable(source, error, cut.checkpoint.cursor)"],
      'advance-failed-captured': ['coverage[at] = unavailable(source, error, String(cut.sequence))', "cuts[cuts.indexOf(cut)] = { kind: 'captured', epoch: cut.epoch, sequence: cut.sequence + 1 }; coverage[at] = unavailable(source, error, String(cut.sequence))"],
      'ignore-captured-envelope': ['current.agentSessionId !== ref.agentSessionId || ', ''],
      'ignore-ordered-range': ['index > 0 && record.sequence <= page.records[index - 1]!.sequence', 'false'],
      'ignore-position-witness': ["if (prior?.kind === 'captured-stream' && record.order.kind === 'captured-stream' &&", "if (false && prior?.kind === 'captured-stream' && record.order.kind === 'captured-stream' &&"],
      'accept-foreign-result': ['page.agentSessionId !== ref.agentSessionId || page.hostId !== ref.hostId ||', 'false || page.hostId !== ref.hostId ||']
    }
    let output = source
    if (mutation) { const edit = edits[mutation]; if (!edit || source.split(edit[0]).length !== 2) throw Error('Missing unique source isolation mutation'); output = source.replace(edit[0], edit[1]) }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_ISOLATION_LOADED) appendFileSync(process.env.AGENTMUX_ISOLATION_LOADED, JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(output), mutation: mutation ?? null }) + '\n')
    return output === source ? undefined : output
  }
}], test: { ...original.test, include: ['packages/core/test/conversation-source-isolation.test.ts'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
