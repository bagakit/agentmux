# Goals reading and intake capture

入口：真实 App → Goals → List/Board → Goal → More properties / Execution → Back → New Goal。采用两份设计 SSOT 中《Goals 的 Grill 与 Grounding》《Goals 的目标正文与对齐密度》。

场景：多个当前目标、done历史、长意图正文、宽窗并置详情、属性/执行按需展开、单轨横向看板、620px详情与返回、真实意图输入与Escape焦点、空态。观察清晰阅读单位、低工具带、非颜色选择、连续正文、渐进属性、无重复目标坞或默认终端。

数据边界：preview API初始化后注入确定的Goal fixture；App和组件/CSS真实，输入点击与键盘来自私有Electron的CDP。原preview Session控制身份前后核对；未触碰用户App或Run。不证明CLI/Native、Mote真实送达、Grill/Grounding认可或重启（由完整候选单独验收）。采图成功只证明采图，独立Agent实际看完整图后才可判审美。

运行：`node apps/desktop/scripts/verify-goals-surface.mjs`。输出私有编译身份、截图、render.json、receipt.json和review.md。
