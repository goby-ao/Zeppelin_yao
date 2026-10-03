/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
angular.module('zeppelinWebApp').service('interpreterRestartService', interpreterRestartService);

function interpreterRestartService($http, baseUrlSrv, ngToast) {
  'ngInject';
  const pending = Object.create(null);

  this.restart = function(settingId, noteId, name) {
    // One setting may share a process across several notebooks in this page.
    if (pending[settingId]) {
      ngToast.info({content: '该解释器正在处理重启，请等待结果。'});
      return;
    }
    pending[settingId] = true;
    const dialog = BootstrapDialog.confirm({
      closable: false,
      closeByBackdrop: false,
      closeByKeyboard: false,
      title: '重启解释器',
      message: '确认重启 <strong>' + _.escape(name) + '</strong>？会话变量将丢失。' +
        '<p>重启会释放本地连接，但远端 SQL 可能仍在运行。请先核查写入任务状态，勿重复提交。</p>',
      btnOKLabel: '确认重启',
      btnCancelLabel: '取消',
      callback: function(confirmed) {
        if (!confirmed) {
          delete pending[settingId];
          return;
        }
        dialog.$modalFooter.find('button').prop('disabled', true);
        dialog.setMessage('正在关闭旧解释器，请稍候。远端 SQL 状态需另行核查。');
        $http.put(baseUrlSrv.getRestApiBase() + '/interpreter/setting/restart/' + settingId,
          {noteId: noteId}, {timeout: 60000}).then(function() {
            ngToast.info({content: '本地解释器已关闭，下次运行时重新初始化。' +
              '远端 SQL 可能仍在运行，请勿直接重复提交写入任务。', timeout: 10000});
          }, function(error) {
            const detail = error.data && error.data.message;
            BootstrapDialog.alert({
              title: '重启未确认完成',
              message: _.escape(detail || '请求超时或连接中断，不能确认旧解释器已关闭。') +
                '<p>请检查服务端日志和远端任务状态，勿连续重启或重复提交 SQL。</p>',
            });
          }).finally(function() {
            delete pending[settingId];
            dialog.close();
          });
        return false;
      },
    });
  };
}
