import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({
  find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
for (const name of ['demand', 'relay']) {
  const workspaceManifest = JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(workspaceManifest.exports) as [string, any][]) {
    aliases.push({ find: new RegExp('^' + (key === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      replacement: resolve(root, 'packages', name, value.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts')) })
  }
}
const clientUiManifest = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8'))
for (const [key, value] of Object.entries(clientUiManifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length) as [string, any][]) {
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
  aliases.push({ find: new RegExp('^' + name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)') + '$'),
    replacement: resolve(root, 'packages/client-ui', typeof value === 'string' ? value : value.browser).replace('*', '$1') })
}
aliases.push({ find: /^@agentmux\/layout$/, replacement: resolve(root, 'packages/core/src/spatial-layout.ts') })
const sdkRoot = resolve(root, 'packages/core/node_modules/@ctxmux/sdk')
const sdkManifest = JSON.parse(readFileSync(resolve(sdkRoot, 'package.json'), 'utf8'))
aliases.push({ find: /^@ctxmux\/sdk$/, replacement: resolve(sdkRoot, sdkManifest.exports['.'].import) })
const mutations: Record<string, [string, string, string]> = {
  'drop-fork-launch': ['packages/core/src/client.ts', 'forkSource ? provider.buildForkLaunch!({ ...launchContext, nativeHandle: forkSource.expectedNativeHandle })', 'false ? provider.buildForkLaunch!({ ...launchContext, nativeHandle: forkSource!.expectedNativeHandle })'],
  'drop-new-identity': ['packages/core/src/agent-fork.ts', 'Your current AgentMux Session ID is ${agentSessionId}', 'Your current AgentMux Session ID is inherited'],
  'disconnect-fork-space': ['apps/desktop/src/renderer/src/lib/space-agent-control.ts', "request.content.kind === 'fork-agent' ? { forkSource: request.content.source, launchOptions: forkParent!.launchOptions } : {}", 'false ? {} : {}'],
  'use-server-local-fork-route': ['apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'forkExecutionHostId = parent.hostId', 'forkExecutionHostId = forkParent.hostId'],
  'use-server-local-agent-fact': ['apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'executorId: session.executorId, hostId, cwd:', 'executorId: session.executorId, hostId: session.hostId, cwd:'],
  'drop-admitted-fork-source': ['apps/desktop/src/renderer/src/lib/space-agent-control.ts', "operation === 'agent.open' && request.content.kind === 'fork-agent' ? { forkSource: structuredClone(request.content.source) } : {}", 'false ? {} : {}']
}
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'current-fork-owning-source', enforce: 'pre',
    transform(source, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^packages\/(?:core|demand|relay|client-ui)\/src\//.test(path) && !path.startsWith('apps/desktop/src/')) return
      let code = source
      const mutation = process.env.AMX_FORK_MUTATION, change = mutation && mutations[mutation]
      if (mutation && !change) throw new Error('Unknown fork source mutation')
      if (change && path === change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Fork mutation anchor must be unique: ' + mutation)
        code = code.replace(change[1], change[2])
      }
      if (process.env.AMX_FORK_LOADED) appendFileSync(process.env.AMX_FORK_LOADED, JSON.stringify({ path,
        originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'),
        ...(code !== source ? { mutation } : {}) }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }], test: { include: ['apps/desktop/test/current-agent-fork.test.ts'], passWithNoTests: false, fileParallelism: false,
    maxWorkers: 1, testTimeout: 60000, hookTimeout: 30000 } })
