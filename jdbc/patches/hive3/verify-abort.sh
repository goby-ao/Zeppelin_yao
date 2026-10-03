#!/usr/bin/env bash
set -euo pipefail

# Compile a temporary source copy against the HDP standalone jar. Never alter Maven's cache.
HIVE_SOURCE=${1:?Usage: bash verify-abort.sh HIVE_SOURCE_ROOT HIVE_STANDALONE_JAR}
HIVE_JAR=${2:?Missing standalone jar}
HADOOP_CP=${3:?Missing Hadoop client classpath}
CP="$HIVE_JAR:$HADOOP_CP"
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hive-abort-check.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/jdbc/src/java/org/apache/hive/jdbc" "$WORK/classes" "$WORK/test"
cp "$HIVE_SOURCE/jdbc/src/java/org/apache/hive/jdbc/HiveConnection.java" \
  "$WORK/jdbc/src/java/org/apache/hive/jdbc/HiveConnection.java"
patch -d "$WORK" -p1 < "$HERE/0001-binary-connection-abort.patch"

# The standalone distribution shades these packages; only the test source copy is relocated.
sed -e 's/org\.apache\.thrift/org.apache.hive.org.apache.thrift/g' \
    -e 's/org\.apache\.http/org.apache.hive.org.apache.http/g' \
    -e 's/org\.apache\.commons/org.apache.hive.org.apache.commons/g' \
    -e 's/org\.slf4j/org.apache.hive.org.slf4j/g' \
    -e 's/com\.google\.common/org.apache.hive.com.google.common/g' \
    "$WORK/jdbc/src/java/org/apache/hive/jdbc/HiveConnection.java" > "$WORK/HiveConnection.java"
"${JAVA_HOME:+$JAVA_HOME/bin/}javac" -cp "$CP" -d "$WORK/classes" "$WORK/HiveConnection.java"
"${JAVA_HOME:+$JAVA_HOME/bin/}javac" -cp "$CP" -d "$WORK/test" "$HERE/HiveAbortSocketCheck.java"
"${JAVA_HOME:+$JAVA_HOME/bin/}java" -cp "$WORK/test:$CP" HiveAbortSocketCheck baseline
"${JAVA_HOME:+$JAVA_HOME/bin/}java" -cp "$WORK/classes:$WORK/test:$CP" HiveAbortSocketCheck patched
