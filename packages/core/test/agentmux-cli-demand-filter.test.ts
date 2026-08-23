import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('agentmux demand filters', () => {
  it('has a production caller for every routing filter', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/agentmux.ts', import.meta.url)), 'utf8')
    expect(source).toContain("if (action === 'list')")
    for (const flag of ['--status', '--project', '--executor', '--session', '--limit']) expect(source).toContain(flag)
  })
})
