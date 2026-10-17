import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const owners = ['packages/client-ui/src/lib/use-conversation-view.ts', 'packages/core/src/client.ts']
export default defineConfig({ ...base, cacheDir: '.cache/conversation-observation-recovery',
  plugins: [...base.plugins ?? [], { name: 'original-observation-recovery-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!owners.includes(path)) return
    const mutation = process.env.AGENTMUX_OBSERVATION_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'skip-replacement': [owners[0]!, ' && !(recover && current.failures.size)', ''],
      'unrelated-clears': [owners[0]!, 'newerAvailable: current.historical || current.held || value.newerAvailable', 'observationError: null, newerAvailable: current.historical || current.held || value.newerAvailable'],
      'retry-latest': [owners[0]!, "? operation.current('resume', {}, true)", "? operation.current('latest', {}, true)"],
      'release-first': [owners[0]!, 'current.binding = snapshot', 'oldHandle?.dispose(); current.binding = snapshot'],
      'late-binding': [owners[0]!, 'if (!alive() || !opening && (!handle || current.handle !== handle)) return', 'if (!alive()) return'],
      'missing-opening-gap': [owners[1]!, "opening = { ...opening!, coverage: checkpointCoverage.map(value => isDeepStrictEqual(value.source, source)\n            ? { ...value, current: code.includes('UNSUPPORTED') ? 'unsupported' : 'unavailable', gaps: [...value.gaps, { code, message }] } : value) }", ''],
      'miss-closed': [owners[1]!, 'if (native.closed?.aborted) nativeEnded()', ''],
      'coverage-revokes-watch': [owners[0]!, 'if (failures.size && oldHandle', "if (handle.coverage.some(value => value.current === 'unavailable')) failures.set('checkpoint', new Error('Checkpoint coverage revoked observer'))\n      if (failures.size && oldHandle"]
    }
    let output = source
    const edit = mutation ? edits[mutation] : undefined
    if (mutation && !edit) throw new Error('Unknown observation mutation')
    if (edit && path === edit[0]) {
      if (source.split(edit[1]).length !== 2) throw new Error('Observation mutation must match exactly once')
      output = source.replace(edit[1], edit[2])
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_OBSERVATION_LOADED) appendFileSync(process.env.AGENTMUX_OBSERVATION_LOADED,
      JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(output), mutation: output === source ? null : mutation, bytes: Buffer.byteLength(output) }) + '\n')
    return output === source ? undefined : output
  } }], test: { ...base.test, include: ['apps/desktop/test/conversation-observation-recovery.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
