import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import original from './mote-conversation-start.gate.config.mts'

export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), {
  name: 'focus-group-production-prompt-proof', enforce: 'pre', transform(source, id) {
    if (!id.endsWith('/apps/desktop/src/renderer/src/lib/focus-group-task.ts')) return
    if (process.env.AGENTMUX_FOCUS_GROUP_PUBLIC_FACTS) appendFileSync(process.env.AGENTMUX_FOCUS_GROUP_PUBLIC_FACTS,
      JSON.stringify({ kind: 'loaded-production-prompt', path: 'apps/desktop/src/renderer/src/lib/focus-group-task.ts', sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
  }
}], test: { ...original.test, include: ['apps/host/test/focus-group-public-handoff.test.ts'], passWithNoTests: false } })
