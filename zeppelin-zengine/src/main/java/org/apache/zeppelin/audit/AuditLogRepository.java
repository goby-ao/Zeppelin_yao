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
 * 审计日志仓储接口 - 定义审计日志的持久化操作
 * by yao's AI
 */
public interface AuditLogRepository {

  /**
   * 初始化仓储
   * by yao's AI
   */
  void init();

  /**
   * 保存或更新审计日志
   * 根据 paragraph ID 判断是插入还是更新
   *
   * @param paragraph 段落对象
   * @param before    之前的状态
   * @param after     之后的状态
   * by yao's AI
   */
  void save(Paragraph paragraph, Job.Status before, Job.Status after);

  /**
   * 关闭仓储，释放资源
   * by yao's AI
   */
  void close();
}
