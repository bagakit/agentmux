import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../scripts/fixtures/toolkit-custom/vitest.config.mts'
import { mutateDefaultShell } from '../scripts/fixtures/toolkit-default-shell/mutations.mjs'

const mutation = process.env.AGENTMUX_DEFAULT_SHELL_MUTATION
export default defineConfig({
  ...owning,
  plugins: [
    ...(owning.plugins ?? []),
    {
      name: 'toolkit-default-shell-mutation',
      enforce: 'pre',
      transform(source, id) {
        const path = relative(owning.root!, id.split('?')[0]!)
        if (path.startsWith('packages/') || path.startsWith('apps/desktop/')) {
          const hash = (value: string | Uint8Array) =>
            createHash('sha256').update(value).digest('hex')
          appendFileSync(
            resolve(process.env.AGENTMUX_TOOLKIT_EVIDENCE!, 'bindings.jsonl'),
            JSON.stringify({
              path,
              disk: hash(readFileSync(id.split('?')[0]!)),
              loaded: hash(source),
            }) + '\n',
          )
        }
        const consumed = mutateDefaultShell(source, path, mutation)
        if (consumed === source) return
        const hash = (value: string) =>
          createHash('sha256').update(value).digest('hex')
        appendFileSync(
          resolve(process.env.AGENTMUX_TOOLKIT_EVIDENCE!, 'mutation.jsonl'),
          JSON.stringify({
            mutation,
            path,
            originalSHA256: hash(source),
            consumedSHA256: hash(consumed),
          }) + '\n',
        )
        return { code: consumed, map: null }
      },
    },
  ],
  test: {
    ...owning.test,
    include:
      process.env.AGENTMUX_DEFAULT_SHELL_NATIVE === '1'
        ? ['apps/desktop/test/toolkit-default-shell-native.test.ts']
        : [
            'apps/desktop/test/toolkit-default-shell.test.ts',
            'apps/desktop/test/toolkit-tui-owner.test.ts',
            'apps/desktop/test/toolkit-tui-config.test.ts',
          ],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
