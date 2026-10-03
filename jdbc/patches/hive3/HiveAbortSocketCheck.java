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
import org.apache.hive.jdbc.HiveConnection;
import org.apache.hive.service.auth.PlainSaslServer.SaslPlainProvider;
import org.apache.hive.service.rpc.thrift.*;
import org.apache.hive.org.apache.thrift.protocol.TBinaryProtocol;
import org.apache.hive.org.apache.thrift.transport.TSocket;
import org.apache.hive.org.apache.thrift.transport.TSaslServerTransport;
import org.apache.hive.org.apache.thrift.transport.TTransport;

import java.lang.reflect.Proxy;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.security.Security;
import javax.security.sasl.AuthorizeCallback;
import java.util.Collections;
import java.util.Properties;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Real Hive client and Thrift/SASL sockets, with a server withholding CloseSession's reply. */
public class HiveAbortSocketCheck {
  public static void main(String[] args) throws Exception {
    boolean patched = "patched".equals(args[0]);
    for (boolean sasl : new boolean[] {false, true}) {
      verify(patched, sasl);
    }
  }

  private static void verify(boolean patched, boolean sasl) throws Exception {
    CountDownLatch closing = new CountDownLatch(1);
    CountDownLatch reply = new CountDownLatch(1);
    AtomicReference<Socket> peer = new AtomicReference<>();
    AtomicReference<Throwable> serverError = new AtomicReference<>();
    ExecutorService caller = Executors.newSingleThreadExecutor();
    try (ServerSocket listener = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      Thread server = new Thread(() -> {
        try (Socket socket = listener.accept()) {
          peer.set(socket);
          TTransport transport = new TSocket(socket);
          if (sasl) {
            Security.addProvider(new SaslPlainProvider());
            TSaslServerTransport.Factory factory = new TSaslServerTransport.Factory();
            factory.addServerDefinition("PLAIN", "NONE", null, Collections.emptyMap(), callbacks -> {
              for (javax.security.auth.callback.Callback callback : callbacks) {
                if (callback instanceof AuthorizeCallback) {
                  ((AuthorizeCallback) callback).setAuthorized(true);
                }
              }
            });
            transport = factory.getTransport(transport);
          }
          TCLIService.Iface handler = (TCLIService.Iface) Proxy.newProxyInstance(
              HiveAbortSocketCheck.class.getClassLoader(), new Class<?>[] {TCLIService.Iface.class},
              (proxy, method, arguments) -> {
                if ("OpenSession".equals(method.getName())) {
                  TOpenSessionResp response = new TOpenSessionResp();
                  response.setStatus(new TStatus(TStatusCode.SUCCESS_STATUS));
                  response.setServerProtocolVersion(TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10);
                  THandleIdentifier id = new THandleIdentifier(
                      ByteBuffer.wrap(new byte[16]), ByteBuffer.wrap(new byte[16]));
                  response.setSessionHandle(new TSessionHandle(id));
                  response.setConfiguration(Collections.emptyMap());
                  return response;
                }
                if ("CloseSession".equals(method.getName())) {
                  closing.countDown();
                  reply.await();
                  return new TCloseSessionResp(new TStatus(TStatusCode.SUCCESS_STATUS));
                }
                throw new AssertionError("Unexpected RPC " + method.getName());
              });
          TCLIService.Processor<TCLIService.Iface> processor = new TCLIService.Processor<>(handler);
          TBinaryProtocol protocol = new TBinaryProtocol(transport);
          processor.process(protocol, protocol); // OpenSession
          processor.process(protocol, protocol); // CloseSession
        } catch (Throwable e) {
          serverError.set(e);
          if (closing.getCount() != 0) {
            e.printStackTrace();
          }
        }
      }, "withholding-hs2");
      server.setDaemon(true);
      server.start();
      Properties properties = new Properties();
      properties.setProperty("user", "local-test");
      properties.setProperty("password", "local-test");
      HiveConnection connection = new HiveConnection("jdbc:hive2://127.0.0.1:"
          + listener.getLocalPort() + "/default" + (sasl ? "" : ";auth=noSasl"), properties);
      Future<?> close = caller.submit(() -> {
        try {
          connection.close();
        } catch (SQLException expectedAfterAbort) {
          // Closing the underlying socket must break the pending Thrift read.
        }
      });
      try {
        if (!closing.await(3, TimeUnit.SECONDS)) {
          throw new AssertionError("CloseSession did not reach server", serverError.get());
        }
        if (patched) {
          connection.abort(Runnable::run);
          close.get(2, TimeUnit.SECONDS);
          if (!connection.isClosed()) {
            throw new AssertionError("Connection remained open");
          }
          connection.abort(Runnable::run); // idempotent
        } else {
          try {
            connection.abort(Runnable::run);
            throw new AssertionError("Expected unpatched abort to be unsupported");
          } catch (SQLFeatureNotSupportedException expected) {
            if (close.isDone()) {
              throw new AssertionError("Baseline unexpectedly released blocked close");
            }
          }
        }
        System.out.println("PASS " + (patched ? "patched" : "baseline")
            + " " + (sasl ? "SASL/PLAIN" : "binary/noSasl"));
      } finally {
        reply.countDown();
        Socket socket = peer.get();
        if (socket != null) {
          socket.close();
        }
        close.get(3, TimeUnit.SECONDS);
        server.join(3000);
      }
    } finally {
      caller.shutdownNow();
    }
  }
}
