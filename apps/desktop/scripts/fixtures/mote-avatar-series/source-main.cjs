const { app, nativeImage } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path')
const [compiled, directory, builtinRoot, runtimeRoot] = process.argv.slice(2)
app.setPath('userData', path.join(directory, 'userData'))
app.whenReady().then(async () => {
  const { MoteAvatarSeriesOwner, MoteAvatarControl, AgentMuxControlServer } = require(path.join(compiled, 'source-entry.cjs'))
  const owner = new MoteAvatarSeriesOwner({ userRoot: path.join(directory, 'avatars'), builtinRoot })
  const control = new MoteAvatarControl(owner)
  const server = new AgentMuxControlServer({ moteAvatars: control, coreClients: () => [], socketPath: path.join(runtimeRoot, 'control.sock.desktop') })
  await server.start()
  await fs.writeFile(path.join(directory, 'source-ready.json'), JSON.stringify({ pid: process.pid, socket: server.path, actualNativeImage: nativeImage.createEmpty().isEmpty() }))
  const stop = () => { void server.stop().then(() => app.quit()) }
  process.on('SIGTERM', stop)
}).catch(error => { console.error(error); app.exit(1) })
