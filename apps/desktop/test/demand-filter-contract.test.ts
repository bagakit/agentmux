import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Demand filter contract', () => {
  it('keeps status, project, executor, and session filters on the CLI path', async () => {
    const source = await readFile(fileURLToPath(new URL('../../../packages/core/src/agentmux.ts', import.meta.url)), 'utf8')
    for (const flag of ['--status', '--project', '--executor', '--session', '--limit']) expect(source).toContain(flag)
  })
})
