# 读取远端环境的网络信息

网络观察用于了解一条已保存 Host 路由的当前 SSH 配置、Owner 请求耗时与各来源的接口地址。范围见[Remote 网络观察](../design/behavior/remote-management.md#所选-host-的只读网络观察)，准确结果结构见 [Host 网络公共类型](../../packages/core/src/host-network-observation.ts)；配置解析不能证明实际物理路径。

## 选择准确环境

先连接原业务 endpoint，读取它已登记的 Host，再沿返回的准确 ID 查询。Host ID 属于该 endpoint；远端业务服务中的 `local` 不一定是运行 CLI 的电脑。

```sh
amux settings hosts ls
amux settings hosts network --host HOST_ID
```

`HOST_ID` 要替换成原清单中的 ID。查询使用已保存配置，不能用未提交表单代替；它不会修改路由、保活策略或 Session。GUI 入口为 Settings → Remote → Environments，选中环境后进入 Overview → Network，点击 Read link；后续用 Refresh 重新读取。网络区手动读取，不自动轮询，与命令消费相同事实。

## 理解来源与缺口

- 观察端接口来自组合结果的服务进程所在网络命名空间；目标接口来自已核验原语义 Owner 的命名空间，两者分别阅读。
- Owner 请求耗时只包裹本次原公开调用，可能包含建连、排队和处理；它不包含 SSH 配置求值，不是纯网络 RTT 或 ICMP Ping。
- SSH 信息是本次系统配置求值。目标、用户、端口、ProxyJump 顺序与保活策略不证明现有连接采用了相同配置；自定义代理的内部路径保持不透明。本机路由没有 SSH 策略。
- 当前读取不采集 DNS 候选。接口地址不证明活跃 socket、各级实际连接 IP 或公网出口；实际物理路径、逐跳时延与丢包也保持未知。

某个来源失败时先读它的具名原因；其他已确认来源仍有效。可再次沿同一 Host 核对；读取失败不要求重建连接或重放输入；上次已确认旧值不能当作本次正常。完整连接 Test 与网络查询各有自己的范围，不能相互代签。

## 直接读取原 Runtime 接口

直接读取时，CLI 应连接到目标语义 Runtime 的原服务 endpoint，并持有该服务的准确 Runtime 与 Owner 代次；管理 endpoint 的另一个 Host 不能代替该目标。传输已认证的 user/device 可调用下层只读叶：

```sh
amux --endpoint RUNTIME_ENDPOINT runtime network inspect --runtime RUNTIME_ID --owner OWNER_INSTANCE_ID
```

`RUNTIME_ENDPOINT` 与两个 ID 都要替换为目标原服务的准确值；身份来自原公开 Owner 事实，不从 Host 名称或地址猜测。代次变化时先沿原身份入口重新核验，不能为读取方便省略 fence。受管 Agent 使用已认证的 Host 聚合查询；来源 Agent 凭据不能当成目标 Runtime 的 Agent 身份，直接 runtime 域的授权边界不会因此放宽。

命令的实际参数、发现与结果以当前执行版本的 help 及[公共能力入口](../specs/public-capabilities.md)为准。本指南不提供公网探测、网络扫描、自动改写配置或跨 Host 通用权限。
