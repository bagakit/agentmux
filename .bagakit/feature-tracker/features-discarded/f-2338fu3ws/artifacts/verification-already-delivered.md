# f-2338fu3ws 核实：缺陷已在本轮别处交付

日期：2026-08-29
核实者：主 session
方法：读代码 + 实测变异验证

## 用户原话

> 一个 executor 是否是 installed 不应按 command 匹配而应按 provider 匹配吧？
> 现在如果我改了 command，它就会变成 not installed

## 核实结论：缺陷已修，无需再动代码

`packages/core/src/agent-provider.ts:538` 现在是：

```ts
const command = executable(commandOverride, catalog.executable)
installed: await probe.hasExecutable(command)
```

`executable()`（`:471-475`）取**用户配置的 command**，仅在其为空时回落到 catalog 默认值。
`hasExecutable`（`client.ts:344-356`）对含 `/` 的路径直接 `access(X_OK)`，
否则按 `PATH` 逐项查找。

即：**改成 `/opt/wrappers/my-claude` 这样的 wrapper 脚本，只要它存在且可执行，
就如实报 installed**，不再因为「字符串不等于硬编码的 `claude`」而报 not installed。
用户描述的症状已消失。

## 关于「按 provider 匹配」这个措辞

用户原话建议「按 provider 匹配」。核实后**没有照字面实现**，理由：

按 provider 匹配意味着「只要这个 provider 存在于目录里就算 installed」——
那会走向另一种不诚实：用户把 command 指到一个**不存在**的路径时，
界面仍会说 installed，直到启动失败才暴露。

真正的目的是「**别因为我改了 command 就骗我说没装**」。现有实现精确满足这个目的：
判定跟踪**用户实际配置的那个可执行文件**，既不硬编码 provider 默认值，也不做字符串相等比较。
两个方向的诚实都保住了。

## 测试与变异验证

`packages/core/test/agent-provider.test.ts:343` 覆盖三种情形：
配到存在的 wrapper → installed；配到不存在的路径 → not installed；
不配（回落默认）→ 按默认值探测。并断言**实际被探测的字符串**是配置值而非 catalog 默认值。

变异验证：把 `:538` 改成恒取 `catalog.executable`（即恢复用户报的 bug）
→ **2 failed | 39 passed**。已还原并 diff 确认逐字节一致。

## 处置

本 feature 的目标已由本轮其他 feature 的交付顺带满足，代码与测试均已就位。
按项目原则「不做无意义的熵增」，不再为它单独拆任务、不再重复实现。
以 discard 收口并记录本核实，使日后审查可追溯"为什么没有独立的实现记录"。
