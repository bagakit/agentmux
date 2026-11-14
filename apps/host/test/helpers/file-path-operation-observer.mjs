import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const c = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { FilePathMutations, OrdinaryWorkspaceFiles } = await import(pathToFileURL(c.entry).href)
const files = new OrdinaryWorkspaceFiles({ helperPath: c.helper })
let publishCalls = 0
files.movePath = files.deletePath = async () => { publishCalls++; throw new Error('Reopened original operation must not publish') }
const owner = new FilePathMutations({ directory: c.directory, files, noteLease: work => work() })
const result = await (c.action === 'delete' ? owner.delete(c.workspace, c.input, c.context) : owner.move(c.workspace, c.input, c.context))
const history = c.historyEventId ? await new (await import('@agentmux/core/notebook-store')).AgentMuxNotebookStore().readHistoryOperation(c.historyEventId) : undefined
process.stdout.write(JSON.stringify({ result, publishCalls, pid: process.pid, ...(history ? { history } : {}) }) + '\n')
