import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it.runIf(process.platform === 'darwin')('staging merges directory contents and keeps executable files and relative links independent', async () => {
  const scriptPath = process.env.AGENTMUX_PACKAGE_STAGING_SOURCE ?? resolve(import.meta.dirname, '../scripts/package-macos.mjs')
  const source = ts.createSourceFile(scriptPath, await readFile(scriptPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const functions = ['run', 'copyDirectoryContents'].map(name => {
    const declarations = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    expect(declarations, `Execute the actual packaging owner ${name}`).toHaveLength(1)
    return declarations[0]!.getText(source)
  })
  const copy = new Function('spawn', 'sep', functions.join('\n') + '\nreturn copyDirectoryContents;')(spawn, sep) as
    (source: string, destination: string) => Promise<void>
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-staging-copy-'))
  try {
    const original = join(temporary, 'original'), staged = join(temporary, 'staged')
    await mkdir(join(original, 'nested'), { recursive: true })
    await writeFile(join(original, 'nested', 'tool'), 'original executable')
    await chmod(join(original, 'nested', 'tool'), 0o755)
    await writeFile(join(original, '.metadata'), 'hidden metadata')
    await symlink('nested/tool', join(original, 'tool'))
    await copy(original, staged)
    await expect(readFile(join(staged, '.metadata'), 'utf8')).resolves.toBe('hidden metadata')
    await expect(readlink(join(staged, 'tool'))).resolves.toBe('nested/tool')
    expect((await lstat(join(staged, 'nested', 'tool'))).mode & 0o111).toBe(0o111)
    expect((await lstat(join(staged, 'nested', 'tool'))).ino).not.toBe((await lstat(join(original, 'nested', 'tool'))).ino)
    await writeFile(join(staged, 'retained'), 'already staged')
    await writeFile(join(original, 'nested', 'tool'), 'updated source')
    await copy(original, staged)
    await expect(readFile(join(staged, 'nested', 'tool'), 'utf8')).resolves.toBe('updated source')
    await expect(readFile(join(staged, 'retained'), 'utf8')).resolves.toBe('already staged')
    await expect(lstat(join(staged, 'original'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(staged, 'nested', 'tool'), 'signed candidate')
    await expect(readFile(join(original, 'nested', 'tool'), 'utf8')).resolves.toBe('updated source')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
