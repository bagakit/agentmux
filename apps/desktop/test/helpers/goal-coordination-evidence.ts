import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Optional raw evidence from the owning calls; no expected prompt is synthesized here. */
export async function recordGoalCoordinationEvidence(label: string, payload: unknown): Promise<void> {
  const directory = process.env.AGENTMUX_GOAL_COORDINATION_EVIDENCE
  if (!directory) return
  const root = resolve(import.meta.dirname, '../../../..')
  const sources = ['apps/desktop/src/shared/scratch-topics.ts', 'apps/desktop/src/main/scratch-topics.ts',
    'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/goals-entry-actions.ts', 'apps/desktop/src/renderer/src/lib/primary-mote-executor.ts',
    'packages/core/src/agent-outbound-message.ts', 'packages/core/src/agentmux-cli-help.ts', 'packages/core/package.json',
    'packages/core/dist/agent-outbound-message.js', 'packages/core/dist/agentmux-cli-help.js']
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${label}.json`), JSON.stringify({ schema: 'agentmux.goal-coordination-payload.v1',
    boundary: label, sourceHashes, payload }, null, 2) + '\n')
}
