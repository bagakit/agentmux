# Browser 展示媒体资源合同

Root `/root` 已批准本合同和准确 ABI 进入原 `f-2gn8f5azk/T-004`；[批准记录](../reviews/shared-native-browser-presentation-abi-review.json) 只批准设计和实施边界，不声明产品已实现、Task 已 start/done 或物理输入已通过。

产品约束唯一消费交互SSOT《Zone→Tabs→Regions 的实体与展示绑定》，视觉只消费密度同节。T004依赖已完成T001/T003，原三验收和product门不变；普通二GUI恢复只由T005签。本合同不把T003严格sourceDoc-pin试验policy搬成产品规则。

## 身份与资源

- 原BrowserEntry/WebContents/view/Profile/navigation/BrowserViewport属于唯一BVM。Browser所属资源Workspace不因foreign展示位置改写。
- presentationId与exact location（displayWorkspaceId/groupId/tabId/regionId）来自同一现公共occurrence事实；DOM host或surface名称不代表新的实体。BVM只持实际注册的瞬态lease，不建立第二持久位置目录。
- source同活体页面导航/reload更新现BrowserSnapshot并继续流，不改input occurrence、不生第二viewport；真实entry/view/WC/Profile替换或释放才使resource scope失效。
- requester由真实受信IPC event得到精确App WC/Session/mainFrame/完整已加载文档寿命。Renderer payload不得携Electron对象/ID、origin、sourceURL或权限。file opaque origin不作为唯一身份校验。
- 原App内容宿主持真实MediaStream/Track资源，一个Browser一个capture，多个video共享srcObject；Main负责许可/失效，不能声称持有Renderer物理track。stage可见性与真实输入可操作分别表达。

## 登记、ARM、ACK、撤销

精确签名见 [Browser 展示媒体 ABI](browser-presentation-abi.md)。新方法直接属于现AgentMuxDesktopApi.browser，经原preload与registerIpc.handleWithEvent到BVM。BVM安装一个App Session display handler，video-only/无system picker，原SourceProfile权限不变；每requester只容一项未settledarm，避免无requestID的callback把源串线。

主Frame/文档/Session错误、opaquehandle不属sender、source已释放、没有真实visiblepositivegeometry均不得capture。任一流程检查失败不停止或销毁健康source；明确服务窗说明媒体呈现未确认。已有同capture多visibleconsumer不因某个issuer lease取消就停流；只有最后visible撤去才收媒体。

ACK为可信App媒体holder报告：ready/stopped带非空实际trackIds，failed单独；stopped不重启revokedscope。已ready时核同集合；迟到流直接停止可报道真实stopped，不假报ready。物理ended仍需actualqualification，不以Main发revoke/ACK无异常/RequesterDOM移除冒观测。requester毁掉后无法读取旧track时保unknown，而不是伪造ended。

媒体/input位置事件使用独立BROWSER_PRESENTATION_EVENT_CHANNEL→preload.onPresentationEvent→唯一媒体holder。BrowserEvent三项union和Store reducer不变；media revoke不得移除Tab/Region。每listener只退自身，handler/lease清理沿唯一BVM/dispose。

## 显隐、输入与尺寸

Settings只更新当前background lease的可见性/命中，其他合法visible stage持续paint。stage cleanup不调用全browserId nullbounds/release；原预算沿可见集合保护原资源。隐藏/目录中引用无capture/fit/bytes/Reader放大。

明确input选择才迁原Nativeview到准确有效lease；不在render/hover/导航时取首项抢焦点，不变Agent driving/humanControl、permissions或overlaylease。被动stage只contain同权威画面，原viewport/Native几何owner唯一。首次点击、IME/selection/clipboard须各自实际事实；stream像素或sourceCDP不等于两个位置均可操作。

## 接口发布与验收边界

原六invoke的privileged sender接线/parity与renderer非定义caller全部非空；类型/builtNative/loaded三行为RED→exactG/独立宽窄图按T004原门。首产品counter从被动stage第一击/原Native命中进入，真实 requester文档失效是同域scope反例；源reload保持流为正控。实际test若因Sourceseam/原生物理输入或停轨观测不足而失败，保原件与未完成，不改原Task/门。

研究工具的private props/mockAPI/旧canonicalSource不得进入公共ABI；产品不留legacyfallback，不新Browser/Profile/navigation/Runowner，不重T003已证矩阵，不打包或操作用户App。
