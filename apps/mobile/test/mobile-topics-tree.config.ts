import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import base from '../vitest.config'
const mutant = process.env.MOBILE_TOPICS_MUTANT ?? 'baseline'
const mutations: Record<string, [string, string]> = {
  'category-binding': ["rpc('topic.ls', { categoryId: requestedCategoryId })", "rpc('topic.ls', { categoryId: categories[0]!.categoryId })"],
  'in-place-tree': ['matchingCategories.map(value => {', 'matchingCategories.filter(value => categoryId === null || value.categoryId === categoryId).map(value => {'],
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base,
  plugins: [...(base.plugins ?? []), { name: 'mobile-topics-tree-source-proof', enforce: 'pre', transform(input, id) {
    if (!id.endsWith('/src/topics/MobileTopicsSurface.tsx')) return
    let code = input
    if (mutant !== 'baseline') {
      const change = mutations[mutant]
      if (!change || input.split(change[0]).length !== 2) throw new Error('Exactly one current production mutation anchor is required.')
      code = input.replace(change[0], change[1])
    }
    if (process.env.MOBILE_TOPICS_SOURCE_LOG) appendFileSync(process.env.MOBILE_TOPICS_SOURCE_LOG, JSON.stringify({ path: id, mutant, originalSHA256: sha(input), consumedSHA256: sha(code) }) + '\n')
    return code === input ? undefined : { code, map: null }
  } }],
  test: { ...base.test, maxWorkers: 1, include: ['test/mobile-topics-tree.test.tsx'], passWithNoTests: false }
})
