import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const store = 'packages/core/src/agent-session-store.ts'
export const commitContentionMutations = {
  'commit-retry-removed': { path: store, test: 'commits one Store mutation after an independent same-process reader', count: 1,
    from: "if ((error as { errcode?: unknown } | null)?.errcode !== 5 || !database.isTransaction || attempt + 1 >= LOCK_ATTEMPTS) throw error",
    to: 'throw error' },
  'mutation-replayed': { path: store, test: 'commits one Store mutation after an independent same-process reader', count: 1, edits: [
    { from: "stage = 'commit'; await this.commit(signal); committed = true",
      to: "stage = 'commit'; await this.commit(signal, operation); committed = true" },
    { from: 'private async commit(signal?: AbortSignal): Promise<void>',
      to: 'private async commit(signal?: AbortSignal, replay?: () => Promise<void>): Promise<void>' },
    { from: '        if (!database.isTransaction) throw error',
      to: '        if (!database.isTransaction) throw error\n        await replay?.()' }
  ] },
  'non-busy-retried': { path: store, test: 'does not retry a COMMIT with non-BUSY numeric identity', count: 2,
    from: '(error as { errcode?: unknown } | null)?.errcode !== 5 || ', to: '' },
  'commit-cancellation-ignored': { path: store, test: 'cancels the exact blocked transaction', count: 1, helper: true }
}
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function instrumentCommitContentionSource(source, path) {
  if ((!path.startsWith('packages/core/src/') && !path.startsWith('packages/core/test/')) || !path.endsWith('.ts')) return source
  const mutant = process.env.AGENTMUX_TEST_COMMIT_CONTENTION_MUTANT
  const mutation = mutant ? commitContentionMutations[mutant] : null
  assert.ok(!mutant || mutation, 'Unknown Session commit mutation')
  let loaded = source, replacements = 0
  if (mutation?.path === path) {
    if (mutation.helper) {
      const start = source.indexOf('  private async commit(signal?: AbortSignal): Promise<void> {')
      const end = source.indexOf('  private async acquireLock(', start)
      assert.ok(start !== -1 && end > start, 'The exact commit owner must exist')
      const helper = source.slice(start, end)
      assert.equal(helper.split('signal?.throwIfAborted()').length - 1, 2)
      assert.equal(helper.split('LOCK_RETRY_JITTER_MS, signal)').length - 1, 1)
      loaded = source.slice(0, start) + helper.replaceAll('signal?.throwIfAborted()', '/* mutation omits the commit cancellation fence */')
        .replace('LOCK_RETRY_JITTER_MS, signal)', 'LOCK_RETRY_JITTER_MS)') + source.slice(end)
      replacements = 3
    } else if (mutation.edits) {
      for (const edit of mutation.edits) {
        assert.equal(loaded.split(edit.from).length - 1, 1, 'The mutation must name one exact owner site')
        loaded = loaded.replace(edit.from, edit.to); replacements++
      }
    } else {
      assert.equal(source.split(mutation.from).length - 1, 1, 'The mutation must name one exact owner site')
      loaded = source.replace(mutation.from, mutation.to); replacements = 1
    }
  }
  const output = process.env.AGENTMUX_TEST_COMMIT_CONTENTION_LOADED
  if (output) {
    const record = JSON.stringify({ path, sourceSHA256: hash(source), loadedSHA256: hash(loaded),
      ...(replacements ? { mutant, replacements } : {}) }) + '\n'
    const observation = "import { appendFileSync as __agentmuxCommitContentionLoad } from 'node:fs'; __agentmuxCommitContentionLoad(" +
      JSON.stringify(output) + ', ' + JSON.stringify(record) + ');\n'
    const offset = loaded.startsWith('#!') ? loaded.indexOf('\n') + 1 : 0
    loaded = loaded.slice(0, offset) + observation + loaded.slice(offset)
  }
  return loaded
}
