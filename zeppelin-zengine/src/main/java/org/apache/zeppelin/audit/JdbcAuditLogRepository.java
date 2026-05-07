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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * JDBC 审计日志仓储实现 - 将审计日志保存到关系型数据库
 * 使用 DriverManager 获取连接，无需额外连接池依赖
 * by yao's AI
 */
public class JdbcAuditLogRepository implements AuditLogRepository {

  private static final Logger LOGGER = LoggerFactory.getLogger(JdbcAuditLogRepository.class);
  private static final int AUDIT_QUEUE_SIZE = 1000;

  private final String jdbcUrl;
  private final String jdbcUser;
  private final String jdbcPassword;
  private final int maxPoolSize;

  private ExecutorService executorService;
  private final ConcurrentMap<String, String> activeRunIds = new ConcurrentHashMap<>();
  private final AtomicLong runSequence = new AtomicLong(1);

  public JdbcAuditLogRepository(String jdbcUrl, String jdbcUser, String jdbcPassword, int maxPoolSize) {
    this.jdbcUrl = jdbcUrl;
    this.jdbcUser = jdbcUser;
    this.jdbcPassword = jdbcPassword;
    this.maxPoolSize = Math.max(1, maxPoolSize);
  }

  @Override
  public void init() {
    try {
      // 加载 JDBC 驱动
      loadDriver(jdbcUrl);

      // 初始化异步写入线程池
      this.executorService = new ThreadPoolExecutor(
          this.maxPoolSize, this.maxPoolSize, 60L, TimeUnit.SECONDS,
          new LinkedBlockingQueue<>(AUDIT_QUEUE_SIZE),
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

      LOGGER.info("JdbcAuditLogRepository initialized with URL: {}, maxPoolSize: {}",
          jdbcUrl, this.maxPoolSize);
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
    Date eventTime = new Date();
    AuditLog auditLog = buildAuditLog(paragraph, after, eventTime);
    // 异步保存，不阻塞任务执行
    executorService.submit(() -> {
      try {
        saveInternal(auditLog);
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
  private AuditLog buildAuditLog(Paragraph paragraph, Job.Status status, Date eventTime) {
    AuditLog auditLog = new AuditLog();
    String taskId = paragraph.getId();
    String runId;

    if (status == Job.Status.PENDING) {
      runId = generateRunId(taskId, eventTime);
      activeRunIds.put(taskId, runId);
    } else {
      runId = activeRunIds.get(taskId);
    }

    auditLog.setRunId(runId);
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
    auditLog.setStatus(status);
    auditLog.setUpdatedAt(eventTime);

    if (status == Job.Status.PENDING) {
      auditLog.setDateSubmitted(eventTime);
    } else if (status == Job.Status.RUNNING) {
      auditLog.setDateStarted(paragraph.getDateStarted() != null
          ? paragraph.getDateStarted() : eventTime);
    } else if (status.isCompleted()) {
      auditLog.setDateStarted(paragraph.getDateStarted());
      auditLog.setDateFinished(paragraph.getDateFinished() != null
          ? paragraph.getDateFinished() : eventTime);
      auditLog.setErrorMessage(paragraph.getErrorMessage());
      auditLog.calculateDuration();
    }

    return auditLog;
  }

  /**
   * 内部保存方法 - 在异步线程中执行
   * by yao's AI
   */
  private void saveInternal(AuditLog auditLog) {
    if (auditLog.getRunId() == null) {
      String runId = findLatestActiveRunId(auditLog.getTaskId());
      if (runId == null) {
        runId = generateRunId(auditLog.getTaskId(), auditLog.getUpdatedAt());
      }
      auditLog.setRunId(runId);
      activeRunIds.putIfAbsent(auditLog.getTaskId(), runId);
    }

    if (auditLog.getStatus() == Job.Status.PENDING) {
      insertAuditLog(auditLog);
    } else {
      int updatedRows = updateAuditLog(auditLog);
      if (updatedRows == 0) {
        insertAuditLog(auditLog);
      }
    }

    if (auditLog.getStatus().isCompleted()) {
      activeRunIds.remove(auditLog.getTaskId(), auditLog.getRunId());
    }
  }

  /**
   * 查询最近一次还未完成的运行记录
   * by yao's AI
   */
  private String findLatestActiveRunId(String taskId) {
    String sql = "SELECT run_id FROM zeppelin_task_audit " +
        "WHERE task_id = ? AND status IN ('PENDING', 'RUNNING') ORDER BY id DESC LIMIT 1";

    try (Connection conn = getConnection();
         PreparedStatement stmt = conn.prepareStatement(sql)) {
      stmt.setString(1, taskId);
      try (ResultSet rs = stmt.executeQuery()) {
        if (rs.next()) {
          return rs.getString("run_id");
        }
      }
    } catch (SQLException e) {
      LOGGER.debug("Active audit log not found for taskId: {}", taskId);
    }
    return null;
  }

  /**
   * 插入新的审计日志
   * by yao's AI
   */
  private void insertAuditLog(AuditLog auditLog) {
    String sql = "INSERT INTO zeppelin_task_audit (" +
        "run_id, task_id, job_name, note_id, note_name, note_path, paragraph_title, " +
        "user, interpreter_type, script_text, status, error_message, " +
        "date_created, date_submitted, date_started, date_finished, execution_duration, " +
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

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
      if (isDuplicateKey(e)) {
        if (auditLog.getStatus() == Job.Status.PENDING) {
          LOGGER.debug("Audit log already exists for runId: {}", auditLog.getRunId());
          updateSubmittedTime(auditLog);
        } else {
          updateAuditLog(auditLog);
        }
        return;
      }
      LOGGER.error("Failed to insert audit log", e);
    }
  }

  /**
   * 更新审计日志
   * by yao's AI
   */
  private int updateAuditLog(AuditLog auditLog) {
    String sql = "UPDATE zeppelin_task_audit SET " +
        "job_name = ?, note_id = ?, note_name = ?, note_path = ?, paragraph_title = ?, " +
        "user = ?, interpreter_type = ?, script_text = ?, status = ?, error_message = ?, " +
        "date_created = ?, date_submitted = COALESCE(date_submitted, ?), " +
        "date_started = COALESCE(?, date_started), date_finished = COALESCE(?, date_finished), " +
        "execution_duration = COALESCE(?, execution_duration), updated_at = ? WHERE run_id = ?";

    if (auditLog.getStatus() == Job.Status.RUNNING) {
      sql += " AND status IN ('PENDING', 'RUNNING')";
    }

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
      stmt.setString(index++, auditLog.getRunId());

      return stmt.executeUpdate();
    } catch (SQLException e) {
      LOGGER.error("Failed to update audit log", e);
      return 0;
    }
  }

  private void updateSubmittedTime(AuditLog auditLog) {
    String sql = "UPDATE zeppelin_task_audit SET date_submitted = COALESCE(date_submitted, ?), " +
        "updated_at = ? WHERE run_id = ?";

    try (Connection conn = getConnection();
         PreparedStatement stmt = conn.prepareStatement(sql)) {
      stmt.setTimestamp(1, toTimestamp(auditLog.getDateSubmitted()));
      stmt.setTimestamp(2, toTimestamp(auditLog.getUpdatedAt()));
      stmt.setString(3, auditLog.getRunId());
      stmt.executeUpdate();
    } catch (SQLException e) {
      LOGGER.error("Failed to update audit log submit time", e);
    }
  }

  /**
   * 设置插入语句的参数
   * by yao's AI
   */
  private void setAuditLogParameters(PreparedStatement stmt, AuditLog auditLog) throws SQLException {
    int index = 1;
    stmt.setString(index++, auditLog.getRunId());
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

  private String generateRunId(String taskId, Date eventTime) {
    return taskId + "_" + eventTime.getTime() + "_" + runSequence.getAndIncrement();
  }

  private boolean isDuplicateKey(SQLException e) {
    return e.getErrorCode() == 1062 || (e.getSQLState() != null && e.getSQLState().startsWith("23"));
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
