import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'

const mutations: Record<string, { file: string; before: string; after: string }> = {
  'app-source': { file: '/src/MobileApp.tsx', before: 'moteSource={mobileMoteInputSource(objectIdentity, workface.selectedSessionId, identityRecipient)}', after: 'moteSource={undefined}' },
  'prompt-retention': { file: '/src/conversation/local-drafts.ts', before: '...(intent.moteSource ? { moteSource: structuredClone(intent.moteSource) } : {}),', after: '' },
  'prompt-retry': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: '...(attempt.moteSource ? { moteSource: structuredClone(attempt.moteSource) } : {}),', after: '' },
  'question-source': { file: '/src/conversation/question-replies.ts', before: '...(moteSource ? { moteSource } : {})', after: '...{}' },
  'permission-source': { file: '/src/conversation/MobileConversationSurface.tsx', before: 'getMoteSource={() => moteSource}', after: 'getMoteSource={() => undefined}' },
  'recipient-source': { file: '/src/conversation/mote-input-source.ts', before: '!recipient || recipient !== identityRecipient || !identity?.mote', after: '!recipient || !identity?.mote' },
  'permission-retry': { file: '/src/conversation/use-mobile-interaction-controller.ts', before: 'const priorInput = previous?.original?.input', after: 'const priorInput = false ? previous?.original?.input : undefined' }
}
const name = process.env.AGENTMUX_TEST_MOBILE_MOTE_MUTATION
if (name && !mutations[name]) throw new Error('Unknown Mobile Mote mutation: ' + name)
const config = mergeConfig(base, {
  plugins: [{ name: 'loaded-mobile-mote-input-mutation', enforce: 'pre' as const, transform(code, id) {
    const mutation = name && mutations[name]
    if (!mutation || !id.split('?')[0]!.endsWith(mutation.file)) return
    const count = code.split(mutation.before).length - 1
    if (count !== (name === 'prompt-retry' ? 2 : 1)) throw new Error('Loaded Mobile mutation marker changed: ' + name)
    const result = code.replaceAll(mutation.before, mutation.after)
    if (!process.env.AGENTMUX_TEST_MOBILE_MOTE_TRACE) throw new Error('Mutation requires loaded-source trace')
    appendFileSync(process.env.AGENTMUX_TEST_MOBILE_MOTE_TRACE, JSON.stringify({ name, file: id.split('?')[0], count,
      before: createHash('sha256').update(code).digest('hex'), after: createHash('sha256').update(result).digest('hex') }) + '\n')
    return result
  } }]
})
config.test!.include = ['test/mobile-mote-input.test.tsx', 'test/conversation-surface.test.tsx', 'test/question-replies.test.tsx',
  'test/device-workface.test.tsx', 'test/concurrent-drafts.test.tsx', 'test/device-draft-acknowledgement.test.tsx', 'test/mobile-chat-start.test.tsx']
export default config
