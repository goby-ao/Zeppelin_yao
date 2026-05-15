# Zeppelin 任务审计日志上线操作手册

## 适用范围

本文档用于上线 Zeppelin 任务审计日志功能及后续修复，覆盖：

- 任务审计功能初始化、配置和验证
- `run_id` 审计历史保留能力
- recovery `READY` 状态跳过审计写入
- 异步乱序下 duplicate `PENDING` 不回写 `updated_at`

当前只提供 MySQL 建表脚本。PostgreSQL、H2 或其他数据库需要单独准备对应方言的 DDL。

## 一、发布包范围

### 推荐方式：整包发布

如果走完整 Zeppelin 包发布，直接使用包含本次改动的新 Zeppelin 安装包替换测试通过后的发布包，并按现有发布流程分发到所有 Zeppelin Server 节点。

### 最小 jar 替换方式

如果只更新 jar，必须同时更新以下 3 个 jar，缺一不可：

| 模块 | 本地构建产物 | 生产目标位置 |
| --- | --- | --- |
| `zeppelin-interpreter` | `zeppelin-interpreter/target/zeppelin-interpreter-${VERSION}.jar` | `${ZEPPELIN_HOME}/lib/zeppelin-interpreter-${VERSION}.jar` |
| `zeppelin-zengine` | `zeppelin-zengine/target/zeppelin-zengine-${VERSION}.jar` | `${ZEPPELIN_HOME}/lib/zeppelin-zengine-${VERSION}.jar` |
| `zeppelin-server` | `zeppelin-server/target/zeppelin-server-${VERSION}.jar` | `${ZEPPELIN_HOME}/lib/zeppelin-server-${VERSION}.jar` |

原因：

- `zeppelin-interpreter`：新增 `zeppelin.audit.*` 配置项。
- `zeppelin-zengine`：新增审计实体、listener、repository 和 JDBC 写入逻辑。
- `zeppelin-server`：新增审计初始化、listener 装配和关闭路径。

## 二、上线前检查

在代码仓库执行：

```bash
mvn -pl zeppelin-server -am -DskipTests package
mvn -pl zeppelin-zengine -am -Dtest=JdbcAuditLogRepositoryTest -DfailIfNoTests=false test
git diff --check
```

确认结果：

- Maven package 成功。
- `JdbcAuditLogRepositoryTest` 通过。
- `git diff --check` 无输出。

## 三、数据库初始化

以下命令以 MySQL 为例。请将占位符替换为生产真实值：

- `YOUR_MYSQL_HOST`
- `YOUR_AUDIT_DB`
- `YOUR_DDL_USER`
- `YOUR_AUDIT_USER`
- `YOUR_ZEPPELIN_SERVER_HOST`

### 1. 创建审计库

由 DBA 或具备 DDL 权限的账号执行：

```sql
CREATE DATABASE IF NOT EXISTS YOUR_AUDIT_DB DEFAULT CHARACTER SET utf8mb4;
```

### 2. 创建审计表

在代码仓库目录执行：

```bash
mysql -h YOUR_MYSQL_HOST -u YOUR_DDL_USER -p YOUR_AUDIT_DB \
  < docs/audit/zeppelin_task_audit.sql
```

### 3. 授权运行账号

审计运行账号只需要最小写入权限：

```sql
GRANT SELECT, INSERT, UPDATE
ON YOUR_AUDIT_DB.zeppelin_task_audit
TO 'YOUR_AUDIT_USER'@'YOUR_ZEPPELIN_SERVER_HOST';
```

如生产 MySQL 账号创建由 DBA 平台统一管理，按平台流程创建账号后授予上述权限即可。

## 四、准备 JDBC 驱动

如果生产 `${ZEPPELIN_HOME}/lib` 下已经有兼容的 MySQL JDBC driver，可以复用；否则放入对应版本驱动。

示例：

```bash
ls -l ${ZEPPELIN_HOME}/lib/mysql-connector*.jar
```

如不存在，请按公司制品库规范下载并放入：

```bash
cp YOUR_MYSQL_CONNECTOR_JAR ${ZEPPELIN_HOME}/lib/
```

## 五、更新 Zeppelin 包

