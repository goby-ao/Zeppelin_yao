/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.apache.zeppelin.jdbc;

import org.apache.commons.dbcp2.ConnectionFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Owns physical connections, including connections currently borrowed from DBCP. */
final class JDBCConnectionClose {
  private static final Logger LOGGER = LoggerFactory.getLogger(JDBCConnectionClose.class);
  private static final ThreadPoolExecutor CLOSE_WORKERS = workers("JDBC-close", 8);
  private static final ThreadPoolExecutor ABORT_WORKERS = workers("JDBC-abort", 8);

  private final Set<Connection> connections =
      Collections.newSetFromMap(new IdentityHashMap<Connection, Boolean>());
  private boolean closing;
  private int creating;
  private int executing;
  private Future<?> closeTask;
  private boolean abortStarted;
  private long graceDeadline;
  private long deadline;

  private static ThreadPoolExecutor workers(String name, int count) {
    return new ThreadPoolExecutor(0, count, 60, TimeUnit.SECONDS,
        new SynchronousQueue<>(), task -> {
          Thread thread = new Thread(task, name);
          thread.setDaemon(true);
          return thread;
        });
  }

  synchronized void ensureOpen() throws SQLException {
    if (closing) {
      throw new SQLException("JDBC interpreter is closing; new connections are disabled");
    }
  }

  Connection create(ConnectionFactory factory) throws SQLException {
    synchronized (this) {
      ensureOpen();
      creating++;
    }
    try {
      Connection connection = factory.createConnection();
      synchronized (this) {
        connections.add(connection);
        if (!closing) {
          return connection;
        }
      }
      // A connection finishing after close started must never escape to a new query.
      connection.abort(Runnable::run);
      if (!connection.isClosed()) {
        throw new SQLException("Driver did not abort a connection created during close");
      }
      released(connection);
      throw new SQLException("Connection completed after JDBC interpreter started closing");
    } finally {
      synchronized (this) {
        creating--;
        notifyAll();
      }
    }
  }

  synchronized void released(Connection connection) {
    connections.remove(connection);
  }

  synchronized void beginExecution() throws SQLException {
    ensureOpen();
    executing++;
  }

  synchronized void endExecution() {
    executing--;
    notifyAll();
  }

  private synchronized List<Connection> snapshot() {
    return new ArrayList<>(connections);
  }

  private synchronized void awaitIdle(boolean includeQueries) throws InterruptedException {
    while (creating > 0 || (includeQueries && executing > 0)) {
      wait();
    }
  }

  void close(Callable<Void> cleanup, long gracefulMs, long abortMs) {
    if (gracefulMs <= 0 || abortMs <= 0) {
      throw new IllegalArgumentException("JDBC close timeouts must be positive");
    }
    Future<?> task;
    synchronized (this) {
      if (closeTask == null) {
        closing = true;
        graceDeadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(gracefulMs);
        deadline = graceDeadline + TimeUnit.MILLISECONDS.toNanos(abortMs);
        // A rejected submission leaves this instance isolated, not partially reopened.
        closeTask = CLOSE_WORKERS.submit(() -> closeResources(cleanup));
      }
      task = closeTask;
    }
    try {
      try {
        task.get(Math.max(1, graceDeadline - System.nanoTime()), TimeUnit.NANOSECONDS);
      } catch (TimeoutException e) {
        abortConnections();
        task.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted closing JDBC; instance remains isolated", e);
    } catch (ExecutionException e) {
      // A transport abort can make CloseSession throw even though local cleanup completed.
      synchronized (this) {
        if (!(e.getCause() instanceof SQLException) || !connections.isEmpty()
            || creating != 0 || executing != 0) {
          throw new IllegalStateException("JDBC close failed; instance remains isolated", e.getCause());
        }
      }
      LOGGER.warn("JDBC connections closed locally; remote session cleanup is unconfirmed",
          e.getCause());
    } catch (TimeoutException e) {
      throw new IllegalStateException("JDBC close timed out; driver must support Connection.abort"
          + " and cleanup must finish before this instance can be replaced", e);
    }
  }

  private Void closeResources(Callable<Void> cleanup) throws Exception {
    awaitIdle(false);
    Exception failure = null;
    try {
      cleanup.call();
    } catch (Exception e) {
      failure = e;
    }
    for (Connection connection : snapshot()) {
      try {
        connection.close();
      } catch (SQLException e) {
        if (failure == null) {
          failure = e;
        } else {
          failure.addSuppressed(e);
        }
      } finally {
        if (connection.isClosed()) {
          released(connection);
        }
      }
    }
    awaitIdle(true);
    if (failure != null) {
      throw failure;
    }
    if (!snapshot().isEmpty()) {
      throw new SQLException("Driver returned from close without closing its physical connection");
    }
    return null;
  }

  private void abortConnections() throws InterruptedException, ExecutionException, TimeoutException {
    synchronized (this) {
      if (abortStarted) {
        return;
      }
      abortStarted = true;
    }
    // The independent worker executes abort synchronously so a returned Future proves it finished.
    // Process connections sequentially to avoid one stuck driver consuming an unbounded worker set.
    for (Connection connection : snapshot()) {
      Future<?> abort = ABORT_WORKERS.submit(() -> {
        connection.abort(Runnable::run);
        if (!connection.isClosed()) {
          throw new SQLException("Driver returned from abort without closing the connection");
        }
        released(connection);
        return null;
      });
      abort.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
    }
    LOGGER.warn("Aborted local JDBC connections after close timeout; remote SQL may still be running");
  }
}
