import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/test/vitest.mote-context.config.mts'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const specs: Record<string, { path: string; edits: [string, string][] }> = {
  'runtime-participant': { path: 'packages/core/src/agent-message-query.ts', edits: [
    ['envelope.senderRuntimeId === undefined || envelope.senderRuntimeId === runtimeId', 'true'],
    ['envelope.recipientRuntimeId === undefined || envelope.recipientRuntimeId === runtimeId', 'true']] },
  'foreign-selector': { path: 'packages/core/src/client.ts', edits: [['participant.participantRuntimeId !== this.requireCreationAuthority().runtimeId ||', 'false ||']] },
  'queue-runtime-filter': { path: 'packages/core/src/client.ts', edits: [['}, runtimeId)\n      return { ...page, messages:', '}, undefined)\n      return { ...page, messages:']] },
  'qualified-journal': { path: 'packages/core/src/public-rpc-service.ts', edits: [["method === 'message.read' && hostId === 'local' && !participant", "method === 'message.read' && hostId === 'local'"]] },
}
const mutation = process.env.AGENTMUX_MAIL_MUTATION
if (mutation) assert.ok(specs[mutation], 'Known actual original mail owner mutation')
export default defineConfig({ resolve: source.resolve, plugins: [{ name: 'actual-original-mail-owner', enforce: 'pre', transform(original, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!Object.values(specs).some(spec => spec.path === path)) return
  let code = original
  const spec = mutation ? specs[mutation] : undefined
  if (spec?.path === path) {
    for (const [from, to] of spec.edits) { assert.equal(code.split(from).length - 1, 1, 'One production mail owner anchor'); code = code.replace(from, to) }
  }
  if (process.env.AGENTMUX_MAIL_LOADED) appendFileSync(process.env.AGENTMUX_MAIL_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code !== original ? mutation : null }) + '\n')
  if (code !== original) return { code, map: null }
} }], test: { include: ['packages/core/test/space-member-native-mail.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000 } })
