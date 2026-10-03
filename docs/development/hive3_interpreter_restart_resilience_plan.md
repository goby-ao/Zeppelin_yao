# Hive3 解释器重启卡死治理方案

日期：2026-09-29

状态：原始设计记录。2026-10-04 已实现精简版并做本地定向验证，未上线。
实际实现、测试及发布边界见 [实现说明](hive3_interpreter_restart_implementation.md)。
下文的 operationId、可查询状态、完整代际协议属于设计选项，本次未引入；
当前复用同步 REST/Thrift，以关闭 Future 去重、实例隔离和错误状态码满足本次故障治理。

范围：Zeppelin 0.9.1-SNAPSHOT 当前分支，以及本次 Hive3 JDBC 关闭阻塞故障。

## 1. 结论与目标

不能把“重启解释器”实现为“同步等所有资源关闭完”，也不能仅给等待线程增加超时。

推荐采用四项配套改造：

1. **关闭阶段有截止时间，超时能真正中断本地 JDBC 网络等待。** 优先正常 CloseSession；失败后只释放目标连接，不默认终止 JVM。
2. **关闭时不持有解释器组公共锁。** 通过明确的关闭状态和代际隔离保护并发，而不是直接删除 synchronized。
3. **解释器列表等元数据读取不触发实例创建。** 故障组不能拖住设置页面、其他笔记和其他用户。
4. **重启操作有可查询的状态。** 区分正常关闭、本地已释放但远端未确认、仍未释放，不能把超时包装成成功。

这能针对本次“JDBC CloseSession 不返回”故障建立无需 kill 的恢复路径。若 JVM 已经无法响应、驱动不能中断网络等待，或旧执行线程无法退出，仍需保留进程级最终处置，不能承诺任何故障都不需要 kill。

最重要的边界：**本地连接已断开，不代表 HS2 会话、Tez Application 或正在执行的 SQL 已经停止。** 不自动重放 SQL，不允许用户把“重启完成”理解为写入已回滚。

## 2. 本次故障的证据链

### 已确认

| 环节 | 运行证据 | 判断 |
| --- | --- | --- |
| Zeppelin 重启入口 | 13:47:17 收到 hive3 重启；13:47:18 开始关闭 shared_session | 进入了真实关闭流程，不只是按钮失效 |
| Zeppelin Server | 两份线程栈中，重启请求持有同一 ManagedInterpreterGroup 锁，并在 Thread.join 等待 | 关闭等待被放在公共锁内 |
| RemoteInterpreter-close | 两次都在 Thrift recv_close / socketRead0 | Server 在等解释器 JVM 的 close 返回 |
| 元数据读取 | 每份 Server 栈有 40 个线程等待该组锁，包括解释器绑定读取 | 单个解释器关闭异常被放大为页面功能阻塞 |
| hive3 解释器 JVM | 两份栈均为 JDBCInterpreter.close → DBCP 关闭连接池 → HiveConnection.close → recv_CloseSession | 真正未返回的是 Hive JDBC CloseSession |
| 连接 | 解释器连接到 HS2 的 10000 端口，TCP 仍为 ESTABLISHED | TCP 存活不代表应用层请求有进展 |
| HS2 | 同一用户在 13:47:18,739 出现 Closing tez session if not default | CloseSession 对应的资源清理很可能已经进入 Tez 关闭流程 |
| 恢复 | 用户终止自己的旧 hive3 解释器 JVM 后出现新 JVM，页面恢复 | 断开旧链路能解除等待；不是必须重启整个 Zeppelin Server |

链路如下：

```text
用户点击重启
  -> Zeppelin REST 同步关闭解释器组
     -> 持有组锁，等待 RemoteInterpreter-close 线程
        -> 解释器 JVM 关闭 JDBC 连接池
           -> Hive JDBC 发送 CloseSession，等待 HS2 回包
              -> HS2 清理 session / Tez / 其他资源，迟迟没有返回

同一组的绑定查询、实例获取等请求
  -> 等待上述组锁
     -> 页面列表空白、重启看似失效、请求继续积压
```

