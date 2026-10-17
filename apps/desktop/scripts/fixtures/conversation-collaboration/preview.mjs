import { createServer } from 'vite'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..'), evidence = resolve(root, '.bagakit/feature-tracker/conversation-subagent-presentation')
mkdirSync(evidence, { recursive: true })
const loaded = new Map()
const server = await createServer({ configFile: false, root: import.meta.dirname,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  resolve: { conditions: ['browser', 'development', 'import', 'default'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  plugins: [{ name: 'collaboration-proof', configureServer(server) {
    server.middlewares.use('/page.json', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(readFileSync(resolve(evidence, 'provider/preview-page.json'))) })
  }, transform(code, id) { if (id.startsWith(root + '/') && !id.includes('/node_modules/') && !id.includes('?')) {
    loaded.set(relative(root, id), createHash('sha256').update(code).digest('hex'))
    writeFileSync(resolve(evidence, 'compiled-sources.json'), JSON.stringify(Object.fromEntries(loaded), null, 2))
  } } }] })
await server.listen(); const url = server.resolvedUrls.local[0]
writeFileSync(resolve(evidence, 'preview-server.json'), JSON.stringify({ url, pid: process.pid })); console.log(url)
