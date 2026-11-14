import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { candidateAlias } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const codec = 'packages/core/src/agent-observation-codec.ts'
const mutation = process.env.GOAL_OBSERVATION_MUTATION || null
const mutants = {
  'main-rejected': [codec, "'semantic', 'mainSession', 'subagentSessions',", "'semantic', 'subagentSessions',"],
  'child-scope-ignored': [codec, 'if (expectedRun && children.run.runId !== expectedRun.runId) invalid()', 'if (false) invalid()'],
  'child-parser-ignored': [codec, 'const children = parseNativeSubagents(p.subagentSessions)', 'const children = p.subagentSessions as ReturnType<typeof parseNativeSubagents>']
} as const
if (mutation && !(mutation in mutants)) throw Error('Unknown Goal observation mutation')
const owners = [codec, 'packages/core/src/goal-responsibility.ts', 'packages/core/src/goal-delegation.ts', 'packages/core/src/agent-status-freshness.ts', 'packages/core/src/agent-subagent-state.ts']
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ root, resolve: { alias: [candidateAlias(root, { source: true })] }, plugins: [{
  name: 'actual-goal-observation-codec', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.includes(file)) return
    const originalSHA256 = sha(source)
    if (mutation) {
      const [target, anchor, replacement] = mutants[mutation as keyof typeof mutants]
      if (file === target) {
        if (source.split(anchor).length !== 2) throw Error('Observation mutation needs one production anchor')
        source = source.replace(anchor, replacement)
      }
    }
    const output = process.env.GOAL_OBSERVATION_LOADED
    if (!output) return source
    const row = { file, originalSHA256, loadedSHA256: sha(source), mutation: file === codec ? mutation : null }
    return `import {appendFileSync as __goalObservationLoaded} from 'node:fs';__goalObservationLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { include: ['packages/core/test/goal-responsibility-observation.test.ts'], maxWorkers: 1, passWithNoTests: false, testTimeout: 20000 } })
