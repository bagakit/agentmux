import base from './vitest.hook-environment.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const mutation = process.env.AGENTMUX_HOOK_CARRIER_MUTATION
const changes: Record<string, [string, string, string]> = {
  'volatile-shell-command': ['packages/core/src/providers/shared.ts',
    'return `/bin/sh -c ${shellQuote(script)} amux-hook`',
    'return `ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote(providerId)} ${shellQuote(process.execPath)} /private/retired-install/worker.mjs`'],
  'shell-runtime-unretained': ['packages/providers/src/gemini/provider.ts', '    retainedRuntime: true,', '    retainedRuntime: false,'],
  'native-timeout-unit': ['packages/providers/src/gemini/provider.ts', "hookCommandTimeout('gemini', 'milliseconds')", "hookCommandTimeout('gemini')"],
  'key-overwrites-callbacks': ['packages/providers/src/antigravity/provider.ts', "merge: { kind: 'json-managed-events' as const, key: 'agentmux-status' }", "merge: { kind: 'json-owned-key' as const, key: 'agentmux-status' }"],
  'forget-native-container': ['packages/core/src/hook-config-merge.ts', 'retainPrevious, strategy.key)', 'retainPrevious)'],
  'conflate-container-ownership': ['packages/core/src/managed-hook-installer.ts',
    "...(merge.kind === 'json-managed-events' && merge.key !== undefined ? { key: merge.key } : {})", '...{}']
}
if (mutation && !changes[mutation]) throw new Error('Unknown Hook carrier mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), {
  name: 'actual-hook-carrier-owner', enforce: 'pre', transform(source, id) {
    const change = mutation ? changes[mutation] : undefined
    const path = relative(base.root!, id.split('?')[0]!)
    const owners = new Set([
      ...['providers/shared', 'managed-hook-installer', 'hook-config-merge',
        ...['cursor', 'droid'].map(name => 'providers/' + name)].map(name => 'packages/core/src/' + name + '.ts'),
      ...['antigravity', 'gemini', 'copilot'].map(id => 'packages/providers/src/' + id + '/provider.ts')
    ])
    if (!owners.has(path)) return
    let code = source
    if (change && path === change[0]) {
      if (source.split(change[1]).length !== 2) throw new Error('Missing unique actual carrier owner anchor: ' + mutation)
      code = source.replace(change[1], change[2])
    }
    if (process.env.AGENTMUX_HOOK_CARRIER_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_HOOK_CARRIER_LOADED, JSON.stringify({ mutation: code !== source ? mutation : null, path, originalSHA256: sha(source), loadedSHA256: sha(code) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/hook-carrier-baseline.test.ts'], testTimeout: 60_000, hookTimeout: 30_000 } })
