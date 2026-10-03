# Hive3 binary Connection.abort 补丁

用于解除客户端 CloseSession/其他 Thrift 调用的本地 socket 等待，不负责远端取消或事务回滚。
仅在 Zeppelin 关闭预算超时后调用，不改变普通长查询的 socket timeout。

## 基线

- 源码：本地 `hdsp-hive-release-HDP-3.1.5.0-152-tag` 的 `HiveConnection.java`。
- 原文件 SHA-256：`a484ca1f911a9a8a6240265f4b59bd8667348cb6a14a5401daf73d34b23175bf`。
- 验证 JAR：`hive-jdbc-3.1.0.3.1.5.3-5-standalone.jar`。
- 原 JAR SHA-256：`60532330b23d697e797569d33a5c4c1b927c795329d7511fa88f042026ee05e7`。

这些是**本地验证基线**，不是已确认的线上加载版本。其他版本需核对 patch 上下文和重新回归。

## 修改

`abort` 使用独立锁提交 executor，直接关闭当前 transport；不调用 Thrift client、
不等待 CloseSession 持有的串行 RPC 锁。关闭状态对其他线程可见；检查 executor/权限；
提交失败不标记成功。重复 abort 不重复关闭。HTTP/embedded 明确返回不支持。

## 无外部服务的复现

使用 JDK 8/11，设置以下路径为自己的本地测试文件，Hadoop classpath 至少包含对应 hadoop-common：

```bash
HIVE_SOURCE=YOUR_LOCAL_HIVE_SOURCE
HIVE_JAR=YOUR_LOCAL_HIVE_STANDALONE_JAR
HADOOP_CP=YOUR_LOCAL_HADOOP_CLIENT_CLASSPATH
bash jdbc/patches/hive3/verify-abort.sh "$HIVE_SOURCE" "$HIVE_JAR" "$HADOOP_CP"
```

脚本仅复制单个源文件到临时目录并编译，不改原源码、Maven 缓存或现有 JAR。
测试使用真实 HiveConnection、Thrift 和 loopback socket，模拟服务收到 CloseSession 后不回包。
只模拟 OpenSession/CloseSession，不运行 SQL。为匹配 standalone 包，临时源码会作包名 relocation。
此步骤仅为验证，不产生或覆盖可发布驱动。

预期输出四个 PASS：baseline binary/noSasl、baseline SASL/PLAIN、patched binary/noSasl、patched SASL/PLAIN。
baseline 的 PASS 表示成功复现未实现 abort 且线程仍阻塞；patched 的 PASS 表示 close 工作线程
在 2 秒验证窗口内结束，连接不可复用。模拟服务在测试结束时释放，不留下线程。

SSL/Kerberos、HTTP、完整 JDBC 执行/取数、真实 HS2 清理尚未在此夹具验证。
HTTP 不受本补丁支持；Kerberos/SSL 上线前必须在对应环境验收，不从 PLAIN 测试推断已全部覆盖。

## 制作发布包

在核对后的 Hive 客户端源码副本中应用 `0001-binary-connection-abort.patch`，
按该发行版原有依赖和 shade 构建流程重新生成 JDBC 客户端包。
不要只把一个 class 塞入线上 JAR，也不要把临时测试 class 当发布产物。
备份旧包、核对实际加载来源后灰度替换；不需要先更新 HS2 服务端，但需重新加载解释器进程。
