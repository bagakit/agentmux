import { defineConfig } from 'vitest/config'
import base from '../conversation-reading-density/vitest.owning.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutation = process.env.COLLABORATION_MUTATION
const edits: Record<string, [string, string]> = {
  'eager-original': ['<ConversationCollaborationOriginal parts={parts} identity={readingIdentity} hasResources={collaborationHasResources} />', 'ConversationCollaborationOriginal({ parts, identity: readingIdentity, hasResources: collaborationHasResources })'],
  'truncate-original': ["parts.map(partText).join('\\n\\n')", "parts.slice(0, -1).map(partText).join('\\n\\n')"],
  'no-fold': ['setCollaborationOpen(located); setCollaborationPresented(located)', 'setCollaborationOpen(true); setCollaborationPresented(true)'],
  'wrong-avatar': ["{ role: 'agent', id: conversationSessionId } : undefined", "{ role: 'agent', id: nativeCollaboration!.sender! } : undefined"],
  'raw-body': ['text={sessionHistoryTextForReading(part)}', 'text={part.text}'],
  'discard-body': ['collaborationPresented || collaborationOpen ? <>', 'collaborationOpen ? <>']
}
export default defineConfig({ ...base, cacheDir: '.tmp/conversation-collaboration/cache/' + (mutation ?? 'baseline'),
  plugins: [{ name: 'collaboration-mutation', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/packages/client-ui/src/components/ConversationMessage.tsx')) return
    const original = code, edit = mutation && edits[mutation]
    if (edit) { if (code.split(edit[0]).length !== 2) throw Error('Mutation anchor must be unique'); code = code.replace(edit[0], edit[1]) }
    if (process.env.COLLABORATION_LOADED) appendFileSync(process.env.COLLABORATION_LOADED, JSON.stringify({ id, mutation, original: createHash('sha256').update(original).digest('hex'), compiled: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }, ...base.plugins!], test: { ...base.test, include: ['packages/client-ui/test/conversation-collaboration.test.tsx',
    'apps/desktop/test/conversation-reading-density.test.tsx', 'packages/client-ui/test/conversation-long-message.test.tsx',
    'packages/client-ui/test/conversation-detail-copy.test.tsx'], passWithNoTests: false }
})
