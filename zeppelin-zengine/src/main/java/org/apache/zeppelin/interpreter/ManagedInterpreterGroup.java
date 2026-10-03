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


package org.apache.zeppelin.interpreter;

import org.apache.zeppelin.conf.ZeppelinConfiguration;
import org.apache.zeppelin.interpreter.remote.RemoteInterpreterProcess;
import org.apache.zeppelin.interpreter.remote.ExecRemoteInterpreterProcess;
import org.apache.zeppelin.scheduler.Job;
import org.apache.zeppelin.scheduler.Scheduler;
import org.apache.zeppelin.scheduler.SchedulerFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * ManagedInterpreterGroup runs under zeppelin server
 */
public class ManagedInterpreterGroup extends InterpreterGroup {

  private static final Logger LOGGER = LoggerFactory.getLogger(ManagedInterpreterGroup.class);

  private InterpreterSetting interpreterSetting;
  private volatile RemoteInterpreterProcess remoteInterpreterProcess;
  private Object interpreterProcessCreationLock = new Object();
  private static final ThreadPoolExecutor CLOSE_EXECUTOR = new ThreadPoolExecutor(
      0, 8, 60, TimeUnit.SECONDS, new SynchronousQueue<>(), task -> {
        Thread thread = new Thread(task, "Interpreter-session-close");
        thread.setDaemon(true);
        return thread;
      });
  private final Map<String, CloseOperation> closingSessions = new HashMap<>();
  private boolean closingGroup;
  private boolean retiring;

  private static class CloseOperation {
    private final CompletableFuture<Void> result = new CompletableFuture<>();
    private final long deadline;

    CloseOperation(int timeoutMs) {
      deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
    }
  }

  /**
   * Create InterpreterGroup with given id and interpreterSetting, used in ZeppelinServer
   * @param id
   * @param interpreterSetting
   */
  ManagedInterpreterGroup(String id, InterpreterSetting interpreterSetting) {
    super(id);
    this.interpreterSetting = interpreterSetting;
  }

  public InterpreterSetting getInterpreterSetting() {
    return interpreterSetting;
  }

  public RemoteInterpreterProcess getOrCreateInterpreterProcess(String userName,
                                                                Properties properties)
      throws IOException {
    synchronized (interpreterProcessCreationLock) {
      if (remoteInterpreterProcess == null) {
        LOGGER.info("Create InterpreterProcess for InterpreterGroup: {}", getId());
        remoteInterpreterProcess = interpreterSetting.createInterpreterProcess(id, userName,
                properties);
        remoteInterpreterProcess.setManagementTimeout(Integer.parseInt(properties.getProperty(
            "zeppelin.interpreter.management.timeout", "30000")));
        remoteInterpreterProcess.start(userName);
        remoteInterpreterProcess.init(ZeppelinConfiguration.create());
        getInterpreterSetting().getRecoveryStorage()
                .onInterpreterClientStart(remoteInterpreterProcess);
      }
      return remoteInterpreterProcess;
    }
  }

  public RemoteInterpreterProcess getInterpreterProcess() {
    return remoteInterpreterProcess;
  }

  public RemoteInterpreterProcess getRemoteInterpreterProcess() {
    return remoteInterpreterProcess;
  }


  /**
   * Close all interpreter instances in this group
   */
  @Override
  public void close() {
    LOGGER.info("Close InterpreterGroup: {}", id);
    List<String> sessionIds;
    synchronized (this) {
      closingGroup = true;
      sessionIds = new ArrayList<>(sessions.keySet());
    }
    InterpreterCloseException failure = null;
    for (String sessionId : sessionIds) {
      try {
        close(sessionId);
      } catch (InterpreterCloseException e) {
        if (failure == null) {
          failure = e;
        } else if (failure != e) {
          failure.addSuppressed(e);
        }
      }
    }
    if (failure != null) {
      throw failure;
    }
  }

  /**
   * Close all interpreter instances in this session
   * @param sessionId
   */
  public void close(String sessionId) {
    CloseOperation operation;
    synchronized (this) {
      if (!sessions.containsKey(sessionId)) {
        return;
      }
      operation = closingSessions.get(sessionId);
      if (operation != null && operation.result.isCompletedExceptionally()
          && remoteInterpreterProcess instanceof ExecRemoteInterpreterProcess
          && !remoteInterpreterProcess.isRunning()) {
        // Explicit retry after the owned local process exited, not after a mere RPC timeout.
        closingSessions.remove(sessionId);
        operation = null;
      }
      if (operation == null) {
        operation = new CloseOperation(getCloseTimeout());
        closingSessions.put(sessionId, operation);
        CloseOperation submitted = operation;
        List<Interpreter> interpreters = new ArrayList<>(sessions.get(sessionId));
        try {
          CLOSE_EXECUTOR.execute(() -> closeSession(sessionId, interpreters, submitted));
        } catch (RejectedExecutionException e) {
          // Nothing was submitted; allow an explicit retry when capacity is available.
          closingSessions.remove(sessionId);
          throw new InterpreterCloseException("Interpreter close workers are busy; retry later",
              e, false);
        }
      }
    }
    awaitClose(sessionId, operation);
  }

