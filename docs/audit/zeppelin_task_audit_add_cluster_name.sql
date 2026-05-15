-- Add cluster_name to Zeppelin task audit table.
-- by yao's AI
--
-- Run this only when zeppelin_task_audit already exists and does not have cluster_name.
-- MySQL 5.7 does not support ADD COLUMN IF NOT EXISTS, so check before running:
--   SHOW COLUMNS FROM zeppelin_task_audit LIKE 'cluster_name';

ALTER TABLE zeppelin_task_audit
  ADD COLUMN cluster_name VARCHAR(64) COMMENT '集群标识' AFTER run_id,
  ADD INDEX idx_cluster_name (cluster_name);
