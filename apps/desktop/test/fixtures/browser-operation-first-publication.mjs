import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { dirname } from 'node:path'

const [bundle, path, mode] = process.argv.slice(2)
const trace = []
const send = value => process.send({ ...value, pid: process.pid })
const pause = async (type, details = {}) => {
  send({ type, ...details })
  await new Promise(resolve => process.once('message', resolve))
}
const open = fs.open, link = fs.link, rename = fs.rename
let failSync = mode === 'fail-sync'
fs.open = async (...args) => {
  const handle = await open(...args)
  const candidate = String(args[0]).startsWith(`${path}.`) && String(args[0]).endsWith('.sqlite')
  if (mode === 'reserve' && args[1] === 'wx' && (candidate || args[0] === path)) {
    const close = handle.close.bind(handle)
    handle.close = async () => { await close(); await pause('reserved', { candidate: args[0] }) }
  }
  if (candidate || args[0] === dirname(path)) {
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      const kind = candidate ? 'file-sync' : 'directory-sync'
      trace.push(`${kind}:start`)
      if (candidate && failSync) {
        failSync = false
        throw Object.assign(new Error('Private first journal fsync failed'), { code: 'ENOSPC' })
      }
      await sync()
      trace.push(`${kind}:done`)
    }
  }
  return handle
}
const publish = async (operation, from, to) => {
  if (to !== path) return operation(from, to)
  if (mode === 'before-publish' || mode === 'race') await pause('before-publish', { candidate: from, trace })
  await operation(from, to)
  trace.push('published')
  if (mode === 'after-publish') await pause('after-publish', { candidate: from, trace })
}
fs.link = (from, to) => publish(link, from, to)
fs.rename = (from, to) => publish(rename, from, to)
syncBuiltinESMExports()

const { BrowserOperationFileStore, BrowserOperationJournal } = await import(bundle)
if (mode === 'read') {
  send({ type: 'read', document: await new BrowserOperationFileStore(path).load() })
} else {
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
  await journal.start({ id: 'first', browserId: 'browser', operator: { id: 'person', name: 'Person' },
    summary: 'First original operation', url: 'https://example.invalid/' })
  if (mode === 'fail-sync' || mode === 'race') {
    await pause('failed', { warning: journal.getPersistenceWarning(), live: await journal.get('first'),
      canonicalExists: await fs.stat(path).then(() => true, () => false) })
    await journal.startStep('first', { method: 'snapshot', label: 'Healthy observation after storage failure' })
  }
  send({ type: 'saved', warning: journal.getPersistenceWarning(), live: await journal.get('first'), trace })
}
process.disconnect()
