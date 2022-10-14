package org.apache.zeppelin.interpreter.bigsqlfilter;

import com.alibaba.druid.DbType;
import com.alibaba.druid.sql.ast.*;
import com.alibaba.druid.sql.ast.expr.*;
import com.alibaba.druid.sql.ast.statement.*;
import com.alibaba.druid.sql.dialect.hive.visitor.HiveSchemaStatVisitor;
import com.google.common.collect.HashMultimap;
import com.google.common.collect.Multimap;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;

public class QueryVisitor extends HiveSchemaStatVisitor {
  private List<QueryResult> queryResults = new ArrayList<>();

  private boolean hasLimit = false;

  public List<QueryResult> getQueryResults() {
    return queryResults;
  }

  public void setQueryResults(List<QueryResult> queryResults) {
    this.queryResults = queryResults;
  }

  public boolean isHasLimit() {
    return hasLimit;
  }

  public QueryVisitor(DbType hive) {
    super(hive);
  }

  /**
   * get all join tables
   *
   * @param sqlTableSource
   * @param tables
   */
  public void findJoinTables(SQLTableSource sqlTableSource, HashSet<String> tables) {
    if (sqlTableSource instanceof SQLJoinTableSource) {
      findJoinTables(((SQLJoinTableSource) sqlTableSource).getLeft(), tables);
      findJoinTables(((SQLJoinTableSource) sqlTableSource).getRight(), tables);
    } else if (sqlTableSource instanceof SQLExprTableSource) {
      if (((SQLExprTableSource) sqlTableSource).getExpr() instanceof SQLPropertyExpr) {
        SQLPropertyExpr expr = (SQLPropertyExpr) ((SQLExprTableSource) sqlTableSource).getExpr();
        tables.add(expr.getOwner().toString() + "." + expr.getName());
      } else {
        tables.add(((SQLExprTableSource) sqlTableSource).getTableName());
      }
    }
  }


  /**
   * 遍历所有的 query 语句
   *
   * @param select
   * @return
   */
  public boolean visit(SQLSelectQueryBlock select) {
    SQLTableSource from = select.getFrom();

    if (select.getFrom() == null) {
      return false;
    }

    QueryResult qr = new QueryResult();
    qr.setQuerySql(select.toString());
    HashSet<String> tables = new HashSet<>();
    // find from tables
    if (from instanceof SQLJoinTableSource) {
      // multi join
      findJoinTables(from, tables);
      // find left and right
    } else if (from instanceof SQLExprTableSource) {
      // get table
      tables.add(((SQLExprTableSource) from).getName().toString());
    }

    qr.setTables(tables);

    Multimap<String, String> tableColumns = HashMultimap.create();
    // find where
    if (select.getWhere() != null) {
      for (SQLObject child : select.getWhere().getChildren()) {
        if (child instanceof SQLExpr) {
          findWhere((SQLExpr) child, tableColumns);
        }
      }
      qr.setWhereTableColumns(tableColumns);
    }
    queryResults.add(qr);

    return true;
  }

  public boolean visit(SQLLimit x) {
    hasLimit = true;
    return true;
  }

  /**
   * 递归查询当前 query 所有的 where 条件，查出对应的表名、列名
   *
   * @param child
   * @param whereList
   */
  private void findWhere(SQLExpr child, Multimap<String, String> whereList) {
    if (child instanceof SQLBinaryOpExpr) {
      // where xx.id = 1 and yy.id = 4 or zz.id in ()
      SQLBinaryOpExpr chi = (SQLBinaryOpExpr) child;
      // = is in not like 等，直接取字段
      if (chi.getOperator().isRelational()) {
        // 判断哪个是字段，哪个是value，因为可能存在写法 where dayid = 1 或 where 1= dayid
        // 或 substr(xx,1,4) = 2
        if (chi.getLeft() instanceof SQLPropertyExpr
                || chi.getLeft() instanceof SQLIdentifierExpr
                || chi.getLeft() instanceof SQLMethodInvokeExpr) {
          findColumn(chi.getLeft(), whereList);
        } else if (chi.getRight() instanceof SQLPropertyExpr
                || chi.getRight() instanceof SQLIdentifierExpr
                || chi.getRight() instanceof SQLMethodInvokeExpr) {
          findColumn(chi.getRight(), whereList);
        }
      } else {
        // 存在多个 where 条件 and、or，递归查
        findWhere(chi.getLeft(), whereList);
        findWhere(chi.getRight(), whereList);
      }
    } else if (child instanceof SQLInSubQueryExpr) {
      // where table.id in (select * from xxx)
      findColumn(((SQLInSubQueryExpr) child).getExpr(), whereList);
    } else if (child instanceof SQLIdentifierExpr
            || child instanceof SQLPropertyExpr
            || child instanceof SQLMethodInvokeExpr) {
      // where id = 1
      // where table.id = 1
      // where substr(hourid,1,6) = '202206'
      findColumn(child, whereList);
    } else if (child instanceof SQLBetweenExpr) {
      // where xx.id between 1 and 68
      findColumn(((SQLBetweenExpr) child).getTestExpr(), whereList);
    } else {
      System.out.println("WARN: other type not found");
    }
  }

  private void findColumn(SQLExpr expr, Multimap<String, String> whereList) {
    if (expr instanceof SQLIdentifierExpr) {
      SQLExprTableSource obj = (SQLExprTableSource) ((SQLIdentifierExpr) expr).getResolvedOwnerObject();
      whereList.put(obj.getName().toString(), ((SQLIdentifierExpr) expr).getName());
    } else if (expr instanceof SQLPropertyExpr) {
      SQLExprTableSource obj = (SQLExprTableSource) ((SQLPropertyExpr) expr).getResolvedOwnerObject();
      whereList.put(obj.getName().toString(), ((SQLPropertyExpr) expr).getName());
    } else if (expr instanceof SQLMethodInvokeExpr) {
      List<SQLExpr> args = ((SQLMethodInvokeExpr) expr).getArguments();
      for (SQLExpr se : args) {
        if (se instanceof SQLIdentifierExpr || se instanceof SQLPropertyExpr) {
          findColumn(se, whereList);
        }
      }
    }
  }
}
