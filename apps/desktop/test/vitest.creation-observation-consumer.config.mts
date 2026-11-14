import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.workbench-recovery-bootstrap.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_CREATION_OBSERVATION_MUTATION
const edits: Record<string, [string, string, string]> = {
  'native-observation-as-session': ['apps/desktop/src/renderer/src/store.ts', "if (created.kind !== 'agent') throw new Error('The original creation has no confirmed Session. Its resume request and native conversation are retained; check the same operation again.')", ''],
  'reopen-observation-as-session': ['apps/desktop/src/renderer/src/store.ts', "if (canonical.kind !== 'agent') throw new Error('The original creation has no confirmed Session. Keep its recovery request and check the same operation; no replacement was started.')", ''],
  'spatial-observation-as-session': ['apps/desktop/src/renderer/src/lib/space-agent-control.ts', "} else if (created.kind === 'agent') {", '} else if (true) {'],
  'fork-observation-as-session': ['apps/desktop/src/renderer/src/lib/space-agent-control.ts', "if (inspected.kind !== 'agent') failure('AGENT_CREATION_UNKNOWN', 'The original fork source has no confirmed Session. Its request, workface and draft are retained; check the same original operation again.')", ''],
  'name-observation-as-session': ['apps/desktop/src/renderer/src/lib/session-takeover.ts', "if (created && created.kind !== 'agent') throw new Error('The original creation has no confirmed Session. Its request and inherited name are retained; check the same operation again.')", '']
}
if (mutation && !edits[mutation]) throw Error('Unknown creation observation mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/creation-observation-consumer'), plugins: [...base.plugins ?? [], {
  name: 'creation-observation-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), edit = mutation && edits[mutation]
    let code = source
    if (edit && path === edit[0]) { if (!code.includes(edit[1])) throw Error('Missing creation observation mutation anchor'); code = code.replace(edit[1], edit[2]) }
    const output = process.env.AGENTMUX_CREATION_OBSERVATION_SOURCE_PROOF
    if (output && path.startsWith('apps/desktop/src/')) appendFileSync(output, JSON.stringify({ path, absolutePath: id.split('?')[0],
      sha256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), compiledSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : mutation }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/creation-observation-consumer.test.ts'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
