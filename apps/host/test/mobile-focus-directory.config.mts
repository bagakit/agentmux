import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { instrumentFocusDirectorySource } from './mobile-focus-directory-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const aliases = ['core', 'client-ui', 'identity', 'relay'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), 'utf8'))
  return Object.entries(manifest.exports).flatMap(([key, entry]: [string, any]) => {
    let source = typeof entry === 'string' ? entry : entry.browser ?? entry.types
    if (typeof source !== 'string') return []
    if (source.startsWith('./dist/')) source = source.replace('./dist/', './src/').replace(/\.d\.ts$/u, '.ts')
    const find = `@agentmux/${name}${key === '.' ? '' : key.slice(1)}`
    const replacement = resolve(root, `packages/${name}`, source)
    return !source.includes('*') && !existsSync(replacement) ? [] : [{ find, replacement }]
  })
}).sort((a, b) => b.find.length - a.find.length).map(value => value.find.includes('*') ? {
  find: new RegExp('^' + value.find.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(.+)') + '$', 'u'),
  replacement: value.replacement.replace('*', '$1')
} : { find: new RegExp('^' + value.find.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$', 'u'), replacement: value.replacement })

export default defineConfig({ root,
  plugins: [{ name: 'evaluated-focus-directory-owner', enforce: 'pre', transform(source, id) {
    const value = instrumentFocusDirectorySource(source, relative(root, id.split('?')[0]!))
    return source === value ? null : { code: value, map: null }
  } }], esbuild: { jsx: 'automatic' },
  resolve: { alias: [...aliases, { find: 'react-dom', replacement: resolve(root, 'apps/mobile/node_modules/react-dom') },
    { find: 'react', replacement: resolve(root, 'apps/mobile/node_modules/react') }] },
  test: { include: ['apps/host/test/mobile-focus-directory.test.tsx'], environment: 'happy-dom',
    setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts')], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, restoreMocks: true, testTimeout: 20000 }
})
