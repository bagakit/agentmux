import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/settings-overview/vitest.config.mts'

const mutation = process.env.AGENTMUX_BOARD_RETIREMENT_MUTATION
if (mutation && mutation !== 'scratch-topic-scope') throw Error('Unknown Board retirement mutation')

// The affected Renderer owners consume current Core source; shared dist is not rebuilt.
export default defineConfig({ ...source, plugins: mutation ? [{ name: 'actual-topic-read-scope', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/hooks/useScratchTopics.ts')) return
  const before = 'snapshot?.scope === scope ?'
  if (code.split(before).length !== 2) throw Error('Missing exact Topic scope boundary')
  const changed = code.replace(before, 'snapshot ?')
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  if (process.env.AGENTMUX_BOARD_RETIREMENT_LOADED) appendFileSync(process.env.AGENTMUX_BOARD_RETIREMENT_LOADED, JSON.stringify({ id, mutation, original: sha(code), changed: sha(changed) }) + '\n')
  return changed
} }] : [], test: { ...source.test, passWithNoTests: false, include: [
  'apps/desktop/test/board-retirement.test.ts',
  'apps/desktop/test/workspace-selection.test.ts',
  'apps/desktop/test/mote-daily-goal.test.tsx',
  'apps/desktop/test/activity-icon-semantics.test.tsx',
  'apps/desktop/test/project-path-metadata-consumers.test.tsx',
  'apps/desktop/test/ime-composition-keyboard-event.test.ts',
  'apps/desktop/test/attention-vocabulary.test.ts',
  'apps/desktop/test/topic-agent-status.test.ts',
  'apps/desktop/test/app-resize-owner.test.tsx',
  'apps/desktop/test/board-data-flow.test.tsx',
  'apps/desktop/test/workspace-board.test.ts',
  'apps/desktop/test/task-session-region-host.test.tsx',
  'apps/desktop/test/host-identity.test.tsx',
  'apps/desktop/test/default-executor-choice.test.tsx',
  'apps/desktop/test/settings-executor-refresh-input.test.tsx',
  'apps/desktop/test/provider-observation-consumer.test.tsx',
  'apps/desktop/test/loading-surface-inventory.test.ts',
  'apps/desktop/test/relative-age.test.ts',
  'apps/desktop/test/attention-ordering.test.ts',
  'apps/desktop/test/fanout-wiring.test.ts',
  'apps/desktop/test/global-board-demand-workspace.test.tsx'
] } })
