import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, cacheDir: '.cache/retained-activity',
  plugins: [...base.plugins!, { name: 'retained-activity-invocations', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/')) return
    let code = source
    const probe = file.endsWith('/ActivityView.tsx')
      ? ['  const logRef = useRef<HTMLDivElement>(null)', '  ;(globalThis as any).__retainedActivityProbe?.activity({ sessionId, conversationReading, activitySemantic })\n']
      : file.endsWith('/ConversationRecordSequence.tsx')
        ? ['  const committed = useRef<', '  ;(globalThis as any).__retainedActivityProbe?.sequence()\n'] : null
    if (probe) {
      if (code.split(probe[0]!).length !== 2) throw Error('Non-unique retained Activity probe')
      code = code.replace(probe[0]!, probe[1]! + probe[0]!)
    }
    const mutation = process.env.AGENTMUX_RETAINED_MUTANT
    if (mutation && file.endsWith(mutation === 'primary' ? '/SessionPane.tsx' : '/SessionActivityPresentation.tsx')) {
      const anchor = mutation === 'primary' ? 'retainActivityControls(activityContent.current, {' : 'retainActivityControls(presented.current.content, {'
      if (code.split(anchor).length !== 2) throw Error('Non-unique retained Activity mutation')
      code = code.replace(anchor, anchor.replace('retainActivityControls', 'cloneElement'))
      if (mutation === 'secondary') code = "import { cloneElement } from 'react'\n" + code
    }
    const log = process.env.AGENTMUX_RETAINED_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path: file, originalSHA256: hash(source), effectiveSHA256: hash(code),
      ...(code !== source && !probe ? { mutation } : {}), probe: Boolean(probe), returnedReplacement: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/retained-activity-cost.test.tsx',
    'apps/desktop/test/session-pane-reading-demand.test.tsx', 'apps/desktop/test/semantic-icon-activity-observation.test.tsx',
    'apps/desktop/test/activity-reading-demand.test.tsx'] }
})