### 尚未确认

- 用户反馈当时 YARN 资源满载，这是重要线索，但不能证明资源满载直接造成 CloseSession 卡死。
- 没有当时 HS2 线程栈，无法确定最终停在 Tez AM RPC、RM 调用、会话锁、预热任务回收还是 HDFS 清理。
- “出现新解释器”可能是原重启请求解除阻塞后，下次访问按需创建，不足以证明有独立自动拉起机制。
- `shared_session` 是解释器组内部的会话标识。本次进程组为 `hive3-chenyao_yy`，不能据此扩大为所有用户共享同一个 JVM。
- 本地 Hive/Tez 源码与栈相吻合，但上线前仍须核对实际加载 JAR 的路径、版本和校验值。

因此，方案先修复已证实的无限等待和锁放大机制，不依赖猜中 HS2 内部的唯一故障点。

## 3. 设计约束

- 正常 SQL 的执行、取数超时策略保持不变，不能用全局短 socket timeout 误伤长查询。
- 只关闭本次操作实际拥有的 session、连接池和物理连接。共享进程内不能误关其他会话。
- 关闭一旦被接受，该作用域立即停止接收新的执行；不排队等待后自动执行旧 SQL。
- 旧实例未完成本地隔离前，不能提前创建新一代实例。
- 关闭成功、失败和重复调用均应可收敛；同一作用域同时最多一个重启操作。
- 所有等待、重试和子资源清理共享预算，不能按连接数或解释器数量成倍累加超时。
- 超时线程必须能够实际退出，或进入有界隔离且停止继续提交，不能无限积累后台任务。
- 不修改笔记文本、运行参数、历史结果和用户已有解释器绑定。
- 不把重启等价于事务回滚；对执行结果不确定的写操作要求先核查远端状态。

## 4. 改造 A：解释器生命周期与锁

### 4.1 短临界区，网络操作放到锁外

主要涉及 `ManagedInterpreterGroup`、`InterpreterSetting`、`RemoteInterpreterServer`。

推荐流程：

1. 在短锁内校验权限及真实作用域，登记操作，标记 CLOSING，取得旧 session/资源快照。
2. 释放锁，在受限关闭执行器中停止调度、关闭解释器和连接。应用 unload 也必须受预算约束。
3. 在短锁内核对操作标识和实例代际，再登记关闭结果、移除已关闭实例或保留故障记录。

读列表只读取元数据；执行请求遇到 CLOSING 立即返回“正在重启”，不进入同一把锁无限等待。

不能只把 `synchronized close()` 改成普通方法。否则关闭期间 `getOrCreateSession()` 可能再次创建实例，旧关闭任务又删除新实例。

### 4.2 用少量明确状态维护安全边界

```text
ACTIVE -> CLOSING -> CLOSED
                    CLOSED_WITH_WARNING
                    CLOSE_FAILED

CLOSED / CLOSED_WITH_WARNING -> 用户下一次明确执行时按需创建
CLOSE_FAILED                -> 保留隔离，不自动新建或重放 SQL
```

- `CLOSED`：本地执行已终止、连接已释放，远端正常确认关闭。
- `CLOSED_WITH_WARNING`：本地执行已终止、连接已释放，但 HS2 清理未确认；不是远端清理成功。
- `CLOSE_FAILED`：不能证明本地已安全释放。即使 HTTP/RPC 已超时，也不能移除故障记录后假装成功。

重启操作另有 operationId，用于查询和去重，不再维护一套复杂、独立的执行状态机。

内部资源归属至少包含 setting、实际 group/session 和实例代际。旧回调只能更新旧实例，不能覆盖新实例的注册、结果或重启状态；优先在现有进程注册与事件分发边界校验代际，不大范围改写普通业务事件。

### 4.3 所有关闭入口复用同一逻辑

