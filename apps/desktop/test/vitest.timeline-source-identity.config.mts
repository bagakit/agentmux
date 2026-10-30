import { defineConfig } from 'vitest/config'
import base from './vitest.channel-profile.config.mts'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { candidateModule } from '../scripts/candidate-package-resolve.mjs'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_TIMELINE_IDENTITY_MUTANT
const changes = {
 'drop-native-identity': { file: 'packages/client-ui/src/lib/conversation-records.ts', before: 'const speaker = collaboration ?', after: 'const speaker = false ?' },
 'drop-axis-avatar': { file: 'apps/desktop/src/renderer/src/components/ConversationAxis.tsx', before: 'url={identity.channelProfile?.profile?.avatarUrl}', after: 'url={undefined}' },
 'ignore-reading-range': { file: 'apps/desktop/src/renderer/src/lib/conversation-ruler.ts', before: "part.kind === 'text' ? sessionHistoryTextForReading(part) : part.text", after: 'part.text' }
} as const
if (mutation && !(mutation in changes)) throw Error('Unknown timeline identity mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/timeline-source-identity'), plugins: [...base.plugins!, {
 name: 'actual-timeline-identity-owner', enforce: 'pre', transform(input, id) {
  const file = relative(root, candidateModule(root, id.split('?')[0]!))
  if (!['packages/client-ui/src/lib/conversation-speaker.ts', 'packages/client-ui/src/lib/conversation-records.ts', 'packages/client-ui/src/components/ConversationMessage.tsx',
   'apps/desktop/src/renderer/src/components/ConversationSpeakerAvatar.tsx', 'apps/desktop/src/renderer/src/components/ConversationAxis.tsx', 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/conversation-ruler.ts'].includes(file)) return
  let output = input
  const change = mutation && changes[mutation as keyof typeof changes]
  if (change && file === change.file) { if (input.split(change.before).length !== 2) throw Error('Timeline identity mutation boundary changed'); output = input.replace(change.before, change.after) }
  const marker = process.env.AGENTMUX_TIMELINE_IDENTITY_LOADED
  if (!marker) return output === input ? undefined : { code: output, map: null }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex'), row = { file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input === output ? null : mutation }
  return { code: "import {appendFileSync as __timelineIdentityLoaded} from 'node:fs';__timelineIdentityLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output, map: null }
 }
 }], test: { ...base.test, include: ['apps/desktop/test/timeline-source-identity-consumer.test.tsx'], globalSetup: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 30_000 } })
