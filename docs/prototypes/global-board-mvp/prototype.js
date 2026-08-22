const shell = document.querySelector('.app-shell')
const workspace = document.querySelector('.task-workspace')
const assistant = document.querySelector('.assistant-popover')
const toast = document.querySelector('.toast')
let toastTimer

function showToast(message) {
  toast.textContent = message
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200)
}
function openWorkspace() {
  workspace.classList.add('open')
  shell.classList.add('task-open')
  workspace.setAttribute('aria-hidden', 'false')
}
function closeWorkspace() {
  workspace.classList.remove('open')
  shell.classList.remove('task-open')
  workspace.setAttribute('aria-hidden', 'true')
}
function openAssistant() {
  assistant.classList.add('open')
  assistant.setAttribute('aria-hidden', 'false')
}
function closeAssistant() {
  assistant.classList.remove('open')
  assistant.setAttribute('aria-hidden', 'true')
}

document.querySelectorAll('[data-task]').forEach((card) => card.addEventListener('click', () => {
  document.querySelectorAll('.task-row.selected').forEach((item) => item.classList.remove('selected'))
  card.classList.add('selected')
  openWorkspace()
}))
document.querySelectorAll('[data-action="assistant"]').forEach((button) => button.addEventListener('click', () => {
  closeWorkspace()
  openAssistant()
}))
document.querySelector('.close-workspace').addEventListener('click', closeWorkspace)
document.querySelector('.close-assistant').addEventListener('click', closeAssistant)
document.querySelector('[data-action="new-task"]').addEventListener('click', () => {
  openAssistant()
  showToast('Default Session 已打开：准备分析并创建 Task')
})
document.querySelectorAll('.region-action, .full-button').forEach((button) => button.addEventListener('click', (event) => {
  event.stopPropagation()
  showToast('按精确 Project / Workspace / Session 打开工作台')
}))
document.querySelectorAll('.arrangement').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.arrangement').forEach((item) => item.classList.remove('active'))
  button.classList.add('active')
  showToast(`Arrangement：${button.textContent}`)
}))
document.querySelector('.topic-confirm').addEventListener('click', () => showToast('Task receipt：AM-241 · 已记录到默认 Topic'))
document.querySelector('.topic-policy').addEventListener('click', () => showToast('当前策略：按风险确认 · 查看 Topic 设置'))
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeWorkspace(); closeAssistant() }
})
