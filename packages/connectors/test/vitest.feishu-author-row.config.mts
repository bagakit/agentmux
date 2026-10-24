import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.feishu-reply.config.mts'

const root = resolve(import.meta.dirname, '../../..'), marker = process.env.FEISHU_AUTHOR_ROW_LOADED
const mutations = {
  metadata: { before: "content: identity, text_size: 'notation', text_color: 'grey'", after: 'content: identity' },
  density: { before: "img_key: speaker.imageKey, size: '16px 16px'", after: "img_key: speaker.imageKey, size: '24px 24px'" }
}
const mutant = process.env.FEISHU_AUTHOR_ROW_MUTANT as keyof typeof mutations | undefined
if (mutant && !mutations[mutant]) throw Error('Unknown author row mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/feishu-author-row'), plugins: [
  { name: 'qualified-author-row', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let output = input
    if (mutant && path === 'packages/connectors/src/adapters/feishu/role-card.ts') {
      const mutation = mutations[mutant]
      if (input.split(mutation.before).length !== 2) throw Error('Author row mutation owner changed')
      output = input.replace(mutation.before, mutation.after)
    }
    if (!marker) return input === output ? undefined : { code: output, map: null }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, sourceSHA256: hash(input), loadedSHA256: hash(output), mutation: input === output ? null : mutant })
    return { code: "import { appendFileSync as __authorRowMark } from 'node:fs'; __authorRowMark(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
  } }, ...original.plugins!], test: { ...original.test,
    include: ['packages/connectors/test/feishu-role-card.test.ts', 'packages/connectors/test/feishu-publication.test.ts'] } })
