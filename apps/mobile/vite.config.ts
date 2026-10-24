import { noteParsingAliases } from '../../packages/client-ui/scripts/note-parsing-aliases'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export default defineConfig(({ command }) => {
  const buildId = randomBytes(16).toString('hex')
  return {
  base: './',
  define: command === 'build' ? { __AGENTMUX_MOBILE_BUILD_ID__: JSON.stringify(buildId) } : {},
  plugins: [react(), {
    name: 'mobile-product-csp',
    transformIndexHtml: () => command === 'build' ? [{ tag: 'meta', attrs: {
      'http-equiv': 'Content-Security-Policy',
      content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-src 'none'"
    }, injectTo: 'head-prepend' as const }] : []
  }, {
    name: 'mobile-immutable-release',
    async writeBundle(options, bundle) {
      if (command !== 'build') return
      const digest = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
      const files = Object.values(bundle).map(file => {
        const bytes = file.type === 'chunk' ? Buffer.from(file.code) : Buffer.from(file.source)
        return { path: file.fileName, bytes: bytes.length, digest: digest(bytes) }
      }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      const manifest = { schema: 'agentmux.mobile-web-release.v1', buildId, files }
      await writeFile(resolve(options.dir ?? 'dist', 'mobile-release.json'), JSON.stringify({ ...manifest, digest: digest(JSON.stringify(manifest)) }) + '\n')
    }
  }],
  resolve: { alias: noteParsingAliases, conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 4321, strictPort: true },
  preview: { host: '127.0.0.1', port: 4321, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true,
    assetsInlineLimit: filePath => /\.(woff2?|ttf|otf)$/iu.test(filePath) ? false : undefined }
}})
