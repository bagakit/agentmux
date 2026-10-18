import base from './vitest.input-mailbox-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, [string, string, string]> = {
  'raw-inputs': ['apps/desktop/src/renderer/src/lib/session-mailbox-messages.ts', '!message || group.mailbox.length', '!message'],
  'drop-originals': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'renderRelated={item => renderOriginalHistory', 'renderRelated={item => null && renderOriginalHistory'],
  'hide-query-match': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'group.messages.length > 0 || ', ''],
  'drop-consensus': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'inputGroup={item => journalGroups.get(inputMailboxItemKey(inputMailboxHost, item))}', 'inputGroup={() => undefined}'],
  'replace-opened-original': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', "const selectedOriginal = wanted && folder === 'user' ? selection?.original : undefined", "const selectedOriginal = wanted && folder === 'user' ? inputGroups.flatMap(group => group.messages).find(message => messageKey({ message }) === wanted) : undefined"],
  'replace-opened-contribution': ['packages/client-ui/src/components/InputHistoryList.tsx', 'for (const [id, message] of reading.messages) originals.set(id, message)', 'for (const [id, message] of reading.messages) if (false) originals.set(id, message)'],
  'drop-selected-journal': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'group.mailbox.some(item => inputMailboxItemKey(inputMailboxHost, item) === wanted)', 'false']
}
export default defineConfig({ ...base, cacheDir: '.cache/desktop-input-groups', plugins: [{ name: 'actual-desktop-input-groups', enforce: 'pre', transform(source, id) {
  const mutation = process.env.AGENTMUX_DESKTOP_INPUTS_MUTATION, change = mutation ? changes[mutation] : undefined
  if (!change || id.split('?')[0] !== resolve(root, change[0])) return
  if (source.split(change[1]).length !== 2) throw Error('Mutation must match one loaded source: ' + mutation)
  const code = source.replace(change[1], change[2]), log = process.env.AGENTMUX_UNIFIED_LOADED
  if (log) appendFileSync(log, JSON.stringify({ path: relative(root, id), mutation, sha256: createHash('sha256').update(code).digest('hex'), originalSHA256: createHash('sha256').update(source).digest('hex') }) + '\n')
  return { code, map: null }
} }, ...base.plugins!], test: { ...base.test, include: ['apps/desktop/test/input-groups.test.tsx', 'apps/desktop/test/input-history-agent-aliases.test.tsx', 'apps/desktop/test/input-mailbox-consumers.test.tsx'] } })
