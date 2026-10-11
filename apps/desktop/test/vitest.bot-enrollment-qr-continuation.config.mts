import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_QR_PENDING_MUTATION
if (mutation && mutation !== 'reject-polling-step') throw Error('Unknown QR pending mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/bot-enrollment-qr-continuation'),
  plugins: [{ name: 'qr-pending-actual-compiled-owner', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/connectors/dist/adapters/feishu/native-account.js') return
    let code = source
    if (mutation) {
      const anchor = " || data.next_step === 'qr_login_polling'"
      if (source.split(anchor).length !== 2) throw Error('Missing unique compiled pending-step mutation')
      code = source.replace(anchor, '')
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_QR_PENDING_LOADED) appendFileSync(process.env.AGENTMUX_QR_PENDING_LOADED, JSON.stringify({ file, compiledFileSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), originalSHA256: sha(source), sha256: sha(code), mutation: mutation ?? null }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['apps/desktop/test/connector-setup-enrollment-continuation.test.tsx'], fileParallelism: false, passWithNoTests: false }
})
