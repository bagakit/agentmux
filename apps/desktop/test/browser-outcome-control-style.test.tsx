import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { BrowserOutcomeCriteria } from '../src/renderer/src/components/BrowserOutcomeCriteria'
import type { BrowserOutcomeEvaluation } from '../src/shared/browser-outcome-criteria'

// Actual production component + complete product stylesheet in Chromium. These local layout
// fixtures do not claim Browser native-page composition, operation input or ordinary restart.
it('gives both real outcome actions the existing compact Mint controls, hits and trusted Tab focus', async () => {
  const evaluation = { status: 'passed', conditions: [] } as unknown as BrowserOutcomeEvaluation
  const cases = [
    { width: 760, height: 580 }, { width: 234.5, height: 580 }, { width: 234.5, height: 320 }
  ].flatMap(size => [false, true].map(busy => ({ ...size, busy,
    markup: renderToStaticMarkup(createElement(BrowserOutcomeCriteria, {
      evaluation, busy, onRun: async () => {}, onVerify: async () => {}
    })) })))
  const directory = await mkdtemp(join(tmpdir(), 'amux-outcome-controls-'))
  try {
    const entry = resolve('apps/desktop/src/renderer/src/styles/index.css')
    const imports = [...(await readFile(entry, 'utf8')).matchAll(/@import '\.\/([^']+)';/g)]
    expect(imports.length).toBeGreaterThan(0)
    const styles = await Promise.all(imports.map(match => readFile(join(dirname(entry), match[1]!), 'utf8')))
    await writeFile(join(directory, 'cases.json'), JSON.stringify(cases))
    await writeFile(join(directory, 'page.html'), `<!doctype html><style>${styles.join('\n')}</style>
      <section class="browser-surface"><div class="browser-toolbar"></div><div class="browser-body"><div class="browser-stage"></div><aside class="browser-trace-rail"></aside></div></section>`)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', main: 'main.mjs' }))
    await writeFile(join(directory, 'main.mjs'), String.raw`
import { app, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
app.setPath('userData',process.env.OUTCOME_CONTROL_ROOT+'/userdata')
app.whenReady().then(async()=>{
 const report={cases:[]};let window
 try{
  window=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{sandbox:true}})
  window.webContents.debugger.attach('1.3')
  const read=source=>window.webContents.executeJavaScript(source)
  const input=(method,params)=>window.webContents.debugger.sendCommand('Input.'+method,params)
  const tick=()=>read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const tab=async()=>{await input('dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await input('dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await tick()}
  const cases=JSON.parse(await readFile(join(process.env.OUTCOME_CONTROL_ROOT,'cases.json'),'utf8'))
  for(const entry of cases){
   await window.loadFile(join(process.env.OUTCOME_CONTROL_ROOT,'page.html'))
   await read('('+((entry)=>{
    const pane=document.querySelector('.browser-surface');pane.style.width=entry.width+'px';pane.style.height=entry.height+'px'
    pane.querySelector('.browser-trace-rail').innerHTML=entry.markup
    pane.querySelector('details').open=true
   }).toString()+')('+JSON.stringify(entry)+')')
   await read('document.fonts.ready');await tick()
   const result={width:entry.width,height:entry.height,busy:entry.busy,buttons:[],tabOrder:[]}
   for(let index=0;index<2;index++){
    await read('document.querySelectorAll(".browser-outcome-criteria button")['+index+'].scrollIntoView({block:"nearest"})');await tick()
    const observed=await read('('+((index)=>{
     const buttons=[...document.querySelectorAll('.browser-outcome-criteria button')],button=buttons[index],r=button.getBoundingClientRect(),s=getComputedStyle(button)
     const token=(name,property)=>{const node=document.createElement('span');node.style[property]='var('+name+')';document.body.appendChild(node);const value=getComputedStyle(node)[property];node.remove();return value}
     const points=[[r.x+r.width/2,r.y+r.height/2],[r.x+1,r.y+r.height/2],[r.right-1,r.y+r.height/2],[r.x+r.width/2,r.y+1],[r.x+r.width/2,r.bottom-1]]
      .map(([x,y])=>{const stack=document.elementsFromPoint(x,y);return {x,y,own:stack[0]?.closest('button')===button,stack:stack.slice(0,8).map(node=>({tag:node.tagName,className:node.className}))}})
     const rail=document.querySelector('.browser-trace-rail').getBoundingClientRect()
     return {count:buttons.length,label:button.textContent.trim(),disabled:button.disabled,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},rail:{x:rail.x,y:rail.y,width:rail.width,height:rail.height},points,
      style:{background:s.backgroundColor,color:s.color,borderColor:s.borderTopColor,borderWidth:s.borderTopWidth,padding:s.paddingInlineStart,fontSize:s.fontSize,opacity:s.opacity,cursor:s.cursor},
      tokens:{background:token('--green-bg','backgroundColor'),hover:token('--green-bg-hover','backgroundColor'),color:token('--green-text','color'),border:token('--green-line','color')}}
    }).toString()+')('+index+')')
    await input('dispatchMouseEvent',{type:'mouseMoved',x:observed.bounds.x+observed.bounds.width/2,y:observed.bounds.y+observed.bounds.height/2})
    await tick()
    observed.hover=await read('getComputedStyle(document.querySelectorAll(".browser-outcome-criteria button")['+index+']).backgroundColor')
    await input('dispatchMouseEvent',{type:'mouseMoved',x:1100,y:700});await tick()
    result.buttons.push(observed)
   }
   if(!entry.busy){
    // The normal product order is summary, key, selector, checked radio, expected value, then both actions.
    for(let index=0;index<7;index++){await tab();result.tabOrder.push(await read('({tag:document.activeElement.tagName,type:document.activeElement.type,text:document.activeElement.textContent.trim()})'));if(index>=5){result.buttons[index-5].focus=await read('('+((index)=>{const button=document.querySelectorAll('.browser-outcome-criteria button')[index],s=getComputedStyle(button);return {focused:document.activeElement===button,visible:button.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor,offset:s.outlineOffset}}).toString()+')('+(index-5)+')')}}
   }
   report.cases.push(result)
  }
 }catch(error){report.error=error.stack||String(error)}
 finally{await writeFile(join(process.env.OUTCOME_CONTROL_ROOT,'report.json'),JSON.stringify(report));window?.destroy();app.quit()}
})`)
    const env: NodeJS.ProcessEnv = { ...process.env, OUTCOME_CONTROL_ROOT: directory, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron') as unknown as string, [directory], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096) })
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Outcome controls deadline: ' + stderr)) }, 25_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', value => { clearTimeout(timer); done(value) })
    })
    expect(code, stderr).toBe(0)
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
    if (process.env.AGENTMUX_OUTCOME_CONTROL_STYLE_PROOF) await writeFile(resolve(process.env.AGENTMUX_OUTCOME_CONTROL_STYLE_PROOF), `${JSON.stringify(report, null, 2)}\n`)
    expect(report.error, JSON.stringify(report)).toBeUndefined()
    expect(report.cases).toHaveLength(6)
    for (const result of report.cases) {
      const context = JSON.stringify(result)
      expect(result.buttons).toHaveLength(2)
      expect(result.buttons.map((button: { label: string }) => button.label)).toEqual([result.busy ? 'Checking…' : 'Check current field', 'Verify recorded evidence'])
      for (const button of result.buttons) {
        expect(button.count, context).toBe(2)
        expect(button.bounds.height, context).toBeGreaterThanOrEqual(25)
        expect(button.bounds.width, context).toBeGreaterThan(0)
        expect(button.bounds.x, context).toBeGreaterThanOrEqual(button.rail.x)
        expect(button.bounds.x + button.bounds.width, context).toBeLessThanOrEqual(button.rail.x + button.rail.width)
        expect(button.points.map((point: { own: boolean }) => point.own), context).toEqual([true, true, true, true, true])
        for (const point of button.points) expect(point.stack.length, context).toBeGreaterThan(0)
        expect(button.style.background, context).toBe(button.tokens.background)
        expect(button.style.color, context).toBe(button.tokens.color)
        expect(button.style.borderColor, context).toBe(button.tokens.border)
        expect(button.style.borderWidth, context).toBe('1px')
        expect(button.style.padding, context).toBe('6px')
        expect(button.style.fontSize, context).toBe('10px')
        expect(button.disabled, context).toBe(result.busy)
        expect(button.style.opacity, context).toBe(result.busy ? '0.45' : '1')
        expect(button.style.cursor, context).toBe(result.busy ? 'default' : 'pointer')
        expect(button.hover, context).toBe(result.busy ? button.tokens.background : button.tokens.hover)
        if (!result.busy) {
          expect(button.focus, context).toEqual({ focused: true, visible: true, outline: 'solid', width: '2px', color: button.tokens.border, offset: '-2px' })
        }
      }
      if (!result.busy) expect(result.tabOrder.map((item: { tag: string; type: string }) => [item.tag, item.type])).toEqual([
        ['SUMMARY', undefined], ['INPUT', 'text'], ['INPUT', 'text'], ['INPUT', 'radio'], ['INPUT', 'text'], ['BUTTON', 'submit'], ['BUTTON', 'submit']
      ])
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)
