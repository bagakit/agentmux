const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [directory] = process.argv.slice(2)
app.setPath('userData', path.join(directory, 'profile'))
app.setPath('sessionData', path.join(directory, 'session'))

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, useContentSize: true })
  const scenes = []
  try {
    await window.loadFile(path.join(directory, 'index.html'))
    for (const width of [1440, 800, 500, 320]) {
      window.setContentSize(width, 600)
      scenes.push(await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        width: innerWidth,
        rows: [...document.querySelectorAll('[data-lane-id]')].map(row => ({
          kind: row.dataset.focusSource,
          right: row.getBoundingClientRect().right,
          fields: [...row.querySelectorAll('.focus-project-lanes__source, .focus-project-lanes__label strong, .focus-project-lanes__activity, .focus-project-lanes__status-rail')].map(element => ({
            text: element.textContent, width: element.clientWidth, scroll: element.scrollWidth,
            left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right
          }))
        }))
      }))))`))
    }
    await fs.writeFile(path.join(directory, 'geometry.json'), JSON.stringify(scenes))
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    window.destroy()
    app.exit(1)
  }
})
