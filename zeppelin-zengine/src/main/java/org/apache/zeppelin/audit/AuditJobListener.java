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
import org.apache.zeppelin.notebook.ParagraphJobListener;
import org.apache.zeppelin.scheduler.Job;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 审计日志 JobListener - 使用装饰器模式包装原有的 ParagraphJobListener
 * 先委托原 listener 处理 WebSocket 等通知，再异步保存审计日志
 * by yao's AI
 */
public class AuditJobListener implements ParagraphJobListener {

  private static final Logger LOGGER = LoggerFactory.getLogger(AuditJobListener.class);

  private final ParagraphJobListener delegate;
  private final AuditLogRepository repository;

  public AuditJobListener(ParagraphJobListener delegate, AuditLogRepository repository) {
    this.delegate = delegate;
    this.repository = repository;
    LOGGER.info("AuditJobListener initialized with repository: {}",
        repository.getClass().getSimpleName());
  }

  @Override
  public void onProgressUpdate(Paragraph paragraph, int progress) {
    // 委托原 listener 处理进度更新
    if (delegate != null) {
      delegate.onProgressUpdate(paragraph, progress);
    }
  }

  @Override
  public void onStatusChange(Paragraph paragraph, Job.Status before, Job.Status after) {
    // 1. 先委托原 listener，保证 WebSocket 实时通知等功能正常
    if (delegate != null) {
      delegate.onStatusChange(paragraph, before, after);
    }

    // 2. 保存审计日志
    try {
      repository.save(paragraph, before, after);
    } catch (Exception e) {
      // 捕获所有异常，保证审计日志失败不影响任务执行
      LOGGER.error("Failed to save audit log for paragraph: {}", paragraph.getId(), e);
    }
  }

  @Override
  public void noteRunningStatusChange(String noteId, boolean newStatus) {
    // 委托原 listener 处理 notebook 运行状态变化
    if (delegate != null) {
      delegate.noteRunningStatusChange(noteId, newStatus);
    }
  }

  /**
   * 获取被委托的原始 listener
   * by yao's AI
   */
  public ParagraphJobListener getDelegate() {
    return delegate;
  }

  /**
   * 获取审计日志仓储
   * by yao's AI
   */
  public AuditLogRepository getRepository() {
    return repository;
  }
}
