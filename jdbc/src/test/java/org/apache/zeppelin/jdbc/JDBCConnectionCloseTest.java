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

import org.junit.Test;

import java.net.ServerSocket;
import java.net.Socket;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.*;
import static org.mockito.Matchers.any;
import static org.mockito.Mockito.*;

public class JDBCConnectionCloseTest {
  @Test
  public void normalCloseDoesNotAbortOrChangeQueryTimeout() throws Exception {
    JDBCConnectionClose owner = new JDBCConnectionClose();
    Connection connection = mock(Connection.class);
    when(connection.isClosed()).thenReturn(true);
    owner.create(() -> connection);
    owner.close(() -> null, 1000, 1000);
    verify(connection).close();
    verify(connection, never()).abort(any(Executor.class));
    verify(connection, never()).setNetworkTimeout(any(Executor.class), anyInt());
    owner.close(() -> { fail("Cleanup must not run twice"); return null; }, 1000, 1000);
    verify(connection, times(1)).close();
  }

  @Test(timeout = 5000)
  public void abortBreaksRealSocketReadAndWaitsForCloseThread() throws Exception {
    JDBCConnectionClose owner = new JDBCConnectionClose();
    try (ServerSocket server = new ServerSocket(0);
         Socket client = new Socket("127.0.0.1", server.getLocalPort());
         Socket peer = server.accept()) {
      AtomicBoolean closed = new AtomicBoolean();
      CountDownLatch exited = new CountDownLatch(1);
      Connection connection = mock(Connection.class);
      when(connection.isClosed()).thenAnswer(invocation -> closed.get());
      doAnswer(invocation -> {
        try {
          client.getInputStream().read();
        } catch (Exception e) {
          throw new SQLException("CloseSession has no response", e);
        } finally {
          exited.countDown();
        }
        return null;
      }).when(connection).close();
      doAnswer(invocation -> {
        ((Executor) invocation.getArguments()[0]).execute(() -> {
          try {
            client.close();
            closed.set(true);
          } catch (Exception e) {
            throw new IllegalStateException(e);
          }
        });
        return null;
      }).when(connection).abort(any(Executor.class));
      owner.create(() -> connection);
      owner.close(() -> null, 100, 1000);
      assertTrue(exited.await(1, TimeUnit.SECONDS));
      assertTrue(client.isClosed());
      verify(connection).abort(any(Executor.class));
    }
  }

  @Test(timeout = 5000)
  public void unsupportedAbortFailsAndDoesNotStartAnotherClose() throws Exception {
    JDBCConnectionClose owner = new JDBCConnectionClose();
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch exited = new CountDownLatch(1);
    AtomicBoolean closed = new AtomicBoolean();
    Connection connection = mock(Connection.class);
    when(connection.isClosed()).thenAnswer(invocation -> closed.get());
    doAnswer(invocation -> {
      release.await();
      closed.set(true);
      exited.countDown();
      return null;
    }).when(connection).close();
    doThrow(new SQLFeatureNotSupportedException("abort unsupported"))
        .when(connection).abort(any(Executor.class));
    owner.create(() -> connection);
    try {
      expectCloseFailure(owner);
      expectCloseFailure(owner);
      verify(connection, times(1)).close();
      try {
        owner.create(() -> mock(Connection.class));
        fail("Must not reopen a failed instance");
      } catch (SQLException expected) {
        assertTrue(expected.getMessage().contains("closing"));
      }
    } finally {
      release.countDown();
      assertTrue(exited.await(1, TimeUnit.SECONDS));
    }
  }

  @Test(timeout = 5000)
  public void abortAlsoProtectsStatementCleanup() throws Exception {
    JDBCConnectionClose owner = new JDBCConnectionClose();
    CountDownLatch statementCanClose = new CountDownLatch(1);
    Connection connection = mock(Connection.class);
    when(connection.isClosed()).thenReturn(true);
    doAnswer(invocation -> {
      statementCanClose.countDown();
      return null;
    }).when(connection).abort(any(Executor.class));
    owner.create(() -> connection);
    owner.close(() -> {
      statementCanClose.await();
      return null;
    }, 100, 1000);
    verify(connection).abort(any(Executor.class));
  }

  private void expectCloseFailure(JDBCConnectionClose owner) {
    try {
      owner.close(() -> null, 100, 100);
      fail("Unreleased resources must not be reported as a successful close");
    } catch (IllegalStateException expected) {
      assertNotNull(expected.getCause());
    }
  }

  @Test(timeout = 5000)
  public void closedSocketAloneDoesNotMeanExecutionHasExited() throws Exception {
    JDBCConnectionClose owner = new JDBCConnectionClose();
    Connection connection = mock(Connection.class);
    when(connection.isClosed()).thenReturn(true);
    owner.create(() -> connection);
    owner.beginExecution();
    try {
      expectCloseFailure(owner);
    } finally {
      owner.endExecution();
    }
  }

  @Test(timeout = 5000)
  public void driverNoOpAbortIsNotReportedAsSuccess() throws Exception {
    JDBCConnectionClose owner = new JDBCConnectionClose();
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch exited = new CountDownLatch(1);
    Connection connection = mock(Connection.class);
    doAnswer(invocation -> {
      release.await();
      exited.countDown();
      return null;
    }).when(connection).close();
    owner.create(() -> connection);
    try {
      expectCloseFailure(owner);
      verify(connection).abort(any(Executor.class));
    } finally {
      release.countDown();
      assertTrue(exited.await(1, TimeUnit.SECONDS));
    }
  }
}
