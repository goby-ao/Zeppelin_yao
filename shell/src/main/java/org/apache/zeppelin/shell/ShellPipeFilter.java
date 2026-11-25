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

package org.apache.zeppelin.shell;

import org.apache.commons.exec.PumpStreamHandler;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/** In-process stream filters for safe pipeline stages such as grep, head, tail, and wc -l. */
final class ShellPipeFilter {
  private static final int LINE_BUFFER_LIMIT = 1024 * 1024;
  private static final int MAX_LINES = 1000;
  private static final List<String> FILTERS = Arrays.asList("grep", "head", "tail", "wc");

  private final StageFactory factory;

  private ShellPipeFilter(StageFactory factory) {
    this.factory = factory;
  }

  static boolean supports(String name) {
    return FILTERS.contains(name);
  }

  static ShellPipeFilter prepare(String name, List<String> args)
      throws RestrictedFileCommand.Denied {
    switch (name) {
      case "grep":
        return prepareGrep(args);
      case "head":
      case "tail":
        return prepareHeadOrTail(name, args);
      case "wc":
        return prepareWc(args);
      default:
        throw new RestrictedFileCommand.Denied("COMMAND_DENIED");
    }
  }

  static ShellSecurityChecker.Command chain(
      ShellSecurityChecker.Command upstream, List<ShellPipeFilter> filters) {
    return (executor, out, err, cancelled) -> {
      Stage stage = new SinkStage(out, cancelled);
      for (int i = filters.size() - 1; i >= 0; i--) {
        stage = filters.get(i).factory.create(stage);
      }
      PipeOutputStream pipeOut = new PipeOutputStream(stage, cancelled);
      executor.setStreamHandler(new PumpStreamHandler(pipeOut, err));
      try {
        upstream.execute(executor, pipeOut, err, cancelled);
      } finally {
        executor.setStreamHandler(new PumpStreamHandler(out, err));
      }
      pipeOut.finish();
    };
  }

  private static ShellPipeFilter prepareGrep(List<String> args)
      throws RestrictedFileCommand.Denied {
    boolean ignoreCase = false;
    boolean invert = false;
    boolean fixedStrings = false;
    boolean lineNumbers = false;
    boolean countOnly = false;
    boolean optionsEnded = false;
    String patternText = null;
    for (int i = 0; i < args.size(); i++) {
      String arg = args.get(i);
      if (!optionsEnded && "-e".equals(arg)) {
        if (patternText != null || i + 1 >= args.size()) {
          throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
        }
        patternText = args.get(++i);
      } else if (!optionsEnded && "--".equals(arg)) {
        optionsEnded = true;
      } else if (!optionsEnded && arg.startsWith("-") && arg.length() > 1) {
        for (int j = 1; j < arg.length(); j++) {
          char flag = arg.charAt(j);
          if (flag == 'i') {
            ignoreCase = true;
          } else if (flag == 'v') {
            invert = true;
          } else if (flag == 'F') {
            fixedStrings = true;
          } else if (flag == 'E') {
            // Java regex supports extended syntax by default.
          } else if (flag == 'n') {
            lineNumbers = true;
          } else if (flag == 'c') {
            countOnly = true;
          } else {
            throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
          }
        }
      } else {
        if (patternText != null) {
          throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
        }
        patternText = arg;
      }
    }
    if (patternText == null) {
      throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
    }
    int flags = (ignoreCase ? Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE : 0)
        | (fixedStrings ? Pattern.LITERAL : 0);
    final Pattern pattern;
    try {
      pattern = Pattern.compile(patternText, flags);
    } catch (PatternSyntaxException e) {
      throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
    }
    final boolean finalInvert = invert;
    final boolean finalLineNumbers = lineNumbers;
    final boolean finalCountOnly = countOnly;
    return new ShellPipeFilter(
        next -> new GrepStage(next, pattern, finalInvert, finalLineNumbers, finalCountOnly));
  }

  private static ShellPipeFilter prepareHeadOrTail(String name, List<String> args)
      throws RestrictedFileCommand.Denied {
    int lines = 10;
    if (!args.isEmpty()) {
      if (args.size() == 2 && "-n".equals(args.get(0)) && args.get(1).matches("[0-9]{1,4}")) {
        lines = Integer.parseInt(args.get(1));
      } else if (args.size() == 1 && args.get(0).matches("-[0-9]{1,4}")) {
        lines = Integer.parseInt(args.get(0).substring(1));
      } else {
        throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
      }
      if (lines < 1 || lines > MAX_LINES) {
        throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
      }
    }
    final int maxLines = lines;
    if ("head".equals(name)) {
      return new ShellPipeFilter(next -> new HeadStage(next, maxLines));
    }
    return new ShellPipeFilter(next -> new TailStage(next, maxLines));
  }

  private static ShellPipeFilter prepareWc(List<String> args)
      throws RestrictedFileCommand.Denied {
    if (args.size() != 1 || !"-l".equals(args.get(0))) {
      throw new RestrictedFileCommand.Denied("PIPE_ARGUMENT_DENIED");
    }
    return new ShellPipeFilter(WcLineStage::new);
  }

  @FunctionalInterface
  private interface StageFactory {
    Stage create(Stage next);
  }

