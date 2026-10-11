import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import owning from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, resolve: owning.resolve!, ssr: owning.ssr!, cacheDir: '.cache/focus-latest-demand',
  plugins: [...base.plugins!, { name: 'focus-latest-source-inverse', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/')) return
    let code = source
    const inverse = process.env.AGENTMUX_FOCUS_LATEST_INVERSE === 'true' && file === 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
    if (inverse) {
      const guard = '    if (!enabled) return { messages: EMPTY_LATEST_INPUTS.messages, clipped: false }\n'
      if (code.split(guard).length !== 2) throw Error('Non-unique disabled latest projection inverse')
      code = code.replace(guard, '')
    }
    const probe = file === 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
    if (probe) {
      const anchor = "    return { messages: projectConversationRecords({ agentSessionId: control?.agentSessionId ?? '', executionHostId: control?.hostId,"
      if (code.split(anchor).length !== 2) throw Error('Non-unique latest projection probe')
      code = code.replace(anchor, '    ;(globalThis as any).__focusLatestProjectionProbe?.(timeline)\n' + anchor)
    }
    const log = process.env.AGENTMUX_FOCUS_LATEST_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path: file, originalSHA256: hash(source), effectiveSHA256: hash(code), inverse, probe }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/focus-timeline-conversation-records.test.tsx'] }
})
