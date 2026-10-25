import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const source = await readFile(new URL('../scripts/measure-desktop-resources.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('measure-desktop-resources.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const readers = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === 'ownedDaemonPids')
if (readers.length !== 1) throw new Error('Expected the original private cleanup reader')

it.each(['original socket', 'another socket'])('bases private cleanup on its exact process scope with %s and no product receipt prerequisite', async shape => {
  const runtimeDirectory = fixturePath('receipt-cleanup/runtime'), daemonPath = fixturePath('receipt-cleanup/core/bin/ctxmuxd')
  const socketPath = join(runtimeDirectory, 'ctxmux.sock'), stateDirectory = join(runtimeDirectory, 'state/ctxmux')
  const readReceipt = vi.fn(async () => { throw new Error('Unrelated stale receipt cannot block private cleanup') })
  const execFileAsync = vi.fn(async (program: string) => ({ stdout: program.endsWith('lsof')
    ? `p101\ncctxmuxd\nn${shape === 'original socket' ? socketPath : fixturePath('other/runtime/ctxmux.sock')}\n`
    : [daemonPath, '--socket', socketPath, '--state-dir', stateDirectory, '--readiness-fd', '3'].join(' ') }))
  const reader = new Function('execFileAsync', 'readFile', 'join', 'runtimeDirectory', 'daemonPath', 'socketPath', 'stateDirectory',
    readers[0]!.getText(ast) + '\nreturn ownedDaemonPids')(execFileAsync, readReceipt, join, runtimeDirectory, daemonPath, socketPath, stateDirectory)
  expect(await reader()).toEqual(shape === 'original socket' ? [101] : [])
  expect(readReceipt).not.toHaveBeenCalled()
})
