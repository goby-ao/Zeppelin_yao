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
package org.apache.zeppelin.interpreter.remote;

import com.google.gson.Gson;
import org.apache.thrift.protocol.TBinaryProtocol;
import org.apache.thrift.protocol.TProtocol;
import org.apache.thrift.transport.TSocket;
import org.apache.thrift.transport.TTransportException;
import org.apache.zeppelin.conf.ZeppelinConfiguration;
import org.apache.zeppelin.interpreter.InterpreterCloseException;
import org.apache.zeppelin.interpreter.thrift.InterpreterRPCException;
import org.apache.zeppelin.interpreter.launcher.InterpreterClient;
import org.apache.zeppelin.interpreter.thrift.RemoteInterpreterService.Client;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Abstract class for interpreter process
 */
public abstract class RemoteInterpreterProcess implements InterpreterClient {
  private static final Logger LOGGER = LoggerFactory.getLogger(RemoteInterpreterProcess.class);
  private static final Gson GSON = new Gson();

  private int connectTimeout;
  protected String intpEventServerHost;
  protected int intpEventServerPort;
  private PooledRemoteClient<Client> remoteClient;
  private String startTime;
  private int managementTimeout = 30000;
  private static final ScheduledThreadPoolExecutor MANAGEMENT_DEADLINES =
      new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "Interpreter-management-deadline");
        thread.setDaemon(true);
        return thread;
      });

  static {
    MANAGEMENT_DEADLINES.setRemoveOnCancelPolicy(true);
  }

  public RemoteInterpreterProcess(int connectTimeout,
                                  int connectionPoolSize,
                                  String intpEventServerHost,
                                  int intpEventServerPort) {
    this.connectTimeout = connectTimeout;
    this.intpEventServerHost = intpEventServerHost;
    this.intpEventServerPort = intpEventServerPort;
    this.startTime = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date());
    this.remoteClient = new PooledRemoteClient<>(() -> {
      TSocket transport = new TSocket(getHost(), getPort());
      try {
        transport.open();
      } catch (TTransportException e) {
        throw new IOException(e);
      }
      TProtocol protocol = new  TBinaryProtocol(transport);
      return new Client(protocol);
    }, connectionPoolSize);
  }

  public int getConnectTimeout() {
    return connectTimeout;
  }

  public String getStartTime() {
    return startTime;
  }

  public void shutdown() {
    if (remoteClient != null) {
      remoteClient.shutdown();
      remoteClient = null;
    }
  }

  /**
   * Called when angular object is updated in client side to propagate
   * change to the remote process
   * @param name
   * @param o
   */
  public void updateRemoteAngularObject(String name,
                                        String noteId,
                                        String paragraphId,
                                        Object o) {
    remoteClient.callRemoteFunction(client -> {
       client.angularObjectUpdate(name, noteId, paragraphId, GSON.toJson(o));
       return null;
    });
  }

  public <R> R callRemoteFunction(PooledRemoteClient.RemoteFunction<R, Client> func) {
    return remoteClient.callRemoteFunction(func);
  }

  public void setManagementTimeout(int timeoutMs) {
    if (timeoutMs <= 0) {
      throw new IllegalArgumentException("zeppelin.interpreter.management.timeout must be positive");
    }
    managementTimeout = timeoutMs;
  }

  /** One connection, one attempt. Never reuse a timed-out management response for a SQL call. */
  public <R> R callManagementFunction(PooledRemoteClient.RemoteFunction<R, Client> func) {
    return callManagementFunction(func, managementTimeout);
  }

  public <R> R callManagementFunction(PooledRemoteClient.RemoteFunction<R, Client> func,
                                     int maxTimeoutMs) {
    int timeoutMs = Math.min(managementTimeout, maxTimeoutMs);
    TSocket transport = new TSocket(getHost(), getPort(), timeoutMs);
    AtomicBoolean expired = new AtomicBoolean();
    ScheduledFuture<?> deadline = MANAGEMENT_DEADLINES.schedule(() -> {
      expired.set(true);
      transport.close();
    }, timeoutMs, TimeUnit.MILLISECONDS);
    try {
      transport.open();
      return func.call(new Client(new TBinaryProtocol(transport)));
    } catch (Exception e) {
      String detail = e instanceof InterpreterRPCException
          ? ((InterpreterRPCException) e).getErrorMessage() : e.toString();
      boolean timeout = expired.get() || (e instanceof TTransportException
          && ((TTransportException) e).getType() == TTransportException.TIMED_OUT);
      throw new InterpreterCloseException("Interpreter management RPC "
          + (timeout ? "timed out: " : "failed: ") + detail, e, timeout);
    } finally {
      deadline.cancel(false);
      transport.close();
    }
  }

  public void init(ZeppelinConfiguration zConf) {
    callRemoteFunction(client -> {
      client.init(zConf.getCompleteConfiguration());
      return null;
    });
  }

  @Override
  public boolean recover() {
    try {
      remoteClient.callRemoteFunction(client -> {
        client.reconnect(intpEventServerHost, intpEventServerPort);
        return null;
      });
      return true;
    } catch (Exception e) {
      LOGGER.error("Fail to recover remote interpreter process: {}" , e.getMessage());
      return false;
    }
  }


  /**
   * called by RemoteInterpreterEventServer to notify that RemoteInterpreter Process is started
   */
  public abstract void processStarted(int port, String host);

  public abstract String getErrorMessage();
}
