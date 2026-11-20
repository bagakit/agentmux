import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
const mutation = process.env.AGENTMUX_PROJECT_RECOVERY_MUTATION
  ? JSON.parse(process.env.AGENTMUX_PROJECT_RECOVERY_MUTATION) as { file: string; before: string; after: string; receipt: string }
  : undefined

export default {
  root,
  plugins: mutation ? [{
    name: 'project-execution-recovery-mutation', enforce: 'pre' as const,
    transform(source: string, file: string) {
      if (!file.endsWith('/' + mutation.file)) return
      if (source.split(mutation.before).length !== 2) throw new Error('The exact project recovery mutation anchor changed.')
      appendFileSync(mutation.receipt, file + '\n')
      return { code: source.replace(mutation.before, mutation.after), map: null }
    },
  }] : [],
  test: { include: ['packages/core/test/project-execution-connection-recovery.test.ts', 'packages/core/test/agent-execution-coordinator.test.ts',
    'packages/core/test/agent-execution-bridge.test.ts'],
    pool: 'threads', maxWorkers: 1, passWithNoTests: false },
}
