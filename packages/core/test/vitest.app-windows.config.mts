import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const protocol = 'packages/core/src/public-rpc-windows.ts', service = 'packages/core/src/public-rpc-service.ts', focus = 'packages/core/src/desktop-focus-parser.ts'
const changes = {
  exactIdentity: [protocol, "value === 'self'", 'false'],
  exactIntent: [protocol, 'JSON.stringify(operation.input) !== JSON.stringify(input)', 'false'],
  uniqueOwner: [protocol, 'new Set(borrowed).size !== borrowed.length', 'false'],
  observedTarget: [protocol, 'if (sameDocument &&', 'if (false &&'],
  receiptDocument: [protocol, 'documentGeneration !== null && documentGeneration !== requested.documentGeneration', 'false'],
  transportActor: [service, 'return parseAppWindowPage(method, result, input, actor)', 'return parseAppWindowPage(method, result, input)'],
  exactForward: [service, 'this.ports.forwardControl!<AppWindowMethod>(method, input, context)', 'this.ports.forwardControl!<AppWindowMethod>(method, {} as never, context)'],
  pairedDocument: [focus, '(required && !hasWindow)', 'false'],
  preserveDocument: [focus, "['scope', 'ownerKind', 'tabId', 'regionId', 'sessionId', 'windowId', 'documentGeneration'].some", "['scope', 'ownerKind', 'tabId', 'regionId', 'sessionId', 'windowId'].some"],
  transferDocument: [focus, "(result.presentation.state === 'window' && (observedInput.after.scope", '(false && (observedInput.after.scope']
} as const
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export default defineConfig({ plugins: [{ name: 'original-window-contract-mutants', enforce: 'pre', transform(source, id) {
  const name = process.env.APP_WINDOW_MUTATION as keyof typeof changes | undefined
  if (!name) return
  assert.ok(changes[name]); const [file, needle, replacement] = changes[name]
  if (relative(root, id) !== file) return
  const occurrences = source.split(needle).length - 1; assert.equal(occurrences, 1)
  const changed = source.replace(needle, replacement)
  if (process.env.APP_WINDOW_HITS) appendFileSync(process.env.APP_WINDOW_HITS, JSON.stringify({ name, file, occurrences, source: sha(source), changed: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], test: {
  include: ['packages/core/test/app-windows.test.ts'], passWithNoTests: false, testTimeout: 30000, hookTimeout: 30000
} })