按钮重启、会话过期、删除解释器和进程 shutdown 都要经过同一关闭控制。尤其要处理 `ShutdownThread` 再次关闭解释器的路径，避免第一次退出后又在 shutdown 中卡住。

关闭线程和队列都设上限；队列满时明确拒绝新任务，不能退回 HTTP/WebSocket 请求线程执行阻塞关闭。截止时间调度与阻塞关闭不能共用一个已经耗尽的线程池。

现有 `ExecutorFactory` 使用的定时线程池并不提供有界工作队列，不能把“复用现有执行器”当作已解决积压问题。只为关闭控制增加必要的受限执行器，不改造整个调度框架。

## 5. 改造 B：真正解除 JDBC 关闭阻塞

这是本次无需 kill 恢复的核心，必须先完成可行性验证。

### 5.1 驱动兼容性是前提

本地 HDP Hive3 源码中：

- `HiveConnection.close()` 先调用 `client.CloseSession()`，最后才在 finally 里关闭 transport。
- `Connection.abort(Executor)` 未实现，直接抛 `SQLFeatureNotSupportedException`。
- `Connection.setNetworkTimeout(...)` 同样未实现。
- Thrift 客户端使用锁串行化调用；若 abort 仍走这个客户端锁，就无法解开正在阻塞的请求。

因此，不能直接调用 JDBC 标准接口后就宣称问题解决。Zeppelin 编译依赖的 Hive JDBC 版本与 hive3 实际外置驱动也不是同一回事。

**推荐明确路线：核对现场驱动后，为当前实际使用的 Hive3 JDBC 客户端补齐本地 abort 能力，再由 Zeppelin 控制关闭截止时间。** 这首先是客户端 JAR 改造，不要求先修改整个 HS2 集群。若选择替换为已有实现的新驱动，也必须通过同一套兼容性测试，不能直接升级全套依赖。

### 5.2 驱动本地 abort 的要求

实现 `HiveConnection.abort(Executor)` 的目标是只终止该连接的本地通信：

- 按 JDBC 约定处理 executor、权限和关闭状态，使重复 close/abort 幂等。
- 阻止该连接再发起新请求，异步关闭其拥有的底层 socket/transport。
- 不发送另一次 CloseSession，不等待正在执行的 Thrift 客户端锁，不依赖对方回包。
- 已阻塞的 CloseSession、执行或取数应因底层连接断开而退出，最终释放本地状态。
- 普通 close 成功时取消对应截止任务，清理物理连接登记，不留下定时任务或强引用。
- 本次优先验证实际使用的 Binary/SASL 路径；SSL 路径单独验证。HTTP 模式必须验证 HTTP 请求取消和连接释放，未验证的模式不得启用该保证。

不能通过反射访问私有 transport 作为生产默认实现，也不能通过普通逻辑连接的 `close()` 代替物理 abort：逻辑连接 close 可能只是归还连接池。

### 5.3 Zeppelin 负责关闭预算与连接归属

在现有 `ConnectionFactory` 创建物理连接的边界登记连接，按 session/代际管理。登记覆盖空闲和借出的连接，销毁时注销；关闭期间创建完成的连接也必须检查代际，直接进入退役流程，不能遗漏。

关闭流程：

1. 禁止目标作用域新建/借用连接，取得所有拥有的物理连接和 statement 快照。
2. 从开始关闭时就安排截止保护，再尝试正常取消、关闭 statement/resultset、关闭连接池。
3. 达到正常关闭预算时，对仍未释放的目标物理连接调用经过验证的本地 abort。
4. 确认阻塞调用已退出、旧执行已停止、本地连接已不可复用，再注销资源；否则保留 CLOSE_FAILED。
5. 汇总远端确认情况，不能在 catch 中仅打印日志后向上返回正常成功。

必须先安排保护再关闭 statement，因为卡点也可能出现在 CloseOperation、cancel 或结果集关闭，而不只出现在 CloseSession。

