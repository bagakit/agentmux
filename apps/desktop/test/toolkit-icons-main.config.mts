import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import base from '../scripts/fixtures/toolkit-custom/vitest.config.mts'

export default {
  ...base,
  resolve: { ...base.resolve, conditions: ['browser', 'module', 'development|production'], alias: [
    ...(base.resolve!.alias as { find: RegExp; replacement: string }[]),
    { find: /^@agentmux\/client-ui\/theme$/, replacement: resolve(base.root!, 'packages/client-ui/src/theme/index.ts') }
  ] },
  plugins: [...(base.plugins ?? []), { name: 'toolkit-icon-public-inputs', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    const receipt = process.env.AGENTMUX_TOOLKIT_ICONS_RECEIPT
    if (!receipt || !file.startsWith('packages/') && !file.startsWith('apps/desktop/src/')) return
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    appendFileSync(receipt, JSON.stringify({ file, fileSHA256: hash(readFileSync(id.split('?')[0]!, 'utf8')),
      sourceSHA256: hash(source), consumedSHA256: hash(source) }) + '\n')
  } }],
  test: { ...base.test, maxWorkers: 1, fileParallelism: false, passWithNoTests: false,
    include: ['apps/desktop/test/toolkit-icons-main.test.ts'] }
}
