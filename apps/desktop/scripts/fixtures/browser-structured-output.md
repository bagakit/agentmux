# Browser 有限结构化提取场景设计

Feature `f-2ew8fzgff / T008` 的有限提取场景设计。行为依据 [interaction SSOT](../../../../docs/design/agentmux-desktop-interaction.md)《Browser 任务能力与可复用资产》的“结构化输出与有限成果验收各自诚实”；视觉依据 [density SSOT](../../../../docs/design/agentmux-surface-density.md)《Browser 任务工具与证据的紧凑呈现》。已 approved r5 的开始边是 T002 官方 done、T003 当前实际 Owner 公共合同已经提供及 T008 官方 start；T003 的完整验收仍由它自己的 Task 负责。T008 已正式 started，模块、source tests 和变异 gate 正在实施，生产入口、原生 Browser 与采图结论单独验收。

Root 已批准的有限合同：32 个扁平字段，类型为 string/number/boolean，来源显式映射 selector 与 text/value/checked/attribute 四种只读模式。within/withinRef 消费现有 T002 的 scope、document 与 issuer，不建立另一份 ref 账本。Zod 拒绝未知 schema 键、不支持类型及超预算输入；没有默认值、模型补全或任意 JSON Schema。实际产物登记只消费 T003 Owner。

准备两个通用布局，运行相同的生产 DOM declaration 与 extraction 模块：

- definition-list/form：文本名称、明确数值文本、值为 0 的 number、真实空字符串、checked 为 false 的输入、缺失字段。
- table：相同类型字段放在 cell/span 内，含重复 selector、缺失 attribute 与类型不符的值。DOM 结构可变，字段来源由调用者明确指定，不依赖站点或按钮文案。

拟议 source test 反例与观察：

1. string 保留真正观察到的空字符串；数字空文本不转换成 0；false 不通过真假值捷径推断。
2. 完整扫描中的零匹配才是 missing；至少两个匹配是 ambiguous，不能静默取第一项。字段读取失败与类型错误各自表达。
3. 只读扫描最多 4096 个元素、8192 个文本节点，每字段保留至多两个匹配。达到扫描预算时，尚未确认的字段是 truncated，而不是 missing 或默认值；记录真实元素处理数、Walker 调用数、selector checks、文本节点、读取次数与实际收集的 UTF8 字符串字节。每字段 16KiB、总计 256KiB；这些是 JS 观察预算，不宣称能约束 CSS 引擎内部工作。
4. 前后 document/navigation 来源不同是 page-changed，不能将旧字段登记到新页面；issuer/scope/读取失败保持 unavailable。
5. 当前完整字段产物与有损字段产物均绑定 Workspace/Browser/operation/navigation/URL/document；登记失败保留已观察字段与可行动告示。大结果按 T003 可读 reference 续读，不能重新提取或借历史产物。
6. 有效 field UI 使用 source-backed 紧凑字段行，原 JSON 按需展开；正常与窄窗口核对层次、缺失/不确定表达、当前产物来源与继续读取。界面不添加表单卡片或常驻空面板。

Source gate 为批准 Task 的命令：`pnpm exec vitest run apps/desktop/test/browser-structured-output.test.ts --maxWorkers=1` 与 `node apps/desktop/scripts/verify-browser-structured-output-mutations.mjs`。结论及源码身份保存在对应 evidence receipt，不能将本设计当作通过结果。变异至少断开缺失状态、默认值禁止、来源绑定、扫描预算与 T003 登记；恢复须 GREEN，并另核对定义文件之外的真实产品调用者。

完整 `browser-structured-output.v1` document 包含 request、实际 source、fields 与 work，只登记到 T003 唯一 Store。receipt 仅带有界摘要：超过 256 UTF8 bytes 的值明确 `inline:false`、省略 value 并提供 preview，不能用 preview 判成果条件。缺失和类型错误不补值，page-changed 不把旧字段登记成当前值，登记故障保留已观察字段及 warning。原始字段继续通过现有 readResult 有界读取；没有第二 schema/store 或 LLM Runtime。

实际 DOM/layout/UI 场景需经真实 Browser 生产入口，页面变更有反例，采图后由独立 Agent 打开完整 PNG。合成 CDP 响应、happy-dom 和 source tests 只证明各自范围，不证明原生 Browser、真实用户 Agent、布局或性能；不能提前签 T008 done。
