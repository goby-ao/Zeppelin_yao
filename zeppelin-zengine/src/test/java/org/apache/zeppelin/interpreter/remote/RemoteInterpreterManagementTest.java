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
package org.apache.zeppelin.interpreter.remote;

import org.apache.zeppelin.interpreter.InterpreterCloseException;
import org.junit.Test;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

public class RemoteInterpreterManagementTest {
  @Test(timeout = 5000)
  public void managementDeadlineClosesSocketWithoutRetry() throws Exception {
    ExecutorService peer = Executors.newSingleThreadExecutor();
    try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      Future<Integer> requestBytes = peer.submit(() -> {
        try (Socket socket = server.accept()) {
          socket.setSoTimeout(3000);
          int received = 0;
          while (socket.getInputStream().read() != -1) {
            received++;
          }
          return received;
        }
      });
      RemoteInterpreterProcess process = mock(RemoteInterpreterProcess.class, CALLS_REAL_METHODS);
      when(process.getHost()).thenReturn("127.0.0.1");
      when(process.getPort()).thenReturn(server.getLocalPort());
      process.setManagementTimeout(100);
      try {
        process.callManagementFunction(client -> { client.close("session", "jdbc"); return null; });
        fail("Server did not reply; RPC must time out");
      } catch (InterpreterCloseException expected) {
        assertTrue(expected.isTimeout());
      }
      assertTrue("The peer must see EOF, not just an abandoned Future",
          requestBytes.get(2, TimeUnit.SECONDS) > 0);
      verify(process, times(1)).getPort();
    } finally {
      peer.shutdownNow();
    }
  }
}
