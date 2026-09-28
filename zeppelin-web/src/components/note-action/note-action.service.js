/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

angular.module('zeppelinWebApp').service('noteActionService', noteActionService);

function noteActionService(websocketMsgSrv, $location, noteRenameService, noteListFactory, ngToast) {
  'ngInject';

  this.moveNoteToTrash = function(noteId, redirectToHome) {
    BootstrapDialog.confirm({
      closable: true,
      title: '移动到回收站',
      message: '此笔记将被移动到<strong>回收站</strong>。',
      btnOKLabel: '确认',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.moveNoteToTrash(noteId);
          if (redirectToHome) {
            $location.path('/');
          }
        }
      },
    });
  };

  this.moveFolderToTrash = function(folderId) {
    BootstrapDialog.confirm({
      closable: true,
      title: '移动到回收站',
      message: '此文件夹将被移动到<strong>回收站</strong>。',
      btnOKLabel: '确认',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.moveFolderToTrash(folderId);
        }
      },
    });
  };

  this.removeNote = function(noteId, redirectToHome) {
    BootstrapDialog.confirm({
      type: BootstrapDialog.TYPE_WARNING,
      closable: true,
      title: '警告！此笔记将被永久删除',
      message: '此操作不可撤销，确认继续？',
      btnOKLabel: '确认删除',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.deleteNote(noteId);
          if (redirectToHome) {
            $location.path('/');
          }
        }
      },
    });
  };

  this.removeFolder = function(folderId) {
    BootstrapDialog.confirm({
      type: BootstrapDialog.TYPE_WARNING,
      closable: true,
      title: '警告！此文件夹将被永久删除',
      message: '此操作不可撤销，确认继续？',
      btnOKLabel: '确认删除',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.removeFolder(folderId);
        }
      },
    });
  };

  this.restoreAll = function() {
    BootstrapDialog.confirm({
      closable: true,
      title: '恢复回收站',
      message: '回收站中的所有笔记和文件夹将被<strong>合并</strong>到原位置。',
      btnOKLabel: '确认恢复',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.restoreAll();
        }
      },
    });
  };

  this.emptyTrash = function() {
    BootstrapDialog.confirm({
      type: BootstrapDialog.TYPE_WARNING,
      closable: true,
      title: '警告！清空回收站',
      message: '回收站中的所有笔记将被永久删除，此操作不可撤销。',
      btnOKLabel: '确认清空',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.emptyTrash();
        }
      },
    });
  };

  this.clearAllParagraphOutput = function(noteId, canClear) {
    let dialog = BootstrapDialog.confirm({
      closable: true,
      title: '清理当前笔记的全部运行结果？',
      message: '<p>将清理本笔记所有段落的运行结果。<strong>代码和段落会保留。</strong></p>' +
        '<p class="zp-clear-output-benefit">清理运行结果可减小笔记体积，' +
        '有助于提升加载和操作的流畅度。</p>' +
        '<p class="zp-clear-output-caution">已保存的运行结果将被清除，需要查看时请重新运行。</p>',
      btnOKLabel: '清理结果',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result && (!canClear || canClear())) {
          websocketMsgSrv.clearAllParagraphOutput(noteId);
          ngToast.info({content: '清理请求已提交，代码和段落会保留。', timeout: 3000});
        }
      },
    });
    // This version of confirm() does not forward cssClass to the dialog.
    dialog.getModal().addClass('zp-clear-output-dialog');
  };

  this.renameNote = function(noteId, notePath) {
    noteRenameService.openRenameModal({
      title: '重命名笔记',
      oldName: notePath,
      callback: function(newName) {
        websocketMsgSrv.renameNote(noteId, newName);
      },
    });
  };

  this.renameFolder = function(folderPath) {
    noteRenameService.openRenameModal({
      title: '重命名文件夹',
      oldName: folderPath,
      callback: function(newName) {
        let newFolderPath = normalizeFolderId(newName);
        if (_.has(noteListFactory.flatFolderMap, newFolderPath)) {
          BootstrapDialog.confirm({
            type: BootstrapDialog.TYPE_WARNING,
            closable: true,
            title: '警告！文件夹将被合并',
            message: '该文件夹将被合并到 <strong>' + _.escape(newFolderPath) + '</strong>，确认继续？',
            btnOKLabel: '确认合并',
            btnCancelLabel: '取消',
            callback: function(result) {
              if (result) {
                websocketMsgSrv.renameFolder(folderPath, newFolderPath);
              }
            },
          });
        } else {
          websocketMsgSrv.renameFolder(folderPath, newFolderPath);
        }
      },
    });
  };

  function normalizeFolderId(folderId) {
    folderId = folderId.trim();

    while (folderId.indexOf('\\') > -1) {
      folderId = folderId.replace('\\', '/');
    }

    while (folderId.indexOf('///') > -1) {
      folderId = folderId.replace('///', '/');
    }

    folderId = folderId.replace('//', '/');

    if (folderId === '/') {
      return '/';
    }

    if (folderId[0] === '/') {
      folderId = folderId.substring(1);
    }

    if (folderId.slice(-1) === '/') {
      folderId = folderId.slice(0, -1);
    }

    return folderId;
  }
}
