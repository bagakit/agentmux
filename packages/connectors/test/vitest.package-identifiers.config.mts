import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import original from '../../../vitest.config.ts'
import { packageIdentifierMutations, mutatePackageIdentifiers } from './helpers/identifier-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const name = process.env.AGENTMUX_PACKAGE_ID_MUTATION
const mutation = name ? packageIdentifierMutations.find(item => item.name === name) : undefined
if (name && !mutation) throw Error('Unknown package identity mutation')
const browserExports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
const clientAliases = Object.entries(browserExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).filter(([, value]) => (value as { browser?: string }).browser).map(([key, value]) => ({
  find: new RegExp('^@agentmux/client-ui' + (key === '.' ? '' : key.slice(1).replace('*', '(.*)')) + '$', 'u'),
  replacement: resolve(root, 'packages/client-ui', (value as { browser: string }).browser.replace('*', '$1'))
}))
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/package-identifiers'), esbuild: { jsx: 'automatic' }, resolve: { alias: clientAliases },
  plugins: [{ name: 'actual-package-id-source-mutation', enforce: 'pre', transform(code, id) {
    const servedPath = relative(root, id.split('?')[0]!)
    if (!/^packages\/(connectors|demand|relay)\/(src|dist)\//u.test(servedPath) || !/\.[jt]s$/u.test(servedPath)) return
    const sourcePath = servedPath.replace('/dist/src/', '/src/').replace('/dist/', '/src/').replace(/\.js$/u, '.ts')
    let source: string
    try { source = readFileSync(resolve(root, sourcePath), 'utf8') } catch { return }
    const selected = mutation?.path === sourcePath
    const changed = selected ? mutatePackageIdentifiers(source, mutation) : source
    if (process.env.AGENTMUX_PACKAGE_ID_LOADED) appendFileSync(process.env.AGENTMUX_PACKAGE_ID_LOADED, JSON.stringify({ path: sourcePath, servedPath,
      originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(changed).digest('hex'), mutation: selected ? name : null }) + '\n')
    if (selected) return { code: servedPath.includes('/dist/') ? ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText : changed, map: null }
  } }],
  test: { ...original.test, globalSetup: [], passWithNoTests: false, fileParallelism: false, include: [
    'packages/connectors/test/{connection-enrollment-public-consumer,connection-setup-configuration-consumer,connection-setup-inspection-consumer,unified-identifiers-ingress,room-provisioning-public-consumer,feishu-permission-actions,feishu-rooms,feishu-publication}.test.ts',
    'packages/demand/test/{unified-identifiers,demand-store-concurrency}.test.ts', 'packages/relay/test/local-identifiers.test.ts'
  ] }
})
