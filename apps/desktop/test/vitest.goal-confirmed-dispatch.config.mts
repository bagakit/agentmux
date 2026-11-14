import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goal-plan-discovery.config.mts'
const repository = resolve(import.meta.dirname, '../../..')
const mutation = process.env.GOAL_CONFIRMED_DISPATCH_MUTANT ? JSON.parse(process.env.GOAL_CONFIRMED_DISPATCH_MUTANT) : null
export default { ...original, plugins: [...(original.plugins ?? []), {
  name: 'confirmed-dispatch-original-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(repository, id.split('?')[0]!)
    if (!mutation || path !== mutation.path) return
    const hash = (value: string) => createHash('sha256').update(value).digest('hex'), originalSHA256 = hash(source)
    for (const edit of mutation.edits ?? [mutation]) {
      if (source.split(edit.anchor).length !== 2) throw Error('Exactly one current dispatch owner anchor is required: ' + mutation.id)
      source = source.replace(edit.anchor, () => edit.replacement)
    }
    const output = process.env.GOAL_CONFIRMED_DISPATCH_LOADED
    const row = { path, mutation: mutation.id, originalSHA256, loadedSHA256: hash(source) }
    if (!output) return source
    return `import { appendFileSync as __confirmedDispatchLoaded } from 'node:fs'; __confirmedDispatchLoaded(${JSON.stringify(output)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-confirmed-dispatch-product.test.ts'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } }
