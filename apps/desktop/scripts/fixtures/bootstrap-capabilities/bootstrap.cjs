// Only the private launch paths and test observations are added. Production Main
// registers every IPC handler, CoreServer owner and Renderer without substitution.
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const root = process.env.AGENTMUX_BOOTSTRAP_PRIVATE_ROOT
if (!root || !process.env.AGENTMUX_BOOTSTRAP_MAIN) throw Error('An exact private product candidate is required')
const paths = { home: process.env.HOME, userData: join(root, 'profile'),
  appData: join(root, 'app-data'), sessionData: join(root, 'session-data') }
for (const [name, value] of Object.entries(paths)) app.setPath(name, value)
globalThis.__bootstrapNative = {
  paths: () => Object.fromEntries(Object.keys(paths).map(name => [name, app.getPath(name)])),
  identity: () => ({ pid: process.pid, entry: process.env.AGENTMUX_BOOTSTRAP_MAIN,
    appPath: app.getAppPath(), versions: process.versions }),
  activate() {
    const expected = pathToFileURL(process.env.AGENTMUX_BOOTSTRAP_RENDERER).href
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().split('?')[0] === expected)
    if (!window) throw Error('The original private App window is unavailable')
    window.show(); window.focus(); app.focus({ steal: true })
    return { pid: process.pid, nativeWindowId: window.id, url: window.webContents.getURL(), focused: window.isFocused() }
  },
  quit: () => { setImmediate(() => app.quit()); return true }
}
import(pathToFileURL(process.env.AGENTMUX_BOOTSTRAP_MAIN).href).catch(error => {
  process.stderr.write(error.stack + '\n'); app.exit(1)
})
