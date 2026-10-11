import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, [string, string, string]> = {
  'omit-message-input': ['agent-global-message-queue.ts', 'rows.slice(0, limit).map(row => {', "rows.slice(0, limit).filter(row => !String(row.original).includes('originalControlOperationId')).map(row => {"],
  'replace-message-key-with-control': ['agent-global-message-queue.ts', 'intent: saved.intent, control: saved.control,', "intent: saved.intent.source.kind === 'message' ? { ...saved.intent, key: { ...saved.intent.key, messageId: saved.intent.source.originalControlOperationId } } : saved.intent, control: saved.control,"],
  'trust-recipient-cursor': ['agent-global-message-queue.ts', 'cut.agentSessionId !== input.agentSessionId ||', 'false ||'],
  'omit-accepted-submission': ['client.ts', 'await this.messageQueue.recordInputSubmission(key, at)', 'await Promise.resolve()'],
  'conflate-wait-generation': ['client.ts', 'ref: saved.control.ref, control: saved.control,', 'ref: { ...saved.control.ref, waitGeneration: saved.sequence }, control: saved.control,'],
  'trust-readonly-producer': ['agent-global-message-queue.ts', "if (!isDeepStrictEqual(original.kind === 'input-submission' ? original.key : original.intent.key, key))", 'if (false)']
}
export default defineConfig({ root, cacheDir: resolve(root, '.cache/input-mailbox', process.env.AGENTMUX_MAILBOX_MUTATION ?? 'positive'),
  plugins: [{ name: 'actual-mailbox-source', enforce: 'pre',
    resolveId(source, importer) {
      if (process.env.AGENTMUX_MAILBOX_COMPILED === '1') return
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
      const original = code, mutation = process.env.AGENTMUX_MAILBOX_MUTATION
      const change = mutation ? mutants[mutation] : undefined
      if (mutation && !change) throw new Error('Unknown mailbox source mutation')
      if (change && path === 'packages/core/src/' + change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Mailbox mutation anchor is not unique: ' + mutation)
        code = code.replace(change[1], change[2])
      }
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      if (process.env.AGENTMUX_MAILBOX_LOADED) appendFileSync(process.env.AGENTMUX_MAILBOX_LOADED, JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation } : {}) }) + '\n')
      if (code !== original) return { code, map: null }
    }
  }], test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: process.env.AGENTMUX_MAILBOX_LAUNCH === '1' ? ['packages/core/test/session-continuity-launch-input.test.ts'] : ['packages/core/test/agent-input-mailbox.test.ts'], testTimeout: 20_000 } })
