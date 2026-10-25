import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.reply-metadata.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.REPLY_FOOTER_LINE_MUTANT
if (mutation && mutation !== 'wrap') throw Error('Unknown footer line mutation')
const marker = process.env.REPLY_FOOTER_LINE_LOADED
export default defineConfig({ ...source, cacheDir: resolve(root, '.cache/reply-footer-one-line'),
  plugins: [...source.plugins!, { name: 'loaded-one-line-footer', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['reply-footer.ts', 'role-card.ts', 'reply-card.ts', 'publication.ts'].some(file => path === 'packages/connectors/src/adapters/feishu/' + file)) return
    let output = input
    if (mutation && path.endsWith('/reply-footer.ts')) {
      const before = "text_color: 'grey', lines: 1"
      if (input.split(before).length !== 2) throw Error('Footer line mutation owner changed')
      output = input.replace(before, "text_color: 'grey'")
    }
    if (!marker) return output === input ? undefined : { code: output, map: null }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input === output ? null : mutation })
    return { code: "import { appendFileSync as __markFooterLine } from 'node:fs'; __markFooterLine(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
  } }],
  test: { ...source.test, include: ['packages/connectors/test/feishu-reply-footer.test.ts'], passWithNoTests: false }
})
