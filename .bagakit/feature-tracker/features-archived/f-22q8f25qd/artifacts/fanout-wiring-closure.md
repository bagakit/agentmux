# f-22q8f25qd 扇出竖切闭合（T-006 前置）

日期：2026-08-29
执行者：主 session
起因：独立审查发现扇出的执行半边没有任何用户入口

## 缺口

`planFanOut` / `runFanOut` / `keepOneOfFanOut` / `removeWorktree` 四个原语都实现完整、
共 37 条单元断言全绿，但**全部零生产调用者**：contracts / preload / ipc / store 四层
grep `fanOut` 均零命中。展示半边（`fanout-group.ts` → `FanOutStrip.tsx` →
`WorkspaceBoard.tsx:212`）是活的，所以 Board 能识别扇出分组——但没有任何途径创建它们。

用户既无法发起一次扇出，也无法执行「留一路」。

## 为什么单元测试全绿却漏掉了

单元测试用 mock ports 驱动 `runFanOut`，这在**接线根本不存在**时同样通过。
测试证明的是"这个函数逻辑对"，不是"这个函数会被调用"。
判 done 需要额外一步：`grep -rn "<symbol>" src | grep -v test`，零命中即未接通。

## 处置：先写红测试，再接线，最后变异验证

1. **红测试**：新建 `apps/desktop/test/fanout-wiring.test.ts`，逐跳断言四层接线存在，
   并特别断言 handler 里出现 `planFanOut(`——因为"名字与路径只有一个出处"正是该模块存在的理由。
   接线前 **4 failed**。

2. **接线**（全部最小加法，未重排任何既有代码）：
   - `contracts.ts`：`RunFanOutInput` / `FanOutLaneOutcome` / `RunFanOutResult` /
     `KeepOneOfFanOutInput` / `FanOutTeardownResult` / `KeepOneOfFanOutOutcome`。
     逐路结果**沿用 runFanOut 已有的三态**（launched / launch-failed 带 worktreeRetained /
     worktree-failed），不新造第二套语汇。
   - `preload/index.ts`：两个 invoke。
   - `ipc.ts:220`：handler 依次 `planFanOut` → `runFanOut`，ports 由真实
     `worktrees.createForBranch` / `runtime.launchAgent` / `worktrees.removeWorktree` 构造。
     **handler 内不拼分支名与路径**，只传 `join(workspace.path, '.worktrees')` 作为根，
     具体命名全部由 planFanOut 推导。plan 的 `rejected` 原样回传不吞，`single` 原样回传
     （一路不是比稿，该走普通启动路径）。
   - `store.ts:1081`：两个 action。**部分失败既不当整体失败也不当整体成功**——
     成功的那几路照常存在，失败的经既有 `reportError` 具名浮现；
     `keepOneOfFanOut` 把 `retained`（脏树被拒、留在磁盘）如实报出，不静默丢弃。
   - `api.ts` 的 web preview mock：`runFanOut` 直接 `rejected`——预览环境没有 git 也没有进程，
     伪造一组"已启动"的 lane 比不回答更糟。

3. **接线后** 41 passed（wiring 4 + plan 11 + run 11 + group 15）。

4. **变异验证**：把 handler 里的 `planFanOut(` 换成内联字面量（模拟绕过唯一命名出处）
   → **1 failed | 3 passed**。已还原并 diff 确认逐字节一致。

5. **零调用者检查**（判 done 的硬标准）：四个原语现在的生产引用数分别为
   planFanOut 3、runFanOut 8、keepOneOfFanOut 8、removeWorktree 8，均 > 0。

## 全仓状态

`pnpm --filter @agentmux/desktop typecheck` 通过；`pnpm test:fast` **1298 passed**
（唯一失败是已知的 workspace-files symlink flake，单独跑 22/22 全过）。

## 仍属 T-006 范围、尚未完成

renderer 侧的**发起入口 UI**（让用户填 count/prompt 发起扇出）与「留一路」按钮尚未落到具体组件上。
store action 与 IPC 已就绪，缺的是调用它们的那个界面元素。在那之前 T-006 不应判 done——
按交互合同 :132 的标准，端到端可达才算竖切完成。

---

## 补充：留一路的用户入口（T-006 acceptance #1）

接线完成后仍缺"用户可指定保留一路"的界面动作——IPC 与 store 就绪，但比稿面只能读、不能收敛。

### 交付

