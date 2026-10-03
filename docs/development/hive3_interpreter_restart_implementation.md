# Hive3 重启阻塞修复：实现与发布说明

日期：2026-10-04。只完成本地代码和定向验证，未连接生产，未构建发布 WAR/JAR。

## 故障与修复

确认的故障链为：HS2 CloseSession 不返回 -> Hive JDBC 等待回包 ->
解释器 close 不返回 -> Zeppelin Server 持有组锁等待 -> 绑定列表和同组请求阻塞。
YARN 当时满载、HS2 日志进入 Tez session 关闭是线索，缺少 HS2 同期线程栈，
不能把它认定为唯一触发原因。

本次沿现有调用链修复，没有引入新操作平台或修改 Thrift 接口：

- `Note` 通过配置解析绑定，不再为读取列表创建解释器实例。
- `ManagedInterpreterGroup` 在短锁内登记关闭，然后在有界工作线程中处理网络关闭。
  同 session 重复请求等待同一结果；失败保留实例，不提前移除后自动新建。
  其他 session 可以继续读取/使用，原有用户、笔记隔离规则不变。
- `RemoteInterpreterServer` 在组锁外关闭；异常通过 RPC 返回，不再吞掉并删除实例。
  shutdown 不重复关闭已在关闭的实例，且不持组锁执行 close。
- close/cancel/shutdown 使用独立管理连接、一次调用，不重试；截止时间关闭管理 socket。
  普通运行 SQL 的 RPC 和 JDBC 查询超时不变。
- `JDBCConnectionClose` 按实例跟踪物理连接，包含池内空闲和已借出的连接。
  先正常关闭 statement/所有前缀的池，超时才调用物理 `Connection.abort`；
  连接释放、关闭工作线程和当前执行都退出后，才能返回本地关闭成功。
- DBCP 注册名增加实例命名空间，避免同一 JVM 的两个 scoped 实例误关对方的池。
- REST 返回 409（关闭失败）、504（截止时间到达）、404（设置不存在），不报假成功。
- 两个笔记重启入口复用同一前端服务，防连点、限时等待，并始终提醒远端 SQL 可能仍在运行。
  段落绑定请求按 noteId 匹配，5 秒未收到响应提示错误并清理监听器。

## 必需的 Hive 客户端补丁

现场同类 HDP Hive3 客户端的 `abort` 是未实现方法。只改 Zeppelin 不能保证无需 kill 恢复。
补丁与真实客户端 socket 回归在 [`jdbc/patches/hive3`](../../jdbc/patches/hive3/README.md)。

补丁直接关闭当前 binary transport，不走串行 RPC 锁、不再发送 CloseSession。
本地使用真实 HDP standalone 客户端验证了无 SASL 和 SASL/PLAIN 两种路径。
HTTP/embedded 明确不支持此补丁；SSL/Kerberos 仍须在对应测试环境验证后推广。
不能用一次 PLAIN 验证替代生产 Kerberos 验收。

## 时间与边界

以下属性加在对应解释器设置，单位毫秒：

| 属性 | 默认值 | 范围 |
| --- | ---: | --- |
| `zeppelin.jdbc.close.timeout` | 15000 | 正常清理宽限时间 |
| `zeppelin.jdbc.close.abort.timeout` | 5000 | 本地 abort 和执行退出的追加预算 |
| `zeppelin.interpreter.management.timeout` | 30000 | 单次管理 RPC 截止时间 |
| `zeppelin.interpreter.close.timeout` | 45000 | 单 session 关闭总等待上限 |

取消请求最多使用 5 秒管理预算，避免 cancel 本身耗尽 close 的时间。
维持 `JDBC 两项之和 < 管理 RPC < session 总预算`，不要只调其中一项。
总预算到达后不继续新开关闭任务；可能仍有最多 8 个无法中断的隔离关闭工作线程，
不会靠无限新建线程或排队掩盖问题。JDBC close/abort 工作池分别也限制为 8。

失败隔离不是远端清理完成。未实现 abort、JVM 无响应、连接建立本身卡住、
第三方插件 close/open/unload 无法退出时，程序只保证有界返回、限制扩散，不能承诺自动恢复。
本次没有自动 kill 失败的解释器。原有进程 launcher 的最终退出兜底保留在正常 close 成功之后。
管理员确认并停止当前所属本地解释器进程后，可再次显式重启清理旧状态；
仅连接超时、不确定进程是否退出时，禁止当作已退出而重建。

管理员针对整个 setting 的关闭仍按组执行，不是一个全局固定时长任务；
本次默认优先保证用户按笔记触发的 session 重启有界。

**本地已关闭 != HS2 已关闭 != SQL 已回滚。** 网络断开后 HS2/Tez 仍可能继续执行。
不会自动重跑 SQL；写入任务必须先核对远端 operation/application 和目标数据状态。

## 发布范围

不能只发布 WAR。至少需要同步更新：

1. 前端 WAR，以及 Server/Zengine 的对应 JAR。
2. Server 使用的 `zeppelin-interpreter` 与子进程使用的 `zeppelin-interpreter-shaded`。
3. JDBC 解释器目录中的 `zeppelin-jdbc` JAR。
4. hive3 实际加载的 Hive JDBC 驱动，应用本目录补丁并做现场版本核对。

现有 `prepare_zeppelin_release.sh --scope web+runtime` 包含前两项，**不含 JDBC 解释器和外置 Hive 驱动**。
须另行构建、纳入同批发布清单及备份，不能误以为已有 scope 覆盖全部。此提交不修改部署脚本。
上线前核实 JVM 实际加载路径及 SHA-256，避免 local-repo、解释器目录中的多个旧 JAR 抢先加载。
灰度窗口更新并重启 Server，退役灰度用户旧解释器实例以加载新类；不能靠覆盖运行中 JAR 热生效。
回滚须恢复本批对应 JAR/WAR 和驱动，并重新加载进程，不修改笔记和业务数据。

## 本地验证

- 元数据绑定 9 项：默认与混合 magic、权限、QuickNote、组锁占用时读取。
- 生命周期与管理 RPC：关闭不持锁、失败保留、重复关闭/截止时间、socket 实际断开。
- 原有 `InterpreterSettingTest`：11 项用户与笔记隔离回归。
- 远端关闭接口：5 项，覆盖异常传播、同 JVM 其他 session、正常启动/关闭。
- REST 返回码：3 项，覆盖不存在、关闭失败和超时，均不能返回成功。
- JDBC：31 项，覆盖正常查询、precode、多前缀池、跨实例关闭隔离、真实 socket 阻塞、
  不支持或空实现 abort、执行线程未退出时拒绝成功。
- 前端：60 项隔离浏览器回归，包含现有编辑同步与新增重启去重、失败文案、绑定超时。
- Hive 补丁：同一真实驱动下 baseline 两种模式均复现阻塞，patched 两种模式均解除阻塞。
- Server 及依赖模块通过 reactor 编译；未跑全仓测试、未接生产 HS2/YARN。

离线 Java 定向回归示例（从源码根目录执行）：

```bash
mvn -o -pl zeppelin-server -am \
  -Dtest=RemoteInterpreterServerTest,NoteInterpreterBindingsTest,ManagedInterpreterGroupTest,RemoteInterpreterManagementTest,InterpreterSettingTest,InterpreterRestartFailureTest \
  -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false \
  -Dcheckstyle.skip=true -Denforcer.skip=true test
mvn -o -pl jdbc -Dtest=JDBCConnectionCloseTest,JDBCInterpreterTest \
  -Dcheckstyle.skip=true -Denforcer.skip=true test
```
