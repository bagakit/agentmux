import base from './vitest.native-input.config.mjs'
import { nativeResumeSource } from './helpers/native-resume-source.js'
import { resolve } from 'node:path'
import type { UserConfig } from 'vitest/config'

const config: UserConfig = { ...base,
  cacheDir: resolve(import.meta.dirname, '../../../.local/state/conversation-native-resume/cache', process.env.AGENTMUX_NATIVE_RESUME_MUTATION ?? 'positive'),
  plugins: [{ name: 'actual-native-resume-source', enforce: 'pre' as const,
    transform(code: string, id: string) { const next = nativeResumeSource(code, id); if (next !== code) return { code: next, map: null } }
  }, ...(base.plugins ?? [])],
  test: { ...base.test, include: ['packages/core/test/native-managed-launch.test.ts'] }
}

export default config