- `FanOutStrip.tsx` 的每条 lane 旁增加一枚 Keep 控件（分组只有一条 lane 时不出现——
  保留唯一一条不拆除任何东西）。可访问名说的是**它对其余各路做了什么**：
  `Keep z-1 and remove the other 2`——只写 "Keep" 会隐藏这个决定真正有后果的那一半。
- 无 Agent 的 lane 同样可被选为胜者：它的 worktree 存在，可以在里面继续。
- 样式上 Keep 保持安静、hover 才提亮：它会拆掉其余各路，不该在读比稿时被误触。
- `WorkspaceBoard.tsx:217` 接到 `store.keepOneOfFanOut`，脏树保护由既有原语承担，
  被拒的那一路经 store 的 reportError 如实报为 retained。

### 一个我自己犯的错，值得记下

第一版把"胜者不在拆除名单里"这条断言写在了**组件测试**里，用 `fanOutGroups` 的输出
自己算了一遍 split 再断言——但组件真正传给回调的值它根本没碰。
变异验证立刻拆穿：删掉组件里的 `.filter(...)` 排除胜者（即"拆掉用户刚选中的那一路"
这个最严重的数据丢失缺陷），**17 个测试全绿**。

因为 SSR 渲染无法触发 onClick，断言够不到回调。修法不是硬凑，而是**把 split 提成纯函数**
`fanOutKeepSplit(group, keepWorkspaceId)`（fanout-group.ts），组件只调用它：

- 胜者不在 removeWorkspaceIds 里
- 只列本分组的 lane（同时跑两个扇出时不越界拆别人的）
- 传入不属于该分组的 lane 返回 null（否则会退化成"删掉所有"）

重跑同一变异：**2 failed | 17 passed**。已还原并 diff 确认。

教训与本轮其他几处一致：**断言要打在被测代码实际产出的那个值上**。
在自己算一遍再断言，测的是测试自己，不是实现。

### 现状

`pnpm --filter @agentmux/desktop typecheck` 通过；扇出四个测试文件 45 passed；
`pnpm test:fast` 1271 passed / 0 failed。

T-006 尚缺：**发起**扇出的入口（填 count/prompt 那一步）。
`store.runFanOut` 与 IPC 已就绪，缺调用它的界面元素。收口前须补齐——
按交互合同 :132，用户能发起也能收敛才算端到端可达。

---

## 补充二：发起入口（T-006 端到端可达达成）

### 交付

新增纯函数 `lib/fanout-request.ts`：把用户输入变成一个扇出请求，或说清为什么还不是。
**它不决定分支名与 worktree 路径**——那是 main 从唯一规划出处推导的，
所以界面这半边只剩"请求是否成形""铺在哪几个 executor 上"两个问题。

- `single` 不是错误：一路不是比稿，走普通启动路径。
- 越过 8 路上限**明确拒绝**并给出可读理由，不静默截断。
- prompt 全是标点导致 stem 为空时**拒绝**，不编造占位名——否则每条 lane 会撞同一个名字。
- 未配置 executor、prompt 为空、count < 1 各有明确拒绝文案。

界面：`BranchesPanel` 头部增加发起按钮（**非 git 仓库时不出现**——扇出需要分支，
一个只会失败的按钮回答不了任何问题），点开一个与"创建 worktree"同形的 Dialog。
提交后：`rejected` 就地显示理由并**不关闭**对话框（关掉等于藏起用户没看见的拒绝），
只有真的扇出成功才关闭；部分失败已由 store 在共享错误面具名报出。

### 变异验证

- 去掉上限拒绝 + 用占位名代替空 stem 拒绝 → **2 failed | 9 passed**。已还原并 diff 确认。
- 之前记录的 keep-split 变异 → **2 failed | 17 passed**。

### 端到端可达（两个用户手势都追到 main）

**发起**：BranchesPanel:232 按钮 → Dialog → `buildFanOutRequest`（纯校验）→
`store.runFanOut`:1081 → preload:55 → `ipc.ts:220` → `planFanOut` → `runFanOut`。

**收敛**：FanOutStrip:54 Keep 控件 → `fanOutKeepSplit`（纯拆分，胜者绝不在拆除名单）→
`WorkspaceBoard.tsx:217` → `store.keepOneOfFanOut`:1109 → preload:56 →
`ipc.ts:268` → `worktrees.keepOneOfFanOut`（脏树保护由既有原语承担）。

### 门禁

`pnpm check` **全绿**：typecheck + **1285 passed** / 0 failed / 3 skipped + build 成功。
扇出五个测试文件 **57 passed**。

至此 T-006 acceptance #1「用户可指定保留一路」与交互合同 :132
「端到端可达：用户能发起、也能收敛」均已满足。
