package org.apache.zeppelin.interpreter.bigsqlfilter;

import com.google.common.collect.Multimap;

import java.util.HashSet;

public class QueryResult {
  private HashSet<String> tables;
  private Multimap<String, String> whereTableColumns;
  private String querySql;

  public String getQuerySql() {
    return querySql;
  }

  public void setQuerySql(String querySql) {
    this.querySql = querySql;
  }

  public HashSet<String> getTables() {
    return tables;
  }

  public void setTables(HashSet<String> tables) {
    this.tables = tables;
  }

  public Multimap<String, String> getWhereTableColumns() {
    return whereTableColumns;
  }

  public void setWhereTableColumns(Multimap<String, String> whereTableColumns) {
    this.whereTableColumns = whereTableColumns;
  }
}
