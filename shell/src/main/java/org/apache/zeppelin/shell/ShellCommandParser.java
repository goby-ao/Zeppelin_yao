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

import java.util.ArrayList;
import java.util.List;

/** Parses one command without invoking a shell or expanding any expressions. */
final class ShellCommandParser {
  private ShellCommandParser() {
  }

  static List<String> parse(String input) {
    ParsedLine parsed = parseCommandLine(input);
    if (parsed.stages.size() != 1 || parsed.redirectTarget != null) {
      throw new IllegalArgumentException("Shell operators are not supported");
    }
    return parsed.stages.get(0);
  }

  static List<List<String>> parsePipeline(String input) {
    ParsedLine parsed = parseCommandLine(input);
    if (parsed.redirectTarget != null) {
      throw new IllegalArgumentException("Shell operators are not supported");
    }
    return parsed.stages;
  }

  static ParsedLine parseCommandLine(String input) {
    if (input.indexOf(0) >= 0) {
      throw new IllegalArgumentException("NUL bytes are not supported");
    }
    input = input.trim();
    List<List<String>> commands = new ArrayList<>();
    List<String> arguments = new ArrayList<>();
    List<String> redirectArgs = new ArrayList<>();
    boolean inRedirect = false;
    boolean redirectAppend = false;
    StringBuilder word = new StringBuilder();
    char quote = 0;
    boolean inWord = false;
    boolean escaped = false;
    for (int i = 0; i < input.length(); i++) {
      char c = input.charAt(i);
      if (escaped) {
        if (quote == '"' && "\\\"`$".indexOf(c) < 0) {
          word.append('\\');
        }
        word.append(c);
        inWord = true;
        escaped = false;
      } else if (c == '\\' && quote != '\'') {
        int continued = skipLineContinuation(input, i, quote);
        if (continued >= 0) {
          if (quote == 0 && inWord && continued > i + 1 && input.charAt(i + 1) != '\r'
              && input.charAt(i + 1) != '\n') {
            (inRedirect ? redirectArgs : arguments).add(word.toString());
            word.setLength(0);
            inWord = false;
          }
          i = continued;
        } else {
          escaped = true;
          inWord = true;
        }
      } else if (quote != 0 && c == quote) {
        quote = 0;
      } else if (quote == 0 && (c == '\'' || c == '"')) {
        quote = c;
        inWord = true;
      } else if (quote == 0 && (c == '\n' || c == '\r')) {
        throw new IllegalArgumentException("Only one command on one line is supported");
      } else if (quote == 0 && c == '#' && !inWord
          && (inRedirect ? !redirectArgs.isEmpty() : !arguments.isEmpty())) {
        break;
      } else if (quote == 0 && c == '|') {
        if (inRedirect) {
          throw new IllegalArgumentException("Shell operators are not supported");
        }
        if (inWord) {
          arguments.add(word.toString());
          word.setLength(0);
          inWord = false;
        }
        if (arguments.isEmpty()) {
          throw new IllegalArgumentException("Shell operators are not supported");
        }
        commands.add(arguments);
        arguments = new ArrayList<>();
      } else if (quote == 0 && c == '>') {
        if (inRedirect) {
          throw new IllegalArgumentException("Shell operators are not supported");
        }
        if (inWord) {
          arguments.add(word.toString());
          word.setLength(0);
          inWord = false;
        }
        if (arguments.isEmpty()) {
          throw new IllegalArgumentException("Shell operators are not supported");
        }
        commands.add(arguments);
        arguments = new ArrayList<>();
        inRedirect = true;
        if (i + 1 < input.length() && input.charAt(i + 1) == '>') {
          redirectAppend = true;
          i++;
        }
      } else if (quote == 0 && "&;<`$(){}".indexOf(c) >= 0) {
        throw new IllegalArgumentException("Shell operators are not supported");
      } else if (quote == 0 && Character.isWhitespace(c)) {
        if (inWord) {
          (inRedirect ? redirectArgs : arguments).add(word.toString());
          word.setLength(0);
          inWord = false;
        }
      } else {
        word.append(c);
        inWord = true;
      }
    }
    if (quote != 0 || escaped) {
      throw new IllegalArgumentException("Unclosed quote or escape");
    }
    if (inWord) {
      (inRedirect ? redirectArgs : arguments).add(word.toString());
    }
    if (inRedirect) {
      if (redirectArgs.size() != 1 || redirectArgs.get(0).isEmpty()) {
        throw new IllegalArgumentException("Invalid redirection target");
      }
      return new ParsedLine(commands, redirectArgs.get(0), redirectAppend);
    }
    if (arguments.isEmpty()) {
      throw new IllegalArgumentException("Command is empty");
    }
    commands.add(arguments);
    return new ParsedLine(commands, null, false);
  }

  static final class ParsedLine {
    final List<List<String>> stages;
    final String redirectTarget;
    final boolean redirectAppend;

    private ParsedLine(List<List<String>> stages, String redirectTarget, boolean redirectAppend) {
      this.stages = stages;
      this.redirectTarget = redirectTarget;
      this.redirectAppend = redirectAppend;
    }
  }

  private static int skipLineContinuation(String input, int backslashIndex, char quote) {
    int i = backslashIndex + 1;
    if (quote == 0) {
      while (i < input.length() && (input.charAt(i) == ' ' || input.charAt(i) == '\t')) {
        i++;
      }
    }
    if (i < input.length() && input.charAt(i) == '\r') {
      i++;
    }
    if (i < input.length() && input.charAt(i) == '\n') {
      return i;
    }
    return -1;
  }
}
