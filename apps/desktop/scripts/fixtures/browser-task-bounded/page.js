const storageKey = 'private-native-task-results';
const state = JSON.parse(localStorage.getItem(storageKey) || '{"items":[],"then":0,"else":0,"events":[]}');
const render = () => {
  document.querySelector('#results').replaceChildren(...state.items.map(value => {const item=document.createElement('li');item.textContent=value;return item}));
  document.querySelector('#status').textContent = `${state.items.length} items · True ${state.then} · False ${state.else}`;
};
const save = event => {state.events.push({type:event.type,trusted:event.isTrusted,at:Date.now()});localStorage.setItem(storageKey,JSON.stringify(state));render()};
document.querySelector('form').addEventListener('submit', event => {event.preventDefault();state.items.push(document.querySelector('#entry').value);save(event)});
for(const [id,key] of [['then','then'],['else','else']]) document.querySelector('#'+id).addEventListener('click',event=>{state[key]++;save(event)});
globalThis.privateTaskPageFacts = () => ({url:location.href,documentFocused:document.hasFocus(),activeElement:document.activeElement?.id || null,state:structuredClone(state),at:Date.now()});
render();
