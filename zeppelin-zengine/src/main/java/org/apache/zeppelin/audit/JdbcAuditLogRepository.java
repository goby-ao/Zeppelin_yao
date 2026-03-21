/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.apache.zeppelin.audit;

import org.apache.zeppelin.notebook.Paragraph;
import org.apache.zeppelin.scheduler.Job;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * JDBC 审计日志仓储实现 - 将审计日志保存到关系型数据库
 * 使用 DriverManager 获取连接，无需额外连接池依赖
 * by yao's AI
 */
public class JdbcAuditLogRepository implements AuditLogRepository {

  private static final Logger LOGGER = LoggerFactory.getLogger(JdbcAuditLogRepository.class);

  private final String jdbcUrl;
  private final String jdbcUser;
  private final String jdbcPassword;
  private final String clusterName;  // 集群名称 - by yao's AI

  private ExecutorService executorService;

  public JdbcAuditLogRepository(String jdbcUrl, String jdbcUser, String jdbcPassword, int maxPoolSize, String clusterName) {
    this.jdbcUrl = jdbcUrl;
    this.jdbcUser = jdbcUser;
    this.jdbcPassword = jdbcPassword;
    this.clusterName = clusterName;  // 保存集群名称
  }

  @Override
  public void init() {
    try {
      // 加载 JDBC 驱动
      loadDriver(jdbcUrl);

      // 初始化异步写入线程池
      this.executorService = new ThreadPoolExecutor(
          1, 2, 60L, TimeUnit.SECONDS,
          new LinkedBlockingQueue<>(1000),
          new ThreadFactory() {
            private final AtomicInteger threadNumber = new AtomicInteger(1);
            @Override
            public Thread newThread(Runnable r) {
              Thread t = new Thread(r, "zeppelin-audit-writer-" + threadNumber.getAndIncrement());
              t.setDaemon(true);
              return t;
            }
          },
          new ThreadPoolExecutor.DiscardPolicy()  // 队列满时丢弃新任务，不影响主流程
      );

      LOGGER.info("JdbcAuditLogRepository initialized with URL: {}", jdbcUrl);
    } catch (Exception e) {
      LOGGER.error("Failed to initialize JdbcAuditLogRepository", e);
      // 初始化失败时降级为不工作，但不抛出异常
      close();
    }
  }

  @Override
  public void save(Paragraph paragraph, Job.Status before, Job.Status after) {
    if (executorService == null || executorService.isShutdown()) {
      return;
    }
    // 异步保存，不阻塞任务执行
    executorService.submit(() -> {
      try {
        saveInternal(paragraph, before, after);
      } catch (Exception e) {
        LOGGER.error("Failed to save audit log", e);
      }
    });
  }

  /**
   * 获取数据库连接
   * by yao's AI
   */
  private Connection getConnection() throws SQLException {
    if (jdbcUser != null && !jdbcUser.isEmpty()) {
      return DriverManager.getConnection(jdbcUrl, jdbcUser, jdbcPassword);
    } else {
      return DriverManager.getConnection(jdbcUrl);
    }
  }

  /**
   * 内部保存方法 - 在异步线程中执行
   * by yao's AI
   */
  private void saveInternal(Paragraph paragraph, Job.Status before, Job.Status after) {
    String taskId = paragraph.getId();
    AuditLog existingLog = findByTaskId(taskId);

    AuditLog auditLog;
    if (existingLog != null) {
      auditLog = existingLog;
    } else {
      auditLog = new AuditLog();
      auditLog.setClusterName(clusterName);  // 设置集群名称 - by yao's AI
      auditLog.setTaskId(taskId);
      auditLog.setJobName(paragraph.getJobName());
      auditLog.setDateCreated(paragraph.getDateCreated());
      if (paragraph.getNote() != null) {
        auditLog.setNoteId(paragraph.getNote().getId());
        auditLog.setNoteName(paragraph.getNote().getName());
        auditLog.setNotePath(paragraph.getNote().getPath());
      }
      auditLog.setUser(paragraph.getUser());
      auditLog.setParagraphTitle(paragraph.getTitle());
      auditLog.setInterpreterType(paragraph.getIntpText());
      auditLog.setScriptText(paragraph.getScriptText());
    }

    // 更新状态和时间
    auditLog.setStatus(after);
    auditLog.setUpdatedAt(new Date());

    Date now = new Date();
    if (after == Job.Status.PENDING) {
      auditLog.setDateSubmitted(now);
    } else if (after == Job.Status.RUNNING) {
      auditLog.setDateStarted(paragraph.getDateStarted() != null ? paragraph.getDateStarted() : now);
    } else if (after.isCompleted()) {
      auditLog.setDateFinished(paragraph.getDateFinished() != null ? paragraph.getDateFinished() : now);
      auditLog.setErrorMessage(paragraph.getErrorMessage());
      auditLog.calculateDuration();
    }

    if (existingLog != null) {
      updateAuditLog(auditLog);
    } else {
      insertAuditLog(auditLog);
    }
  }

