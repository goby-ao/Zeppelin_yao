-- Zeppelin 任务审计日志表 - 支持多集群
-- by yao's AI
--
-- 使用方法：
-- 1. 创建数据库：CREATE DATABASE zeppelin_audit DEFAULT CHARACTER SET utf8mb4;
-- 2. 执行此脚本：mysql -u root -p zeppelin_audit < zeppelin_task_audit.sql
--

CREATE TABLE IF NOT EXISTS zeppelin_task_audit (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  cluster_name VARCHAR(100) COMMENT '集群名称 (ns1/ns2/ns3)',
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

  INDEX idx_cluster_name (cluster_name),
  INDEX idx_task_id (task_id),
  INDEX idx_note_id (note_id),
  INDEX idx_user (user),
  INDEX idx_status (status),
  INDEX idx_date_created (date_created),
  INDEX idx_date_started (date_started)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Zeppelin 任务审计日志表';
