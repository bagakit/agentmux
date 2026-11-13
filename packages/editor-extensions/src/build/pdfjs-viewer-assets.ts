import { createReadStream, cpSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import type { Plugin } from 'vite'

const directories = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const

/** PDF.js auxiliary resources use the same local base in dev, gallery and the installed app. */
export function pdfjsViewerAssets(root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))): Plugin {
  let base = '/'
  return {
    name: 'agentmux-pdfjs-viewer-assets',
    configResolved(config) { base = config.base },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let path: string
        try { path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname) } catch { next(); return }
        const prefix = `${base}pdfjs/`
        if (!path.startsWith(prefix) || (request.method !== 'GET' && request.method !== 'HEAD')) { next(); return }
        const parts = path.slice(prefix.length).split('/')
        if (!directories.some(directory => directory === parts[0]) || parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) { next(); return }
        const source = resolve(root, ...parts), within = relative(root, source)
        if (within.startsWith('..')) { next(); return }
        let size: number
        try { const facts = statSync(source); if (!facts.isFile()) { next(); return }; size = facts.size } catch { next(); return }
        if (response.destroyed) return
        response.statusCode = 200
        response.setHeader('Content-Length', size)
        const extension = extname(source)
        response.setHeader('Content-Type', extension === '.wasm' ? 'application/wasm' : extension === '.js' ? 'text/javascript' : 'application/octet-stream')
        if (request.method === 'HEAD') { response.end(); return }
        const stream = createReadStream(source)
        const stop = () => stream.destroy()
        response.once('close', stop); response.once('error', stop)
        stream.once('close', () => { response.off('close', stop); response.off('error', stop) })
        stream.once('error', () => response.destroy())
        stream.pipe(response)
      })
    },
    writeBundle(options) {
      if (!options.dir) throw new Error('PDF.js renderer output directory is required')
      for (const directory of directories) cpSync(join(root, directory), join(options.dir, 'pdfjs', directory), { recursive: true })
    }
  }
}
