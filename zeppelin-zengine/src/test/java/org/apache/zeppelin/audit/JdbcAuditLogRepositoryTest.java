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

import org.apache.zeppelin.notebook.Note;
import org.apache.zeppelin.notebook.Paragraph;
import org.apache.zeppelin.scheduler.Job;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.logging.Logger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class JdbcAuditLogRepositoryTest {

  private static final String JDBC_URL_PREFIX = "jdbc:zeppelin-audit-test:";

  private RecordingDriver driver;

  @Before
  public void setUp() throws SQLException {
    driver = new RecordingDriver();
    DriverManager.registerDriver(driver);
  }

  @After
  public void tearDown() throws SQLException {
    DriverManager.deregisterDriver(driver);
  }

  @Test
  public void shouldIgnoreReadyStatus() {
    JdbcAuditLogRepository repository =
        new JdbcAuditLogRepository(JDBC_URL_PREFIX + "ready", "", "", 1);
    repository.init();

    repository.save(new Paragraph("paragraph_1", null, null),
        Job.Status.RUNNING, Job.Status.READY);
    repository.close();

    assertTrue(driver.getSqls().isEmpty());
  }

  @Test
  public void shouldNotMoveUpdatedAtBackwardsWhenPendingInsertIsDuplicated() {
    driver.setDuplicateOnInsert(true);
    JdbcAuditLogRepository repository =
        new JdbcAuditLogRepository(JDBC_URL_PREFIX + "duplicate", "", "", 1);
    repository.init();

    Paragraph paragraph = new Paragraph("paragraph_1", null, null);
    paragraph.setText("%md\nselect 1");
    repository.save(paragraph, Job.Status.READY, Job.Status.PENDING);
    repository.close();

    String updateSql = findSqlStartingWith("UPDATE zeppelin_task_audit SET date_submitted");
    assertFalse(updateSql.contains("updated_at"));
  }

  @Test
  public void shouldUseNoteDefaultInterpreterWhenParagraphHasNoInterpreterText() {
    JdbcAuditLogRepository repository =
        new JdbcAuditLogRepository(JDBC_URL_PREFIX + "default-interpreter", "", "", 1);
    repository.init();

    Note note = new Note();
    note.setDefaultInterpreterGroup("dataanalysis3_mysql");
    Paragraph paragraph = new Paragraph("paragraph_1", null, null);
    paragraph.setNote(note);
    paragraph.setText("select * from zeppelin_task_audit");

    repository.save(paragraph, Job.Status.READY, Job.Status.PENDING);
    repository.close();

    assertEquals("dataanalysis3_mysql", driver.getInsertInterpreterTypes().get(0));
  }

  @Test
  public void shouldWriteConfiguredClusterName() {
    JdbcAuditLogRepository repository =
        new JdbcAuditLogRepository(JDBC_URL_PREFIX + "cluster-name", "", "", 1, "cluster1");
    repository.init();

    Paragraph paragraph = new Paragraph("paragraph_1", null, null);
    paragraph.setText("%sh\nwhoami");

    repository.save(paragraph, Job.Status.READY, Job.Status.PENDING);
    repository.close();

    assertEquals("cluster1", driver.getInsertClusterNames().get(0));
  }

  @Test
  public void shouldUseClusterNameWhenLookingUpActiveRun() {
    JdbcAuditLogRepository repository =
        new JdbcAuditLogRepository(JDBC_URL_PREFIX + "active-run", "", "", 1, "cluster1");
    repository.init();

    Paragraph paragraph = new Paragraph("paragraph_1", null, null);
    paragraph.setText("%sh\nwhoami");

    repository.save(paragraph, Job.Status.PENDING, Job.Status.RUNNING);
    repository.close();

    String selectSql = findSqlStartingWith("SELECT run_id FROM zeppelin_task_audit");
    assertTrue(selectSql.contains("cluster_name = ?"));
  }


  private String findSqlStartingWith(String prefix) {
    for (String sql : driver.getSqls()) {
      if (sql.startsWith(prefix)) {
        return sql;
      }
    }
    throw new AssertionError("SQL not found with prefix: " + prefix
        + ", executed SQLs: " + driver.getSqls());
  }

  private static final class RecordingDriver implements Driver {

    private final List<String> sqls = Collections.synchronizedList(new ArrayList<String>());
    private final List<String> insertClusterNames =
        Collections.synchronizedList(new ArrayList<String>());
    private final List<String> insertInterpreterTypes =
        Collections.synchronizedList(new ArrayList<String>());
    private volatile boolean duplicateOnInsert;

    void setDuplicateOnInsert(boolean duplicateOnInsert) {
      this.duplicateOnInsert = duplicateOnInsert;
    }

    List<String> getSqls() {
      return sqls;
    }

    List<String> getInsertClusterNames() {
      return insertClusterNames;
    }

    List<String> getInsertInterpreterTypes() {
      return insertInterpreterTypes;
    }

    @Override
    public Connection connect(String url, Properties info) throws SQLException {
      if (!acceptsURL(url)) {
        return null;
      }
      return proxy(Connection.class, new ConnectionHandler(this));
    }

    @Override
    public boolean acceptsURL(String url) {
      return url != null && url.startsWith(JDBC_URL_PREFIX);
    }

    @Override
    public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
      return new DriverPropertyInfo[0];
    }

    @Override
    public int getMajorVersion() {
      return 1;
    }

    @Override
    public int getMinorVersion() {
      return 0;
    }

    @Override
    public boolean jdbcCompliant() {
      return false;
    }

    @Override
    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
      throw new SQLFeatureNotSupportedException();
    }
  }

  private static final class ConnectionHandler implements InvocationHandler {

    private final RecordingDriver driver;

    ConnectionHandler(RecordingDriver driver) {
      this.driver = driver;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
      String methodName = method.getName();
      if ("prepareStatement".equals(methodName)) {
        return JdbcAuditLogRepositoryTest.proxy(PreparedStatement.class,
            new PreparedStatementHandler(driver, (String) args[0]));
      }
      if ("close".equals(methodName)) {
        return null;
      }
      if ("isClosed".equals(methodName)) {
        return false;
      }
      if ("isValid".equals(methodName)) {
        return true;
      }
      if ("toString".equals(methodName)) {
        return "RecordingConnection";
      }
      return defaultValue(method.getReturnType());
    }
  }

  private static final class PreparedStatementHandler implements InvocationHandler {

    private final RecordingDriver driver;
    private final String sql;
    private final Map<Integer, Object> parameters = new HashMap<>();

    PreparedStatementHandler(RecordingDriver driver, String sql) {
      this.driver = driver;
      this.sql = sql;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
      String methodName = method.getName();
      if (methodName.startsWith("set") && args != null && args.length >= 2
          && args[0] instanceof Integer) {
        parameters.put((Integer) args[0], args[1]);
        return null;
      }
      if ("executeUpdate".equals(methodName)) {
        driver.getSqls().add(sql);
        if (sql.startsWith("INSERT INTO zeppelin_task_audit")) {
          Object clusterName = parameters.get(2);
          driver.getInsertClusterNames().add(
              clusterName == null ? null : clusterName.toString());
          Object interpreterType = parameters.get(10);
          driver.getInsertInterpreterTypes().add(
              interpreterType == null ? null : interpreterType.toString());
        }
        if (driver.duplicateOnInsert && sql.startsWith("INSERT INTO zeppelin_task_audit")) {
          throw new SQLException("Duplicate run_id", "23000", 1062);
        }
        return 1;
      }
      if ("executeQuery".equals(methodName) || "getGeneratedKeys".equals(methodName)) {
        driver.getSqls().add(sql);
        return JdbcAuditLogRepositoryTest.proxy(ResultSet.class, new EmptyResultSetHandler());
      }
      if ("close".equals(methodName)) {
        return null;
      }
      if ("toString".equals(methodName)) {
        return sql;
      }
      return defaultValue(method.getReturnType());
    }
  }

  private static final class EmptyResultSetHandler implements InvocationHandler {

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) {
      String methodName = method.getName();
      if ("next".equals(methodName)) {
        return false;
      }
      if ("close".equals(methodName)) {
        return null;
      }
      if ("toString".equals(methodName)) {
        return "EmptyResultSet";
      }
      return defaultValue(method.getReturnType());
    }
  }

  @SuppressWarnings("unchecked")
  private static <T> T proxy(Class<T> iface, InvocationHandler handler) {
    return (T) Proxy.newProxyInstance(
        iface.getClassLoader(), new Class<?>[] { iface }, handler);
  }

  private static Object defaultValue(Class<?> returnType) {
    if (returnType == Void.TYPE) {
      return null;
    }
    if (returnType == Boolean.TYPE) {
      return false;
    }
    if (returnType == Byte.TYPE) {
      return (byte) 0;
    }
    if (returnType == Short.TYPE) {
      return (short) 0;
    }
    if (returnType == Integer.TYPE) {
      return 0;
    }
    if (returnType == Long.TYPE) {
      return 0L;
    }
    if (returnType == Float.TYPE) {
      return 0F;
    }
    if (returnType == Double.TYPE) {
      return 0D;
    }
    if (returnType == Character.TYPE) {
      return '\0';
    }
    return null;
  }
}
