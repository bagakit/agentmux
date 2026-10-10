import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import media from './vitest.media.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...media, cacheDir: resolve(root, '.tmp/agent-input-recall/recall-cache'),
  plugins: [...media.plugins ?? [], { name: 'original-input-recall-consumer', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), mutation = process.env.AGENT_RECALL_MUTATION
    let served = code
    if (path === 'apps/desktop/src/renderer/src/components/AgentInputRecap.tsx' && mutation) {
      if (mutation === 'count') { if (code.split('.slice(-6)').length !== 3) throw Error('Two input window bounds required'); served = code.replaceAll('.slice(-6)', '.slice(-3)') }
      else {
        const pair = mutation === 'tail' ? ['<AgentReadingBody reading={meta.reading}', '<AgentReadingBody reading={{ ...meta.reading, text: meta.reading.text.slice(0, 240) }}']
          : mutation === 'lifetime' ? ['if (!available) setInspected(null)', 'if (false && !available) setInspected(null)'] : null
        if (!pair || code.split(pair[0]!).length !== 2) throw Error('One original input consumer required')
        served = code.replace(pair[0]!, pair[1]!)
      }
    }
    if (process.env.AGENT_RECALL_LOADED && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/client-ui/src/'))) appendFileSync(process.env.AGENT_RECALL_LOADED,
      JSON.stringify({ path, sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: served !== code }) + '\n')
    return served === code ? undefined : { code: served, map: null }
  } }],
  test: { ...media.test, include: ['apps/desktop/test/agent-input-recall.test.tsx', 'apps/desktop/test/agent-reading-images.test.tsx', 'apps/desktop/test/agent-reading-preview.test.tsx', 'apps/desktop/test/agent-reading-pin.test.tsx', 'apps/desktop/test/agent-information-card.test.tsx', 'apps/desktop/test/focus-context-hover-inputs.test.tsx'] }
})
