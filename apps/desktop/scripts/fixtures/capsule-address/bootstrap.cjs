const { app } = require('electron')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const native = process.argv.splice(2, 1)[0], profile = process.argv[3]
app.disableHardwareAcceleration()
for (const [name, directory] of [['home', 'home'], ['appData', 'app-data'], ['userData', 'user-data'], ['sessionData', 'session-data']]) {
  const path = join(profile, directory); mkdirSync(path, { recursive: true }); app.setPath(name, path)
}
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  return import(pathToFileURL(native).href)
}).catch(error => { console.error(error); app.exit(1) })
