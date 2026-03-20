# Zeppelin 任务审计日志功能

## 需求描述

用户在 Zeppelin notebook 提交的查询目前仅记录在日志文件中。需要将以下信息记录到结构化数据库（如 MySQL）中：

- 用户提交任务的时间
- 任务类型（解释器类型）
- 具体执行代码
- 执行开始时间
- 执行结束时间
- 任务状态

要求：最小化改动，确保能正常上线。

---

## 实现方案

### 架构设计

```
用户提交任务
    ↓
Paragraph.execute() → Job.setStatus()
    ↓
JobListener.onStatusChange()  ← 【核心监听点】
    ↓
┌─────────────────────────────────────────┐
│  AuditJobListener (装饰器模式)           │
│  - 委托原 listener 处理 WebSocket 通知    │
│  - 异步保存审计日志                        │
└─────────────────────────────────────────┘
    ↓
AuditLogRepository
    ↓
┌─────────────┬─────────────┐
│  Jdbc impl  │  Noop impl  │  ← 可插拔
└─────────────┴─────────────┘
```

### 核心思路

利用 Zeppelin 已有的 **JobListener 机制**，通过装饰器模式包装原有的 `NotebookServer`，在不破坏现有功能的前提下添加审计日志能力。

### 设计原则

1. **默认关闭**：功能默认不启用，不影响现有系统
2. **最小侵入**：仅在 ZeppelinServer 启动处添加集成点
3. **异常降级**：审计日志失败不影响任务执行
4. **异步写入**：使用线程池异步保存，不阻塞任务执行
5. **可插拔存储**：支持多种存储类型（JDBC、Noop 等）

---

## 数据结构

### 数据库表

```sql
CREATE TABLE IF NOT EXISTS zeppelin_task_audit (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  task_id VARCHAR(255) NOT NULL COMMENT 'Paragraph ID',
  job_name VARCHAR(500) COMMENT '任务名称',
  note_id VARCHAR(255) COMMENT 'Notebook ID',
  note_name VARCHAR(500) COMMENT 'Notebook 名称',
  note_path VARCHAR(1000) COMMENT 'Notebook 路径',
  paragraph_title VARCHAR(500) COMMENT 'Paragraph 标题',
  user VARCHAR(255) COMMENT '提交用户',
  interpreter_type VARCHAR(255) COMMENT '解释器类型',
  script_text TEXT COMMENT '执行的代码',
  status VARCHAR(50) NOT NULL COMMENT '任务状态: READY/PENDING/RUNNING/FINISHED/ERROR/ABORT',
  error_message TEXT COMMENT '错误信息',
  date_created DATETIME COMMENT '创建时间',
  date_submitted DATETIME COMMENT '提交时间 (PENDING)',
  date_started DATETIME COMMENT '开始时间 (RUNNING)',
  date_finished DATETIME COMMENT '结束时间 (FINISHED/ERROR/ABORT)',
  execution_duration BIGINT COMMENT '执行耗时(毫秒)',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '记录更新时间',

  INDEX idx_task_id (task_id),
  INDEX idx_note_id (note_id),
  INDEX idx_user (user),
  INDEX idx_status (status),
  INDEX idx_date_created (date_created),
  INDEX idx_date_started (date_started)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Zeppelin 任务审计日志表';
```

### 任务状态流转

```
UNKNOWN → READY → PENDING → RUNNING → FINISHED/ERROR/ABORT
              ↑
           (新建)
```

---

## 实现流程

### 1. 任务提交流程

```
1. 用户点击运行 Paragraph
   ↓
2. Paragraph.execute() 被调用
   ↓
3. setStatus(PENDING) - 标记为待执行
   ↓
4. JobListener.onStatusChange() 被触发
   ↓
5. AuditJobListener 拦截：
   - 先委托 NotebookServer 发送 WebSocket 通知
   - 异步保存审计日志（状态：PENDING）
   ↓
6. 任务提交到调度器
```

### 2. 任务执行流程

```
1. 调度器开始执行任务
   ↓
2. setStatus(RUNNING)
   ↓
3. JobListener.onStatusChange() 被触发
   ↓
4. AuditJobListener 更新审计日志（状态：RUNNING，记录开始时间）
   ↓
5. 执行用户代码
```

### 3. 任务完成流程

```
1. 任务执行完成（成功/失败/取消）
   ↓
2. setStatus(FINISHED/ERROR/ABORT)
   ↓
3. JobListener.onStatusChange() 被触发
   ↓
4. AuditJobListener 更新审计日志：
   - 记录结束时间
   - 计算执行耗时
   - 记录错误信息（如有）
```

---

## 涉及的改动

### 新增文件

