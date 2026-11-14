import base from './vitest.hook-environment.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const mutation = process.env.AGENTMUX_PI_HOOK_MUTATION
const changes: Record<string, [string, string]> = {
  'unguarded-host': ["  if (process.env.AGENTMUX_ENV !== '1' || process.env.AGENTMUX_PROVIDER_ID !== 'pi') return", ''],
  'foreign-provider': [" || process.env.AGENTMUX_PROVIDER_ID !== 'pi'", ''],
  'ambient-route': ['void sendHookReceipt(url, token, JSON.stringify({', 'void sendHookReceipt(process.env.AGENTMUX_HOOK_URL, process.env.AGENTMUX_HOOK_TOKEN, JSON.stringify({'],
  'trim-native-root': ["const override = executionEnvironmentValue(env, agentDirEnv)", "const override = executionEnvironmentValue(env, agentDirEnv)?.trim()"]
}
if (mutation && !changes[mutation]) throw Error('Unknown Pi Hook owner mutant')
const owner = resolve(import.meta.dirname, '../../providers/src/pi/provider.ts')
export default defineConfig({ ...base, cacheDir: resolve(import.meta.dirname, '../../../.local/hook-carrier/pi-vitest', mutation ?? 'positive'),
  plugins: [...(base.plugins ?? []), { name: 'pi-binding-owner', enforce: 'pre', transform(original: string, id: string) {
    if (id.split('?')[0] !== owner) return
    let code = original
    if (mutation) { const [from, to] = changes[mutation]!; if (code.split(from).length !== 2) throw Error('Pi owner mutation anchor is not unique'); code = code.replace(from, to) }
    const evidence = process.env.AGENTMUX_PI_HOOK_LOADED
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (evidence) appendFileSync(evidence, JSON.stringify({ path: owner, mutation: mutation ?? null, applied: code !== original,
      originalSHA256: hash(original), loadedSHA256: hash(code) }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['packages/core/test/providers/pi.test.ts', 'packages/core/test/providers/pi-hook-binding.test.ts',
    ...(process.env.AGENTMUX_PI_NATIVE_PACKAGE ? ['packages/core/test/providers/pi-hook-binding.native.test.ts'] : [])], testTimeout: 45_000 }
})
