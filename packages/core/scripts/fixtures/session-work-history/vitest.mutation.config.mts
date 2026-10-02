import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import owning from './vitest.owning.config.mts'
const name = process.env.AGENTMUX_WORK_HISTORY_MUTANT
const patches = {
  'native-producer-omitted': ['packages/core/src/client.ts',
    'if (next.activityCommit?.latest.id === activityId) await this.flushAgentActivity(next)',
    'if (false) await this.flushAgentActivity(next)'],
  'tool-evicts-status': ['packages/core/src/session-timeline-reducer.ts',
    "item.activityState ? ++states : item.kind === 'user_message' ? ++inputs : ++activity",
    "item.kind === 'user_message' ? ++inputs : ++activity"],
  'cross-run-closed': ['packages/core/src/session-timeline.ts',
    'next.activityState!.run.runId === activity.run.runId', 'true']
} as const
if (!name || !(name in patches) || !process.env.AGENTMUX_WORK_HISTORY_MUTANT_RECEIPT) throw new Error('Explicit loaded work-history mutation required')
const [path, needle, replacement] = patches[name as keyof typeof patches]
export default defineConfig({ ...owning, plugins: [{ name: 'session-work-history-loaded-mutation', enforce: 'pre',
  transform(source, id) {
    if (!id.split('?')[0]!.endsWith(`/${path}`)) return
    if (source.split(needle).length !== 2) throw new Error('Mutation must match exactly one production owner')
    const code = source.replace(needle, replacement)
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.AGENTMUX_WORK_HISTORY_MUTANT_RECEIPT!, `${JSON.stringify({ mutant: name, path, sourceSha: sha(source), transformedSha: sha(code), replacements: 1 })}\n`)
    return { code, map: null }
  }
}] })
