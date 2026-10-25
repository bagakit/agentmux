import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_CURRENT_CODEX_MUTATION
if (mutation && !['restore-old-version'].includes(mutation)) throw new Error('Unknown prompt carrier mutation')
export default defineConfig({ root,
  cacheDir: resolve(root, '.local/channel-current-session-regression/codex-current-carrier/cache', mutation ?? 'candidate'),
  plugins: [{ name: 'prompt-carrier-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const original = code
    if (mutation === 'restore-old-version' && path === 'packages/core/src/providers/codex-native-queue.ts') {
      const anchor = "!['codex-cli 0.163.0', 'codex-cli 0.165.0'].includes(version.stdout.trim())"
      if (code.split(anchor).length !== 2) throw new Error('Version qualification mutation needs one actual owner anchor')
      code = code.replace(anchor, "version.stdout.trim() !== 'codex-cli 0.163.0'")
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_CURRENT_CODEX_LOADED) appendFileSync(process.env.AGENTMUX_CURRENT_CODEX_LOADED,
      JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original === code ? {} : { mutation }) }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { environment: 'node', globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/codex-current-carrier-native.test.ts'], testTimeout: 90_000 }
})