  /**
   * 根据 taskId 查询已存在的审计日志
   * by yao's AI
   */
  private AuditLog findByTaskId(String taskId) {
    String sql = "SELECT id, cluster_name, task_id, job_name, note_id, note_name, note_path, " +
        "paragraph_title, user, interpreter_type, script_text, status, error_message, " +
        "date_created, date_submitted, date_started, date_finished, execution_duration, " +
        "created_at, updated_at FROM zeppelin_task_audit WHERE task_id = ? AND cluster_name = ?";

    try (Connection conn = getConnection();
         PreparedStatement stmt = conn.prepareStatement(sql)) {
      stmt.setString(1, taskId);
      stmt.setString(2, clusterName);
      try (ResultSet rs = stmt.executeQuery()) {
        if (rs.next()) {
          return extractAuditLog(rs);
        }
      }
    } catch (SQLException e) {
      LOGGER.debug("Audit log not found for taskId: {}, cluster: {}", taskId, clusterName);
    }
    return null;
  }

  /**
   * 插入新的审计日志
   * by yao's AI
   */
  private void insertAuditLog(AuditLog auditLog) {
    String sql = "INSERT INTO zeppelin_task_audit (" +
        "cluster_name, task_id, job_name, note_id, note_name, note_path, paragraph_title, " +
        "user, interpreter_type, script_text, status, error_message, " +
        "date_created, date_submitted, date_started, date_finished, execution_duration, " +
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    try (Connection conn = getConnection();
         PreparedStatement stmt = conn.prepareStatement(sql, PreparedStatement.RETURN_GENERATED_KEYS)) {
      setAuditLogParameters(stmt, auditLog);
      stmt.executeUpdate();

      try (ResultSet rs = stmt.getGeneratedKeys()) {
        if (rs.next()) {
          auditLog.setId(rs.getLong(1));
        }
      }
    } catch (SQLException e) {
      LOGGER.error("Failed to insert audit log", e);
    }
  }

  /**
   * 更新审计日志
   * by yao's AI
   */
  private void updateAuditLog(AuditLog auditLog) {
    String sql = "UPDATE zeppelin_task_audit SET " +
        "job_name = ?, note_id = ?, note_name = ?, note_path = ?, paragraph_title = ?, " +
        "user = ?, interpreter_type = ?, script_text = ?, status = ?, error_message = ?, " +
        "date_created = ?, date_submitted = ?, date_started = ?, date_finished = ?, " +
        "execution_duration = ?, updated_at = ? WHERE id = ?";

    try (Connection conn = getConnection();
         PreparedStatement stmt = conn.prepareStatement(sql)) {
      int index = 1;
      stmt.setString(index++, auditLog.getJobName());
      stmt.setString(index++, auditLog.getNoteId());
      stmt.setString(index++, auditLog.getNoteName());
      stmt.setString(index++, auditLog.getNotePath());
      stmt.setString(index++, auditLog.getParagraphTitle());
      stmt.setString(index++, auditLog.getUser());
      stmt.setString(index++, auditLog.getInterpreterType());
      stmt.setString(index++, auditLog.getScriptText());
      stmt.setString(index++, auditLog.getStatus() != null ? auditLog.getStatus().name() : null);
      stmt.setString(index++, auditLog.getErrorMessage());
      stmt.setTimestamp(index++, toTimestamp(auditLog.getDateCreated()));
      stmt.setTimestamp(index++, toTimestamp(auditLog.getDateSubmitted()));
      stmt.setTimestamp(index++, toTimestamp(auditLog.getDateStarted()));
      stmt.setTimestamp(index++, toTimestamp(auditLog.getDateFinished()));
      stmt.setObject(index++, auditLog.getExecutionDuration());
      stmt.setTimestamp(index++, toTimestamp(auditLog.getUpdatedAt()));
      stmt.setLong(index++, auditLog.getId());

      stmt.executeUpdate();
    } catch (SQLException e) {
      LOGGER.error("Failed to update audit log", e);
    }
  }

