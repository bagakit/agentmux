import { appendFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../vitest.config'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.TOPICS_NAVIGATION_MUTATION ?? 'baseline', trace = process.env.TOPICS_NAVIGATION_LOADED
const changes: Record<string, { file: string; from: string; to: string; target: string }> = {
  'sticky-source': { file: '/src/topics/topics-navigation.ts', from: 'const active = visit({ ...state, sources: sourcesForTarget(state, intent.scope), context:', to: 'const active = visit({ ...state, sources: state.sources, context:', target: 'actual App leaves original Source A' },
  'forget-scope': { file: '/src/topics/topics-navigation.ts', from: "case 'mode': return visit({ ...state,", to: "case 'mode': return visit({ ...state, positions: new Map(state.positions).set(intent.scope, emptyKnowledgePosition()),", target: 'retains canonical positions for every visited scope' },
  'metadata-navigates': { file: '/src/topics/topics-navigation.ts', from: '  if (observation.type === \'source-content\') {', to: "  if (observation.type === 'draft-key') return { ...state, context: { ...state.context, topicId: observation.scope, mode: 'knowledge' } }\n  if (observation.type === 'source-content') {", target: 'late original metadata cannot navigate' },
  'late-save-body': { file: '/src/topics/MobileTopicKnowledge.tsx', from: 'if (target?.topicId === entry.topicId && target.entryId === entry.entryId) setBody', to: 'setBody', target: 'keeps already confirmed B readable' },
  'null-origin': { file: '/src/topics/topics-navigation.ts', from: 'originFrame ? originFrame.origin.topicId : route.knowledge.topicId', to: 'originFrame?.origin.topicId ?? route.knowledge.topicId', target: 'restores an existing All Topics source origin' },
  'old-source-frame': { file: '/src/topics/topics-navigation.ts', from: 'frame.token !== observation.frameToken || ', to: '', target: 'actual App rejects a delayed original Source trail' },
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, server: { fs: { allow: [root, dirname(realpathSync(resolve(root, 'node_modules')))] } },
  plugins: [...(base.plugins ?? []), { name: 'topics-navigation-loaded-proof', enforce: 'pre', transform(input, id) {
    if (!/\/src\/topics\/(topics-navigation\.ts|use-topics-navigation\.ts|MobileTopicsSurface\.tsx|MobileTopicKnowledge\.tsx|MobileTopicSource\.tsx)$/.test(id)
      && !id.endsWith('/src/MobileApp.tsx') && !id.endsWith('/test/responsive-topics.test.tsx') && !id.endsWith('/test/topics-navigation.test.tsx') && !id.endsWith('/test/topics-source-metadata.test.tsx')) return
    const change = changes[mutation]
    if (mutation !== 'baseline' && !change) throw new Error('Unknown Topics navigation mutation.')
    let code = input
    if (change && id.endsWith(change.file)) {
      if (input.split(change.from).length !== 2) throw new Error('Exactly one current navigation mutation anchor is required.')
      code = input.replace(change.from, change.to)
    }
    if (trace) {
      const row = { file: relative(root, id), mutation, originalSHA256: hash(input), consumedSHA256: hash(code) }
      appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
      return code + `\nimport {appendFileSync as __topicsTrace} from 'node:fs';__topicsTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
    }
    return input === code ? undefined : { code, map: null }
  } }],
  test: { ...base.test, maxWorkers: 1, include: process.env.TOPICS_NAVIGATION_REGRESSION ? ['test/responsive-topics.test.tsx', 'test/responsive-source-loading.test.tsx', 'test/mobile-topics.test.tsx', 'test/mobile-topics-tree.test.tsx', 'test/mobile-topic-directory-input.test.tsx', 'test/mobile-knowledge-input.test.tsx', 'test/mobile-knowledge-owner.test.tsx', 'test/mobile-topics-route.test.tsx', 'test/mobile-content-route.test.tsx', 'test/mobile-topic-source-reference.test.tsx', 'test/topics-navigation.test.tsx', 'test/topics-source-metadata.test.tsx'] : ['test/topics-navigation.test.tsx', 'test/topics-source-metadata.test.tsx'], passWithNoTests: false,
    ...(changes[mutation] ? { testNamePattern: changes[mutation].target } : {}) } })
