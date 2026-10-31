import base from './vitest.conversation-unified-consumers.config.mts'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const component = (name: string) => `packages/client-ui/src/components/${name}.tsx`
const changes: Record<string, { file: string; from: string; to: string }> = {
  'hide-readable-input': { file: component('CapturedConversationMessage'),
    from: "content={record?.contentParts ?? item.content ?? ''}", to: 'content=""' },
  'lose-empty-native-selection': { file: component('ConversationView'),
    from: "const contribution = item.kind === 'user-message' && !conversationMessageHasContent(record.contentParts, item.questionAnswers)",
    to: "const contribution = false && item.kind === 'user-message' && !conversationMessageHasContent(record.contentParts, item.questionAnswers)" },
  'ignore-native-answers': { file: component('ConversationMessage'),
    from: 'return Boolean(answers?.length) || parts.some(partHasRenderableContent)', to: 'return parts.some(partHasRenderableContent)' },
  'lose-original-reader': { file: component('ConversationView'),
    from: 'inputReadPending: readingSubmission, renderSubmissionOriginal,', to: 'inputReadPending: readingSubmission, renderSubmissionOriginal: () => null,' },
  'hide-compact-originals': { file: component('ConversationMessage'),
    from: '<div className="log-turn__meta">{messageStatus}{submissionMetadata}</div>',
    to: '<div className="log-turn__meta">{messageStatus}</div>' },
  'lose-explicit-reading-choice': { file: component('ConversationView'),
    from: '.set(id, open)', to: '.set(id, false)' },
}
const mutation = process.env.AGENTMUX_SUBMISSION_MUTATION
if (mutation && !changes[mutation]) throw Error('Unknown submission mutation: ' + mutation)
const sourceFiles = new Set(Object.values(changes).map(change => change.file))
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...base, cacheDir: '.cache/conversation-submissions', plugins: [...base.plugins ?? [], {
  name: 'submission-source-qualification', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!sourceFiles.has(path)) return
    const change = mutation ? changes[mutation] : undefined
    if (change?.file === path && source.split(change.from).length !== 2) throw Error('Missing unique submission mutation: ' + mutation)
    const code = change?.file === path ? source.replace(change.from, change.to) : source
    if (process.env.AGENTMUX_SUBMISSION_LOADED) appendFileSync(process.env.AGENTMUX_SUBMISSION_LOADED, JSON.stringify({
      path, mutation: change?.file === path ? mutation : null, originalSHA256: sha(source), sha256: sha(code),
    }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: [
  'apps/desktop/test/conversation-message-retention.test.tsx',
  'apps/desktop/test/conversation-submission-presentation.test.tsx',
  'apps/desktop/test/conversation-source-labels.test.tsx',
  'apps/desktop/test/conversation-collected-reply.test.tsx',
  'apps/desktop/test/conversation-submission-reader.test.tsx',
], passWithNoTests: false } })
