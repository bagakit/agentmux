# Browser 展示媒体 ABI

Root `/root` 已批准本接口设计进入原 `f-2gn8f5azk/T-004`；见 [批准记录](../reviews/shared-native-browser-presentation-abi-review.json)。以下为待实施签名，不声明现源码已导出这些方法，不代签 Native 输入、物理停轨或 Task done。产品须先由 Root 完成持久 refs 和公共 Tracker update/start。

行为寿命唯一消费 [资源合同](browser-presentation-resource-contract.md) 与两份设计 SSOT。先沿原 BVM/shared/preload/registered IPC 资源 holder 实施；Workspace/Stable 等 T002 接缝不在首片，BrowserPane 按准确 hunk 协商。

## 准确类型与出口

以下 TypeScript 是接口设计文本。`BrowserPresentationApiCandidate` 仅展示既有 `AgentMuxDesktopApi.browser` 的新增签名，不引入另一个 API 对象或 manager。Main 私有方法不向 Renderer 导出 Electron identity。

```ts
// Root-approved interface design. Public T004 start is required before implementation.
// Placement: apps/desktop/src/shared/contracts.ts; this file is not executable Source.
import type { AgentMuxSpaceLocation } from '@agentmux/core/control'

export type BrowserPresentationOccurrence = {
  presentationId: string
  location: Pick<AgentMuxSpaceLocation,
    'displayWorkspaceId' | 'groupId' | 'tabId' | 'regionId'>
}

export type BrowserPresentationGeometry =
  | { visible: false }
  | { visible: true; bounds: BrowserBounds }

/** Main-issued opaque resource handle; every operation validates its actual sender and lifetime. */
export type BrowserPresentationLease = { leaseId: string }

/** One arm for the original Browser's one capture; never contains Renderer-supplied Electron identity. */
export type BrowserPresentationCapture = { captureId: string; browserId: string }

export type BrowserPresentationCaptureAck =
  | { outcome: 'ready'; trackIds: readonly [string, ...string[]] }
  | { outcome: 'stopped'; trackIds: readonly [string, ...string[]] }
  | { outcome: 'failed'; message: string }

export type BrowserPresentationRevocationReason =
  | 'requester-ended'
  | 'source-replaced'
  | 'source-released'
  | 'no-visible-presentations'

/** Media/input-placement state, not Browser entity deletion or durable workspace state. */
export type BrowserPresentationEvent =
  | { type: 'capture-revoked'; browserId: string; captureId: string;
      reason: BrowserPresentationRevocationReason }
  | { type: 'input-owner-changed'; browserId: string; leaseId: string | null }

// New exact push channel, beside the existing BROWSER_EVENT_CHANNEL.
// Keep BrowserEvent itself unchanged: its current reducer treats non-updated/unavailable as closed.
export const BROWSER_PRESENTATION_EVENT_CHANNEL = 'agentmux:browser-presentation-event'

// Added directly to AgentMuxDesktopApi.browser; no second Browser API/manager object.
// BrowserBounds is the existing shared BrowserBounds type, not redeclared here.
export type BrowserPresentationApiCandidate = {
  registerPresentation(input: {
    browserId: string
    occurrence: BrowserPresentationOccurrence
    geometry: BrowserPresentationGeometry
  }): Promise<BrowserPresentationLease>
  updatePresentation(leaseId: string, geometry: BrowserPresentationGeometry): Promise<void>
  removePresentation(leaseId: string): Promise<void>
  armPresentationCapture(leaseId: string): Promise<BrowserPresentationCapture>
  ackPresentationCapture(captureId: string, ack: BrowserPresentationCaptureAck): Promise<void>
  activatePresentation(leaseId: string): Promise<void>
  onPresentationEvent(listener: (event: BrowserPresentationEvent) => void): () => void
}

// Placement: apps/desktop/src/preload/index.ts browser object.
// These are signature/wiring candidates, not declarations that the methods already exist.
const preloadBrowserPresentationCandidate = {
  registerPresentation: (input: Parameters<BrowserPresentationApiCandidate['registerPresentation']>[0]) =>
    ipcRenderer.invoke('browser:registerPresentation', input),
  updatePresentation: (leaseId: string, geometry: BrowserPresentationGeometry) =>
    ipcRenderer.invoke('browser:updatePresentation', leaseId, geometry),
  removePresentation: (leaseId: string) => ipcRenderer.invoke('browser:removePresentation', leaseId),
  armPresentationCapture: (leaseId: string) => ipcRenderer.invoke('browser:armPresentationCapture', leaseId),
  ackPresentationCapture: (captureId: string, ack: BrowserPresentationCaptureAck) =>
    ipcRenderer.invoke('browser:ackPresentationCapture', captureId, ack),
  activatePresentation: (leaseId: string) => ipcRenderer.invoke('browser:activatePresentation', leaseId),
  onPresentationEvent(listener: (event: BrowserPresentationEvent) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, event: BrowserPresentationEvent): void => listener(event)
    ipcRenderer.on(BROWSER_PRESENTATION_EVENT_CHANNEL, wrapped)
    return () => ipcRenderer.off(BROWSER_PRESENTATION_EVENT_CHANNEL, wrapped)
  }
}

// All six invoke channels are exact new PRIVILEGED_SENDER_LABELS entries with 'Browser presentation'.
// Placement: apps/desktop/src/main/ipc.ts, registerIpc, through its existing handleWithEvent owner.
handleWithEvent('browser:registerPresentation', (event, input) => {
  requireTrustedSender('browser:registerPresentation', event)
  return browsers.registerPresentation(event.sender, event.senderFrame, input)
})
handleWithEvent('browser:updatePresentation', (event, leaseId, geometry) => {
  requireTrustedSender('browser:updatePresentation', event)
  return browsers.updatePresentation(event.sender, event.senderFrame, leaseId, geometry)
})
handleWithEvent('browser:removePresentation', (event, leaseId) => {
  requireTrustedSender('browser:removePresentation', event)
  return browsers.removePresentation(event.sender, event.senderFrame, leaseId)
})
handleWithEvent('browser:armPresentationCapture', (event, leaseId) => {
  requireTrustedSender('browser:armPresentationCapture', event)
  return browsers.armPresentationCapture(event.sender, event.senderFrame, leaseId)
})
handleWithEvent('browser:ackPresentationCapture', (event, captureId, ack) => {
  requireTrustedSender('browser:ackPresentationCapture', event)
  return browsers.ackPresentationCapture(event.sender, event.senderFrame, captureId, ack)
})
handleWithEvent('browser:activatePresentation', (event, leaseId) => {
  requireTrustedSender('browser:activatePresentation', event)
  return browsers.activatePresentation(event.sender, event.senderFrame, leaseId)
})

// Placement: BrowserViewManager instance methods. Electron handles come ONLY from actual IPC event.
// Main-private method signatures, not exported Renderer data.
interface BrowserViewManagerPresentationMethodsCandidate {
  registerPresentation(sender: WebContents, frame: WebFrameMain | null,
    input: Parameters<BrowserPresentationApiCandidate['registerPresentation']>[0]): BrowserPresentationLease
  updatePresentation(sender: WebContents, frame: WebFrameMain | null,
    leaseId: string, geometry: BrowserPresentationGeometry): void
  removePresentation(sender: WebContents, frame: WebFrameMain | null, leaseId: string): void
  armPresentationCapture(sender: WebContents, frame: WebFrameMain | null,
    leaseId: string): BrowserPresentationCapture
  ackPresentationCapture(sender: WebContents, frame: WebFrameMain | null,
    captureId: string, ack: BrowserPresentationCaptureAck): void
  activatePresentation(sender: WebContents, frame: WebFrameMain | null, leaseId: string): void
}

// No srcObject/MediaStream/Session/WebContents/frame/origin/title/navigation URL in IPC payload.
// The holder receives its stream directly from navigator.mediaDevices.getDisplayMedia in Renderer.
// ACK conveys trusted-App reported media state; Main authorization revocation is a different fact.

```

