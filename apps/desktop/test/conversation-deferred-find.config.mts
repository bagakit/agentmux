import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_DEFERRED_FIND_MUTATION
const loaded = process.env.AGENTMUX_DEFERRED_FIND_LOADED
const edits: Record<string, [string, string, string]> = {
  'skip-current-deferred-hit': ['packages/client-ui/src/components/ReadingFind.tsx',
    'direction > 0 && before >= 0 && !matches.current[before]!.range ? 0 : direction', 'direction'],
  'skip-deferred-text': ['packages/client-ui/src/components/ConversationProgressiveBody.tsx',
    'if (!active || !reading || !node.current || !heavy) return', 'if (true) return'],
  'mount-window-on-find': ['packages/client-ui/src/components/ReadingFind.tsx',
    'if (body.presented || !readableReadingBody(body.node, root)) continue',
    'if (!body.presented) body.reveal(); if (body.presented || !readableReadingBody(body.node, root)) continue'],
  'skip-captured-payload': ['apps/desktop/src/renderer/src/components/ActivityView.tsx',
    '.log-turn__body, .log-row__prose, .conversation-tool-trace__payload, .wf-native-process__body, .log-diff__body',
    '.log-turn__body, .log-row__prose, .log-diff__body'],
  'allow-stale-owner': ['packages/client-ui/src/components/ReadingFind.tsx',
    'const current = () => active && latest.current === owner && content.current?.isConnected',
    'const current = () => active && content.current?.isConnected'],
  'search-raw-markdown': ['packages/client-ui/src/components/AgentMarkdown.tsx',
    'return () => blocks ??= markdownReadingBlocks(parse()?.blocks ?? null, content, context)', 'return () => [content]'],
  'collapsed-trace-budget': ['packages/client-ui/src/components/ConversationMessage.tsx',
    'return hasContent ? discloseBody(', 'return hasContent ? <ConversationProgressiveBody heavy={parts.some(part => part.kind === "reasoning" && part.text.length > 2000)}>{discloseBody(']
}
if (mutation && !edits[mutation]) throw Error('Unknown deferred find mutation')
export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/conversation-deferred-find-' + (mutation ?? 'base')),
  resolve: { ...base.resolve, alias: [...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : []), candidateAlias(root, { source: true, browser: true })] },
  plugins: [...base.plugins ?? [], { name: 'deferred-find-source-proof', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    const kind = !query && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'module' : 'resource'
    const edit = mutation && edits[mutation]
    let code = source
    if (edit && kind === 'module' && path === edit[0]) {
      if (source.split(edit[1]).length !== 2) throw Error('Expected one exact deferred find mutation')
      code = source.replace(edit[1], edit[2])
      if (mutation === 'collapsed-trace-budget') {
        const end = '      ) : null\n  }\n}'
        if (code.split(end).length !== 2) throw Error('Expected one original message body boundary')
        code = code.replace(end, '      )}</ConversationProgressiveBody> : null\n  }\n}')
      }
    }
    const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
    if (loaded) appendFileSync(loaded,
      JSON.stringify({ path, kind, query, fileSHA256: hash(readFileSync(actual)), originalSHA256: hash(source), loadedSHA256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/conversation-deferred-find.test.tsx', 'apps/desktop/test/reading-find.test.tsx', 'packages/client-ui/test/conversation-progressive-content.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
