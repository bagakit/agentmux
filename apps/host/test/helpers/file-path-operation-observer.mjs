import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const c = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { FilePathMutations, OrdinaryWorkspaceFiles } = await import(pathToFileURL(c.entry).href)
const files = new OrdinaryWorkspaceFiles({ helperPath: c.helper })
let publishCalls = 0
files.movePath = async () => { publishCalls++; throw new Error('Reopened original operation must not publish') }
const owner = new FilePathMutations({ directory: c.directory, files, noteLease: work => work() })
const result = await owner.move(c.workspace, c.input, c.context)
process.stdout.write(JSON.stringify({ result, publishCalls }) + '\n')
