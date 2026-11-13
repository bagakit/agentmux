import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; before: string; after: string }> = {
  owner: { file: '/packages/core/src/public-rpc-service.ts', before: 'this.ports.images ? await this.ports.images.call', after: 'false ? await this.ports.images.call' },
  authority: { file: '/packages/core/src/public-rpc-service.ts', before: "throw new AgentMuxError('Image operations require an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')", after: 'void 0' },
  host: { file: '/packages/core/src/public-rpc-image.ts', before: 'if (p.hostId !== input.hostId)', after: 'if (false)' },
  operation: { file: '/packages/core/src/public-rpc-image.ts', before: 'operation.operationId !== input.operationId', after: 'false' },
  png: { file: '/packages/core/src/public-rpc-image.ts', before: 'if (image.scale !== 1)', after: 'if (false)' },
  origin: { file: '/packages/core/src/public-rpc-image.ts', before: "!((o.width as number) > 0 && (o.height as number) > 0)", after: 'false' }
}
const selected = process.env.IMAGE_PUBLIC_MUTATION
const mutation = selected ? mutations[selected] : undefined
if (selected && !mutation) throw new Error('Unknown image public mutation')
export default defineConfig({ root,
  plugins: mutation ? [{ name: 'image-public-behavior-mutation', enforce: 'pre', async load(id) {
    if (!id.endsWith(mutation.file)) return
    const source = await readFile(id, 'utf8')
    if (source.split(mutation.before).length !== 2) throw new Error('Image mutation anchor must be unique')
    const changed = source.replace(mutation.before, mutation.after), prefix = process.env.IMAGE_PUBLIC_LOAD_PREFIX
    if (prefix) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      await writeFile(prefix + '-source.txt', source); await writeFile(prefix + '-mutated.txt', changed)
      await writeFile(prefix + '-load.json', JSON.stringify({ mutation: selected, file: mutation.file.slice(1), sourceSha256: hash(source), mutatedSha256: hash(changed) }) + '\n')
    }
    return changed
  } }] : [],
  test: { include: ['packages/core/test/image-public.test.ts'], environment: 'node', maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
