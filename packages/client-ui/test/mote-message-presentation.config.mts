import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import base from './conversation-message.config.mts'

const variants = {
  'captured-options': ['packages/client-ui/src/components/ConversationView.tsx',
    '...(reading.detailsOnlyMetadata === undefined ? {} : { detailsOnlyMetadata: reading.detailsOnlyMetadata }),', 'detailsOnlyMetadata: false,'],
  'native-details': ['packages/client-ui/src/components/ConversationMessage.tsx', '{detailsOnlyMetadata ? submissionMetadata : null}', ''],
  'captured-attention': ['packages/client-ui/src/components/CapturedConversationMessage.tsx', 'attentionOnly={props.detailsOnlyMetadata}', 'attentionOnly={false}'],
  'system-preview': ['packages/client-ui/src/components/ConversationMessage.tsx', 'summary={detailsOnlyMetadata ? undefined : systemSummary}', 'summary={systemSummary}'],
  'located-contribution': ['packages/client-ui/src/components/ConversationMessage.tsx', 'revealSourceKey={revealSubmission}', '']
} as const
const mutation = process.env.MOTE_MESSAGE_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Mote presentation mutation')
export default defineConfig({ ...base, cacheDir: '.cache/mote-message-presentation', plugins: [...base.plugins ?? [], {
  name: 'loaded-mote-message-presentation', enforce: 'pre', transform(source, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!Object.values(variants).some(row => row[0] === path)) return
    let code = source
    const change = mutation && variants[mutation]
    if (change && path === change[0]) {
      if (source.split(change[1]).length !== 2) throw Error('Mote presentation mutation did not have one exact production target')
      code = source.replace(change[1], change[2])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const log = process.env.MOTE_MESSAGE_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/client-ui/test/mote-message-presentation.test.tsx',
  'apps/desktop/test/conversation-submission-presentation.test.tsx', 'apps/desktop/test/conversation-system-message.test.tsx',
  'packages/client-ui/test/conversation-message-card.test.tsx', 'packages/client-ui/test/conversation-message-copy.test.tsx'] } })
