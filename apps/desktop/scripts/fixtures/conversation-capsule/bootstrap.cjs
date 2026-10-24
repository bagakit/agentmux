const { app } = require('electron')
const { pathToFileURL } = require('node:url')
const native = process.argv.splice(2, 1)[0]
app.setPath('userData', process.argv[3])
app.whenReady().then(() => import(pathToFileURL(native).href)).catch(error => { console.error(error); app.exit(1) })