  int getCloseTimeout() {
    int timeout = Integer.parseInt(interpreterSetting.getJavaProperties().getProperty(
        "zeppelin.interpreter.close.timeout", "45000"));
    if (timeout <= 0) {
      throw new IllegalArgumentException("zeppelin.interpreter.close.timeout must be positive");
    }
    return timeout;
  }

  private void awaitClose(String sessionId, CloseOperation operation) {
    try {
      operation.result.get(Math.max(1, operation.deadline - System.nanoTime()),
          TimeUnit.NANOSECONDS);
    } catch (TimeoutException e) {
      synchronized (this) {
        // Do not cancel a blocking close and then recreate a session on top of it.
        operation.result.completeExceptionally(new InterpreterCloseException(
            "Timed out closing session " + sessionId + "; session remains isolated", e, true));
      }
      awaitClose(sessionId, operation);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new InterpreterCloseException("Interrupted waiting for session close " + sessionId,
          e, false);
    } catch (ExecutionException e) {
      throw (InterpreterCloseException) e.getCause();
    }
  }

  private void closeSession(String sessionId, List<Interpreter> interpreters,
                            CloseOperation operation) {
    try {
      for (Interpreter interpreter : interpreters) {
        if (operation.result.isDone()) {
          return;
        }
        closeInterpreter(interpreter);
      }
      RemoteInterpreterProcess process;
      synchronized (this) {
        if (operation.result.isDone()) {
          return;
        }
        if (sessions.size() > 1) {
          sessions.remove(sessionId);
          closingSessions.remove(sessionId);
          operation.result.complete(null);
          return;
        }
        retiring = true;
        process = remoteInterpreterProcess;
      }
      // Network calls and process waits must never own the group monitor.
      if (process != null) {
        process.stop();
        try {
          interpreterSetting.getRecoveryStorage().onInterpreterClientStop(process);
        } catch (IOException e) {
          LOGGER.error("Fail to store recovery data", e);
        }
      }
      synchronized (this) {
        if (operation.result.isDone()) {
          return;
        }
        sessions.remove(sessionId);
        closingSessions.remove(sessionId);
        remoteInterpreterProcess = null;
        interpreterSetting.removeInterpreterGroup(id, this);
        operation.result.complete(null);
      }
    } catch (Exception e) {
      InterpreterCloseException failure = e instanceof InterpreterCloseException
          ? (InterpreterCloseException) e : new InterpreterCloseException(
              "Failed to close session " + sessionId + "; session remains isolated", e, false);
      operation.result.completeExceptionally(failure);
    }
  }

  private void closeInterpreter(Interpreter interpreter) throws InterpreterException {
    Scheduler scheduler = interpreter.getScheduler();

    if (Boolean.parseBoolean(
            interpreter.getProperty("zeppelin.interpreter.close.cancel_job", "true"))) {
      for (final Job job : scheduler.getAllJobs()) {
        if (!job.isTerminated()) {
          try {
            job.abort();
            job.setStatus(Job.Status.ABORT);
            LOGGER.info("Job {} aborted ", job.getJobName());
          } catch (Exception e) {
            // Cancellation failure must not prevent JDBC close from aborting its transport.
            LOGGER.warn("Job cancellation failed; continuing interpreter close", e);
            break;
          }
        }
      }
    } else {
      LOGGER.info("Keep job running while closing interpreter: {}", interpreter.getClassName());
    }

    LOGGER.info("Trying to close interpreter {}", interpreter.getClassName());
    interpreter.close();

    //TODO(zjffdu) move the close of schedule to Interpreter
    SchedulerFactory.singleton().removeScheduler(scheduler.getName());
  }

  public synchronized List<Interpreter> getOrCreateSession(String user, String sessionId) {
    ensureSessionOpen(sessionId);
    if (sessions.containsKey(sessionId)) {
      return sessions.get(sessionId);
    } else {
      List<Interpreter> interpreters = interpreterSetting.createInterpreters(user, id, sessionId);
      for (Interpreter interpreter : interpreters) {
        interpreter.setInterpreterGroup(this);
      }
      LOGGER.info("Create Session: {} in InterpreterGroup: {} for user: {}", sessionId, id, user);
      sessions.put(sessionId, interpreters);
      return interpreters;
    }
  }

  public synchronized void ensureSessionOpen(String sessionId) {
    if (closingGroup || retiring || closingSessions.containsKey(sessionId)) {
      throw new InterpreterCloseException("Session " + sessionId
          + " is closing or failed to close; execution is unavailable", null, false);
    }
  }

  public boolean isEmpty() {
    return this.sessions.isEmpty();
  }
}
