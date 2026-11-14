import assert from 'node:assert/strict'
import type { WebContents } from 'electron'

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
export async function nativeUntil<T>(read: () => T | Promise<T>, label: string, budget = 15000): Promise<NonNullable<T>> {
  const deadline = Date.now() + budget
  do { const value = await read(); if (value) return value as NonNullable<T>; await pause(35) } while (Date.now() < deadline)
  throw new Error('Private Profile workface observation is unconfirmed: ' + label)
}

/** The production App and its original site receive native CDP input, never setter events. */
export function nativeInput(contents: WebContents, trace: any[]) {
  const attachedHere=!contents.debugger.isAttached()
  if (attachedHere) contents.debugger.attach('1.3')
  const read = (expression: string) => contents.executeJavaScript(expression)
  const key = async (key: string, code: string, virtual: number, modifiers = 0, commands?: string[]) => {
    for (const type of ['keyDown', 'keyUp']) await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode: virtual, modifiers,
      ...(type === 'keyDown' && commands ? { commands } : {}),
      ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {})
    })
  }
  const click = async (selector: string, text?: string, button: 'left' | 'right' = 'left') => {
    const point = await nativeUntil(() => read(`(()=>{
      const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility()&&(${JSON.stringify(text??null)}===null||e.textContent.trim()===${JSON.stringify(text??null)}));
      if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
      return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;
    })()`), 'actual pointer target ' + selector)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button, clickCount: 1 })
    })
    trace.push({ kind: 'pointer', contentsId: contents.id, selector })
    await pause(70)
  }
  const fill = async (selector: string, value: string) => {
    await click(selector)
    await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2, ['selectAll'])
    await contents.debugger.sendCommand('Input.insertText', { text: value })
    assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), value, 'Actual native input must contain the requested fixture value')
    trace.push({ kind: 'text-input', contentsId: contents.id, selector, length: value.length })
  }
  const select = async (selector: string, value: string) => {
    await click(selector)
    await key('Escape','Escape',27)
    const target = await nativeUntil(() => read(`(()=>{
      const e=document.querySelector(${JSON.stringify(selector)});if(!e?.checkVisibility()||e.disabled)return null;
      const options=[...e.options].filter(o=>!o.disabled),i=options.findIndex(o=>o.value===${JSON.stringify(value)});if(i<0)return null;
      e.scrollIntoView({block:'nearest'});e.focus();globalThis.profileSurveySelectEvents??=[];
      globalThis.profileSurveyKeyEvents??=[];
      if(!globalThis.profileSurveyKeyObserver){globalThis.profileSurveyKeyObserver=true;document.addEventListener('keydown',event=>{globalThis.profileSurveyKeyEvents.push({key:event.key,tag:event.target?.tagName,label:event.target?.getAttribute?.('aria-label'),trusted:event.isTrusted});globalThis.profileSurveyKeyEvents=globalThis.profileSurveyKeyEvents.slice(-16)},true)}
      e.addEventListener('change',event=>globalThis.profileSurveySelectEvents.push({value:e.value,trusted:event.isTrusted}),{once:true});return{i,from:options.findIndex(o=>o.value===e.value),label:options[i].textContent.trim()};
    })()`), 'original selectable option ' + value)
    const attempt:any={kind:'keyboard-select',contentsId:contents.id,selector,value,target,state:'dispatched',steps:[]}
    trace.push(attempt)
    const snapshot=()=>read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return{value:e?.value,activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label'),documentFocus:document.hasFocus(),keys:globalThis.profileSurveyKeyEvents?.slice(-5),changes:globalThis.profileSurveySelectEvents?.slice(-5)}})()`)
    attempt.steps.push(await snapshot())
    // Chromium on macOS delegates arrow handling to its native popup. The
    // repository's native handoff fixture uses trusted type-ahead instead.
    // The label comes from the exact requested option value, and the final
    // value is checked below; no displayed name grants a Profile identity.
    if(target.from!==target.i){
      await pause(1100)
      for(const character of target.label){
        await contents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'char',key:character,text:character,unmodifiedText:character})
        const observed=await snapshot();attempt.steps.push(observed)
        assert.equal(observed.activeTag,'SELECT','Changing the Survey environment keeps keyboard focus on the person’s original selector')
        assert.equal(observed.activeLabel,'Survey environment','The same original environment selector keeps keyboard input')
      }
    }
    await key('Enter', 'Enter', 13)
    attempt.steps.push(await snapshot())
    await nativeUntil(() => read(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`), 'actual selected option')
    attempt.state='confirmed'
    await pause(70)
  }
  return { read, click, fill, select, key, release() { if(attachedHere&&!contents.isDestroyed()&&contents.debugger.isAttached())contents.debugger.detach() } }
}
