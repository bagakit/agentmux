import { noteParsingAliases } from '../../packages/client-ui/scripts/note-parsing-aliases'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), {
    name: 'mobile-product-csp',
    transformIndexHtml: (_html, context) => command === 'build' && !context.filename.endsWith('/device.html') ? [{ tag: 'meta', attrs: {
      'http-equiv': 'Content-Security-Policy',
      content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-src 'none'"
    }, injectTo: 'head-prepend' as const }] : []
  }, {
    name: 'mobile-immutable-release',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
        const describe = (path: string, source: Uint8Array | string) =>
          ({ path, bytes: Buffer.byteLength(source), digest: 'sha256:' + sha(source) })
        const index = bundle['index.html']
        if (index?.type !== 'asset') this.error('The Mobile build did not emit index.html.')
        const html = Buffer.from(index.source).toString('utf8')
        if (!html.includes('</head>')) this.error('The Mobile Web document is missing its head.')
        const buildMeta = (id: string) => `<meta name="agentmux-mobile-build" content="${id}">`
        const placeholder = buildMeta('')
        index.source = html.replace('</head>', `  ${placeholder}\n  </head>`)
        // The Web Host excludes the desktop-only document. Leave the build ID
        // empty during hashing so the rest of the emitted markup also counts.
        const output = Object.values(bundle).filter(file => file.fileName !== 'device.html')
          .map(file => describe(file.fileName, file.type === 'chunk' ? file.code : file.source))
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        const buildId = sha(JSON.stringify(output))
        index.source = index.source.replace(placeholder, buildMeta(buildId))
        const files = output.map(file => file.path === index.fileName ? describe(index.fileName, index.source) : file)
        const manifest = { schema: 'agentmux.mobile-web-release.v1', buildId, files }
        this.emitFile({ type: 'asset', fileName: 'mobile-release.json',
          source: JSON.stringify({ ...manifest, digest: 'sha256:' + sha(JSON.stringify(manifest)) }) + '\n' })
      }
    }
  }],
  resolve: { alias: noteParsingAliases, conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 4321, strictPort: true },
  preview: { host: '127.0.0.1', port: 4321, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true,
    rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), device: resolve(import.meta.dirname, 'device.html') } },
    assetsInlineLimit: filePath => /\.(woff2?|ttf|otf)$/iu.test(filePath) ? false : undefined }
}))
