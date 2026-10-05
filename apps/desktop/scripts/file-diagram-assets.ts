import { createReadStream, cpSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { Plugin, UserConfig } from 'vite'
import { localizeExcalidrawFontUrls } from './excalidraw-local-fonts'

/** Fixed official assets are local in both development and the installed private renderer. */
export function fileDiagramAssets(desktopRoot: string): Plugin {
  const require = createRequire(import.meta.url)
  const plantuml = dirname(require.resolve('@plantuml/core/package.json'))
  const excalidrawFonts = join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts')
  const roots = [
    { prefix: 'diagram-assets/drawio/', root: resolve(desktopRoot, 'vendor/drawio/v32.4.1') },
    { prefix: 'diagram-assets/plantuml/', root: plantuml, files: ['viz-global.js', 'plantuml.js', 'themes.js', 'emoji.js', 'openiconic.js', 'LICENSE'] },
    { prefix: 'excalidraw-assets/fonts/', root: excalidrawFonts }
  ]
  let base = '/'
  // Dev dependency optimization runs before normal Vite transforms. Apply the
  // same pinned change there, without excluding Excalidraw's CommonJS dependencies.
  const optimizeDeps: UserConfig['optimizeDeps'] = { esbuildOptions: { plugins: [{
    name: 'agentmux-local-excalidraw-fonts',
    setup(build) {
      build.onLoad({ filter: /[/\\]@excalidraw[/\\]excalidraw[/\\]dist[/\\](?:dev|prod)[/\\][^/\\]+\.js$/ }, async ({ path }) => {
        const contents = localizeExcalidrawFontUrls(readFileSync(path, 'utf8'), path)
        return contents === undefined ? undefined : { contents, loader: 'js' }
      })
    }
  }] } }
  return {
    name: 'agentmux-file-diagram-assets',
    enforce: 'pre',
    config: () => ({ optimizeDeps }),
    transform: localizeExcalidrawFontUrls,
    configResolved(config) { base = config.base },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let path: string
        try { path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname) } catch { next(); return }
        const resource = roots.find(item => path.startsWith(`${base}${item.prefix}`))
        if (!resource || !['GET', 'HEAD'].includes(request.method ?? '')) { next(); return }
        const parts = path.slice(`${base}${resource.prefix}`.length).split('/')
        if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) || resource.files && !resource.files.includes(parts.join('/'))) { response.writeHead(404).end(); return }
        const source = resolve(resource.root, ...parts), within = relative(resource.root, source)
        if (within === '..' || within.startsWith(`..${sep}`) || within.startsWith(sep)) { response.writeHead(404).end(); return }
        let size: number
        try { const facts = statSync(source); if (!facts.isFile()) throw new Error('Not a file'); size = facts.size } catch { response.writeHead(404).end(); return }
        const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2', '.xml': 'application/xml' }
        response.setHeader('Content-Type', mime[extname(source)] ?? 'application/octet-stream')
        response.setHeader('Content-Length', size)
        if (request.method === 'HEAD') { response.end(); return }
        const stream = createReadStream(source), stop = () => stream.destroy()
        response.once('close', stop); response.once('error', stop)
        stream.once('close', () => { response.off('close', stop); response.off('error', stop) })
        stream.once('error', () => response.destroy())
        stream.pipe(response)
      })
    },
    writeBundle(options) {
      if (!options.dir) throw new Error('Diagram renderer output directory is required.')
      for (const item of roots) {
        const destination = join(options.dir, item.prefix)
        mkdirSync(destination, { recursive: true })
        if (item.files) for (const file of item.files) cpSync(join(item.root, file), join(destination, file), { recursive: true })
        else cpSync(item.root, destination, { recursive: true })
      }
    }
  }
}
