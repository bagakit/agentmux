import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'allow-agent-adoption': ['public-rpc-service.ts', "if (method === 'space.mote.preferences.save' && p.kind === 'quick' && p.action !== undefined &&", "if (false && method === 'space.mote.preferences.save' && p.kind === 'quick' && p.action !== undefined &&"],
  'accept-adoption-placement': ['mote/preferences.ts', 'if (action && destination)', 'if (false && action && destination)'],
  'lose-separate-receipt': ['mote/preferences.ts', 'confirmed && !maintenanceAdoption', 'false'],
  'borrow-loop-receipt': ['mote/preferences.ts', 'maintenanceAdoption.loopId !== action.expectedSchedule.loopId', 'false'],
  'accept-agent-actor': ['continuous-progress-definition.ts', "actor.kind !== 'user' && actor.kind !== 'device'", 'false'],
  'adopt-without-publish': ['continuous-progress-definition.ts', "p.state === 'adopted' && (publishedAt === undefined || p.issue !== null)", 'false'],
  'ignore-definition-shape': ['public-rpc-schedules.ts', 'if (p.currentDefinition !== undefined) parseContinuousProgressDefinition(p.currentDefinition)', 'if (false) parseContinuousProgressDefinition(p.currentDefinition)'],
  'lose-adoption-op-read': ['public-rpc-schedules.ts', ' && !schedule.guidanceAdoptions?.some(receipt => receipt.operationId === request.operationId)', ''],
  'drop-control-adoption': ['space-control-parser.ts', "['kind', 'target', 'requestId', 'status', 'source', 'message', 'maintenanceAdoption']", "['kind', 'target', 'requestId', 'status', 'source', 'message']"],
  'change-unchanged-file': ['mote/preferences.ts', 'if (action && confirmed && !dequal(source, params.baseline))', 'if (false && action && confirmed && !dequal(source, params.baseline))']
}
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'original-guidance-contract-source', enforce: 'pre', transform(original, id) {
  const path = relative(root, id.split('?')[0]!), selected = process.env.MOTE_GUIDANCE_CODEC_MUTANT
  if (selected && !mutations[selected]) throw Error('Unknown guidance mutation')
  const owned = ['mote/preferences.ts', 'continuous-progress-definition.ts', 'continuous-progress-scheduler.ts', 'public-rpc-schedules.ts', 'public-rpc-service.ts', 'space-control-parser.ts', 'agentmux-cli-commands.ts']
  if (!owned.some(file => path === 'packages/core/src/' + file)) return
  let loaded = original
  if (selected && path === 'packages/core/src/' + mutations[selected]![0]) {
    const [, before, after] = mutations[selected]!
    if (original.split(before).length !== 2) throw Error('Guidance source mutation needs exactly one anchor: ' + selected)
    loaded = original.replace(before, after)
  }
  if (process.env.MOTE_GUIDANCE_CODEC_LOADED) appendFileSync(process.env.MOTE_GUIDANCE_CODEC_LOADED,
    JSON.stringify({ path, mutation: selected ?? null, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return loaded === original ? undefined : { code: loaded, map: null }
} }], test: { ...source.test, include: ['packages/core/test/mote-guidance-codec.test.ts'], fileParallelism: false, maxWorkers: 1, passWithNoTests: false } })
