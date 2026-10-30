import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import nativeInput from './vitest.native-input.config.mts'
export default defineConfig({ ...nativeInput, cacheDir: '.local/grok-input-reliability/vitest-cache',
  plugins: [...nativeInput.plugins!, { name: 'record-loaded-connector-recovery', enforce: 'pre', transform(code, id) {
    const path = relative(nativeInput.root!, id.split('?')[0]!)
    if (process.env.AGENTMUX_NATIVE_INPUT_LOADED && path.startsWith('packages/connectors/src/') && path.endsWith('.ts')) {
      const sha256 = createHash('sha256').update(code).digest('hex')
      appendFileSync(process.env.AGENTMUX_NATIVE_INPUT_LOADED, JSON.stringify({ path, originalSHA256: sha256, sha256 }) + '\n')
    }
  } }],
  test: { ...nativeInput.test,
    include: ['packages/core/test/session-continuity-message-input.test.ts', 'packages/core/test/launch-input-contract.test.ts',
      'packages/core/test/mote-chat-diagnosis.test.ts', 'packages/connectors/test/recovery-message-ingress.test.ts'], fileParallelism: false
  }
})