  private interface Stage {
    void accept(String line) throws IOException;

    void finish() throws IOException;
  }

  private static final class SinkStage implements Stage {
    private final OutputStream out;
    private final BooleanSupplier cancelled;

    private SinkStage(OutputStream out, BooleanSupplier cancelled) {
      this.out = out;
      this.cancelled = cancelled;
    }

    @Override
    public void accept(String line) throws IOException {
      checkCancelled(cancelled);
      out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
    }

    @Override
    public void finish() throws IOException {
      checkCancelled(cancelled);
      out.flush();
    }
  }

  private static final class GrepStage implements Stage {
    private final Stage next;
    private final Pattern pattern;
    private final boolean invert;
    private final boolean lineNumbers;
    private final boolean countOnly;
    private long lineNumber;
    private long matchCount;

    private GrepStage(Stage next, Pattern pattern, boolean invert, boolean lineNumbers,
        boolean countOnly) {
      this.next = next;
      this.pattern = pattern;
      this.invert = invert;
      this.lineNumbers = lineNumbers;
      this.countOnly = countOnly;
    }

    @Override
    public void accept(String line) throws IOException {
      lineNumber++;
      boolean matched = pattern.matcher(line).find();
      if (invert) {
        matched = !matched;
      }
      if (matched) {
        matchCount++;
        if (!countOnly) {
          next.accept(lineNumbers ? lineNumber + ":" + line : line);
        }
      }
    }

    @Override
    public void finish() throws IOException {
      if (countOnly) {
        next.accept(String.valueOf(matchCount));
      }
      next.finish();
    }
  }

  private static final class HeadStage implements Stage {
    private final Stage next;
    private final int maxLines;
    private int emitted;

    private HeadStage(Stage next, int maxLines) {
      this.next = next;
      this.maxLines = maxLines;
    }

    @Override
    public void accept(String line) throws IOException {
      if (emitted < maxLines) {
        emitted++;
        next.accept(line);
      }
    }

    @Override
    public void finish() throws IOException {
      next.finish();
    }
  }

  private static final class TailStage implements Stage {
    private final Stage next;
    private final int maxLines;
    private final Deque<String> buffer;

    private TailStage(Stage next, int maxLines) {
      this.next = next;
      this.maxLines = maxLines;
      this.buffer = new ArrayDeque<>(maxLines);
    }

    @Override
    public void accept(String line) {
      if (buffer.size() == maxLines) {
        buffer.removeFirst();
      }
      buffer.addLast(line);
    }

    @Override
    public void finish() throws IOException {
      for (String line : buffer) {
        next.accept(line);
      }
      next.finish();
    }
  }

  private static final class WcLineStage implements Stage {
    private final Stage next;
    private long count;

    private WcLineStage(Stage next) {
      this.next = next;
    }

    @Override
    public void accept(String line) {
      count++;
    }

    @Override
    public void finish() throws IOException {
      next.accept(String.valueOf(count));
      next.finish();
    }
  }

  private static final class PipeOutputStream extends OutputStream {
    private final Stage head;
    private final BooleanSupplier cancelled;
    private final ByteArrayOutputStream lineBuffer = new ByteArrayOutputStream();

    private PipeOutputStream(Stage head, BooleanSupplier cancelled) {
      this.head = head;
      this.cancelled = cancelled;
    }

    @Override
    public void write(int b) throws IOException {
      checkCancelled(cancelled);
      if (b == '\n') {
        flushLine();
      } else {
        lineBuffer.write(b);
        if (lineBuffer.size() >= LINE_BUFFER_LIMIT) {
          flushLine();
        }
      }
    }

    @Override
    public void write(byte[] b, int off, int len) throws IOException {
      checkCancelled(cancelled);
      int start = off;
      int end = off + len;
      for (int i = off; i < end; i++) {
        if (b[i] == '\n') {
          appendChunk(b, start, i - start);
          flushLine();
          start = i + 1;
        }
      }
      if (start < end) {
        appendChunk(b, start, end - start);
      }
    }

    private void appendChunk(byte[] b, int off, int len) throws IOException {
      int remaining = len;
      int offset = off;
      while (remaining > 0) {
        int space = LINE_BUFFER_LIMIT - lineBuffer.size();
        int toWrite = Math.min(remaining, space);
        lineBuffer.write(b, offset, toWrite);
        offset += toWrite;
        remaining -= toWrite;
        if (lineBuffer.size() >= LINE_BUFFER_LIMIT) {
          flushLine();
        }
      }
    }

    private void flushLine() throws IOException {
      byte[] bytes = lineBuffer.toByteArray();
      lineBuffer.reset();
      int length = bytes.length;
      if (length > 0 && bytes[length - 1] == '\r') {
        length--;
      }
      head.accept(new String(bytes, 0, length, StandardCharsets.UTF_8));
    }

    private void finish() throws IOException {
      checkCancelled(cancelled);
      if (lineBuffer.size() > 0) {
        flushLine();
      }
      head.finish();
    }
  }

  private static void checkCancelled(BooleanSupplier cancelled) throws InterruptedIOException {
    if (Thread.currentThread().isInterrupted() || cancelled.getAsBoolean()) {
      throw new InterruptedIOException();
    }
  }
}