本地断链后，同一个 HS2 操作仍可能运行。只有本地执行已终止且远端风险被记录时才能进入带警告的关闭状态。普通读取场景可由用户明确发起后续操作；有状态不明的写 SQL 时，提示先核查，不自动补跑。

### 5.4 同时补上必要的连接池清理缺口

当前 `initConnectionPoolMap()` 只显式关闭每个用户的 `DEFAULT_KEY` 池，然后清空池映射。存在其他 dbPrefix 时，不能用“映射清空”代替“池已关闭”。

应遍历该实例实际拥有的所有池；每个池有明确关闭结果。失败资源保留在退役记录中，不提前丢失引用。池名和注册关系按实例归属核对，不扩大到其他用户或其他实例。

`maxWaitMillis` 是借连接等待，`maxConnLifetime` 是连接寿命，都不是 CloseSession 的截止时间，不能作为本次主修复。

## 6. 改造 C：管理 RPC 和进程停止也必须有界

### 6.1 只约束管理调用

当前 `RemoteInterpreterProcess` 创建 TSocket 时没有设置本次关闭所需的读截止；`connectTimeout` 也不能当作 close/read timeout。

首版建议关闭、停止使用独立的短生命周期管理连接，具备连接/读取超时，并受整个管理调用的截止控制；不要把短超时全局设置到运行 SQL 的客户端池上。

- 到期主动关闭该管理连接，使本地 RPC 读取退出，而不只是停止 Future 等待。
- 不复用超时/协议状态不明的连接，防止迟到回包污染后续调用。
- 不自动重试已经发出的 close/shutdown；结果未知时查询同一个重启操作。
- 管理 RPC 断链不等于解释器侧 JDBC 已释放，仍需解释器侧独立截止保护。
- close 只能查找已有进程，不能通过 getOrCreate 路径为“关闭”新建一个进程。

保留普通执行 RPC 行为，只定向修复管理调用，不顺手改动所有 RPC 的重试语义。

### 6.2 关闭结果必须能向上传递

保留现有 Thrift close 接口，建议给现有 `InterpreterRPCException` 增加可选的关闭错误码、阶段和 `localClosed` 字段，兼容旧 wire 字段；正常完全关闭仍正常返回。

例如，本地释放成功、远端未确认时，返回可识别的关闭警告。调用方只能在明确收到 `localClosed=true` 且符合状态约束后退役旧实例，不能根据异常文本猜成功。

`JDBCInterpreter` 和 `RemoteInterpreterServer.close()` 当前均有吞掉关闭异常的路径，必须配套调整。警告情况下完成本地移除后再上报；真正失败保留隔离记录。

新 server/解释器需配套部署并验证版本能力。旧解释器吞异常或未实现新关闭策略时，只能报告能力受限，不能从一个普通成功回包推断具备新方案的保证。

### 6.3 进程级操作保留为最后一层

当前 `ExecRemoteInterpreterProcess.stop()` 先调用远端 shutdown，再进入等待/launcher.stop。若 shutdown RPC 不返回，后面的兜底可能根本到不了。

优化后的升级路径：

```text
正常关闭 session / JDBC
  -> 到期中断目标 JDBC 本地 transport
  -> 确认本地资源和执行退出，完成关闭或带警告关闭
  -> 若仍失败：保持隔离，展示原因和诊断入口
  -> 对确认属于本次作用域的独占进程，允许受限的正常进程停止
  -> 仍失败且管理员明确确认：最终强制终止目标进程
```

正常进程退出也要有截止时间；不能只给 shutdown RPC 限时，却无限等 launcher 或 shutdown hook。

共享进程不能因为一个 session 失败就自动结束整个 JVM。进程级处置需要核验归属、启动实例和影响范围；不按名称批量匹配，不因旧 PID 复用而误杀。

## 7. 改造 D：列表可用、重启可感知

### 7.1 绑定查询不访问运行实例

`Note.getBindedInterpreterSettings()` 当前会沿着 paragraph 解析走到实例获取，最终争用正在关闭的组锁。

