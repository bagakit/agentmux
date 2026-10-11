# 配置远端应用授权同步

应用授权同步用于把一个明确应用账户的指定 scope 从来源传给目标，并由目标应用验真。行为边界归[应用授权同步](../design/behavior/remote-application-access.md)；准确公共类型与机器解析归 [application-access.ts](../../packages/core/src/application-access.ts)，执行与原操作归 [application-access-owner.ts](../../packages/core/src/application-access-owner.ts)。下面的命令须连接已经启用该 owner 的原 endpoint；不读取秘密的清单不会启动 Runtime。

## 准备连接器

双方需要 POSIX 执行环境、已登记的准确 Host，以及用户安装或编写的应用连接器可执行程序。连接器实现自己的应用官方授权协议，不能用任意目录复制或一个“已授权”布尔值代替。Core 提供通用命令承载，不内置某个外部应用已经支持迁移的承诺。

在 Settings → Remote → Environments → Apps & access 配置来源、目标、双方 Runtime ID 和实际执行的 OS 账户，再配置固定 executable / argv、期望应用账户 ID 和最小 scope。使用绝对可执行文件路径；每个参数是独立字符串。argv 与普通配置不用于存 token 或密码，也不接受操作调用临时指定另一条 shell 命令。Host / Runtime 绑定沿原配置和身份核验，OS 账户由准确执行环境的 `/usr/bin/id -un` 读取；应用账户由连接器核验。

## 公共命令

以下 JSON 中的 ID、账户、命令和 scope 均应换成自己的准确配置；`expectedRevision: null` 只创建不存在的配置。修改时先读取当前修订，以该修订保存。

```json
{
  "expectedRevision": null,
  "profile": {
    "label": "Project application access",
    "applicationId": "project-service",
    "source": {
      "hostId": "local",
      "runtimeId": "source-runtime-id",
      "osAccount": "source-user",
      "command": "HOST_CONNECTOR_EXECUTABLE",
      "args": []
    },
    "target": {
      "hostId": "build-host",
      "runtimeId": "target-runtime-id",
      "osAccount": "build-user",
      "command": "HOST_CONNECTOR_EXECUTABLE",
      "args": []
    },
    "accountId": "stable-application-account-id",
    "scopes": ["project:read"]
  }
}
```

```sh
amux settings applications ls --host build-host
amux settings applications configure project-access --input connector.json
amux settings applications plan project-access --revision CURRENT_REVISION
amux settings applications apply project-access --plan ORIGINAL_PLAN_ID --operation-id ORIGINAL_OPERATION_ID
amux settings applications operation ORIGINAL_OPERATION_ID
```

清单返回相关配置的最近操作和全部未决操作，含已删除配置的未决结果。`plan` 只读取双方的身份、scope 与修订；先核对其差异，再由用户显式 `apply`。配置保存、删除及执行只接受传输实际认证的 user；Agent 不能通过 JSON 字段自称用户批准。只读请求仍需要原传输认证。

目标已经以期望账户拥有所需 scope 时走 `reuse`，独立验真后成功，不复制材料。目标是另一账户时显示冲突，不覆盖；不能迁移的应用显示准确目标登录需求。观察未知时重查原观察，不显示为未登录或无授权。

执行回执为 `unknown` 时保留原 operation ID，使用 `operation` 查询。查询只会调用目标原操作查询和验真，绝不重新导出或导入；换 ID、改配置或删配置不能绕过同目标应用范围的未决操作。`imported` 与 exit 0 均不能替代准确账户和所有 scope 的目标验真。

```sh
amux settings applications delete project-access --revision CURRENT_REVISION
```

删除配置只停止本产品管理，不删除目标凭据、不注销上游账户，原操作仍可查询。实际移除材料或撤销服务端授权，需要具体应用独立提供准确合同。

## 命令连接器机器协议

每次固定命令从 stdin 读取一个 JSON 对象，stdout 只输出一个 JSON 对象；日志写 stderr，但服务不会把原始 stdout / stderr 传给界面或错误。所有请求和响应都有 `schema: "agentmux.application-access.v1"`、准确 `action` 和 `applicationId`。请求还带期望 `accountId` 和已排序的 `scopes`。连接器须拒绝其他 schema、应用或不支持的 action。

| action | 请求的额外字段 | 响应的额外字段与责任 |
| --- | --- | --- |
| `inspect` | 无 | `status` 为 `ready` / `login-required` / `unsupported`；`accountId` 为稳定 ID 或 null，`scopes` 为已确认列表，`revision` 为准确应用配置修订，`transferable` 为是否能按本协议迁移。目标为空但可以导入时返回 `login-required`、null 账户、原修订和 true。只读，不导出材料。 |
| `export` | `expectedRevision` | `accountId`、本次准确 `scopes`、原 `revision`、私密 `materialBase64`。导出前核原修订与账户，只包含本次 scope 的最小材料；应用自身若无法按 scope 限定则不可声称支持。 |
| `import` | `operationId`、`intentDigest`、`expectedRevision`、`materialBase64` | 原 `operationId`、`intentDigest` 及 `status: "imported"` / `"rejected"`。按原 ID 持久记账、守准确意图和目标 CAS，保留其他账户与无关配置。rejected 必须是确认未应用该导入；不能把不确定结果改称拒绝。 |
| `operation` | 原 `operationId`、`intentDigest` | 原二字段及 `status: "imported"` / `"rejected"` / `"unknown"`。只读原操作，不通过重做导入来查询。来源或完成事实不足保持 unknown。 |
| `verify` | 无 | 与 inspect 相同的结构，但必须以目标应用真实协议确认当前账户与所选 scope。导入成功记录不代签可用；account 和 scopes 不完整时不能返回虚假 ready。 |

连接器原始导出材料仅在 Core 内存和目标 stdin 之间传递，不在配置、计划、操作 journal、普通 RPC 或 Renderer 中出现。单次解码材料限定为 4 MiB，命令 stdout / stderr 合计限定为 8 MiB，以保护本次内存分配；超过时仅拒绝本次同步，不将应用或 Agent 判为死亡。Core 不保证应用自身具有 exactly-once 导入，也不保证操作系统内存的安全擦除；连接器须遵守自身的事务、重复请求和敏感内存合同。

可取消一次调用的观察；导入已经可能发出时，取消不证明撤回，也不授权新 ID 重放。连接器丢回执后，先让原 `operation` 给出准确结果，再由 `verify` 确认目标。若目标本来可复用，原操作查询只重新验真，不要求凭空存在一个导入记录。