## 最小产品 Source 范围

1. **shared/contracts.ts**：新增 serializable occurrence/geometry/lease/capture/ACK 与 BrowserPresentationEvent，以及唯一 BROWSER_PRESENTATION_EVENT_CHANNEL 常量；六项命令和一个 subscription 直接接 AgentMuxDesktopApi.browser。BrowserEvent 保原三项 union，不让 media revoke进入实体关闭 reducer。
2. **preload/index.ts**：六个精确 browser:*Presentation/ *Capture invoke出口和一个独立事件监听/退订。参数类型从唯一contracts导入，Renderer不能传Electron WC/session/frame/origin、Profile权限、title、任意source URL或navigation规则。捕获流仅由真实requester getDisplayMedia取得。
3. **main/ipc.ts + ipc-sender-trust.ts**：在原registerIpc的handleWithEvent注册六handler并由原channels清；新privileged labels使用同一'Browser presentation'标签，每handler第一句原requireTrustedSender，然后真实event.sender/event.senderFrame交原BVM。不用裸ipcMain另建清理owner或避过现parity/AST门。generic trust只核WC，BVM还必须核当前App主frame/Session/已加载完整document寿命。
4. **main/browser-view-manager.ts**：同BrowserEntry持瞬态active leases/capture resource epoch/input occurrence；单App requester的pending-arm字段归这个已有BVM，不建第二manager。一个原App Session handler按该精确pending scope处理getDisplayMedia，绑定来源为唯一当前entry/view/WC/Profile。源正常navigation不revoke；真正资源替换/释放、requester寿命结束、最后visibleconsumer消失才撤capture；通过独立presentation channel通知。Profile成功commit才撤旧authority，失败不伤旧页。detach listeners/reset本owned handler沿原dispose。
5. **renderer原共有呈现owner→WorkspaceWorkbench.SurfaceContent→BrowserPane**：消费稳定T001 exact occurrence，原BrowserPane只有一次source生命周期/media holder；实际第二stage复用同Browser模块的薄呈现，不复制完整Agent/Terminal树。holder注册lease/arm、用同stream接多个video、消费presentation事件/实际track ACK、保晚scope。每stage复用原BoundsSynchronizer报告自己的visibility/bounds，不全实体null bounds。source lifecycle/预算仍一次。明确input只是原Nativeview的当前位置，不因render/hover夺焦点或更改Agent控制。
6. **surface-memory-budget-coordinator/candidates 的必要caller hunk**：已有窗口预算消费实际可见bindings并集；局部stage hidden不能release另一个visiblebinding的Source。不建新的budget或保活策略。
7. **renderer/lib/api.ts的必要类型接线**：其web preview对象也受AgentMuxDesktopApi约束。只声明Native呈现未可用，不能用假Browser/canvas数据补actualNative资格；产品fixture用真实preload，不能借mock分支把命令测绿。