新增明确的纯元数据解析路径供绑定列表使用：依据笔记绑定、默认设置、段落 magic 和权限计算，不调用 getOrCreateSession，也不启动进程。

必须保留以下语义：无 magic 的默认解释器、短名、完整 `%group.name`、别名、绑定顺序、授权过滤，以及 QuickNote 的展示子集与内部完整绑定集合。

同时检查读取笔记后的 Angular 对象同步、Helium 建议等辅助路径。已有实例忙时允许延后，不让这些请求在公共锁上拖住页面；不能因此丢弃持久化的 Angular 状态。

### 7.2 重启采用异步操作查询

保留旧同步接口的有界行为，增加新前端显式使用的异步重启入口：

- 校验、登记后快速返回 operationId，表示“已接受”，不是“已成功”。
- 相同实际 group/session 的重复点击返回已有操作；共享进程的冲突关闭在组级协调。
- 状态查询检查用户权限，不暴露其他用户的连接或 SQL 信息。
- 前端刷新、断线或请求超时后查询原操作，不再发起一轮关闭。
- 操作缓存有数量/时间上限，关闭中的任务不可因普通缓存过期而丢失；服务重启后的状态标为未知并核对，不能虚构成功。
- 旧客户端接口只在真实完成时返回成功；超时返回明确错误及可查询标识。

依赖复制等准备操作不能混在无限等待的重启热路径内；使用已验证依赖，确需更新时作为独立受限准备阶段。

### 7.3 页面显示真实状态

- 绑定列表区分加载中、失败、空列表，不再用空白表达所有情况。
- `ensureInterpreterBindingsLoaded()` 加超时、noteId/requestId 关联及销毁清理；不能等待任意笔记的全局事件。
- 段落和设置面板复用同一重启状态，同一操作期间禁止重复提交。
- 展示真实影响范围，例如“当前用户 hive3 关联的多个笔记”，不能一律写“仅当前段落”。
- 本地关闭但远端未确认时提示：“本地连接已释放，集群会话清理尚未确认。请勿直接重跑状态不明的写入操作。”
- 当前系统按需拉起时显示“旧实例已关闭，下次运行时创建”，不提前显示“新实例已就绪”。

## 8. HS2 / Tez / YARN：降低诱因并处理远端遗留

### 8.1 不把参数调整当成根治

本地 Tez `TezClient.stop()` 仍会访问 AM 并发出 shutdownSession。异步停止主要影响是否等待 Application 最终状态，**不代表整个 stop 没有阻塞 RPC**。

`tez.session.client.timeout.secs` 主要与等待 AM 就绪有关；`tez.client.timeout-ms` 也不是从 Zeppelin 到 HS2 的整条 CloseSession 总超时。不要盲目缩短这些配置后宣称已修复。

YARN 满载可能使 AM 启动/交互变慢，但重启不是解决集群排队的通用措施。应将“排队等待资源”和“解释器通信失效”分开显示，避免用户反复重启制造新的 session/AM。

### 8.2 控制重连与遗留会话

- 同一用户/组同一时间只允许一个创建动作，失败采用有上限的退避；不自动恢复并重放全部排队 SQL。
- 本地断链后登记远端清理未确认记录：用户、HS2 地址、可获得的 session/operation/application 标识及时间。
- 使用日志关联、受限状态查询或运维已有监控确认远端结束，记录数与重试均有界。首版建议每组最多允许一代远端未确认的旧实例；若后续实例再次发生同类故障，暂停继续重建并告警，直到清理确认或管理员处置，不能无限积累。
- 需要处理遗留 Application 时，只处理已核实归属的对象，并单独授权；不能按用户名批量结束所有作业。
- 会话空闲超时可作为补充，但要核对实际配置、是否有打开 operation，以及相关清理线程能否正常工作。

### 8.3 如确认 HS2 关闭阻塞，再做独立服务端改造

