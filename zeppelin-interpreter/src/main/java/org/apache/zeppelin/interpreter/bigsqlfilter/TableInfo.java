package org.apache.zeppelin.interpreter.bigsqlfilter;

import java.util.List;
import java.util.Objects;

public class TableInfo {
  private String cluster;
  private String tableName;
  private String db;
  private List<String> partitionColumns;
  private int partitionsNums;
  private int tableSize;

  public String getCluster() {
    return cluster;
  }

  public void setCluster(String cluster) {
    this.cluster = cluster;
  }

  public String getTableName() {
    return tableName;
  }

  public String getDb() {
    return db;
  }

  public void setDb(String db) {
    this.db = db;
  }

  public boolean isPartitionTable() {
    return this.partitionColumns != null && this.partitionColumns.size() > 0;
  }

  public void setTableName(String tableName) {
    this.tableName = tableName;
  }

  public List<String> getPartitionColumns() {
    return partitionColumns;
  }

  public void setPartitionColumns(List<String> partitionColumns) {
    this.partitionColumns = partitionColumns;
  }

  public int getPartitionsNums() {
    return partitionsNums;
  }

  public void setPartitionsNums(int partitionsNums) {
    this.partitionsNums = partitionsNums;
  }

  public int getTableSize() {
    return tableSize;
  }

  public void setTableSize(int tableSize) {
    this.tableSize = tableSize;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (o == null || getClass() != o.getClass()) return false;
    TableInfo tableInfo = (TableInfo) o;
    return cluster.equals(tableInfo.cluster) &&
            tableName.equals(tableInfo.tableName) &&
            db.equals(tableInfo.db);
  }

  @Override
  public int hashCode() {
    return Objects.hash(cluster, tableName, db);
  }
}
