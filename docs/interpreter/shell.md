---
layout: page
title: "Shell interpreter for Apache Zeppelin"
description: "Shell interpreter uses Apache Commons Exec to execute external processes."
group: interpreter
---
<!--
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->
{% include JB/setup %}

# Shell interpreter for Apache Zeppelin

<div id="toc"></div>

## Overview
Zeppelin Shell has two interpreters the default is the %sh interpreter.

### Shell interpreter
Shell interpreter uses [Apache Commons Exec](https://commons.apache.org/proper/commons-exec) to execute external processes. 
In Zeppelin notebook, you can use ` %sh ` in the beginning of a paragraph to invoke system shell and run commands.

### Terminal interpreter
Terminal interpreter uses [hterm](https://chromium.googlesource.com/apps/libapps/+/HEAD/hterm), [Pty4J](https://github.com/JetBrains/pty4j) analog terminal operation.

### Shell security policy

Run the interpreter in an isolated process per user with user impersonation enabled.
The authenticated username must match the non-root operating-system account of
that process. Configure `zeppelin.shell.security.exempt.users` as an exact,
comma-separated list of trusted accounts. The default is empty. Exempt accounts
and paragraphs whose first non-empty line starts with `#;;;`
can run Bash scripts under their own identity.
Administrators configure the Shell interpreter properties in the interpreter
settings. Notebook `%sh.conf` paragraphs cannot change them.

Other accounts can submit multiple lines, with one command per line. Blank
lines and comments are ignored, and quoted arguments (including multiline
quoted SQL) and trailing `\` line continuations are supported. Allowed
commands can pipe standard output through in-process `grep`, `head`, `tail`,
or `wc -l` filters without file arguments. The
interpreter validates the command and shell syntax on every line before starting
any process. A rejected line blocks the entire paragraph. Commands run in
order and stop on the first execution error. The interpreter accepts
`hadoop`, `hdfs`, `hive`, `beeline`, and `yarn`, and sends their arguments directly
to the client. For `hadoop` and `hdfs`, recursive delete (`-r`, `-R`, `-rmr`,
`-rmdir`), `-skipTrash`, wildcard delete, and root-path delete are rejected before
execution. For these clients, the policy otherwise applies to the submitted command
only. The client's own local file access, subprocesses and cluster operations
remain governed by its execution environment and permissions. The interpreter
does not provide client or OS sandboxing.

For `ls`, `stat`, `cat`, `head`, `tail`, `mkdir`, `cp`, and `rm`, Java NIO
checks local paths against `/home/<username>` and
`/tmp/zeppelin/<username>`. Provision the temporary directory with mode
`0700` under an administrator-controlled parent. Paths to credential and
startup files are denied. Copies must target a new file. Restricted `rm` takes
one explicit path to an owned, singly linked regular file. It permanently
removes that file. Options, wildcards, directories, and symlinks are rejected.
These path checks are not a filesystem sandbox and are not race-free when
directories are replaced concurrently. Keep OS permissions and the non-root
interpreter identity in place.

The properties `zeppelin.shell.security.executable.<name>` select trusted
absolute paths for the four clients. Each defaults to `/usr/bin/<name>`. Local
file commands do not start another process or require Python. Keep the executables, the
interpreter and its startup configuration under administrator control.
Verify these paths and interpreter user mapping on each deployment before
restarting the interpreter with the new policy.

The interactive terminal is disabled by default. An administrator can enable it
for exempt accounts with `zeppelin.shell.security.terminal.enabled=true` only
when access to the terminal WebSocket is authenticated and restricted to the
session owner by the deployment.

## Configuration
At the "Interpreters" menu in Zeppelin dropdown menu, you can set the property value for Shell interpreter.

<table class="table-configuration">
  <tr>
    <th>Name</th>
    <th>Default</th>
    <th>Description</th>
  </tr>
  <tr>
    <td>shell.command.timeout.millisecs</td>
    <td>60000</td>
    <td>Shell command time out in millisecs</td>
  </tr>
  <tr>
    <td>shell.working.directory.user.home</td>
    <td>false</td>
    <td>If this set to true, the shell's working directory will be set to user home</td>
  </tr>
  <tr>
    <td>zeppelin.shell.auth.type</td>
    <td></td>
    <td>Types of authentications' methods supported are SIMPLE, and KERBEROS</td>
  </tr>
  <tr>
    <td>zeppelin.shell.principal</td>
    <td></td>
    <td>The principal name to load from the keytab</td>
  </tr>
  <tr>
    <td>zeppelin.shell.keytab.location</td>
    <td></td>
    <td>The path to the keytab file</td>
  </tr>
  <tr>
    <td>zeppelin.shell.interpolation</td>
    <td>false</td>
    <td>Enable ZeppelinContext variable interpolation into paragraph text</td>
  </tr>
  <tr>
    <td>zeppelin.terminal.ip.mapping</td>
    <td></td>
    <td>Internal and external IP mapping of zeppelin server</td>
  </tr>
</table>

## Example

### Shell interpreter
The following example demonstrates the basic usage of Shell in a Zeppelin notebook.

<img src="{{BASE_PATH}}/assets/themes/zeppelin/img/docs-img/shell-example.png" />

If you need further information about **Zeppelin Interpreter Setting** for using Shell interpreter, 
please read [What is interpreter setting?](../usage/interpreter/overview.html#what-is-interpreter-setting) section first.

### Kerberos refresh interval
For changing the default behavior of when to renew Kerberos ticket following changes can be made in `conf/zeppelin-env.sh`.

```bash
# Change Kerberos refresh interval (default value is 1d). Allowed postfix are ms, s, m, min, h, and d.
export KERBEROS_REFRESH_INTERVAL=4h
# Change kinit number retries (default value is 5), which means if the kinit command fails for 5 retries consecutively it will close the interpreter. 
export KINIT_FAIL_THRESHOLD=10
```

### Object Interpolation
The shell interpreter also supports interpolation of `ZeppelinContext` objects into the paragraph text.
The following example shows one use of this facility:

####In Scala cell:

```scala
z.put("dataFileName", "members-list-003.parquet")
    // ...
val members = spark.read.parquet(z.get("dataFileName"))
    // ...
```

####In later Shell cell:

```bash
%sh
stat "{dataFileName}"
```

Object interpolation is disabled by default, and can be enabled (for the Shell interpreter) by
setting the value of the property `zeppelin.shell.interpolation` to `true` (see _Configuration_ above).
More details of this feature can be found in [Zeppelin-Context](../usage/other_features/zeppelin_context.html)

### Terminal interpreter
The following example demonstrates the basic usage of terminal in a Zeppelin notebook.

```bash
%sh.terminal
input any char
```

<img src="{{BASE_PATH}}/assets/themes/zeppelin/img/docs-img/shell-terminal.gif" />

### zeppelin.terminal.ip.mapping

When running the terminal interpreter in the notebook, the front end of the notebook needs to obtain the IP address of the server where the terminal interpreter is located to communicate.

In a public cloud environment, the cloud host has an internal IP and an external access IP, and the interpreter runs in the cloud host. This will cause the notebook front end to be unable to connect to the terminal interpreter properly, resulting in the terminal interpreter being unusable.

Solution: Set the mapping between internal IP and external IP in the terminal interpreter, and connect the front end of the notebook through the external IP of the terminal interpreter.

Example: 
{"internal-ip1":"external-ip1", "internal-ip2":"external-ip2"}