本地 Hive3 的 `SessionManager.closeSession()` 是同步方法，会先从会话表移除，再执行 `session.close()`。后者经过 Tez、HDFS 等清理。单靠空闲扫描不能保证补偿已从会话表移除但仍卡住的资源。

下一阶段才考虑：短锁登记逻辑关闭，受限工作队列执行物理清理；保留关闭中记录、按阶段超时和重试；分别观测 CloseOperation、Tez stop、RM、scratch 清理。

这类修改必须验证 doAs/UGI、会话锁、连接配额、shutdown 以及线程上下文，不能简单把 session.close 扔进线程池。远端清理存在活跃写入时，不能直接删除临时目录。建议单独发布，不与第一轮 Zeppelin 修复捆绑。

## 9. 初始预算与可观测性

下列是**拟实现的初始值与测试目标，不是当前已存在的配置或生产保证**：

| 项目 | 建议初值 | 约束 |
| --- | --- | --- |
| JDBC 关闭阶段总预算 | 20 秒 | 前 15 秒尝试正常关闭，后 5 秒用于本地 abort 及确认退出；所有连接共用预算 |
| 管理 close RPC 上限 | 30 秒 | 留出解释器侧清理和回包时间，同时受重启总预算约束 |
| 一次重启关闭操作总预算 | 45 秒 | 到期必须报告明确状态；不承诺所有故障都能在此时成功释放 |
| 绑定请求前端等待 | 5 秒 | 超时显示失败和重试，不清空已有绑定 |
| 正常元数据读取 | 测试环境 1 秒内 | 必须在故障注入时仍达标，再以实际负载测量调整 |

每个进程内部使用单调时钟计算剩余预算；跨进程传递剩余时长，不传递另一 JVM 的 nanoTime。每一步取剩余预算与阶段预算的较小值；新实例启动预算独立，不能与旧实例关闭混算。

最小日志字段：operationId、setting/group/session、实例代际、阶段、开始/结束时间、耗时、结果、仍未释放的资源数量、远端是否确认。保留原始异常原因，不记录密码、完整 JDBC 凭据或默认输出 SQL 全文。

最小监控：关闭耗时与超时数、本地 abort 数、关闭执行器活动/排队数、未释放本地连接数、远端清理未确认数、绑定请求延迟。重点检查重复重启后线程/FD 是否持续增长。

## 10. 实施顺序与交付范围

| 阶段 | 内容 | 验收边界 |
| --- | --- | --- |
| 第一步：驱动验证 | 核对实际 JAR 与 Binary/SASL 模式；用不回 CloseSession 的测试服务验证本地 abort | 确认无需 kill 能让真实网络读取退出；此项未通过不能承诺无 kill 恢复 |
| 第二步：核心修复 | JDBC 物理连接归属/abort、生命周期短锁与隔离、管理 RPC 截止、结构化关闭结果 | 能从本次故障模式恢复，无悬挂线程和误伤其他会话 |
| 第三步：页面与接口 | 纯元数据绑定查询、异步重启查询、去重与状态展示 | 故障期间页面可用，重复点击不会制造多个关闭任务 |
| 第四步：集群治理 | 远端未确认告警、限流退避；获得 HS2 栈后再做定向 HS2/Tez 改造 | 控制遗留资源和诱发条件，不让问题转移成后台泄漏 |

第二、三步组成推荐的第一批完整发布。第三步可先独立缓解页面问题，但单独上线不算修复 JDBC 卡死。

代码尽量沿现有模块边界实现：生命周期状态放在组/session 所有者；重启操作放在现有服务层；JDBC 资源登记放在连接创建/销毁处。只增加必要的关闭上下文、结果类型和受限执行器，不搭建通用工作流平台。

### 制品影响

