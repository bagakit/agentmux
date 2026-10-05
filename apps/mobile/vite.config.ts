import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), {
    name: 'mobile-product-csp',
    transformIndexHtml: () => command === 'build' ? [{ tag: 'meta', attrs: {
      'http-equiv': 'Content-Security-Policy',
      content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-src 'none'"
    }, injectTo: 'head-prepend' as const }] : []
  }],
  resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 4321, strictPort: true },
  preview: { host: '127.0.0.1', port: 4321, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true,
    assetsInlineLimit: filePath => /\.(woff2?|ttf|otf)$/iu.test(filePath) ? false : undefined }
}))
