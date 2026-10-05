import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store.js'
import { ConfigOwner } from '../../../src/main/config-owner.js'
import { GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
const directory = process.env.AGENTMUX_THEME_PROOF_DATA!
const site = resolve(process.env.AGENTMUX_THEME_PROOF_SITE!)
await mkdir(directory, { recursive: true })
const configPath = join(directory, 'config.json')
try { await readFile(configPath) } catch (cause) {
  if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.owner-proof'; custom.name = 'Owner proof'
  custom.description = 'Private proof of the original settings and runtime consumer.'
  custom.variants.dark.colors.surface0 = '#20354a'; custom.variants.light.colors.surface0 = '#faeed1'
  await writeFile(configPath, JSON.stringify({ ...DEFAULT_CONFIG,
    workspaces: [{ id: 'workspace-demo', name: 'Theme workbench', hostId: 'local', kind: 'folder', path: join(directory, 'workspace') }],
    appearance: { ...DEFAULT_CONFIG.appearance, customThemes: { [custom.id]: themeValue(custom) } } }))
}
const store = new ConfigStore(configPath)
let current = await store.get()
const owner = new ConfigOwner({ read: () => current, save: value => store.save(value), publish: value => { current = value } })
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/proof-config') {
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST') {
        const parts = []; for await (const chunk of request) parts.push(chunk)
        const { next, expected } = JSON.parse(Buffer.concat(parts).toString('utf8'))
        const saved = await owner.edit(expected, next)
        response.end(JSON.stringify(saved)); return
      }
      response.end(JSON.stringify(await owner.inspect(value => value))); return
    }
    const name = decodeURIComponent(new URL(request.url!, 'http://127.0.0.1').pathname)
    const path = resolve(site, '.' + (name === '/' ? '/index.html' : name))
    if (!path.startsWith(site + '/')) { response.writeHead(403); response.end(); return }
    response.setHeader('content-type', mime[extname(path)] ?? 'application/octet-stream')
    response.end(await readFile(path))
  } catch (cause) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) })) }
})
server.listen(Number(process.env.AGENTMUX_THEME_PROOF_PORT ?? 4282), '127.0.0.1', () => console.log(JSON.stringify({ ready: true, configPath, site })))