### 1. 设置变量

```bash
export VERSION=0.9.1-SNAPSHOT
export ZEPPELIN_HOME=/YOUR_ZEPPELIN_HOME
export BACKUP_DIR=${ZEPPELIN_HOME}/lib/audit-backup-$(date +%Y%m%d%H%M%S)
```

### 2. 备份现有 jar

```bash
mkdir -p "${BACKUP_DIR}"
cp "${ZEPPELIN_HOME}/lib/zeppelin-interpreter-${VERSION}.jar" "${BACKUP_DIR}/"
cp "${ZEPPELIN_HOME}/lib/zeppelin-zengine-${VERSION}.jar" "${BACKUP_DIR}/"
cp "${ZEPPELIN_HOME}/lib/zeppelin-server-${VERSION}.jar" "${BACKUP_DIR}/"
```

### 3. 替换 jar

在代码仓库目录执行：

```bash
cp "zeppelin-interpreter/target/zeppelin-interpreter-${VERSION}.jar" "${ZEPPELIN_HOME}/lib/"
cp "zeppelin-zengine/target/zeppelin-zengine-${VERSION}.jar" "${ZEPPELIN_HOME}/lib/"
cp "zeppelin-server/target/zeppelin-server-${VERSION}.jar" "${ZEPPELIN_HOME}/lib/"
```

所有 Zeppelin Server 节点都需要执行同样的 jar 更新。若解释器进程由独立机器上的 Zeppelin 安装目录拉起，也应同步更新该安装目录，避免类版本不一致。

## 六、修改配置

编辑：

```bash
${ZEPPELIN_HOME}/conf/zeppelin-site.xml
```

新增或修改以下配置：

```xml
<property>
  <name>zeppelin.audit.enabled</name>
  <value>true</value>
</property>

<property>
  <name>zeppelin.audit.storage.type</name>
  <value>jdbc</value>
</property>

<property>
  <name>zeppelin.audit.jdbc.url</name>
  <value>jdbc:mysql://YOUR_MYSQL_HOST:3306/YOUR_AUDIT_DB?useSSL=false&amp;serverTimezone=UTC</value>
</property>

<property>
  <name>zeppelin.audit.jdbc.user</name>
  <value>YOUR_AUDIT_USER</value>
</property>

<property>
  <name>zeppelin.audit.jdbc.password</name>
  <value>YOUR_AUDIT_PASSWORD</value>
</property>

<property>
  <name>zeppelin.audit.jdbc.maxPoolSize</name>
  <value>5</value>
</property>
```

说明：

- `zeppelin.audit.enabled=false` 时审计完全关闭。
- `zeppelin.audit.storage.type=noop` 时不写数据库。
- `zeppelin.audit.jdbc.maxPoolSize` 是异步审计 writer 线程数，建议先保持 `5`，后续按写入压力调整。

## 七、重启 Zeppelin

按生产实际方式重启。二选一：

```bash
${ZEPPELIN_HOME}/bin/zeppelin-daemon.sh stop
${ZEPPELIN_HOME}/bin/zeppelin-daemon.sh start
```

或：

```bash
systemctl restart YOUR_ZEPPELIN_SERVICE
```

多节点部署建议逐台滚动重启，并在每台重启后完成日志检查。

## 八、上线后验证

### 1. 检查启动日志

```bash
grep -E "Initializing audit log|Audit log initialized successfully|JdbcAuditLogRepository initialized" \
  ${ZEPPELIN_HOME}/logs/zeppelin-*.log
```

期望看到：

- `Initializing audit log...`
- `JdbcAuditLogRepository initialized with URL: ...`
- `Audit log initialized successfully`

如果看到 `Failed to initialize audit log` 或 `Failed to save audit log`，先不要继续扩大发布范围。

### 2. 执行测试 paragraph

在 Zeppelin 页面上用普通用户执行一个简单 paragraph。执行成功后查询：

```sql
SELECT id, run_id, task_id, user, interpreter_type, status,
       date_submitted, date_started, date_finished, execution_duration
FROM zeppelin_task_audit
ORDER BY id DESC
LIMIT 5;
```

期望：

