import base from './vitest.hook-environment.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const mutation = process.env.AGENTMUX_HERMES_HOOK_MUTATION
const edits: Record<string, [string, string]> = {
  'no-retained-runtime': ['  retainedRuntime: true,', '  retainedRuntime: false,'],
  'allowlist-command-drift': ['({ event: eventName, command }))', "({ event: eventName, command: command + ' mismatched-native-consent' }))"],
  'no-explicit-shell': ["const command = runScopedHookCommand('hermes')", "const command = runScopedHookCommand('hermes').replace('/bin/sh -c ', '')"],
  'retire-old-declaration': ['    retainPreviousDeclarations: true,', '    retainPreviousDeclarations: false,']
}
if (mutation && !edits[mutation]) throw Error('Unknown Hermes production owner mutation: ' + mutation)
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.local/hook-carrier/hermes-vitest', mutation ?? 'positive'),
  plugins: [...base.plugins ?? [], { name: 'hermes-hook-production-owner', enforce: 'pre', transform(original, id) {
    if (relative(base.root!, id.split('?')[0]!) !== 'packages/core/src/providers/hermes.ts') return
    let code = original
    if (mutation) {
      const edit = edits[mutation]!
      if (original.split(edit[0]).length !== 2) throw Error('Expected one Hermes owner mutation anchor: ' + mutation)
      code = original.replace(edit[0], edit[1])
    }
    const path = process.env.AGENTMUX_HERMES_HOOK_LOADED
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (path) appendFileSync(path, JSON.stringify({ path: 'packages/core/src/providers/hermes.ts', mutation: mutation ?? null,
      originalSHA256: sha(original), loadedSHA256: sha(code), applied: code !== original }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['packages/core/test/providers/hermes-hook-binding.native.test.ts', 'packages/core/test/providers/hermes.test.ts'],
    passWithNoTests: false, testTimeout: 40_000, hookTimeout: 15_000 }
})
