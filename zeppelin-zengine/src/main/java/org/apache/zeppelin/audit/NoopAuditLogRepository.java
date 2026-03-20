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

/**
 * 空实现审计日志仓储 - 不做任何操作，默认使用
 * by yao's AI
 */
public class NoopAuditLogRepository implements AuditLogRepository {

  @Override
  public void init() {
    // 空操作 - 默认关闭审计功能
  }

  @Override
  public void save(Paragraph paragraph, Job.Status before, Job.Status after) {
    // 空操作 - 不保存任何日志
  }

  @Override
  public void close() {
    // 空操作 - 无资源需要释放
  }
}
