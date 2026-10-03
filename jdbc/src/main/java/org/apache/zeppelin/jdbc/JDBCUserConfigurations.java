/**
 * Licensed to the Apache Software Foundation (ASF) under one or more contributor license
 * agreements. See the NOTICE file distributed with this work for additional information regarding
 * copyright ownership. The ASF licenses this file to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License. You may obtain a
 * copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */
package org.apache.zeppelin.jdbc;

import org.apache.commons.dbcp2.PoolingDriver;

import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.ArrayList;
import java.util.List;
import java.util.Collections;
import java.util.concurrent.ConcurrentHashMap;

import org.apache.zeppelin.user.UsernamePassword;

/**
 * UserConfigurations for JDBC impersonation.
 */
public class JDBCUserConfigurations {
  private final Map<String, Statement> paragraphIdStatementMap;
  // dbPrefix --> PoolingDriver
  private final Map<String, PoolingDriver> poolingDriverMap;
  // dbPrefix --> Properties
  private final HashMap<String, Properties> propertiesMap;
  // dbPrefix --> Boolean
  private Map<String, Boolean> isSuccessful;

  public JDBCUserConfigurations() {
    // Precode may use a null paragraph id, which ConcurrentHashMap does not support.
    paragraphIdStatementMap = Collections.synchronizedMap(new HashMap<>());
    poolingDriverMap = new ConcurrentHashMap<>();
    propertiesMap = new HashMap<>();
    isSuccessful = new ConcurrentHashMap<>();
  }

  public void initStatementMap() throws SQLException {
    SQLException failure = null;
    List<Statement> statements;
    synchronized (paragraphIdStatementMap) {
      statements = new ArrayList<>(paragraphIdStatementMap.values());
    }
    for (Statement statement : statements) {
      try {
        statement.close();
      } catch (SQLException e) {
        if (failure == null) {
          failure = e;
        } else {
          failure.addSuppressed(e);
        }
      }
    }
    paragraphIdStatementMap.clear();
    if (failure != null) {
      throw failure;
    }
  }

  public List<String> getDBPoolNames() {
    return new ArrayList<>(poolingDriverMap.keySet());
  }

  public PoolingDriver getDBDriverPool(String key) {
    return poolingDriverMap.get(key);
  }

  public void initConnectionPoolMap() throws SQLException {
    poolingDriverMap.clear();
    isSuccessful.clear();
  }

  public void setPropertyMap(String dbPrefix, Properties properties) {
    Properties p = (Properties) properties.clone();
    propertiesMap.put(dbPrefix, p);
  }

  public Properties getPropertyMap(String key) {
    return propertiesMap.get(key);
  }

  public void cleanUserProperty(String dfPrefix) {
    propertiesMap.get(dfPrefix).remove("user");
    propertiesMap.get(dfPrefix).remove("password");
  }

  public void setUserProperty(String dbPrefix, UsernamePassword usernamePassword) {
    propertiesMap.get(dbPrefix).setProperty("user", usernamePassword.getUsername());
    propertiesMap.get(dbPrefix).setProperty("password", usernamePassword.getPassword());
  }

  public void saveStatement(String paragraphId, Statement statement) throws SQLException {
    paragraphIdStatementMap.put(paragraphId, statement);
  }

  public void cancelStatement(String paragraphId) throws SQLException {
    paragraphIdStatementMap.get(paragraphId).cancel();
  }

  public void removeStatement(String paragraphId) {
    paragraphIdStatementMap.remove(paragraphId);
  }

  public void saveDBDriverPool(String dbPrefix, PoolingDriver driver) throws SQLException {
    poolingDriverMap.put(dbPrefix, driver);
    isSuccessful.put(dbPrefix, false);
  }
  public PoolingDriver removeDBDriverPool(String key) throws SQLException {
    isSuccessful.remove(key);
    return poolingDriverMap.remove(key);
  }

  public boolean isConnectionInDBDriverPool(String key) {
    return poolingDriverMap.containsKey(key);
  }

  public void setConnectionInDBDriverPoolSuccessful(String dbPrefix) {
    isSuccessful.put(dbPrefix, true);
  }
}
