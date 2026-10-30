import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import base from './mobile-mote-default-entry.config.mts'

const variants: Record<string, { file: string; before: string; after: string }> = {
  'main-observation': { file: '/src/conversation/mote-main-input.ts', before: 'return observedMobileMoteMain(snapshot, target, agentSessionId) ?? (previous && target &&',
    after: 'return observedMobileMoteMain(snapshot, target, agentSessionId) ?? (false && previous && target &&' },
  'main-cold-role': { file: '/src/conversation/MobileConversationSurface.tsx', before: 'moteTarget && !moteMain ?', after: 'false && moteTarget && !moteMain ?' },
  'main-handoff': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: 'if (!originalBody && !moteDirectAgent && moteMainIssue &&', after: 'if (false && !originalBody && !moteDirectAgent && moteMainIssue &&' },
  'direct-member': { file: '/src/conversation/MobileConversationSurface.tsx', before: 'const moteMain = moteDirectAgent ? undefined : retainMobileMoteMain', after: 'const moteMain = false ? undefined : retainMobileMoteMain' },
  'reader-owner': { file: '/src/conversation/use-mobile-conversation-reading.tsx', before: 'key={value.key} owner={value}', after: 'key={value.key + String(value === owner)} owner={value}' },
  'reader-position': { file: '/src/conversation/use-mobile-conversation-reading.tsx', before: 'owner.scrollTop ?? 0', after: '0' },
  'reader-follow': { file: '/src/conversation/use-mobile-conversation-reading.tsx', before: 'const reading = owner.reading ?? emptyReading', after: 'owner.follow.current = initFollowState(); const reading = owner.reading ?? emptyReading' }
}
const name = process.env.AGENTMUX_MOBILE_READING_MUTATION
if (name && !variants[name]) throw Error('Unknown Mobile reading protection mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], { name: 'loaded-mobile-reading-protection', enforce: 'pre', transform(source, id) {
  const mutation = name && variants[name]
  const file = id.split('?')[0]!
  if (!file.includes('/apps/mobile/src/conversation/') || !/\.(?:ts|tsx)$/u.test(file)) return
  if (mutation && file.endsWith(mutation.file) && source.split(mutation.before).length !== 2) throw Error('Loaded protection mutation marker changed: ' + name)
  const changed = mutation && file.endsWith(mutation.file) ? source.replace(mutation.before, mutation.after) : source
  const trace = process.env.AGENTMUX_MOBILE_READING_TRACE
  if (name && !trace) throw Error('Loaded mutation trace is required')
  const marker = { name: name ?? 'baseline', file, applied: changed !== source,
    originalSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(changed).digest('hex') }
  if (trace) appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...marker }) + '\n')
  return { code: changed + '\n;globalThis.__mobileReadingProtectionEvaluated ??= []; globalThis.__mobileReadingProtectionEvaluated.push(' + JSON.stringify(marker) + ');\n', map: null }
} }], test: { ...base.test, include: ['apps/mobile/test/mobile-mote-reading-protection.test.tsx'] } })
