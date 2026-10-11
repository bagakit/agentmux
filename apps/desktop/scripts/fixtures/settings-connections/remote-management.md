# Remote 管理的 Renderer 场景

需求与状态来源唯一见 [Remote 管理 PRD](../../../../../docs/design/behavior/remote-management.md)，图、列表和连接编辑的呈现见[Remote 管理拓扑](../../../../../docs/design/presentation/settings-and-observation.md#remote-管理拓扑)。本场景通过当前 `SettingsPanel`、模块目录、`HostSettingsPane`、真实 React Flow 与完整生产 CSS 操作产品消费者。

```sh
node apps/desktop/scripts/verify-settings-connections.mjs --remote-owning
node apps/desktop/scripts/verify-settings-connections.mjs --callers
node apps/desktop/scripts/verify-settings-connections.mjs --capture hosts
```

单元场景保留 24 个准确 Host，其中两个同名且有相同项目路径；图节点只选择自己的 Host overview，List 的明确叶子进入原连接/项目。逐位编辑和 per-Host 展开意图经图/列表、Host、设置分区及显隐切换保留。变异直接改实际加载的生产接线、单对象挂载与草稿更新；编译/收集失败不能充当断言红。

采集使用私有 Electron Renderer、同一 fixture entry 和 Preview ConfigOwner。常见规模的 7 个环境用于 1480px 的浅/深主题图与详情；640px、320px 使用等价列表和单对象编辑。通过 native Renderer 点击和输入完成：选择重名节点、原 Agent/Terminal 精确投影导航、连接草稿、另一 Host 的项目、回原草稿、原 Test 捕获输入、原 Save、设备分区离开/返回及关闭。图和列表不能同时挂载，节点选择不能夺走键盘焦点，窄窗原操作与长原因完整可读。

Runtime 采集仍挂载原 `HostRuntimePanel`，受控 `api.hosts.inspect` 只返回符合公共 `HostRuntimeObservation` 的 DTO；不替换面板、时钟或业务 Store。每个宽度与主题通过原生 Refresh 验证完整 owner、Native、diagnostics、resources 的身份和值，资源来源部分失败时数值和原 producer `observedAt` 保留，恢复后更新。展开原身份详情核对 Host route、Semantic Runtime、Core instance、Native instance 分离；最终浅色图保留具名 partial 原因，深色图显示恢复后资源。Renderer 只引用公共类型；同一三态样本在 Node 侧另用公共 parser 校验。

采集不使用用户配置、Session 或 Run。受控 Host/设备/Runtime 观察不是 SSH 可达、原生身份、真人批准或真实远端恢复证明；Preview 保存不证明 Main 磁盘耐久。采图只提供完整 PNG、实际操作和源码/编译身份；独立 Agent 必须实际打开本轮每张图并评判，采集成功不代表审美通过。

本轮精炼：Remote 独立分组 → Environments，准确 Host 的 Apps & access 展示原配置盘点与来源信任。受控 public DTO 经原面展示 unknown approval；真实输入批准、切原连接与其他 Host 后返回不重放、勾选清零。原维护 unknown / verifying 和 updatedAt 首层可见，Native 六项声明来自原 diagnostics/readAt。附加截图覆盖 3 宽度 Apps & access、原升级及宽/窄能力详情；仅受控 owner DTO，不声称真实 SSH、远端批准、升级或安装。

块面改版场景：宽窗图中读取原配置hostname、user、port override、Runtime binding；另一Host省略user/port时显示SSH config，不猜默认值。移除ReactFlow Background。浅色宽窗用真实鼠标按下、移动、抬起采pan before/mid/after，选择准确原Host后viewport保持。宽窗另外切现有Retro Future浅深主题采图，用户实际主题与配置不变。原6主图、8管理附图外增加3运动帧和2Retro主题图，构成19张原管理覆盖；来源仍是受控DTO的原完整Renderer，不代签物理网络观察。

应用账户同步新增12张原图：3宽度浅色双端配置、宽窗浅深差异计划、3宽度深色原unknown结果、宽窗浅深验真结果和Retro浅深应用面，总计31张。原生输入编辑固定argv、保存准确目标、比较、显式apply、离开返回与查询同一operationId；确认apply仅一次。只有公共白名单metadata受控，无导出材料或私密输入。真实CLI/connector/stdin/目标验真与服务进程重启由独立领域证据持有，Renderer采图不代签外部应用登录。

Source context: the original `settings.applications.ls(hostId)` projection includes either endpoint. Six additional full originals show source Host context and its actual registered target editor (wide light/dark and narrow light); native input opens the real editor and asserts that other registered targets remain legal. These are controlled metadata, not application credentials.
