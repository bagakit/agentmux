# Goals reading and intake capture

入口：真实 App → Goals → List/Board → Goal → More properties / Execution → Back → New Goal。采用两份设计 SSOT 中《Goals 的 Grill 与 Grounding》《Goals 的目标正文与对齐密度》。

场景：多个当前目标、done历史、长意图正文、宽窗并置详情、属性/执行按需展开、单轨横向看板、620px详情与返回、真实意图输入与Escape焦点、空态。观察清晰阅读单位、低工具带、非颜色选择、连续正文、渐进属性、无重复目标坞或默认终端。

数据边界：preview API初始化后注入确定的Goal fixture；App和组件/CSS真实，输入点击与键盘来自私有Electron的CDP。原preview Session控制身份前后核对；未触碰用户App或Run。不证明CLI/Native、Mote真实送达、Grill/Grounding认可或重启（由完整候选单独验收）。采图成功只证明采图，独立Agent实际看完整图后才可判审美。

运行：`node apps/desktop/scripts/verify-goals-surface.mjs`。输出私有编译身份、截图、render.json、receipt.json和review.md。

T3 adds actual App views of a current proposal, unresolved choice, confirmed target, complete report, explicit gap acceptance, unknown result, stale earlier accepted report, normal acceptance, accepted gaps, and an actual failed-confirmation service window. Wide + 620px key reading states are captured. Proposal/report/acknowledgement facts are deterministic fixture data; the receipt-failure transport intentionally rejects. These images do not prove native persistence or real Agent evidence contents; the mounted workflow suite uses the unique real durable owner for acknowledgements.


Feature f-2f88faqnf adds ordinary Goal / Results language, one compact clarification block, an explicit confirmed/no-report reading state, three Done/no-report combinations, a persisted report without a current target, and real store request failure feedback. The delivery-failure scenario rejects only the preview scratch ensureTopic transport: the product request method runs, and the saved Goal is retained. It does not prove a real model received anything. The normal and narrow confirmed/no-report, incomplete-record report, Done/confirmed and delivery-failure views are captured in addition to the existing evidence/gap/stale states. Open discussion only opens; Clarify goal / Discuss changes send a goal request; Ask agent sends the existing result-check request. Screenshots need independent comprehension review; receipts are capture evidence only.

R1 revisits the unconfirmed acknowledgement through actual App navigation: wide and 620px detail, Back to goals, wide and 620px list, then reopen the detail at 620px. The primary recovery is Reload current proposal; the same retained feedback supplies the row's next step, while clicking that row only opens the goal. The normal fixture still rejects confirmation without persisting it; successful owner writes followed by lost transport receipts are verified separately in the mounted durable-owner workflow tests. The 38 captured frames do not imply reload or confirmation succeeded.