| 文件路径 | 说明 |
|---------|------|
| `zeppelin-zengine/src/main/java/org/apache/zeppelin/audit/AuditLog.java` | 审计日志实体类 |
| `zeppelin-zengine/src/main/java/org/apache/zeppelin/audit/AuditLogRepository.java` | 仓储接口 |
| `zeppelin-zengine/src/main/java/org/apache/zeppelin/audit/NoopAuditLogRepository.java` | 空实现（默认） |
| `zeppelin-zengine/src/main/java/org/apache/zeppelin/audit/JdbcAuditLogRepository.java` | JDBC 实现 |
| `zeppelin-zengine/src/main/java/org/apache/zeppelin/audit/AuditJobListener.java` | JobListener 包装器 |
| `zeppelin-zengine/src/main/java/org/apache/zeppelin/audit/AuditLoggerFactory.java` | 仓储工厂类 |
| `docs/audit/zeppelin_task_audit.sql` | 数据库建表脚本 |
| `docs/audit/README.md` | 本文档 |

### 修改文件

| 文件路径 | 改动内容 |
|---------|---------|
| `zeppelin-interpreter/src/main/java/org/apache/zeppelin/conf/ZeppelinConfiguration.java` | 添加配置项枚举（6个） |
| `zeppelin-server/src/main/java/org/apache/zeppelin/server/ZeppelinServer.java` | 添加审计日志集成点（import + 初始化代码） |
| `conf/zeppelin-site.xml.template` | 添加配置示例 |

### 配置项

```xml
<!-- 审计功能开关 -->
<property>
  <name>zeppelin.audit.enabled</name>
  <value>false</value>
</property>

<!-- 存储类型：noop/jdbc -->
<property>
  <name>zeppelin.audit.storage.type</name>
  <value>noop</value>
</property>

<!-- JDBC 配置 -->
<property>
  <name>zeppelin.audit.jdbc.url</name>
  <value></value>
</property>
<property>
  <name>zeppelin.audit.jdbc.user</name>
  <value></value>
</property>
<property>
  <name>zeppelin.audit.jdbc.password</name>
  <value></value>
</property>
<property>
  <name>zeppelin.audit.jdbc.maxPoolSize</name>
  <value>5</value>
</property>
```

---

## 部署指南

### 1. 编译部署

```bash
mvn clean package -DskipTests
```

### 2. 准备数据库

```bash
# 创建数据库
mysql -u root -p
CREATE DATABASE zeppelin_audit DEFAULT CHARACTER SET utf8mb4;
exit;

# 执行建表脚本
mysql -u root -p zeppelin_audit < docs/audit/zeppelin_task_audit.sql
```

### 3. 下载 JDBC 驱动

```bash
cd $ZEPPELIN_HOME/lib

# MySQL
wget https://repo1.maven.org/maven2/mysql/mysql-connector-java/8.0.28/mysql-connector-java-8.0.28.jar

# 或 PostgreSQL
wget https://repo1.maven.org/maven2/org/postgresql/postgresql/42.2.23/postgresql-42.2.23.jar
```

### 4. 修改配置

编辑 `conf/zeppelin-site.xml`：

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
  <value>jdbc:mysql://localhost:3306/zeppelin_audit?useSSL=false&serverTimezone=UTC</value>
</property>
<property>
  <name>zeppelin.audit.jdbc.user</name>
  <value>root</value>
</property>
<property>
  <name>zeppelin.audit.jdbc.password</name>
  <value>your_password</value>
</property>
```

### 5. 重启 Zeppelin

```bash
bin/zeppelin-daemon.sh restart
```

### 6. 验证

查看日志确认审计功能已启用：
```
INFO [main] ... - Initializing audit log...
INFO [main] ... - Audit log initialized successfully
```

---

## 回滚方案

如需关闭审计功能，只需修改配置：

```xml
<property>
  <name>zeppelin.audit.enabled</name>
  <value>false</value>
</property>
```

然后重启 Zeppelin 即可。

---

## 核心类说明

### AuditJobListener

使用装饰器模式包装原有的 `ParagraphJobListener`（即 `NotebookServer`）：

- **职责**：拦截 Job 状态变化事件
- **流程**：
  1. 先委托给原 listener 处理 WebSocket 通知
  2. 异步调用仓储保存审计日志

### AuditLogRepository

仓储接口，定义审计日志的持久化操作：

- `init()` - 初始化
- `save(Paragraph, Status, Status)` - 保存审计日志
- `close()` - 关闭资源

### JdbcAuditLogRepository

JDBC 实现：

- 使用 `DriverManager` 获取连接（无需额外连接池依赖）
- 异步线程池执行数据库操作
- 支持 MySQL、PostgreSQL、H2 等

---

## 异常处理

| 场景 | 处理方式 |
|-----|---------|
| 审计功能未开启 | 使用 Noop 实现，无任何开销 |
| JDBC 驱动未找到 | 记录警告日志，使用 DriverManager 自动探测 |
| 数据库连接失败 | 捕获异常，记录 ERROR 日志，不影响任务执行 |
| 写入数据库超时 | 线程池异步执行，不阻塞主线程 |
| SQL 执行报错 | 降级为仅记录日志，任务继续 |

---

## 性能影响

- **默认关闭**：无任何性能影响
- **开启后**：
  - 异步写入，不阻塞任务执行线程
  - 线程池配置：核心 1 线程，最大 2 线程，队列容量 1000
  - 队列满时使用 DiscardPolicy 丢弃新任务（保证主流程稳定）

---

## 作者

by yao's AI
