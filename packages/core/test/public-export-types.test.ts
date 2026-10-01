import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('compiles the complete public Core export graph without Node ambient types or skipped declarations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-public-types-'))
  try {
    const consumer = join(directory, 'consumer.mts')
    await writeFile(consumer, `import * as core from '@agentmux/core'
const publicApi = core
const subscribe: typeof core.subscribeAgentMuxToolkit = publicApi.subscribeAgentMuxToolkit
type ToolkitWatchRequest = Parameters<typeof subscribe>[0]
type ToolkitWatchHandlers = Parameters<typeof subscribe>[1]
declare const request: ToolkitWatchRequest
declare const handlers: ToolkitWatchHandlers
void subscribe(request, handlers)
`)
    const program = ts.createProgram([consumer], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
      skipLibCheck: false,
      paths: { '@agentmux/core': [resolve(import.meta.dirname, '../dist/index.d.ts')] }
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
