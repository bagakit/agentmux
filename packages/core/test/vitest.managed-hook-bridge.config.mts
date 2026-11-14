import base from './vitest.hook-environment.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const mutation = process.env.AGENTMUX_HOOK_BRIDGE_MUTATION
const changes: Record<string, [string, string, string]> = {
  'drop-launch-mark': ['packages/core/src/providers/shared.ts', ' ${LAUNCH_SCOPED_HOOK_FLAG} "$@"', ' "$@"'],
  'borrow-foreign-provider': ['packages/core/src/providers/shared.ts',
    '|| [ "\\${AGENTMUX_PROVIDER_ID-}" != ${shellQuote(providerId)} ]', ''],
  'persist-installation-path': ['packages/core/src/providers/shared.ts',
    'return `/bin/sh -c ${shellQuote(script)} amux-hook`',
    'return `ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote(providerId)} ${shellQuote(process.execPath)} ${shellQuote(resolveCoreBinPath("agentmux-hook.js"))}`'],
  'retire-live-callback': ['packages/core/src/managed-hook-installer.ts',
    'prior?.owner?.content, plan.retainPreviousDeclarations)', 'prior?.owner?.content, false)'],
  'forget-owned-callback': ['packages/core/src/managed-hook-installer.ts',
    'prior?.owner?.content, plan.retainPreviousDeclarations)', 'undefined, plan.retainPreviousDeclarations)']
}
if (mutation && !changes[mutation]) throw new Error('Unknown Hook bridge owner mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), {
  name: 'actual-hook-bridge-owner', enforce: 'pre',
  transform(source, id) {
    const change = mutation ? changes[mutation] : undefined
    if (!change || relative(base.root!, id.split('?')[0]!) !== change[0]) return
    if (source.split(change[1]).length !== 2) throw new Error('The Hook bridge mutation anchor is not unique: ' + mutation)
    const code = source.replace(change[1], change[2])
    const receipt = process.env.AGENTMUX_HOOK_BRIDGE_MUTATION_EVIDENCE
    if (receipt) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(receipt, JSON.stringify({ mutation, path: change[0], sourceSHA256: sha(source), loadedSHA256: sha(code) }) + '\n')
    }
    return { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/managed-hook-bridge.test.ts'], testTimeout: 60_000, hookTimeout: 30_000 } })
