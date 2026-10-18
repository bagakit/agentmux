import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_DELETION_MUTATION
if (mutation && !['delete-neighbour', 'skip-revalidation'].includes(mutation)) throw Error('Unknown identity removal mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/connection-deletion'),
  plugins: [{ name: 'local-identity-removal-counterexample', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/connectors/src/connection-host.ts') return
    const anchor = ".prepare('DELETE FROM connection_configuration WHERE connection_id=? AND revision=?').run(input.connectionId, input.expectedRevision)"
    let code = source
    if (mutation === 'skip-revalidation') {
      const check = 'await context?.assertCurrent?.()'
      if (source.split(check).length !== 2) throw Error('Actual deletion authorization changed')
      code = source.replace(check, '')
    } else if (mutation) {
      if (source.split(anchor).length !== 2) throw Error('The actual identity-removal owner changed; update this counterexample')
      code = source.replace(anchor, anchor.replace('run(input.connectionId,', "run('second-bot',"))
    }
    if (process.env.AGENTMUX_DELETION_LOADED) {
      const digest = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AGENTMUX_DELETION_LOADED, JSON.stringify({ file, originalSha256: digest(source), loadedSha256: digest(code), mutation: mutation ?? null }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...original.test, include: ['packages/connectors/test/connection-deletion-consumer.test.ts'], passWithNoTests: false, fileParallelism: false }
})
