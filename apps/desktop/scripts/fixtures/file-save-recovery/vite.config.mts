import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import owning from './vitest.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
const compiled = new Map<string, { path: string; sourceSha256: string; transformedSha256: string }>()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  root: import.meta.dirname, define: owning.define, resolve: owning.resolve,
  plugins: [react(), { name: 'file-save-source-receipt', enforce: 'post',
    transform(code, id) {
      const path = id.split('?')[0]
      if (!path.startsWith(repository + '/') || path.includes('/node_modules/') || !/(\.[cm]?[jt]sx?|\.css)$/.test(path)) return
      compiled.set(relative(repository, path), { path: relative(repository, path), sourceSha256: hash(readFileSync(path)), transformedSha256: hash(code) })
    },
    configureServer(server) { server.middlewares.use('/__file_source_receipt', (_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ boundary: 'Candidate Source transformed for the original FileSurfaceView and Monaco; controlled files API, no native Run claim', compiledImports: [...compiled.values()] }))
    }) }
  }],
  server: { host: '127.0.0.1', port: 4198, strictPort: true, fs: { allow: [repository] } }
})
