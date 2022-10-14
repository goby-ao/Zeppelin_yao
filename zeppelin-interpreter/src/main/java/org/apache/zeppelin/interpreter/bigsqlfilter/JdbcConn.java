package org.apache.zeppelin.interpreter.bigsqlfilter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.*;
import java.util.concurrent.ConcurrentHashMap;

public class JdbcConn {

  static Logger LOGGER = LoggerFactory.getLogger(JdbcConn.class);
  static ConcurrentHashMap<String, Connection> cluster_conns = new ConcurrentHashMap<>();

  static Connection conn = null;

  public static ResultSet query(String sql, Connection conn) {
    LOGGER.info("[mg] exec sql: {} ", sql);

    // Open a connection
    try {
      Statement stmt = conn.createStatement();
      ResultSet rs = stmt.executeQuery(sql);
      // Extract data from result set
      return rs;
    } catch (SQLException e) {
      LOGGER.error("query mysql failed,sql:{}", sql, e);
      return null;
    }
  }


  public static Connection getConn(String cluster) throws SQLException {
    Connection con = cluster_conns.get(cluster);
    if (con == null || con.isClosed() || !con.isValid(3000)) {
      Connection conNew = createConnection(cluster);
      cluster_conns.put(cluster, conNew);
      if (con != null) {
        try {
          con.close();
        } catch (Exception ignored) {
        }
      }
      return conNew;
    }

    return con;
  }

  private static Connection createConnection(String cluster) throws SQLException {
    LOGGER.info("[mg] create connection for {}", cluster);
    return DriverManager.getConnection(HiveConfig.getUrl(cluster),
            HiveConfig.getUser(cluster), HiveConfig.getPasswd(cluster));
  }
}