import { appendFileSync } from 'node:fs'
import { tests, mutations } from './cross-host-execution-checks.mjs'

const selected = process.env.CROSS_HOST_EXECUTION_MUTATION
const mutation = selected ? mutations.find(value => value.id === selected) : undefined
if (selected && !mutation) throw new Error('Unknown cross-host execution mutation')
export default {
  plugins: mutation ? [{ name: 'cross-host-execution-mutation', enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.endsWith('/packages/core/src/' + mutation.file)) return
      if (code.split(mutation.before).length !== 2) throw new Error('Exact mutation target missing: ' + mutation.id)
      if (!process.env.CROSS_HOST_EXECUTION_MUTATION_HIT) throw new Error('Mutation hit receipt missing')
      appendFileSync(process.env.CROSS_HOST_EXECUTION_MUTATION_HIT, JSON.stringify({ mutation: mutation.id, file: id }) + '\n')
      return { code: code.replace(mutation.before, mutation.after), map: null }
    },
  }] : [],
  test: { include: mutation ? [`packages/core/test/${mutation.test}.test.ts`] : tests,
    exclude: ['**/node_modules/**'], pool: 'forks', maxWorkers: 1 },
}
