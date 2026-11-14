import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import original from './agent-learning.config.mts'
import coreSource from '../../../packages/core/test/a2a-resumed-inbox.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, root,
  cacheDir: resolve(root, '.local/mote-host-creation-contract/learning-cache', process.env.LEARNING_CREATION_MUTANT ?? 'original'),
  plugins: [{ name: 'learning-creation-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'apps/host/src/agent-learning-owner.ts') return
    const mutation = process.env.LEARNING_CREATION_MUTANT
    const changes = {
      'erase-created-fact': ["fail('LEARNING_CREATION_UNCONFIRMED',", "worker.state = 'retired'; fail('LEARNING_CREATION_UNCONFIRMED',"],
      'accept-uncommitted-source': ["original.kind === 'retired-agent' ? original.history?.workspacePath : undefined", "original.kind === 'retired-agent' ? original.history?.workspacePath : original.workspacePath"]
    } as const
    let loaded = source
    if (mutation) {
      if (!(mutation in changes)) throw Error('Unknown learning creation mutation')
      const [before, after] = changes[mutation as keyof typeof changes]
      if (source.split(before).length !== 2) throw Error('Missing exact learning creation mutation anchor')
      loaded = source.replace(before, after)
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const trace = process.env.LEARNING_CREATION_TRACE
    const row = { path, originalSHA256: hash(source), loadedSHA256: hash(loaded), mutation: mutation ?? null }
    return { code: (trace ? `import {appendFileSync as __creationTrace} from 'node:fs'; __creationTrace(${JSON.stringify(trace)}, JSON.stringify({...${JSON.stringify(row)},pid:process.pid})+${JSON.stringify('\n')});\n` : '') + loaded, map: null }
  } }, ...original.plugins!, ...coreSource.plugins!],
  test: { ...original.test, include: ['apps/host/test/agent-learning-creation-inspection.test.ts'], maxWorkers: 1, passWithNoTests: false }
})
