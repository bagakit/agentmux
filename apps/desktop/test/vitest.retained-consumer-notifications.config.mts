import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

export default defineConfig({ ...base, cacheDir: '.tmp/retained-consumer-notifications-vitest', plugins: [{
  name: 'retained-consumer-source-qualification', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!), hash = (value: string) => createHash('sha256').update(value).digest('hex')
    let code = original
    if (path === 'apps/desktop/src/renderer/src/components/SessionPane.tsx' && process.env.AGENTMUX_PANE_SNAPSHOT_INVERSE) {
      assert.equal(process.env.AGENTMUX_PANE_SNAPSHOT_INVERSE, 'restore-unused-snapshot')
      const anchor = '  const firstPromptSelector = useMemo(() => createFirstPromptSelector(sessionId), [sessionId])'
      assert.equal(code.split(anchor).length - 1, 1)
      code = code.replace(anchor, "  const timelineSnapshot = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.timelines[sessionId])\n" + anchor)
    }
    if (process.env.AGENTMUX_PANE_SNAPSHOT_LOADED && (path.startsWith('apps/desktop/src/') || path.endsWith('/retained-consumer-notifications.test.tsx')))
      appendFileSync(process.env.AGENTMUX_PANE_SNAPSHOT_LOADED, JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(code) }) + '\n')
    if (code !== original) return { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/retained-consumer-notifications.test.tsx'] } })
