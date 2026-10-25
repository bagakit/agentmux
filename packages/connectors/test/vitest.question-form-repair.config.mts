import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.feishu-question-card.config.mts'
const files = ['packages/connectors/src/conversation-actions.ts', 'packages/connectors/src/durable-ingress.ts', 'packages/connectors/src/adapters/feishu/index.ts',
  'packages/core/src/ingress-contract.ts', 'packages/core/src/ingress-codec.ts', 'packages/core/src/connection-diagnosis-contract.ts']
export default defineConfig({ ...original, cacheDir: '.cache/question-form-repair', plugins: [{ name: 'question-form-repair-loaded-source', enforce: 'pre', transform(source, id) {
  const path = relative(original.root!, id.split('?')[0]!)
  if (!files.includes(path)) return
  let loaded = source, mutation: string | undefined
  if (process.env.QUESTION_FORM_MUTANT && path === files[0]) {
    if (process.env.QUESTION_FORM_MUTANT !== 'invalid-is-unsupported') throw Error('Unknown question form mutation')
    const anchor = "return this.questionClaimed(ref.actionRef) ? 'INGRESS_AUTHORITY_REVISED' : 'INGRESS_QUESTION_ANSWER_INVALID'"
    if (source.split(anchor).length !== 2) throw Error('Original invalid form result must occur once')
    loaded = source.replace(anchor, "return this.questionClaimed(ref.actionRef) ? 'INGRESS_AUTHORITY_REVISED' : 'INGRESS_ACTION_UNSUPPORTED'"); mutation = 'invalid-is-unsupported'
  }
  const marker = process.env.QUESTION_FORM_LOADED
  if (marker) {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    const row = { path, originalSHA256: sha(source), loadedSHA256: sha(loaded), ...(mutation ? { mutation } : {}) }
    loaded = "import { appendFileSync as __questionFormLoaded } from 'node:fs'; __questionFormLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded
  }
  return loaded === source ? undefined : { code: loaded, map: null }
} }, ...original.plugins!], test: { ...original.test, include: ['packages/connectors/test/feishu-question-actions.test.ts', 'packages/connectors/test/discord-channel.test.ts', 'packages/connectors/test/feishu-permission-actions.test.ts'],
  testNamePattern: process.env.QUESTION_FORM_CASE ?? 'correctable original Question|invalid Question|unknown native answer|default Desktop and authenticated Feishu form|permission grants do not authorize answers|native question button and modal.*false|authenticates the SDK callback, commits before ACK', fileParallelism: false, passWithNoTests: false } })
