import { noteParsingAliases } from '../../../../../packages/client-ui/scripts/note-parsing-aliases'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, relative } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import owning from '../file-save-recovery/vitest.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..'), compiled = new Map()
export default defineConfig({ root: import.meta.dirname, define: owning.define, resolve: { ...owning.resolve, alias: [...Object.entries(noteParsingAliases).map(([find, replacement]) => ({ find, replacement })), ...owning.resolve.alias.filter(entry => !entry.replacement.includes('/json-rpc-2.0/dist/index.js'))] }, ssr: { external: ['json-rpc-2.0'] }, optimizeDeps: { include: ['@agentmux/core > node-diff3', '@agentmux/core > diff'] },
  plugins: [react(), { name: 'private-original-note-host', enforce: 'post',
    transform(code, id) { const path = id.split('?')[0]; if (path.startsWith(repository + '/') && !path.includes('/node_modules/') && /\.[cm]?[jt]sx?$/.test(path)) compiled.set(relative(repository, path), { path: relative(repository, path), sourceSha256: createHash('sha256').update(readFileSync(path)).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex') }) },
    configureServer(server) {
      const listeners = new Set<any>(), ready = server.ssrLoadModule(resolve(import.meta.dirname, 'host.ts')).then(module => module.start(process.env.AGENTMUX_NOTE_FIXTURE_ROOT, event => { for (const response of listeners) response.write('data: ' + JSON.stringify(event) + '\n\n') }, { notebook: process.env.AGENTMUX_NOTE_FIXTURE_MODE === 'notebook' }))
      server.middlewares.use('/__note/events', (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); response.write(': ready\n\n'); listeners.add(response); response.on('close', () => listeners.delete(response)) })
      server.middlewares.use('/__note/invoke', async (request, response) => { try { let body = ''; for await (const chunk of request) body += chunk; const input = JSON.parse(body); const value = await (await ready).invoke(input.method, input.args); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ value })) } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: { message: String(error), code: (error as any).code } })) } })
      server.middlewares.use('/__note/source', (_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ boundary: 'Original Store/FileSurfaceView/owners and CLI; fixture HTTP/SSE replaces Electron transport; no Agent/Run claim', imports: [...compiled.values()] })) })
      server.httpServer?.once('close', () => { for (const response of listeners) response.end(); void ready.then(host => host.close()) })
    }
  }], server: { host: '127.0.0.1', port: 4209, hmr: false, strictPort: true, fs: { allow: [repository] } } })
