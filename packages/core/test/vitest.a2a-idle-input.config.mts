import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'native-queue-becomes-steer': ['providers/codex-native-input.ts', "if (frozen.operation === 'queue-idle') {", 'if (false) {'],
  'native-idle-target-is-omitted': ['prompt-submission.ts', '...(control?.idleOnly ? { idleOnly: true } : {})', '...{}'],
  'completion-fence-is-omitted': ['prompt-submission.ts', '} else if (agentTurnCompletionIdentity(current) !== expectedCompletionId || current.promptCompletionAdmission?.completionId === expectedCompletionId && !independentIdleNotification) {', '} else if (false) {'],
  'final-input-fence-is-omitted': ['prompt-submission.ts', 'if (control?.idleOnly && currentRun.acceptedInputBytes !== control.idleOnly.inputByte)', 'if (false)'],
  'notification-identity-is-omitted': ['prompt-submission.ts', 'message.questionReply, message.a2aNotificationId])', 'message.questionReply])'],
  'edited-notification-is-adopted': ['native-input-adoption.ts', "item.contentParts.length === 1 && item.contentParts[0]?.kind === 'text' && item.contentParts[0].text === intent.prompt", 'true'],
  'native-queue-receipt-is-unchecked': ['providers/codex-native-input.ts', "if (typeof queued?.id !== 'string' || !queued.id || queued.clientUserMessageId !== frozen.clientCorrelation ||\n                !isDeepStrictEqual(queued.input, input)) throw unavailable()", 'void queued'],
  'notification-identity-is-not-restored': ['prompt-submission-record.ts', "...(message.a2aNotificationId === undefined ? {} : { a2aNotificationId: string(message.a2aNotificationId, 'original A2A notification identity') }),", ''],
  'independent-idle-notification-is-blocked': ['prompt-submission.ts', ' && !independentIdleNotification)) {', ')) {'],
  'independent-idle-completion-is-consumed': ['prompt-submission.ts', 'completionId === expectedCompletionId && !independentIdleNotification)', 'completionId === expectedCompletionId)'],
  'controlled-notice-reservation-spills-to-other-key': ['agent-global-message-queue.ts', "key.kind === 'prompt' && isDeepStrictEqual(this.notification(key.submissionId)?.key, key)", "key.kind === 'prompt' && this.notification(key.submissionId)"],
  'uncontrolled-notice-reservation-spills-to-other-key': ['agent-global-message-queue.ts', 'if (expectedNotificationId === undefined ? sameNotificationKey :', 'if (expectedNotificationId === undefined ? notice !== undefined :'],
}
export default defineConfig({ root, plugins: [{ name: 'original-workspace-source', enforce: 'pre', resolveId(id) {
  const match = id.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (!match) return
  const directory = resolve(root, 'packages', match[1]!)
  const entry = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).exports?.[match[2] ? '.' + match[2] : '.']?.import
  if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
}, transform(code, id) {
  const file = relative(resolve(root, 'packages/core/src'), id.split('?')[0]!)
  if (file.startsWith('..') || !file.endsWith('.ts')) return
  const mutation = process.env.AGENTMUX_IDLE_INPUT_MUTATION
  if (mutation && !mutations[mutation]) throw new Error('Unknown idle input mutation')
  const change = mutation && mutations[mutation], before = code
  if (change && file === change[0]) {
    if (code.split(change[1]).length !== 2) throw new Error('Idle input mutation anchor is not unique: ' + mutation)
    code = code.replace(change[1], change[2])
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.AGENTMUX_IDLE_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_IDLE_INPUT_LOADED,
    JSON.stringify({ file, originalSHA256: hash(before), sha256: hash(code), ...(before === code ? {} : { mutation }) }) + '\n')
  if (before !== code) return { code, map: null }
} }], test: { include: ['packages/core/test/a2a-idle-input.test.ts', 'packages/core/test/codex-idle-queue.test.ts', 'packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts'], maxWorkers: 1, globalSetup: [], testTimeout: 20_000 } })
