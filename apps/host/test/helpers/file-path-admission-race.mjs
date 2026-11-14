import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const c = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { FilePathMutations, OrdinaryWorkspaceFiles } = await import(pathToFileURL(c.entry).href)
const files = new OrdinaryWorkspaceFiles({ helperPath: c.helper })
let nativeCalls = 0
const original = files.mkdirPath.bind(files)
files.mkdirPath = async (...args) => { nativeCalls++; return original(...args) }
const owner = new FilePathMutations({ directory: c.directory, files, noteLease: work => work() })
process.once('message', async message => {
  if (message?.type !== 'go') process.exit(2)
  try { const result = await owner.mkdir(c.workspace, c.request, c.actor); process.send?.({ type: 'result', pid: process.pid, nativeCalls, result }, () => process.exit(0)) }
  catch (error) { process.send?.({ type: 'error', pid: process.pid, nativeCalls, code: error.code, message: error.message }, () => process.exit(1)) }
})
process.send?.({ type: 'ready', pid: process.pid })
