import fs from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { createReviewCatalog, root, sourceRoots } from './catalog.mjs'

const source = import.meta.dirname
const sharedStyles = Object.fromEntries(['semantic-icons', 'mote-identity'].map(name =>
  [`/${name}.css`, resolve(root, `packages/client-ui/src/styles/${name}.css`)]))
const watchedRoots = [source, ...sourceRoots.map(path => resolve(root, path))]
const relevant = file => watchedRoots.some(path => file.startsWith(path + '/'))
  && ['.ts', '.tsx', '.css', '.js', '.json'].includes(extname(file))

export function iconReviewConfig({ port = 4186, open = false, context } = {}) {
  return {
    configFile: false, root: source,
    cacheDir: resolve(root, '.local/icon-review/vite-cache'),
    server: { host: '127.0.0.1', port, strictPort: true, open, fs: { allow: [root] } },
    plugins: [{
      name: 'current-semantic-icon-catalog',
      configureServer(server) {
        // Consumers outside the page module graph still contribute source references.
        server.watcher.add(watchedRoots)
        let refresh
        server.watcher.on('all', (event, file) => {
          if (!['add', 'change', 'unlink'].includes(event) || !relevant(file)) return
          clearTimeout(refresh)
          refresh = setTimeout(() => server.ws.send({ type: 'custom', event: 'icon-review:source-change' }), 100)
        })
        server.httpServer?.once('close', () => clearTimeout(refresh))
        server.middlewares.use(async (req, res, next) => {
          const path = req.url?.split('?')[0]
          if (path !== '/catalog.json' && !Object.hasOwn(sharedStyles, path)) return next()
          res.setHeader('Cache-Control', 'no-store')
          try {
            if (Object.hasOwn(sharedStyles, path)) {
              res.setHeader('Content-Type', 'text/css')
              res.end(await fs.readFile(sharedStyles[path]))
            } else {
              const metadata = await server.ssrLoadModule(resolve(source, 'catalog-source.ts'))
              const catalog = await createReviewCatalog(metadata, { context })
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ...catalog, sourceMode: 'live' }))
            }
          } catch (error) {
            server.config.logger.error(error.stack ?? error.message)
            res.statusCode = 500
            res.end('Current icon source could not be loaded. Existing browser drafts are retained.')
          }
        })
      },
      // Use the page's guarded reload, so an unsaved in-memory draft can be exported.
      hotUpdate({ file }) { if (this.environment.name === 'client' && relevant(file)) return [] },
    }],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '4186' }, open: { type: 'boolean', default: false },
    context: { type: 'string' }, help: { type: 'boolean', default: false },
  } })
  if (values.help) {
    console.log('pnpm icons:dev [--port 4186] [--open] [--context previous/catalog.json]\nCurrent shared icon source; automatic refresh; browser-only drafts. Ctrl-C stops the server.')
  } else {
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535.')
    const server = await createServer(iconReviewConfig({ ...values, port }))
    await server.listen()
    server.printUrls()
    server.bindCLIShortcuts({ print: true })
  }
}