  /**
   * 设置插入语句的参数
   * by yao's AI
   */
  private void setAuditLogParameters(PreparedStatement stmt, AuditLog auditLog) throws SQLException {
    int index = 1;
    stmt.setString(index++, auditLog.getClusterName());
    stmt.setString(index++, auditLog.getTaskId());
    stmt.setString(index++, auditLog.getJobName());
    stmt.setString(index++, auditLog.getNoteId());
    stmt.setString(index++, auditLog.getNoteName());
    stmt.setString(index++, auditLog.getNotePath());
    stmt.setString(index++, auditLog.getParagraphTitle());
    stmt.setString(index++, auditLog.getUser());
    stmt.setString(index++, auditLog.getInterpreterType());
    stmt.setString(index++, auditLog.getScriptText());
    stmt.setString(index++, auditLog.getStatus() != null ? auditLog.getStatus().name() : null);
    stmt.setString(index++, auditLog.getErrorMessage());
    stmt.setTimestamp(index++, toTimestamp(auditLog.getDateCreated()));
    stmt.setTimestamp(index++, toTimestamp(auditLog.getDateSubmitted()));
    stmt.setTimestamp(index++, toTimestamp(auditLog.getDateStarted()));
    stmt.setTimestamp(index++, toTimestamp(auditLog.getDateFinished()));
    stmt.setObject(index++, auditLog.getExecutionDuration());
    stmt.setTimestamp(index++, toTimestamp(auditLog.getCreatedAt()));
    stmt.setTimestamp(index++, toTimestamp(auditLog.getUpdatedAt()));
  }

  /**
   * 从 ResultSet 提取 AuditLog 对象
   * by yao's AI
   */
  private AuditLog extractAuditLog(ResultSet rs) throws SQLException {
    AuditLog log = new AuditLog();
    log.setId(rs.getLong("id"));
    log.setClusterName(rs.getString("cluster_name"));
    log.setTaskId(rs.getString("task_id"));
    log.setJobName(rs.getString("job_name"));
    log.setNoteId(rs.getString("note_id"));
    log.setNoteName(rs.getString("note_name"));
    log.setNotePath(rs.getString("note_path"));
    log.setParagraphTitle(rs.getString("paragraph_title"));
    log.setUser(rs.getString("user"));
    log.setInterpreterType(rs.getString("interpreter_type"));
    log.setScriptText(rs.getString("script_text"));

    String statusStr = rs.getString("status");
    if (statusStr != null) {
      log.setStatus(Job.Status.valueOf(statusStr));
    }
    log.setErrorMessage(rs.getString("error_message"));
    log.setDateCreated(rs.getTimestamp("date_created"));
    log.setDateSubmitted(rs.getTimestamp("date_submitted"));
    log.setDateStarted(rs.getTimestamp("date_started"));
    log.setDateFinished(rs.getTimestamp("date_finished"));
    log.setExecutionDuration((Long) rs.getObject("execution_duration"));
    log.setCreatedAt(rs.getTimestamp("created_at"));
    log.setUpdatedAt(rs.getTimestamp("updated_at"));
    return log;
  }

  /**
   * 根据 JDBC URL 加载驱动
   * by yao's AI
   */
  private void loadDriver(String url) {
    try {
      if (url.startsWith("jdbc:mysql:")) {
        Class.forName("com.mysql.cj.jdbc.Driver");
      } else if (url.startsWith("jdbc:postgresql:")) {
        Class.forName("org.postgresql.Driver");
      } else if (url.startsWith("jdbc:h2:")) {
        Class.forName("org.h2.Driver");
      } else if (url.startsWith("jdbc:oracle:")) {
        Class.forName("oracle.jdbc.OracleDriver");
      }
      // 其他数据库让 DriverManager 自动探测
    } catch (ClassNotFoundException e) {
      LOGGER.warn("JDBC driver not found for URL: {}, will try DriverManager auto-detection", url);
    }
  }

  private Timestamp toTimestamp(Date date) {
    return date != null ? new Timestamp(date.getTime()) : null;
  }

  @Override
  public void close() {
    if (executorService != null && !executorService.isShutdown()) {
      executorService.shutdown();
      try {
        if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
          executorService.shutdownNow();
        }
      } catch (InterruptedException e) {
        executorService.shutdownNow();
        Thread.currentThread().interrupt();
      }
      executorService = null;
    }
  }
}
