// One private media holder consumes the actual production preload/API. No public research props.
const api = window.agentmux.browser
const videos = [...document.querySelectorAll('video')]
let stream, capture, leases
const events = []
api.onPresentationEvent(event => {
  events.push(event)
  if (event.type === 'capture-revoked' && event.captureId === capture?.captureId && stream) {
    stream.getTracks().forEach(track => track.stop())
    const trackIds = stream.getTracks().map(track => track.id)
    api.ackPresentationCapture(capture.captureId, { outcome: 'stopped', trackIds }).catch(error => {
      events.push({ observation: 'cleanup-ack-unconfirmed', message: error.message })
    })
  }
})
const geometry = index => {
  const r = videos[index].getBoundingClientRect()
  return { visible: true, bounds: { x: r.x, y: r.y, width: r.width, height: r.height } }
}
const acquire = async index => {
  capture = await api.armPresentationCapture(leases[index].leaseId)
  stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  for (const video of videos) { video.srcObject = stream; await video.play() }
  await api.ackPresentationCapture(capture.captureId, { outcome: 'ready', trackIds: stream.getTracks().map(track => track.id) })
}
window.resourceProof = {
  async start(url) {
    const snapshot = await api.create('original-browser', url, null)
    leases = []
    for (let index = 0; index < videos.length; index++) leases.push(await api.registerPresentation({
      browserId: 'original-browser', occurrence: { presentationId: 'private-' + index,
        location: { displayWorkspaceId: 'private-space', groupId: 'group-' + index, tabId: 'same-tab', regionId: 'same-region' } },
      geometry: geometry(index) }))
    await api.activatePresentation(leases[0].leaseId)
    return { snapshot, leases }
  },
  async acquireInitial() { await acquire(0); return capture },
  async hide(index) { await api.updatePresentation(leases[index].leaseId, { visible: false }) },
  async remove(index) { await api.removePresentation(leases[index].leaseId) },
  async reacquire() { await api.updatePresentation(leases[1].leaseId, geometry(1)); await acquire(1); return capture },
  async reloadSource() { return api.reload('original-browser') },
  async staleUpdate(id) { try { await api.updatePresentation(id, geometry(0)); return { rejected: false } } catch (error) { return { rejected: true, message: error.message } } },
  facts() {
    return { events: [...events], capture, leases,
      tracks: stream?.getTracks().map(track => ({ id: track.id, readyState: track.readyState })),
      videos: videos.map(video => {
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
        const context = canvas.getContext('2d'); let pixel = null
        if (video.readyState >= 2) { context.drawImage(video, 0, 0, 2, 2); pixel = [...context.getImageData(0, 0, 1, 1).data] }
        return { width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
          frames: video.getVideoPlaybackQuality().totalVideoFrames, pixel }
      }) }
  }
}
