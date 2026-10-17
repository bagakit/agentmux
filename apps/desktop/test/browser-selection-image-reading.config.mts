import base from './browser-contextual-composer.config.mts'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), ui = resolve(root, 'packages/client-ui')
const exports = JSON.parse(readFileSync(resolve(ui, 'package.json'), 'utf8')).exports
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const aliases = Object.entries(exports).sort(([left], [right]) => Number(left.includes('*')) - Number(right.includes('*')) || right.length - left.length).flatMap(([key, target]) => {
  const browser = typeof target === 'object' && target !== null ? (target as { browser?: string }).browser : undefined
  if (!browser) return []
  const specifier = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
  return [{ find: new RegExp('^' + specifier.split('*').map(escape).join('(.+)') + '$'), replacement: resolve(ui, browser).replace('*', '$1') }]
})
const mutations = {
  disclosure: ['packages/client-ui/src/components/ConversationBrowserContext.tsx', 'expanded && visible &&', 'true && visible &&'],
  readonly: ['packages/client-ui/src/components/ConversationBrowserContext.tsx', '(!readOnly || readOnlyImages)', 'true'],
  reference: ['apps/desktop/src/renderer/src/components/BrowserSelectionImage.tsx', '[hostId, path, mimeType, sha256, width, height]', '[path]']
} as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, cacheDir: resolve(root, '.tmp/browser-selection-image-reading/cache'),
  resolve: { ...base.resolve, alias: [...aliases, ...base.resolve!.alias as { find: RegExp; replacement: string }[],
    { find: /^@agentmux\/identity$/, replacement: resolve(root, 'packages/identity/src/index.ts') }] },
  plugins: [{ name: 'exact-selection-reading-inputs', enforce: 'pre' as const, transform(code: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/client-ui/') && !path.startsWith('apps/desktop/src/') && !path.startsWith('apps/desktop/test/')) return
    let served = code
    const mutation = process.env.AGENTMUX_SELECTION_READING_MUTATION as keyof typeof mutations | undefined
    if (mutation) {
      if (!mutations[mutation]) throw new Error('Unknown selection reading mutation')
      const [file, from, to] = mutations[mutation]
      if (path === file) {
        if (code.split(from).length !== 2) throw new Error('The exact selected production target must occur once')
        served = code.replace(from, to)
      }
    }
    if (process.env.AGENTMUX_SELECTION_READING_INPUTS) appendFileSync(process.env.AGENTMUX_SELECTION_READING_INPUTS,
      JSON.stringify({ path, source: sha(code), served: sha(served), mutated: served !== code }) + '\n')
    return served === code ? undefined : { code: served, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/browser-selection-image-reading.test.tsx',
    'packages/client-ui/test/conversation-browser-context.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
}
