const { app } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const [entry, privateRoot, ...args] = process.argv.slice(2)
app.setPath('userData', join(privateRoot, 'user-data'))
app.setPath('sessionData', join(privateRoot, 'session-data'))
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
const failed = error => { process.stderr.write(String(error?.stack ?? error) + '\n'); app.exit(1) }
process.on('uncaughtException', failed)
process.on('unhandledRejection', failed)
// Dynamic loading keeps a missing proof dependency from opening Electron's default error dialog.
process.argv.splice(1, process.argv.length - 1, entry, ...args)
import(pathToFileURL(entry).href).catch(failed)
