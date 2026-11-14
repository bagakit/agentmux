import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), {
  name: 'work-continuity-guidance-delivery', enforce: 'pre', transform(code, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/host/src/mote-presence.ts', 'packages/core/src/mote/input-source.ts', 'packages/core/src/mote/guidance.ts',
      'packages/core/src/generated/agentmux-guides.ts', 'apps/host/src/goal-runtime.ts'].includes(file)) return
    let loaded = code
    if (process.env.MOTE_GUIDANCE_MUTANT === 'heartbeat-disconnected' && file === 'apps/host/src/mote-presence.ts') {
      const anchor = "'Mote main heartbeat.\\n\\n' + MOTE_SUPERVISION_GUIDANCE +"
      if (!code.includes(anchor)) throw Error('Missing heartbeat composition anchor')
      loaded = code.replace(anchor, "'Mote main heartbeat.\\n\\n' +")
    }
    if (process.env.MOTE_GUIDANCE_MUTANT === 'main-input-disconnected' && file === 'packages/core/src/mote/input-source.ts') {
      const anchor = '+ "\\n\\n" + MOTE_SUPERVISION_GUIDANCE'
      if (!code.includes(anchor)) throw Error('Missing Main input composition anchor')
      loaded = code.replace(anchor, '')
    }
    if (process.env.MOTE_GUIDANCE_LOADED) appendFileSync(process.env.MOTE_GUIDANCE_LOADED, JSON.stringify({ file,
      original: createHash('sha256').update(code).digest('hex'), loaded: createHash('sha256').update(loaded).digest('hex'),
      mutant: process.env.MOTE_GUIDANCE_MUTANT ?? null }) + '\n')
    return loaded === code ? undefined : { code: loaded, map: null }
  }
}], test: { ...source.test, include: ['apps/host/test/mote-work-continuity-guidance.test.ts'],
  setupFiles: [...(source.test?.setupFiles ?? []), resolve(root, 'apps/host/test/fixtures/mote-continuity-rollover-runtime.ts')],
  fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 30000, hookTimeout: 30000 } })
