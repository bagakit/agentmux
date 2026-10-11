import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import owning from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, resolve: owning.resolve!, ssr: owning.ssr!, cacheDir: '.cache/focus-empty-read',
  plugins: [...base.plugins!, { name: 'focus-empty-read-source-probe', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/')) return
    let code = source
    const probe = file === 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
    const inverse = probe && process.env.AGENTMUX_FOCUS_EMPTY_INVERSE === 'true'
    if (inverse) {
      const guard = '      if (!source.messages.length && !source.conversationRead) continue'
      if (code.split(guard).length !== 2) throw Error('Non-unique empty read handoff inverse')
      code = code.replace(guard, '      if (!source.messages.length) continue')
    }
    if (probe) {
      const track = 'projectConversationRecords({ agentSessionId: sessionId, executionHostId: context?.hostId, timeline })'
      const holder = 'projectConversationRecords({ agentSessionId: part.reference.agentSessionId, executionHostId: part.reference.hostId, historyPage: part.page ?? undefined, timeline: part.timeline })'
      for (const anchor of [track, holder]) if (code.split(anchor).length !== 2) throw Error('Non-unique empty read projection probe')
      code = code.replace(track, '((globalThis as any).__focusEmptyTrackProbe?.(sessionId, timeline), ' + track + ')')
        .replace(holder, '((globalThis as any).__focusEmptyHolderProbe?.(part.reference, part.page, part.timeline), ' + holder + ')')
    }
    const log = process.env.AGENTMUX_FOCUS_EMPTY_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path: file, originalSHA256: hash(source), effectiveSHA256: hash(code), probe, inverse }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/focus-timeline-conversation-records.test.tsx'] }
})
