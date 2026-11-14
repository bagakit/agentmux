import { appendFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../vitest.config'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOBILE_WORKFACE_MUTATION ?? 'baseline', trace = process.env.MOBILE_WORKFACE_LOADED
const changes = {
  'source-ignores-primary': { file: '/src/navigation/current-workface.ts', from: "const source = !showSession && primary === 'topics' && input.sourceKind !== undefined", to: 'const source = !showSession && input.sourceKind !== undefined', target: 'actual Root Goals header and Back' },
  'directory-ignores-session': { file: '/src/navigation/current-workface.ts', from: 'directory: showSession ? null : primary, session: showSession', to: 'directory: primary, session: showSession', target: 'actual Root Agent overlay' },
  'relative-rejected': { file: '/src/topics/MobileTopicSource.tsx', from: 'openWorkspaceFile={path => { void read({ ...view.scope, path }, undefined, true) }}', to: 'openWorkspaceFile={path => { const relative = relativeTo(view.scope.directoryPath, path); if (relative !== null) void read({ ...view.scope, path: relative }, undefined, true) }}', target: 'actual App opens a Markdown workspace-relative source link' },
  'pause-hides': { file: '/src/topics/MobileTopicSource.tsx', from: 'hidden={!presentation.presented}', to: 'hidden={!presentation.observed}', target: 'keeps the presented original reader and scroll node' },
  'no-source-menu': { file: '/src/topics/MobileTopicSource.tsx', from: '<MobileHeaderMenu />', to: '', target: 'actual App opens a Markdown workspace-relative source link' },
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, server: { fs: { allow: [root, dirname(realpathSync(resolve(root, 'node_modules')))] } },
  plugins: [...(base.plugins ?? []), { name: 'mobile-workfaces-loaded-proof', enforce: 'pre', transform(input, id) {
    if (!id.endsWith('/src/navigation/current-workface.ts') && !id.endsWith('/src/MobileApp.tsx') && !id.endsWith('/src/topics/MobileTopicSource.tsx') && !id.endsWith('/test/mobile-workfaces.test.tsx') && !id.endsWith('/test/topics-source-metadata.test.tsx')) return
    let code = input
    const change = changes[mutation as keyof typeof changes]
    if (mutation !== 'baseline' && !change) throw new Error('Unknown current workface mutation.')
    if (change && id.endsWith(change.file)) {
      if (input.split(change.from).length !== 2) throw new Error('Exactly one current workface mutation anchor is required.')
      code = input.replace(change.from, change.to)
    }
    if (trace) {
      const row = { file: relative(root, id), mutation, originalSHA256: sha(input), consumedSHA256: sha(code) }
      appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
      return code + `\nimport {appendFileSync as __workfaceTrace} from 'node:fs';__workfaceTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
    }
    return code === input ? undefined : { code, map: null }
  } }], test: { ...base.test, maxWorkers: 1, include: ['test/mobile-workfaces.test.tsx', 'test/mobile-topic-source.test.tsx', 'test/mobile-topic-source-reference.test.tsx', 'test/topics-source-metadata.test.tsx'], passWithNoTests: false,
    ...(changes[mutation as keyof typeof changes] ? { testNamePattern: changes[mutation as keyof typeof changes].target } : {}) } })
