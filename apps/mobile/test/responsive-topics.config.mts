import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import base from '../vitest.config'
const mutant = process.env.MOBILE_RESPONSIVE_TOPICS_MUTANT ?? 'baseline'
const changes: Record<string, { file: string; from: string; to: string; target: string }> = {
  'source-navigation-sticky': { file: '/src/topics/MobileTopicKnowledge.tsx', from: 'function read(entry: TopicKnowledgeItem) {\n    onNavigate?.()', to: 'function read(entry: TopicKnowledgeItem) {', target: 'actual App leaves original Source A' },
  'source-reader-active': { file: '/src/topics/MobileTopicKnowledge.tsx', from: 'const readingVisible = visible && !sourceActive', to: 'const readingVisible = visible', target: 'withdraws the actual in-flight knowledge read' },
  'topic-navigation-hidden': { file: '/src/topics/MobileTopicsSurface.tsx', from: 'hidden={!directoryVisible}', to: 'hidden={!directoryVisible || inTopic}', target: 'keeps the exact original Topic navigation' },
  'knowledge-navigation-hidden': { file: '/src/topics/MobileTopicKnowledge.tsx', from: 'hidden={!directoryVisible}', to: 'hidden={!directoryVisible || Boolean(selection) || editorVisible}', target: 'retains the same original knowledge editor' },
}
const sha = (input: string) => createHash('sha256').update(input).digest('hex')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), { name: 'responsive-topics-loaded-proof', enforce: 'pre', transform(input, id) {
  if (!/\/src\/topics\/(MobileTopicsSurface|MobileTopicKnowledge|MobileTopicSource)\.tsx$/.test(id) && !id.endsWith('/src/MobileApp.tsx') && !id.endsWith('/test/responsive-topics.test.tsx')) return
  let consumed = input
  const change = changes[mutant]
  if (mutant !== 'baseline' && !change) throw new Error(`Unknown responsive Topics mutation: ${mutant}`)
  if (change && id.endsWith(change.file)) {
    if (input.split(change.from).length !== 2) throw new Error('Exactly one current production mutation anchor is required.')
    consumed = input.replace(change.from, change.to)
  }
  const trace = process.env.MOBILE_RESPONSIVE_TOPICS_SOURCE_LOG
  if (trace) {
    const row = { path: id, mutant, originalSHA256: sha(input), consumedSHA256: sha(consumed) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return consumed + `\nimport {appendFileSync as __responsiveTopicsTrace} from 'node:fs';__responsiveTopicsTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
  }
  return input === consumed ? undefined : { code: consumed, map: null }
} }], test: { ...base.test, maxWorkers: 1, include: ['test/responsive-topics.test.tsx'], passWithNoTests: false,
  ...(changes[mutant] ? { testNamePattern: changes[mutant].target } : {}) } })
