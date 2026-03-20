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

package org.apache.zeppelin.audit;

import org.apache.zeppelin.scheduler.Job;

import java.util.Date;

/**
 * 审计日志实体类 - 记录任务执行信息
 * by yao's AI
 */
public class AuditLog {

  private Long id;
  private String taskId;           // Paragraph ID
  private String jobName;          // 任务名称
  private String noteId;           // Notebook ID
  private String noteName;         // Notebook 名称
  private String notePath;         // Notebook 路径
  private String paragraphTitle;   // Paragraph 标题
  private String user;             // 提交用户
  private String interpreterType;  // 解释器类型
  private String scriptText;       // 执行的代码
  private Job.Status status;       // 任务状态
  private String errorMessage;     // 错误信息
  private Date dateCreated;        // 创建时间
  private Date dateSubmitted;      // 提交时间 (PENDING)
  private Date dateStarted;        // 开始时间 (RUNNING)
  private Date dateFinished;       // 结束时间 (FINISHED/ERROR/ABORT)
  private Long executionDuration;  // 执行耗时(毫秒)
  private Date createdAt;          // 记录创建时间
  private Date updatedAt;          // 记录更新时间

  public AuditLog() {
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  // Getters and Setters
  public Long getId() {
    return id;
  }

  public void setId(Long id) {
    this.id = id;
  }

  public String getTaskId() {
    return taskId;
  }

  public void setTaskId(String taskId) {
    this.taskId = taskId;
  }

  public String getJobName() {
    return jobName;
  }

  public void setJobName(String jobName) {
    this.jobName = jobName;
  }

  public String getNoteId() {
    return noteId;
  }

  public void setNoteId(String noteId) {
    this.noteId = noteId;
  }

  public String getNoteName() {
    return noteName;
  }

  public void setNoteName(String noteName) {
    this.noteName = noteName;
  }

  public String getNotePath() {
    return notePath;
  }

  public void setNotePath(String notePath) {
    this.notePath = notePath;
  }

  public String getParagraphTitle() {
    return paragraphTitle;
  }

  public void setParagraphTitle(String paragraphTitle) {
    this.paragraphTitle = paragraphTitle;
  }

  public String getUser() {
    return user;
  }

  public void setUser(String user) {
    this.user = user;
  }

  public String getInterpreterType() {
    return interpreterType;
  }

  public void setInterpreterType(String interpreterType) {
    this.interpreterType = interpreterType;
  }

  public String getScriptText() {
    return scriptText;
  }

  public void setScriptText(String scriptText) {
    this.scriptText = scriptText;
  }

  public Job.Status getStatus() {
    return status;
  }

  public void setStatus(Job.Status status) {
    this.status = status;
  }

  public String getErrorMessage() {
    return errorMessage;
  }

  public void setErrorMessage(String errorMessage) {
    this.errorMessage = errorMessage;
  }

  public Date getDateCreated() {
    return dateCreated;
  }

  public void setDateCreated(Date dateCreated) {
    this.dateCreated = dateCreated;
  }

  public Date getDateSubmitted() {
    return dateSubmitted;
  }

  public void setDateSubmitted(Date dateSubmitted) {
    this.dateSubmitted = dateSubmitted;
  }

  public Date getDateStarted() {
    return dateStarted;
  }

  public void setDateStarted(Date dateStarted) {
    this.dateStarted = dateStarted;
  }

  public Date getDateFinished() {
    return dateFinished;
  }

  public void setDateFinished(Date dateFinished) {
    this.dateFinished = dateFinished;
  }

  public Long getExecutionDuration() {
    return executionDuration;
  }

  public void setExecutionDuration(Long executionDuration) {
    this.executionDuration = executionDuration;
  }

  public Date getCreatedAt() {
    return createdAt;
  }

  public void setCreatedAt(Date createdAt) {
    this.createdAt = createdAt;
  }

  public Date getUpdatedAt() {
    return updatedAt;
  }

  public void setUpdatedAt(Date updatedAt) {
    this.updatedAt = updatedAt;
  }

  /**
   * 计算执行耗时
   * by yao's AI
   */
  public void calculateDuration() {
    if (dateStarted != null && dateFinished != null) {
      this.executionDuration = dateFinished.getTime() - dateStarted.getTime();
    }
  }
}
