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

import {
  QUICK_NOTE_ROOT,
  getQuickNoteBinding,
} from '../quick-note.config';

angular.module('zeppelinWebApp').controller('HomeCtrl', HomeCtrl);

const RECENT_NOTES_KEY = 'zp_recent_notes';

function HomeCtrl($scope, noteListFactory, websocketMsgSrv, $rootScope, $location, arrayOrderingSrv,
                  ngToast, noteActionService, TRASH_FOLDER_ID) {
  'ngInject';

  ngToast.dismiss();
  let vm = this;
  vm.notes = noteListFactory;
  vm.websocketMsgSrv = websocketMsgSrv;
  vm.arrayOrderingSrv = arrayOrderingSrv;
  vm.noteActionService = noteActionService;
  vm.numberOfNotesDisplayed = Math.max(200, window.innerHeight / 20);

  vm.notebookHome = false;
  vm.noteCustomHome = true;
  if ($rootScope.ticket !== undefined) {
    vm.staticHome = false;
  } else {
    vm.staticHome = true;
  }

  $scope.isReloading = false;
  $scope.TRASH_FOLDER_ID = TRASH_FOLDER_ID;
  $scope.query = {q: ''};
  $scope.recentNotes = readRecentNotes();

  $scope.toggleStar = function(note, $event) {
    $event.preventDefault();
    $event.stopPropagation();
    if (!note.starred) {
      let starredCount = $scope.recentNotes.filter(function(n) {
        return n.starred;
      }).length;
      if (starredCount >= 5) {
        ngToast.create({content: '最多置顶 5 个笔记', className: 'warning', timeout: 2000});
        return;
      }
    }
    note.starred = !note.starred;
    saveRecentNotes($scope.recentNotes);
    $scope.recentNotes = readRecentNotes();
  };

  function saveRecentNotes(notes) {
    try {
      window.localStorage.setItem(RECENT_NOTES_KEY, angular.toJson(notes));
    } catch (e) {
      // ignore localStorage errors
    }
  }

  $scope.isNoteDeleted = function(noteId) {
    // 笔记列表未加载完成时，不显示为已删除
    if (!vm.notes || !angular.isArray(vm.notes.flatList) || vm.notes.flatList.length === 0) {
      return false;
    }
    for (let i = 0; i < vm.notes.flatList.length; i++) {
      if (vm.notes.flatList[i] && vm.notes.flatList[i].id === noteId) {
        return false;
      }
    }
    return true;
  };

  $scope.removeRecentNote = function(note, $event) {
    $event.preventDefault();
    $event.stopPropagation();
    $scope.recentNotes = $scope.recentNotes.filter(function(n) {
      return n.id !== note.id;
    });
    saveRecentNotes($scope.recentNotes);
  };

  $scope.initHome = function() {
    websocketMsgSrv.getHomeNote();
    vm.noteCustomHome = false;
  };

  $scope.quickCreate = function(interpreter) {
    let userName = getCurrentUserName();
    let noteName = QUICK_NOTE_ROOT + '/' + userName + '/QuickNote_' + interpreter;
    let existingNote = findNoteByPath(noteName);

    if (existingNote && existingNote.id) {
      $location.path('/notebook/' + existingNote.id);
      return;
    }

    websocketMsgSrv.createNotebook(noteName, getDefaultInterpreterGroup(interpreter));
  };

  $scope.formatRecentTime = function(time) {
    if (!time) {
      return '';
    }
    let diff = Math.max(0, Date.now() - time);
    let minute = 60 * 1000;
    let hour = 60 * minute;
    let day = 24 * hour;

    if (diff < minute) {
      return '刚刚';
    }
    if (diff < hour) {
      return Math.floor(diff / minute) + '分钟前';
    }
    if (diff < day) {
      return Math.floor(diff / hour) + '小时前';
    }
    if (diff < 7 * day) {
      return Math.floor(diff / day) + '天前';
    }
    return new Date(time).toLocaleDateString();
  };

  function readRecentNotes() {
    try {
      let raw = window.localStorage.getItem(RECENT_NOTES_KEY);
      let notes = raw ? angular.fromJson(raw) : [];
      if (!angular.isArray(notes)) {
        notes = [];
      }
      notes.sort(function(a, b) {
        if (a.starred && !b.starred) {
          return -1;
        }
        if (!a.starred && b.starred) {
          return 1;
        }
        return (b.time || 0) - (a.time || 0);
      });
      return notes.slice(0, 10);
    } catch (e) {
      return [];
    }
  }

  function getCurrentUserName() {
    let principal = $rootScope.ticket && $rootScope.ticket.principal
      ? $rootScope.ticket.principal
      : 'anonymous';
    return principal.replace(/[\/\\]/g, '_');
  }

  function getDefaultInterpreterGroup(interpreter) {
    return getQuickNoteBinding(interpreter);
  }

  function findNoteByPath(notePath) {
    let candidates = [];
    let normalizedNotePath = normalizeNotePath(notePath);
    if (vm.notes && angular.isArray(vm.notes.flatList)) {
      candidates = candidates.concat(vm.notes.flatList);
    }
    if ($rootScope.notes && angular.isArray($rootScope.notes.list)) {
      candidates = candidates.concat($rootScope.notes.list);
    }

    for (let i = 0; i < candidates.length; i++) {
      let note = candidates[i];
      if (note && (normalizeNotePath(note.path) === normalizedNotePath ||
          normalizeNotePath(note.name) === normalizedNotePath)) {
        return note;
      }
    }
    return null;
  }

  function normalizeNotePath(path) {
    return path ? path.replace(/^\/+/, '') : '';
  }

  $scope.reloadNoteList = function() {
    websocketMsgSrv.reloadAllNotesFromRepo();
    $scope.isReloadingNotes = true;
  };

  $scope.toggleFolderNode = function(node) {
    node.hidden = !node.hidden;
  };

  angular.element('#loginModal').on('hidden.bs.modal', function(e) {
    $rootScope.$broadcast('initLoginValues');
  });

  /*
   ** $scope.$on functions below
   */

  $scope.$on('setNoteMenu', function(event, notes) {
    $scope.isReloadingNotes = false;
  });

  $scope.$on('setNoteContent', function(event, note) {
    if (vm.noteCustomHome) {
      return;
    }

    if (note) {
      vm.note = note;

      // initialize look And Feel
      $rootScope.$broadcast('setLookAndFeel', 'home');

      // make it read only
      vm.viewOnly = true;

      vm.notebookHome = true;
      vm.staticHome = false;
    } else {
      vm.staticHome = true;
      vm.notebookHome = false;
    }
  });

  $scope.loadMoreNotes = function() {
    vm.numberOfNotesDisplayed += 10;
  };

  $scope.renameNote = function(nodeId, nodePath) {
    vm.noteActionService.renameNote(nodeId, nodePath);
  };

  $scope.moveNoteToTrash = function(noteId) {
    vm.noteActionService.moveNoteToTrash(noteId, false);
  };

  $scope.moveFolderToTrash = function(folderId) {
    vm.noteActionService.moveFolderToTrash(folderId);
  };

  $scope.restoreNote = function(noteId) {
    websocketMsgSrv.restoreNote(noteId);
  };

  $scope.restoreFolder = function(folderId) {
    websocketMsgSrv.restoreFolder(folderId);
  };

  $scope.restoreAll = function() {
    vm.noteActionService.restoreAll();
  };

  $scope.renameFolder = function(node) {
    vm.noteActionService.renameFolder(node.id);
  };

  $scope.removeNote = function(noteId) {
    vm.noteActionService.removeNote(noteId, false);
  };

  $scope.removeFolder = function(folderId) {
    vm.noteActionService.removeFolder(folderId);
  };

  $scope.emptyTrash = function() {
    vm.noteActionService.emptyTrash();
  };

  $scope.clearAllParagraphOutput = function(noteId) {
    vm.noteActionService.clearAllParagraphOutput(noteId);
  };

  $scope.isFilterNote = function(note) {
    if (!$scope.query.q) {
      return true;
    }

    let noteName = note.name;
    if (noteName.toLowerCase().indexOf($scope.query.q.toLowerCase()) > -1) {
      return true;
    }
    return false;
  };

  $scope.getNoteName = function(note) {
    return arrayOrderingSrv.getNoteName(note);
  };

  $scope.getNotePath = function(note) {
    return arrayOrderingSrv.getNotePath(note);
  };

  $scope.noteComparator = function(note1, note2) {
    return arrayOrderingSrv.noteComparator(note1, note2);
  };
}
