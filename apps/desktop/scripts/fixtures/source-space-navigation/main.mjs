import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'

const facts=process.env.SOURCE_NAVIGATION_FACTS
if(!facts)throw new Error('SOURCE_NAVIGATION_FACTS is required')
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{contextIsolation:false,sandbox:true}})
  await window.webContents.loadFile(resolve(process.env.SOURCE_NAVIGATION_RENDERER,''),{search:'facts='+encodeURIComponent(facts)})
})
