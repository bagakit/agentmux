import { createServer } from 'vite'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const repository = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url)
const alias = ['core', 'demand', 'layout'].flatMap(name => Object.entries(JSON.parse(readFileSync(resolve(repository, 'packages', name, 'package.json'))).exports).map(([subpath, value]) => ({
  find: new RegExp('^@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1)) + '$'), replacement: resolve(repository, 'packages', name, value.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts'))
})))
alias.push({ find: 'react-dom/client', replacement: require.resolve('react-dom/profiling') })
const server = await createServer({ configFile: false, root: resolve(import.meta.dirname, 'fixtures/mote-navigation-footer'),
  resolve: { alias }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 4381, strictPort: true, fs: { allow: [repository, resolve(repository, '../agentmux')] } } })
await server.listen()
console.log('Mote avatar preview: http://127.0.0.1:4381/paperdoll.html')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