- 新增一条记录。
- `run_id` 非空。
- `status` 为 `FINISHED` 或实际终态。
- `date_submitted`、`date_started`、`date_finished` 按执行过程写入。

### 3. 验证中断后重跑

操作：

1. 执行一个耗时 paragraph。
2. 点击停止或取消。
3. 再次执行同一个 paragraph，并让它成功完成。

查询：

```sql
SELECT run_id, task_id, status, date_submitted, date_started, date_finished
FROM zeppelin_task_audit
WHERE task_id = 'YOUR_PARAGRAPH_ID'
ORDER BY id DESC
LIMIT 5;
```

期望：

- 同一个 `task_id` 有不同 `run_id`。
- 第一次为 `ABORT` 或实际取消终态。
- 第二次为 `FINISHED`。
- 第二次不会覆盖第一次历史。

### 4. 验证 recovery 修复

如需要验证 recovery 场景，应在测试环境完成：

1. 让 paragraph 进入 `RUNNING`。
2. 模拟 Zeppelin 进程异常退出。
3. 启动 Zeppelin。
4. 检查旧运行记录没有被更新成 `READY`。

## 九、回滚方案

### 快速关闭审计

如果审计写库异常但 Zeppelin 主功能正常，优先关闭审计：

```xml
<property>
  <name>zeppelin.audit.enabled</name>
  <value>false</value>
</property>

<property>
  <name>zeppelin.audit.storage.type</name>
  <value>noop</value>
</property>
```

修改后重启 Zeppelin。

### 回滚 jar

如需要回滚代码：

```bash
cp "${BACKUP_DIR}/zeppelin-interpreter-${VERSION}.jar" "${ZEPPELIN_HOME}/lib/"
cp "${BACKUP_DIR}/zeppelin-zengine-${VERSION}.jar" "${ZEPPELIN_HOME}/lib/"
cp "${BACKUP_DIR}/zeppelin-server-${VERSION}.jar" "${ZEPPELIN_HOME}/lib/"
```

然后重启 Zeppelin。

### 数据库处理

回滚时默认保留 `zeppelin_task_audit` 表和历史审计记录，不做删除。

## 十、常见问题

### 1. 没有审计记录

检查：

- `zeppelin.audit.enabled` 是否为 `true`。
- `zeppelin.audit.storage.type` 是否为 `jdbc`。
- JDBC URL、账号、密码是否正确。
- MySQL driver 是否在 `${ZEPPELIN_HOME}/lib` 下。
- 日志是否有 `Failed to save audit log`。

### 2. 只有 PENDING，没有终态

检查：

- Zeppelin 是否在任务运行期间异常退出。
- 异步 writer 队列是否长期积压。
- 数据库连接是否间歇失败。

### 3. 重跑是否覆盖历史

不会。每次 `PENDING` 会生成新的 `run_id`，同一个 paragraph 多次执行会保留多条记录。

## 十一、上线风险评估

- 审计功能默认关闭，只有显式配置 `zeppelin.audit.enabled=true` 后才生效。
- 审计写入为异步执行，数据库异常只记录日志，不阻塞 paragraph 执行。
- 队列满时会丢弃新审计事件以保护 Zeppelin 主流程，极端情况下审计记录可能缺失。
- `script_text` 会记录用户提交代码，生产库权限需要按审计数据敏感级别控制。

## 十二、⚠️ 危险操作与数据删除风险评估

- `CREATE DATABASE IF NOT EXISTS YOUR_AUDIT_DB`：只创建不存在的数据库，不删除已有数据。
- `CREATE TABLE IF NOT EXISTS zeppelin_task_audit`：只创建不存在的表，不删除已有数据。
- `GRANT SELECT, INSERT, UPDATE`：只授权审计账号访问审计表，不授予 `DELETE` / `DROP` / `TRUNCATE`。
- jar 替换命令会覆盖 `${ZEPPELIN_HOME}/lib` 下同名 jar，执行前必须完成备份。
- 重启 Zeppelin 会中断当前 Web 服务和正在运行的 paragraph，建议在维护窗口或滚动发布时执行。
- 本文档不包含任何 `DROP`、`DELETE`、`TRUNCATE`、`rm`、HDFS 删除或 Hive 覆盖命令。
