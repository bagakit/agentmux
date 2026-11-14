const { app, BrowserWindow } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const [directory, prefix, privateRoot] = process.argv.slice(2)
app.setPath('userData', join(privateRoot, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } })
  const images = []
  try {
    for (const state of ['choice', 'choice-open', 'review', 'changed', 'unknown', 'region']) {
      const body = await readFile(prefix + '-' + state + '.html', 'utf8')
      const path = join(directory, state + '.html')
      await writeFile(path, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./scene.css"></head><body>' + body + (state === 'choice-open' ? '<script type="module" src="./menu.js"></script>' : '') + '</body></html>')
      for (const [theme, width, height] of [['dark', 1440, 900], ['light', 1440, 900], ['dark', 420, 520], ['light', 420, 520]]) {
        window.setSize(width, height)
        await window.loadFile(path)
        await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance=${JSON.stringify(theme)};for(const host of document.querySelectorAll('[popover]'))if(host.querySelector('.confirmation-dialog')||host.querySelector('[role=menu]'))host.showPopover();new Promise(resolve=>setTimeout(resolve,250))`)
        const facts = await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('.confirmation-dialog'),r=dialog.getBoundingClientRect();return{title:dialog.querySelector('.confirmation-dialog__title').textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight}}})()`)
        if (facts.rect.width <= 0 || facts.rect.x < 0 || facts.rect.y < 0 || facts.rect.x + facts.rect.width > facts.viewport.width + 1 || facts.rect.y + facts.rect.height > facts.viewport.height + 1) throw Error('Original modal remains within the selected viewport: ' + JSON.stringify(facts))
        const file = `${state}-${theme}-${width}.png`
        await writeFile(join(directory, file), (await window.webContents.capturePage()).toPNG())
        images.push({ file, theme, ...facts })
      }
    }
    await writeFile(join(directory, 'render.json'), JSON.stringify({ images }))
  } finally { window.destroy() }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
