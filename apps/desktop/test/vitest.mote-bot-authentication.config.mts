import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_MOTE_AUTHENTICATION_MUTATION
if (mutation && mutation !== 'stop-authentication-driving') throw Error('Unknown Mote authentication mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/mote-bot-authentication'),
  plugins: [{ name: 'mote-authentication-actual-renderer-consumer', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'apps/desktop/src/renderer/src/lib/use-mote-bot-setup.ts') return
    let code = source
    if (mutation) {
      const anchor = 'if (!driving || !selectedId || busy.includes(selectedId) || enrollmentView?.parentId !== selectedId) return'
      if (source.split(anchor).length !== 2) throw Error('Missing unique original Mote authentication driver')
      code = source.replace(anchor, 'if (true) return')
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_MOTE_AUTHENTICATION_LOADED)
      appendFileSync(process.env.AGENTMUX_MOTE_AUTHENTICATION_LOADED, JSON.stringify({ file,
        sourceFileSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), originalSHA256: sha(source),
        sha256: sha(code), mutation: mutation ?? null }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['apps/desktop/test/mote-bot-authentication-continuation.test.tsx'], fileParallelism: false, passWithNoTests: false }
})