| 模块 | 影响 |
| --- | --- |
| zeppelin-web | 新状态和交互，需要更新 WAR |
| zeppelin-zengine / zeppelin-server | 生命周期、元数据、重启接口，需要对应服务端 JAR |
| zeppelin-interpreter | 远端关闭及 RPC 结果，需要同步更新包含该模块的解释器运行制品，核对 shaded 包 |
| jdbc | JDBCInterpreter 和池资源管理，需要 JDBC 解释器 JAR |
| 实际 Hive3 JDBC 驱动 | 补齐 abort 或使用验证通过的替代版本，更新 hive3 实际加载位置，避免同类多版本冲突 |
| HS2/Tez 服务端 | 第一批不要求修改；后续独立评估 |

部署前列出现场 classpath 到制品的真实映射，不能仅替换 WAR 或假定 Maven 模块名就是线上 JAR 名。现存 JVM 不会因替换磁盘 JAR 自动获得修复；需维护窗口重新加载相应 server/interpreter，不能把这次部署说成零重启。

## 11. 必须通过的定向回归

| 场景 | 必须看到的结果 |
| --- | --- |
| 正常关闭 | 正常 CloseSession 完成，无 abort，无误报警 |
| 对端接受连接但永不返回 CloseSession | 到期底层连接确实断开，close 线程退出，旧实例按结果退役；无需 kill |
| CloseOperation/cancel/statement.close 不返回 | 同一截止保护生效，不在进入连接池关闭前就永久卡住 |
| 关闭遇到正在执行的长 SQL | 普通运行阶段不被关闭超时误伤；明确重启后才按策略取消/断链，远端状态不明不自动补跑 |
| 空闲和借出连接、多 dbPrefix 池 | 全部按本实例归属释放；无遗漏、不关闭其他用户连接 |
| 关闭期间并发创建/借用 | 新连接不能进入旧代际，也不能在快照之外泄漏 |
| 100 次重复或并发重启 | 相同作用域去重，结束后线程/FD/定时任务回到稳定基线，不随次数增长 |
| 管理 RPC 无响应、进程 shutdown 无响应 | 请求有界返回失败，旧实例保持隔离；不自动结束共享 JVM |
| 故障组与正常组并存 | 元数据、笔记读取和正常组执行仍可用，无公共组锁等待堆积 |
| 旧事件迟到、同组下一代创建 | 旧结果/注销不能覆盖新实例或移除新资源 |
| 短 magic、默认绑定、QuickNote、多权限用户 | 纯元数据解析结果与原语义一致，未授权解释器不泄漏 |
| 前端断线、刷新、重复点击 | 查回同一操作，不重复发起关闭，不无限等待全局绑定事件 |
| 驱动不支持 abort、旧解释器版本 | 明确提示能力受限并隔离失败，不能吞异常后显示重启成功 |
| HS2 迟到完成清理 | 未确认记录收敛；新实例不被旧清理影响，无 SQL 自动重放 |

真实网络故障用本地受控 Thrift/Socket 服务模拟，不只 mock 一个永远不完成的 Future。补充实际 Hive3 Binary/SASL 集成用例；HTTP/SSL 支持分别验收。测试使用专用无业务数据环境，不运行生产 SQL、不制造线上资源满载。

## 12. 灰度与回滚

1. 记录未修改版本在本地故障注入下的线程栈和超时表现，作为回归基线。
2. 核对现场驱动身份、解释器隔离模式和实际制品，先对单个测试用户的 hive3 实例灰度。
3. 验证正常查询、长查询、明确取消、重启和会话变量丢失等既有语义，再验证不回 CloseSession 场景。
4. 连续观察重启成功/警告/失败比例、线程/FD、HS2 session 和 Tez Application 数；任一持续增长都不扩大灰度。
5. 模块和驱动版本成套记录，旧制品保留。回滚时先停止该作用域新执行，处理进行中的重启，再按兼容矩阵恢复，避免新 server/旧解释器混用导致结果失真。

验收的关键不只是“按钮能点了”，而是同时证明：页面不被拖住、旧本地执行和连接确实退出、远端遗留有记录且可收敛、其他用户不受影响。

## 13. 主要源码与资料

以下行号基于本次审阅版本，后续修改可能变化。

### Zeppelin

