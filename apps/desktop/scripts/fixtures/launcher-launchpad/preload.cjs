const { contextBridge } = require('electron'), fs = require('node:fs')
const arg = process.argv.find(value => value.startsWith('--launchpad-boot='))
if (arg) contextBridge.exposeInMainWorld('launchpadFixtureBootFacts', JSON.parse(fs.readFileSync(arg.slice('--launchpad-boot='.length), 'utf8')))
