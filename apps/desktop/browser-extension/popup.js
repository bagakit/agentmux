const status = document.querySelector('#status')
const share = document.querySelector('#share')
const tabs = document.querySelector('#tabs')
const send = async message => {
  const reply = await chrome.runtime.sendMessage(message)
  if (!reply?.ok) throw new Error(reply?.error || 'AgentMux connection is unavailable.')
  return reply.value
}
async function refresh() {
  const state = await send({ type: 'status' })
  status.textContent = state.connected ? 'Connected · only shared tabs are available' : 'Disconnected · no Agent control'
  share.disabled = !state.connected
  tabs.replaceChildren()
  for (const tab of state.tabs) {
    const row = document.createElement('li')
    const text = document.createElement('span')
    text.textContent = tab.title || 'Shared tab'
    const id = document.createElement('small')
    id.textContent = tab.bindingId || 'Waiting for AgentMux'
    text.append(id)
    const revoke = document.createElement('button')
    revoke.textContent = 'Stop sharing'
    revoke.addEventListener('click', () => perform(() => send({ type: 'unshare', tabId: tab.tabId })))
    row.append(text, revoke); tabs.append(row)
  }
}
async function perform(action) {
  try { await action(); await refresh() } catch (error) { status.textContent = error.message }
}
document.querySelector('#pair').addEventListener('submit', event => {
  event.preventDefault()
  const input = document.querySelector('#connection')
  void perform(async () => { await send({ type: 'connect', link: input.value }); input.value = '' })
})
share.addEventListener('click', () => perform(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!Number.isInteger(tab?.id)) throw new Error('Choose a tab before sharing it.')
  await send({ type: 'share', tabId: tab.id })
}))
void perform(async () => {})
