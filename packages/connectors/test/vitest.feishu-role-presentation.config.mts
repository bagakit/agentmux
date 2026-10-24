import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'

const mutation = process.env.FEISHU_ROLE_MUTANT
if (mutation && mutation !== 'original-role') throw Error('Unknown role presentation mutant')
export default defineConfig({ ...native, cacheDir: resolve(native.root!, '.cache/feishu-role-presentation'),
  plugins: [...native.plugins!, { name: 'runtime-loaded-role-presentation', enforce: 'pre', transform(input, id) {
    const path = relative(native.root!, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.[cm]?ts$/u.test(path)) return
    let output = input
    if (mutation === 'original-role' && path === 'packages/connectors/src/adapters/feishu/publication.ts') {
      const before = 'incoming: originalMessage !== undefined'
      if (input.split(before).length !== 2) throw Error('Original role mutation must load once')
      output = input.replace(before, 'incoming: false')
    }
    const marker = process.env.FEISHU_ROLE_LOADED
    if (!marker) return input === output ? undefined : { code: output, map: null }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: hash(input), loadedSHA256: hash(output), mutation: input === output ? null : mutation })
    return { code: "import { appendFileSync as __roleLoaded } from 'node:fs'; __roleLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
  } }], test: { ...native.test, setupFiles: [resolve(native.root!, 'vitest.setup.ts')], include: [
    'packages/connectors/test/feishu-role-card.test.ts', 'packages/connectors/test/feishu-publication.test.ts',
    'packages/connectors/test/a2a-publication-consumer.test.ts'
  ], testTimeout: 30_000 }
})
