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

import org.apache.zeppelin.conf.ZeppelinConfiguration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 审计日志仓储工厂 - 根据配置创建对应的 AuditLogRepository 实例
 * by yao's AI
 */
public class AuditLoggerFactory {

  private static final Logger LOGGER = LoggerFactory.getLogger(AuditLoggerFactory.class);

  /**
   * 根据配置创建审计日志仓储
   *
   * @param conf Zeppelin 配置
   * @return AuditLogRepository 实例
   * by yao's AI
   */
  public static AuditLogRepository createRepository(ZeppelinConfiguration conf) {
    if (!conf.getBoolean(ZeppelinConfiguration.ConfVars.ZEPPELIN_AUDIT_ENABLED)) {
      LOGGER.info("Audit log is disabled, using NoopAuditLogRepository");
      return new NoopAuditLogRepository();
    }

    String storageType = conf.getString(ZeppelinConfiguration.ConfVars.ZEPPELIN_AUDIT_STORAGE_TYPE);

    if ("jdbc".equalsIgnoreCase(storageType)) {
      String jdbcUrl = conf.getString(ZeppelinConfiguration.ConfVars.ZEPPELIN_AUDIT_JDBC_URL);
      String jdbcUser = conf.getString(ZeppelinConfiguration.ConfVars.ZEPPELIN_AUDIT_JDBC_USER);
      String jdbcPassword = conf.getString(ZeppelinConfiguration.ConfVars.ZEPPELIN_AUDIT_JDBC_PASSWORD);
      int maxPoolSize = conf.getInt(ZeppelinConfiguration.ConfVars.ZEPPELIN_AUDIT_JDBC_MAX_POOL_SIZE);

      if (jdbcUrl == null || jdbcUrl.isEmpty()) {
        LOGGER.warn("Audit log JDBC URL is not configured, using NoopAuditLogRepository");
        return new NoopAuditLogRepository();
      }

      LOGGER.info("Creating JdbcAuditLogRepository with URL: {}", jdbcUrl);
      JdbcAuditLogRepository repo = new JdbcAuditLogRepository(jdbcUrl, jdbcUser, jdbcPassword, maxPoolSize);
      repo.init();
      return repo;
    }

    LOGGER.warn("Unknown audit storage type: {}, using NoopAuditLogRepository", storageType);
    return new NoopAuditLogRepository();
  }
}
