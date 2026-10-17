import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const owners = ['packages/client-ui/src/lib/use-conversation-view.ts', 'packages/client-ui/src/lib/use-conversation-record-layout.ts', 'packages/client-ui/src/lib/captured-conversation-page.ts', 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts']
export default defineConfig({ ...base, cacheDir: '.cache/conversation-reading-transaction', plugins: [...base.plugins ?? [], {
  name: 'original-reading-transaction-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!owners.includes(path)) return
    const mutation = process.env.AGENTMUX_TRANSACTION_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'hide-held-failure': [owners[0]!, 'current.held && sourceError ? { error: sourceError, errorOperation: kind }', 'false ? { error: sourceError, errorOperation: kind }'],
      'mixed-metadata': [owners[0]!, '            newerAvailable: kind ===', '            historical: current.historical, newerAvailable: kind ==='],
      'lose-held-intent': [owners[0]!, 'beforeCommit.current?.(frame.snapshot, frame.operation,', "beforeCommit.current?.(frame.snapshot, 'changes',"],
      'resume-overwrites-intent': [owners[0]!, "(kind === 'resume' || kind === 'changes') && current.pending?.snapshot.window.id", "kind === 'changes' && current.pending?.snapshot.window.id"],
      'lose-version': [owners[1]!, ' && version(next) === row.revision', ''],
      'captured-ID-only': [owners[2]!, '(!next || !original || conversationRevision(original) !== conversationRevision(next))', '!next'],
      'lose-parked-intent': [owners[0]!, 'pending: parked?.pending ?? null', 'pending: null as PendingFrame | null'],
      'return-global-document': [owners[3]!, '  const document = useWorkbenchDocument()', '  const document = globalThis.document']
    }
    const edit = mutation ? edits[mutation] : undefined
    if (mutation && !edit) throw new Error('Unknown reading transaction mutation')
    let output = source
    if (edit && edit[0] === path) {
      if (source.split(edit[1]).length !== 2) throw new Error('Reading transaction mutation must match exactly once')
      output = source.replace(edit[1], edit[2])
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_TRANSACTION_LOADED) appendFileSync(process.env.AGENTMUX_TRANSACTION_LOADED,
      JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(output), mutation: output === source ? null : mutation }) + '\n')
    return output === source ? undefined : output
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-reading-transaction.test.tsx', 'apps/desktop/test/conversation-owner-document-release.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
