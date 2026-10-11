import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const dialog = require.resolve('@radix-ui/react-dialog')
const scroll = createRequire(dialog).resolve('react-remove-scroll')
const bar = createRequire(scroll).resolve('react-remove-scroll-bar')
const singleton = createRequire(scroll).resolve('react-style-singleton')
const mutation = process.env.MODAL_DOCUMENT_SCROLL_MUTATION
const mutations = {
  'global-scroll-document': {
    file: '/react-remove-scroll/dist/es2015/SideEffect.js',
    needle: 'var ownerDocument = props.ownerDocument || (props.lockRef.current && props.lockRef.current.ownerDocument) || globalThis.document;',
    replacement: 'var ownerDocument = globalThis.document;',
  },
  'global-stylesheet-document': {
    file: '/react-style-singleton/dist/es2015/singleton.js',
    needle: 'ownerDocument = ownerDocument || globalThis.document;',
    replacement: 'ownerDocument = globalThis.document;',
  },
} as const
if (mutation) assert.ok(mutation in mutations, 'Unknown actual document scroll mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')

export default defineConfig({
  root,
  resolve: { alias: [
    { find: /^react$/, replacement: resolve(root, 'packages/client-ui/node_modules/react') },
    { find: /^react-dom$/, replacement: resolve(root, 'packages/client-ui/node_modules/react-dom') },
    // Exercise the installed packages' published ESM entries so private transforms
    // reach the real dependency owner rather than an uninstrumented require().
    { find: /^@radix-ui\/react-dialog$/, replacement: dialog.replace('/dist/index.js', '/dist/index.mjs') },
    ...[['react-remove-scroll', scroll], ['react-remove-scroll-bar', bar], ['react-style-singleton', singleton]].map(([name, path]) => ({
      find: new RegExp(`^${name}$`), replacement: path!.replace('/dist/es5/index.js', '/dist/es2015/index.js'),
    })),
  ] },
  plugins: [{ name: 'actual-document-scroll-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    const selected = mutations[mutation as keyof typeof mutations]
    if (!id.split('?')[0]!.endsWith(selected.file)) return
    const count = source.split(selected.needle).length - 1
    assert.equal(count, mutation === 'global-stylesheet-document' ? 2 : 1, 'Actual installed dependency mutation anchor must match')
    const changed = source.split(selected.needle).join(selected.replacement)
    const receipt = { mutation, file: id, occurrences: count, source: hash(source), changed: hash(changed),
      inputHashes: Object.fromEntries(['packages/client-ui/test/modal-document-scroll.config.mts', 'packages/client-ui/test/modal-document-scroll.test.tsx'].map(file => [file, hash(readFileSync(resolve(root, file), 'utf8'))])) }
    if (process.env.MODAL_DOCUMENT_SCROLL_HITS) appendFileSync(process.env.MODAL_DOCUMENT_SCROLL_HITS, JSON.stringify(receipt) + '\n')
    return changed
  } }],
  test: {
    include: ['packages/client-ui/test/modal-document-scroll.test.tsx'],
    environment: 'happy-dom', globals: false,
    server: { deps: { inline: [/@radix-ui\/react-dialog/, /react-remove-scroll/, /react-style-singleton/] } },
  },
})