- `zeppelin-zengine/src/main/java/org/apache/zeppelin/interpreter/ManagedInterpreterGroup.java`：close、join、getOrCreateSession。
- `zeppelin-zengine/src/main/java/org/apache/zeppelin/interpreter/InterpreterSetting.java`：group/session 作用域计算、closeInterpreters。
- `zeppelin-zengine/src/main/java/org/apache/zeppelin/interpreter/remote/RemoteInterpreter.java`：close RPC、实例获取。
- `zeppelin-zengine/src/main/java/org/apache/zeppelin/interpreter/remote/RemoteInterpreterProcess.java`：TSocket 创建。
- `zeppelin-zengine/src/main/java/org/apache/zeppelin/interpreter/remote/ExecRemoteInterpreterProcess.java`：stop 顺序。
- `zeppelin-interpreter/src/main/java/org/apache/zeppelin/interpreter/remote/PooledRemoteClient.java`：借还连接、重试和异常传播。
- `zeppelin-interpreter/src/main/java/org/apache/zeppelin/interpreter/remote/RemoteInterpreterServer.java`：close、ShutdownThread。
- `zeppelin-interpreter/src/main/thrift/RemoteInterpreterService.thrift`：close 和 InterpreterRPCException。
- `jdbc/src/main/java/org/apache/zeppelin/jdbc/JDBCInterpreter.java`：299 起清理、395 closeDBPool、480 起连接池创建。
- `jdbc/src/main/java/org/apache/zeppelin/jdbc/JDBCUserConfigurations.java`：statement 与池登记。
- `zeppelin-zengine/src/main/java/org/apache/zeppelin/notebook/Note.java`：getBindedInterpreterSettings。
- `zeppelin-server/src/main/java/org/apache/zeppelin/socket/NotebookServer.java`：绑定查询与打开笔记后的对象同步。
- `zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java`：restartSetting。
- `zeppelin-web/src/app/notebook/notebook.controller.js`、`paragraph/paragraph.controller.js`：绑定等待和重启交互。

### Hive / Tez 本地对照源码

- Hive：`/Users/yao/IdeaProjects/hdsp-hive-release-HDP-3.1.5.0-152-tag`。
- Hive `jdbc/src/java/org/apache/hive/jdbc/HiveConnection.java`：940 abort、1001 close、1577 setNetworkTimeout、1698 SynchronizedHandler。
- Hive `service/src/java/org/apache/hive/service/cli/session/SessionManager.java`：577 closeSession。
- Hive `service/src/java/org/apache/hive/service/cli/session/HiveSessionImpl.java`：775 close。
- Hive `ql/src/java/org/apache/hadoop/hive/ql/session/SessionState.java`：1737 close。
- Hive `ql/src/java/org/apache/hadoop/hive/ql/exec/tez/TezSessionState.java`：749 close。
- Tez：`/Users/yao/IdeaProjects/hdsp-tez-release-HDP-3.1.5.0-152-tag`。
- Tez `tez-api/src/main/java/org/apache/tez/client/TezClient.java`：730 stop。

### 原始证据与官方定义

- 本机 `upup/zeppelin-threads-1.txt`、`zeppelin-threads-2.txt` 及 `hive3-threads-1.txt`、`hive3-threads-2.txt`，父目录为 `/Users/yao/projects/video_hadoop3_update`。
- [JDBC Connection 官方接口约定](https://docs.oracle.com/javase/8/docs/api/java/sql/Connection.html)：abort、setNetworkTimeout 的语义及驱动支持边界；不代表当前 Hive 驱动已实现。
- [Tez 官方配置说明](https://tez.apache.org/releases/0.8.5/tez-api-javadocs/org/apache/tez/dag/api/TezConfiguration.html)：异步停止和客户端关闭等待相关配置的范围；实际发行版以现场 JAR 为准。

本文保留实施前的源码与证据分析；原方案阶段未修改运行代码或执行测试。
后续已实现内容及验证结果以开头链接的实现说明为准，仍未连接或发布生产。
