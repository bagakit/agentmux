const { app } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, phase, evidence, owner, preload, node, cli, handlers] = process.argv.slice(2)
app.setPath('userData', join(privateRoot, 'profile'))
app.setPath('sessionData', join(privateRoot, 'session'))
app.whenReady().then(async () => {
  try {
    const { runPublicOwner } = await import(pathToFileURL(owner).href)
    app.exit(await runPublicOwner({ html, privateRoot, phase, evidence, preload, node, cli, handlers }) ? 0 : 1)
  } catch (error) { console.error(error); app.exit(1) }
})
