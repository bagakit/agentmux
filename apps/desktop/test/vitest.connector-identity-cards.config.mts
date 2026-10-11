import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_ENROLLMENT_METADATA_MUTATION
if (mutation && mutation !== 'probe-vault-on-list') throw Error('Unknown enrollment metadata mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/connector-identity-cards'),
  plugins: [{ name: 'enrollment-metadata-actual-compiled-owner', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/connectors/dist/connection-enrollment.js') return
    let code = source
    if (mutation) {
      const anchor = 'const available = !!this.options.secrets;'
      if (source.split(anchor).length !== 2) throw Error('Missing unique compiled metadata availability choice')
      code = source.replace(anchor, 'let available = true; try { await this.secure() } catch { available = false }')
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_ENROLLMENT_METADATA_LOADED) appendFileSync(process.env.AGENTMUX_ENROLLMENT_METADATA_LOADED,
      JSON.stringify({ file, compiledFileSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), originalSHA256: sha(source), sha256: sha(code), mutation: mutation ?? null }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/connection-enrollment-metadata-consumer.test.ts'], fileParallelism: false, passWithNoTests: false }
})
