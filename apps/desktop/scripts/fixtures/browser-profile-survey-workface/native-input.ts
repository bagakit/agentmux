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
  const select = async (selector: string, value: string, keepFocus = false) => {
    await click(selector)
    const option = `[role="option"][data-value="${value}"]:not(:disabled)`
    const count = await nativeUntil(() => read(`(()=>{
      const target = document.querySelector(${JSON.stringify(option)});
      if (!target?.checkVisibility()) return 0;
      globalThis.profileSurveySelectEvents ??= [];
      const observe = event => {
        if (event.key !== 'Enter') return;
        globalThis.profileSurveySelectEvents.push({value:target.dataset.value,trusted:event.isTrusted});
        target.removeEventListener('keydown', observe, true);
      };
      target.addEventListener('keydown', observe, true);
      return target.closest('[role="listbox"]').querySelectorAll('[role="option"]:not(:disabled)').length;
    })()`), 'original selectable option ' + value)
    for (let step = 0; step < count; step++) {
      if (await read(`document.activeElement?.matches(${JSON.stringify(option)})`)) break
      await key('ArrowDown', 'ArrowDown', 40)
    }
    assert.equal(await read(`document.activeElement?.matches(${JSON.stringify(option)})`), true, 'Keyboard reaches the exact Survey environment option')
    await key('Enter', 'Enter', 13)
    await nativeUntil(() => read(`document.querySelector(${JSON.stringify(selector)})?.dataset.value === ${JSON.stringify(value)}`), 'actual selected option')
    await nativeUntil(() => read(`!document.querySelector('.survey-profile-picker__menu')`), 'closed Survey environment selector')
    const changes = await read('globalThis.profileSurveySelectEvents.slice(-1)')
    assert.deepEqual(changes, [{ value, trusted: true }])
    trace.push({ kind: 'keyboard-select', contentsId: contents.id, selector, value, state: 'confirmed', steps: [{ changes }] })
    if (keepFocus) assert.ok(await read(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), 'Changing the Survey environment keeps keyboard focus on the person’s original selector')
  }
  return { read, click, fill, select, key, release() { if(attachedHere&&!contents.isDestroyed()&&contents.debugger.isAttached())contents.debugger.detach() } }
}
