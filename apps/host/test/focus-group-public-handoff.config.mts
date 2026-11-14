import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import original from './mote-conversation-start.gate.config.mts'

export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), {
  name: 'focus-group-production-prompt-proof', enforce: 'pre', transform(source, id) {
    const owners = ['apps/desktop/src/renderer/src/lib/focus-group-task.ts', 'apps/desktop/src/renderer/src/lib/focus-group-reference.ts',
      'packages/core/src/agent-input-submit.ts', 'packages/core/src/focus-task-guidance.ts']
    const path = owners.find(path => id.endsWith('/' + path)); if (!path) return
    const inverse = process.env.AGENTMUX_FOCUS_GROUP_PUBLIC_MUTANT
    if (inverse && inverse !== 'omit-focus-note') throw Error('Unknown Focus public source inverse')
    let loaded = source
    if (inverse && path === 'packages/core/src/agent-input-submit.ts') {
      const anchor = 'input.focusTask ? focusTaskHandoffNote(input.focusTask) : undefined'
      if (source.split(anchor).length !== 2) throw Error('Expected one original Focus note combiner')
      loaded = source.replace(anchor, 'undefined')
    }
    if (process.env.AGENTMUX_FOCUS_GROUP_PUBLIC_FACTS) appendFileSync(process.env.AGENTMUX_FOCUS_GROUP_PUBLIC_FACTS,
      JSON.stringify({ kind: 'loaded-production-prompt', path, sha256: createHash('sha256').update(source).digest('hex'),
        loadedSHA256: createHash('sha256').update(loaded).digest('hex'), inverse: loaded === source ? null : inverse }) + '\n')
    return loaded === source ? undefined : { code: loaded, map: null }
  }
}], test: { ...original.test, include: ['apps/host/test/focus-group-public-handoff.test.ts'], passWithNoTests: false } })