应用来源仍消费 **main/index.ts→top-frame-navigation.ts** 的成熟原加载/来源闸：dev来源与prod规范化Renderer文件由实际load入口唯一派生，renderer update也更新同一个appOrigin。BVM一次scope锁原Main创建Window中实际已加载的主Frame/完整文档，并在文档寿命失效时撤销；不另手抄预期URL，不把所有file origin的null当许可。实际产品fixture也必须保这条真实App加载约束，不能只造一个有同名preload的任意Window而冒已注册App来源。原Source范围不重写这条安全机制。

精确路径均以 apps/desktop/src/ 为根。不要为本片改 Browser导航/Profile权限、viewport、NativeOverlaySurfaces、Core/Run协议或实体Store owner。shared T002 child持directRegion/multibinding的公共加载hunk；本片只需其准确stage occurrence seam，Source start后先按文件/hunk协商，不覆盖WorkspaceWorkbench/StableWorkbenchView其它修改。

## 独立事件出口与唯一消费者

`agentmux:browser-presentation-event` 的唯一生产者是原BrowserViewManager本entry的lease/capture处理；preload只转发。唯一主动资源消费者是原Browser媒体holder，stage只消费holder给予的被动画面/当前input位置，不订第二份实体状态。

该事件**不**交Store.applyBrowserEvent、reduceBrowserEvent或pendingBrowserEvents。现reduceBrowserEvent排除updated/unavailable之后把任何余项按closed移除Region；因此不能新增revoked到BrowserEvent，更不能拿media revoke发closed/unavailable。一般实体updated/closed/unavailable继续原onEvent通道与原store reducer。

onPresentationEvent的返回值只卸自己的listener；不会resetSession handler或撤别的holder。BVM dispose先阻新arm/使generation失效，再撤本owned leases/capture/handler/listeners，Requester真正unload/pagehide停自己tracks；过期ACK或迟到Promise不能复活新scope。Main写“撤销已发出”不证明Renderer实际ended，缺确认保持unknown/服务窗，原Source正常工作。

## 类型边界与真实状态

