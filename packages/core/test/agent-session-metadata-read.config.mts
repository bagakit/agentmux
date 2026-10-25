import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_METADATA_READ_MUTATION
const changes: Record<string, [string, string, number]> = {
  'receipt-global': [
    'async readPromptAdmission(agentSessionId: string, run: AgentMuxRunRef, submissionId: string): Promise<AgentPromptSubmissionRecord | null> {\n    await this.sessionWriteTails.get(agentSessionId)',
    'async readPromptAdmission(agentSessionId: string, run: AgentMuxRunRef, submissionId: string): Promise<AgentPromptSubmissionRecord | null> {\n    await this.tail', 1],
  'drop-related': ['await this.sessionWriteTails.get(agentSessionId)', 'await Promise.resolve()', 2],
  'borrow-writer': ['if (this.database && !committedOnly) return read(this.database)', 'if (this.database) return read(this.database)', 1],
  'erase-successor': ['if (this.sessionWriteTails.get(sessionId) === settled) this.sessionWriteTails.delete(sessionId)', 'this.sessionWriteTails.delete(sessionId)', 1]
}
if (mutation && !changes[mutation]) throw Error('Unknown metadata read mutation')
export default defineConfig({ cacheDir: '.cache/session-metadata-read',
  plugins: [{ name: 'actual-metadata-read-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id)
    if (!['agent-session-store.ts', 'agent-session-registry.ts', 'agent-session-database.ts', 'client.ts', 'prompt-submission.ts']
      .some(name => path === 'packages/core/src/' + name)) return
    const change = mutation && path === 'packages/core/src/agent-session-store.ts' ? changes[mutation] : undefined
    if (change && original.split(change[0]).length !== change[2] + 1) throw Error('Expected exact nonempty metadata read mutation anchors')
    const code = change ? original.replaceAll(change[0], change[1]) : original
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_METADATA_READ_LOADED) appendFileSync(process.env.AGENTMUX_METADATA_READ_LOADED,
      JSON.stringify({ path, original: hash(original), loaded: hash(code), mutation: change ? mutation : null }) + '\n')
    return { code, map: null }
  } }], test: { include: ['packages/core/test/agent-session-metadata-read.test.ts', 'packages/core/test/native-admission-history.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false,
    passWithNoTests: false, testTimeout: 10000, hookTimeout: 10000 }
})
