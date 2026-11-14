import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_CURRENT_CODEX_MUTATION
if (mutation && !['restore-old-version'].includes(mutation)) throw new Error('Unknown prompt carrier mutation')
export default defineConfig({ root,
  resolve: { alias: { '@agentmux/providers/codex/native-queue': resolve(root, 'packages/providers/src/codex/native-queue.ts') } },
  cacheDir: resolve(root, '.local/channel-current-session-regression/codex-current-carrier/cache', mutation ?? 'candidate'),
  plugins: [{ name: 'prompt-carrier-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('packages/core/src/') && !path.startsWith('packages/providers/src/')) || !path.endsWith('.ts')) return
    const original = code
    if (mutation === 'restore-old-version' && path === 'packages/providers/src/codex/native-queue.ts') {
      const anchor = "    await assertFile(executable)\n"
      if (code.split(anchor).length !== 2) throw new Error('Version qualification mutation needs one actual owner anchor')
      code = code.replace(anchor, anchor + "    if ((await import('node:child_process')).execFileSync(executable.path, ['--version'], { encoding: 'utf8', signal }).trim() !== 'codex-cli 0.163.0') throw unavailable()\n")
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_CURRENT_CODEX_LOADED) appendFileSync(process.env.AGENTMUX_CURRENT_CODEX_LOADED,
      JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original === code ? {} : { mutation }) }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { environment: 'node', globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/codex-current-carrier-native.test.ts'], testTimeout: 90_000 }
})