- occurrence使用现AgentMuxSpaceLocation的四项位置和原presentationId；与browserId分别输入，不把foreign displayWorkspace当资源workspace并因此拒绝合法关联。可信App owner按现catalog/Tab/Region确认browserId与准确位置，Main按真实原BrowserEntry和真实IPC请求者确认资源与scope；不复制布局catalog到Main。
- leaseId/captureId都是Main颁发的opaque string，类型不是信任依据。空/过期/另一requester的handle拒绝；Main从实际sender取得Electronidentity，payload永不提供这些identity。
- visible geometry为显式二分：false或true+原BrowserBounds。零面积/不有限正bounds不登记可见Native；临时测量零不改原健康source。hidden/目录consumer不capture或fit。
- ready/stopped ACK带非空实际trackId tuple；failed独立且不冒拥有track。它是可信App报告，actualqualified还须真正track.readyState/cleanup观测。Main运行期核非空；若此前已ready，再核同一id集合。迟到流在挂载前已经失效时可直接报道真实stopped ids，不能先制造ready来配ACK。ready只接受当前活scope；stopped只作原scope资源报告，绝不重新激活已撤授权。requester已经换文档且无法认证旧ACK，或scope已销毁无法对账时明确unconfirmed/unknown，不把无异常返回推成Main已证明ended；不因它强停Source或阻健康页面。
- capture lifetime不绑首次arm所用lease的唯一home；那个位置隐藏后若另一合法consumer仍visible，原Browser holder/capture可继续。源navigationId是动态Browser事实，不是capture终身document pin；requesterApp完整document/generation才是准确授权边界。
- display callback无业务requestId，原BVM/requester只能有一个未settledarm；ready/failed完成后才放下一请求。不能把共享profileSession/defaultSession所有frame放行。Source Profile原permission handlers、raw userGesture记录与video-only均保持。

## 最可能推翻当前产品方向的一条 counter（只计划）

使用一个轻量独占privateWindow/Profile/state和原genericpage，同source WC/Profile/view，真正T001两个已登记stage。fixture正常消费生产preload→registerIpc handleWithEvent→原BVM方法；非Browser/AppSettings字段可准确声明隔离，但不伪注册同名handler，不注入research props冒公共接口，不完整Core/Runtime/fullDesktop构建。若这一真实生产seam仍不可轻执行，先报具体准备阻点，不改门/复制新engine。

首次反例重点是**从被动位置的第一下点击，是否真的把原Nativeview交到正确位置，并把这一击送到原页**。原母只有“主动对source WC发CDP”的输入，DOMpointerDown→IPC→move可能已经错过第一击，这最容易推翻现方案。

计划步骤：A为准确原input位置、B为真正passive位置，两video同stream有新像素；读原Native bounds/Windowfocus与page-input计数。用已授权、准确privatePID/Window的真实pointer在B所显示的同一页控件首次点击（有工具时实际OS输入；若只CDP点击Requester Renderer，必须诚实限定为自动化入口，不能签物理Native命中），不用SourceWC CDP/executeJavaScript点击控件。实读原BVM nativeOwner/currentlease/actualview bounds，原page focus与输入值/计数、页selection，A仍新像素。第一击丢、命中A或只有镜像DOMclick时即真RED；不补第二击、不预先hover移view、不人工focus源WC、不减stage人口。当前API激活Promise返回或video存在均不算输入成功。IME/OSclipboard仍未知，不能顺手代签。

在同合法candidate的后续最窄scope反例中：只使RequesterApp当前文档失效/退出，旧pendingarm/grant/latePromise不能进入新App；媒体holder同步清tracks，记录真实ended或unobservable/unknown，Source原页资源继续。源正常reload是普通活体正控，两个位置应继续同流更新，不要求新grant/撤旧镜像，不重T003源doc-pin旧矩阵。

这份是可证伪计划，不是已经执行的Native输入/trackended证明。Root先审ABI与实际hunk边界/正式start，再从最小counter决定输入桥是否真的还需变化；不能为使counter过绿提前选合成事件协议、加一套permission manager或改原control/overlay。

## 原门、前置与收口

不追加新Task/第二账本；T004原三acceptance、唯一product命令和T005普通join全部保持。真实loaded dropsecond/localhide/wronginput各RED→exactG、nondefinitioncaller/非空集合、source/compiled绑定、production/owning types与独立宽窄图只签本片actual。轻量编译不等于全App/安装/Runtime恢复，IME和未观测trackended诚实留边界。OOM是原环境事实，不增heap/大依赖副本或重T003矩阵。

