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

import moment from 'moment';

import {isParagraphRunning} from './paragraph/paragraph.status';
import {
  QUICK_NOTE_ROOT,
  getCurrentZeppelinClusterName,
  getQuickNoteBinding,
  getRecentNotesStorageKey,
} from '../quick-note.config';

angular.module('zeppelinWebApp').controller('NotebookCtrl', NotebookCtrl);

function NotebookCtrl($scope, $route, $routeParams, $location, $rootScope,
                      $http, websocketMsgSrv, baseUrlSrv, $timeout, saveAsService,
                      ngToast, noteActionService, noteVarShareService, TRASH_FOLDER_ID,
                      heliumService, scrollMonitor, interpreterRestartService) {
  'ngInject';

  ngToast.dismiss();

  $scope.note = null;
  $scope.actionOnFormSelectionChange = true;
  $scope.hideForms = false;
  $scope.disableForms = false;
  $scope.editorToggled = false;
  $scope.tableToggled = false;
  $scope.viewOnly = false;
  $scope.showSetting = false;
  $scope.showRevisionsComparator = false;
  $scope.collaborativeMode = false;
  $scope.collaborativeModeUsers = [];
  $scope.looknfeelOption = ['default', 'simple', 'report'];
  $scope.noteFormTitle = null;

  // Paragraph pin state
  $scope.lockedParagraphId = null;
  let highlightTimer = null;
  const PIN_MODE_BODY_CLASS = 'zp-pin-mode-active';

  // Safety watch: guarantee body/html pin class stays in sync with lockedParagraphId.
  // If any code path (or external DOM mutation) leaves the class behind after
  // lockedParagraphId is cleared, the full-viewport fixed overlay would block all
  // pointer events — this watch acts as the last line of defense.
  $scope.$watch('lockedParagraphId', function(lockedId) {
    if (!lockedId && document && document.body) {
      document.body.classList.remove(PIN_MODE_BODY_CLASS);
      document.documentElement.classList.remove(PIN_MODE_BODY_CLASS);
    }
  });
  $scope.cronOption = [
    {name: 'None', value: undefined},
    {name: '1m', value: '0 0/1 * * * ?'},
    {name: '5m', value: '0 0/5 * * * ?'},
    {name: '1h', value: '0 0 0/1 * * ?'},
    {name: '3h', value: '0 0 0/3 * * ?'},
    {name: '6h', value: '0 0 0/6 * * ?'},
    {name: '12h', value: '0 0 0/12 * * ?'},
    {name: '1d', value: '0 0 0 * * ?'},
  ];

  $scope.formatRevisionDate = function(date) {
    if (!date) {
      return '';
    }
    return moment.unix(date).format('MMMM Do YYYY, h:mm a');
  };

  // reorder this array without Head revision, put Head revision in the first
  $scope.revisionSort = function(array) {
    let orderArr = array.slice(1).sort((a, b) => {
      return b.time-a.time;
    });
    orderArr.unshift(array[0]);
    return orderArr;
  };

  $scope.interpreterSettings = [];
  $scope.interpreterBindings = [];
  $scope.allInterpreterBindings = [];
  $scope.isNoteDirty = null;
  $scope.saveTimer = null;
  $scope.paragraphWarningDialog = {};
  $scope.viewportWatchSuspend = 0;

  let connectedOnce = false;
  let quickNoteBindingSaved = {};
  let interpreterBindingsBackgroundTimer = null;
  let loadingInterpreterBindingsInBackground = false;
  let initializingParagraphIds = {};
  let initializingParagraphTimeouts = {};
  let isRevisionPath = function(path) {
    let pattern = new RegExp('^.*\/notebook\/[a-zA-Z0-9_]*\/revision\/[a-zA-Z0-9_]*');
    return pattern.test(path);
  };

  $scope.noteRevisions = [];
  $scope.currentRevision = 'Head';
  $scope.revisionView = isRevisionPath($location.path());

  $scope.search = {
    searchText: '',
    occurrencesExists: false,
    needHighlightFirst: false,
    occurrencesHidden: false,
    replaceText: '',
    needToSendNextOccurrenceAfterReplace: false,
    occurrencesCount: 0,
    currentOccurrence: 0,
    searchBoxOpened: false,
    searchBoxWidth: 350,
    left: '0px',
  };
  let currentSearchParagraph = 0;

  $scope.$watch('note', function(value) {
    let title;
    if (value) {
      title = value.name.substr(value.name.lastIndexOf('/') + 1, value.name.length);
      title += ' - Zeppelin';
    } else {
      title = 'Zeppelin';
    }
    $rootScope.pageTitle = title;
  }, true);

  $scope.$on('setConnectedStatus', function(event, param) {
    if (connectedOnce && param) {
      initNotebook();
    }
    connectedOnce = true;
  });

  function togglePinnedPageClass(isPinned) {
    if (document && document.body) {
      document.body.classList.toggle(PIN_MODE_BODY_CLASS, isPinned);
    }
    if (document && document.documentElement) {
      document.documentElement.classList.toggle(PIN_MODE_BODY_CLASS, isPinned);
    }
  }

  function notifyParagraphLayoutChange(paragraphIds) {
    let ids = (paragraphIds || []).filter(function(id, index, arr) {
      return !!id && arr.indexOf(id) === index;
    });

    if (ids.length === 0) {
      return;
    }

    $timeout(function() {
      ids.forEach(function(id) {
        $scope.$broadcast('paragraphLayoutChanged', id);
        $scope.$broadcast('paragraphResized', id);
      });
    }, 0);
  }

  function setLockedParagraphId(nextParagraphId) {
    let previousParagraphId = $scope.lockedParagraphId;
    if (previousParagraphId === nextParagraphId) {
      return;
    }

    $scope.lockedParagraphId = nextParagraphId || null;
    togglePinnedPageClass(!!$scope.lockedParagraphId);
    notifyParagraphLayoutChange([previousParagraphId, $scope.lockedParagraphId]);
  }

  $scope.addEvent = function(config) {
    let removeEventByID = function(id) {
      let events = jQuery._data(config.element, 'events')[config.eventType];
      if (!events) {
        return;
      }
      for (let i=0; i < events.length; i++) {
        if (events[i].data && events[i].data.eventID === id) {
          events.splice(i, 1);
          i--;
        }
      }
    };

    removeEventByID(config.eventID);
    angular.element(config.element).bind(config.eventType, {eventID: config.eventID}, config.handler);
    angular.element(config.onDestroyElement).scope().$on('$destroy', () => {
      removeEventByID(config.eventID);
    });
  };

  $scope.getCronOptionNameFromValue = function(value) {
    if (!value) {
      return '';
    }

    for (let o in $scope.cronOption) {
      if ($scope.cronOption[o].value === value) {
        return $scope.cronOption[o].name;
      }
    }
    return value;
  };

  $scope.blockAnonUsers = function() {
    let zeppelinVersion = $rootScope.zeppelinVersion;
    let url = 'https://zeppelin.apache.org/docs/' + zeppelinVersion + '/security/notebook_authorization.html';
    let content = 'Only authenticated user can set the permission.' +
      '<a data-toggle="tooltip" data-placement="top" title="Learn more" target="_blank" href=' + url + '>' +
      '<i class="icon-question" />' +
      '</a>';
    BootstrapDialog.show({
      closable: false,
      closeByBackdrop: false,
      closeByKeyboard: false,
      title: 'No permission',
      message: content,
      buttons: [{
        label: 'Close',
        action: function(dialog) {
          dialog.close();
        },
      }],
    });
  };

  const requestRevisionHistory = function() {
    // 版本历史功能已禁用，减少打开笔记时的请求
    return;
  };

  /** Init the new controller */
  const initNotebook = function() {
    noteVarShareService.clear();
    if ($routeParams.revisionId) {
      websocketMsgSrv.getNoteByRevision($routeParams.noteId, $routeParams.revisionId);
    } else {
      websocketMsgSrv.getNote($routeParams.noteId);
    }
    requestRevisionHistory();
    let currentRoute = $route.current;
    if (currentRoute) {
      setTimeout(
        function() {
          let routeParams = currentRoute.params;
          let $id = angular.element('#' + routeParams.paragraph + '_container');

          if ($id.length > 0) {
            // adjust for navbar
            let top = $id.offset().top - 103;
            angular.element('html, body').scrollTo({top: top, left: 0});
          }
        },
        1000
      );
    }
  };

  initNotebook();

  $scope.$on('loginSuccess', function() {
    requestRevisionHistory();
  });

  function rememberOpenedNote(note) {
    if (!note || !note.id) {
      return;
    }

    try {
      let recentNotesKey = getRecentNotesStorageKey(getCurrentZeppelinClusterName());
      let raw = window.localStorage.getItem(recentNotesKey);
      let notes = raw ? angular.fromJson(raw) : [];
      if (!angular.isArray(notes)) {
        notes = [];
      }
      let existing = null;
      notes = notes.filter(function(item) {
        if (item && item.id === note.id) {
          existing = item;
          return false;
        }
        return item && item.id !== note.id;
      });
      let entry = {
        id: note.id,
        name: note.name || note.id,
        time: Date.now(),
      };
      if (existing && existing.starred) {
        entry.starred = true;
      }
      notes.unshift(entry);
      window.localStorage.setItem(recentNotesKey, angular.toJson(notes.slice(0, 20)));
    } catch (e) {
      // LocalStorage can be unavailable in private mode or restricted iframe contexts.
    }
  }

  function removeDeletedNoteFromRecentNotes(noteId) {
    if (!noteId) {
      return;
    }
    try {
      let recentNotesKey = getRecentNotesStorageKey(getCurrentZeppelinClusterName());
      let raw = window.localStorage.getItem(recentNotesKey);
      let notes = raw ? angular.fromJson(raw) : [];
      if (!angular.isArray(notes)) {
        return;
      }
      let filtered = notes.filter(function(item) {
        return item && item.id !== noteId;
      });
      if (filtered.length !== notes.length) {
        window.localStorage.setItem(recentNotesKey, angular.toJson(filtered));
      }
    } catch (e) {
      // ignore localStorage errors
    }
  }

  function isNoteForCurrentRoute(note) {
    if (!$routeParams.noteId) {
      return true;
    }
    return note && note.id && String(note.id) === String($routeParams.noteId);
  }

  // ---- Large note performance helpers ----

  const NOTE_SIZE_WARNING_MB = 3;
  const NOTE_SIZE_CRITICAL_MB = 5;

  function computeNoteStats(note) {
    let paragraphCount = (note && angular.isArray(note.paragraphs)) ? note.paragraphs.length : 0;
    let estimatedSizeMB = 0;
    let severity = 'normal';

    try {
      let jsonStr = angular.toJson(note);
      let bytes = jsonStr ? jsonStr.length : 0;
      estimatedSizeMB = Math.round((bytes / (1024 * 1024)) * 10) / 10;
      if (estimatedSizeMB >= NOTE_SIZE_CRITICAL_MB) {
        severity = 'critical';
      } else if (estimatedSizeMB >= NOTE_SIZE_WARNING_MB) {
        severity = 'warning';
      }
    } catch (e) {
      estimatedSizeMB = 0;
    }

    return {
      paragraphCount: paragraphCount,
      estimatedSizeMB: estimatedSizeMB,
      severity: severity,
    };
  }

  function showLargeNoteToast(stats) {
    if (!$scope.hasNoteOutput()) {
      return;
    }
    let sizeInfo = stats.estimatedSizeMB > 0
      ? '约 ' + stats.estimatedSizeMB + ' MB'
      : stats.paragraphCount + ' 个段落';

    if (stats.severity === 'critical') {
      ngToast.warning({
        content: '此笔记规模较大（' + sizeInfo + '）。使用顶部「清理全部结果」可减小笔记体积，' +
          '有助于提升加载和操作的流畅度，代码会保留。',
        dismissOnTimeout: false,
        timeout: 15000,
        verticalPosition: 'top',
      });
    } else if (stats.severity === 'warning') {
      ngToast.info({
        content: '此笔记包含 ' + stats.paragraphCount + ' 个段落（' + sizeInfo + '）。' +
          '使用顶部「清理全部结果」可减小笔记体积，有助于提升加载和操作的流畅度，代码会保留。',
        dismissOnTimeout: false,
        timeout: 8000,
        verticalPosition: 'top',
      });
    }
  }

  function normalizeQuickNotePath(path) {
    return path ? path.replace(/^\/+/, '') : '';
  }

  function getQuickNoteInterpreterBinding(note) {
    if (!note) {
      return null;
    }

    let notePath = normalizeQuickNotePath(note.path || note.name);
    let pathParts = notePath.split('/');
    let noteName = pathParts[pathParts.length - 1];
    let inQuickNoteRoot = pathParts.length >= 3 && pathParts[0] === QUICK_NOTE_ROOT;
    if (!inQuickNoteRoot && noteName.indexOf('QuickNote_') !== 0) {
      return null;
    }

    let match = noteName.match(/^QuickNote_(.+)$/);
    if (!match) {
      return null;
    }

    return getQuickNoteBinding(match[1]);
  }

  function filterQuickNoteInterpreterBindings(interpreterBindings) {
    let quickNoteBinding = getQuickNoteInterpreterBinding($scope.note);
    if (!quickNoteBinding || !angular.isArray(interpreterBindings)) {
      return interpreterBindings;
    }

    let matchedBinding = null;
    let filteredBindings = interpreterBindings.filter(function(setting) {
      if (setting && (setting.id === quickNoteBinding || setting.name === quickNoteBinding)) {
        matchedBinding = setting;
        return true;
      }
      return false;
    });

    if (!matchedBinding) {
      console.warn('Quick note interpreter binding %o not found, keeping original bindings', quickNoteBinding);
      return interpreterBindings;
    }

    matchedBinding.selected = true;
    // Quick note has a fixed single-engine binding. Do not expand note-level bindings
    // from paragraph magic like %jdbc, otherwise a shell quick note can drift into SQL bindings.
    let idsToSave = [matchedBinding.id];
    if ($scope.note && $scope.note.id) {
      let savedKey = idsToSave.join(',');
      if (quickNoteBindingSaved[$scope.note.id] !== savedKey) {
        quickNoteBindingSaved[$scope.note.id] = savedKey;
        websocketMsgSrv.saveInterpreterBindings($scope.note.id, idsToSave);
      }
    }
    return filteredBindings;
  }

  function formatInterpreterMagic(name) {
    if (!name) {
      return '';
    }
    return '%' + String(name).replace(/^%+/, '');
  }

  function getSelectedInterpreterMagic(interpreterBindings) {
    if (!angular.isArray(interpreterBindings) || interpreterBindings.length === 0) {
      return '';
    }
    let defaultBinding = null;
    for (let i = 0; i < interpreterBindings.length; i++) {
      let binding = interpreterBindings[i];
      if (binding && binding.selected) {
        defaultBinding = binding;
        break;
      }
    }
    if (!defaultBinding) {
      defaultBinding = interpreterBindings[0];
    }

    return defaultBinding && defaultBinding.name ? formatInterpreterMagic(defaultBinding.name) : '';
  }

  function getFirstParagraphMagic() {
    if (!$scope.note || !angular.isArray($scope.note.paragraphs)) {
      return '';
    }
    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      let text = $scope.note.paragraphs[i] && $scope.note.paragraphs[i].text;
      let match = text && text.match(/^\s*%([\w.-]+)/);
      if (match) {
        return formatInterpreterMagic(match[1]);
      }
    }
    return '';
  }

  $scope.getDefaultInterpreterMagic = function() {
    return getSelectedInterpreterMagic($scope.interpreterBindings) ||
      formatInterpreterMagic(getQuickNoteInterpreterBinding($scope.note)) ||
      getFirstParagraphMagic();
  };

  function refreshNoMagicParagraphEditorSettings() {
    if (!$scope.note || !$scope.note.paragraphs) {
      return;
    }
    _.forEach($scope.note.paragraphs, function(n) {
      let regExp = /^\s*%/g;
      if (!n.text || !regExp.exec(n.text)) {
        $scope.$broadcast('saveInterpreterBindings', n.id);
      }
    });
  }

  $scope.focusParagraphOnClick = function(clickEvent) {
    if (!$scope.note) {
      return;
    }
    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      let paragraphId = $scope.note.paragraphs[i].id;
      let containerEl = angular.element('#' + paragraphId + '_container')[0];
      if (!containerEl) {
        continue;
      }
      if (jQuery.contains(containerEl, clickEvent.target)) {
        $scope.$broadcast('focusParagraph', paragraphId, 0, null, true);
        break;
      }
    }
  };

  // register mouseevent handler for focus paragraph
  document.addEventListener('click', $scope.focusParagraphOnClick);

  let keyboardShortcut = function(keyEvent) {
    // handle keyevent
    if (!$scope.viewOnly && !$scope.revisionView) {
      $scope.$broadcast('keyEvent', keyEvent);
    }
  };

  $scope.keydownEvent = function(keyEvent) {
    if ((keyEvent.ctrlKey || keyEvent.metaKey) && String.fromCharCode(keyEvent.which).toLowerCase() === 's') {
      keyEvent.preventDefault();
    }

    keyboardShortcut(keyEvent);
  };

  // register mouseevent handler for focus paragraph
  document.addEventListener('keydown', $scope.keydownEvent);

  $scope.paragraphOnDoubleClick = function(paragraphId) {
    $scope.$broadcast('doubleClickParagraph', paragraphId);
  };

  // Move the note to trash and go back to the main page
  $scope.moveNoteToTrash = function(noteId) {
    noteActionService.moveNoteToTrash(noteId, true);
  };

  // Remove the note permanently if it's in the trash
  $scope.removeNote = function(noteId) {
    noteActionService.removeNote(noteId, true);
  };

  $scope.isTrash = function(note) {
    return note && note.path ? note.path.split('/')[1] === TRASH_FOLDER_ID : false;
  };

  // Export notebook
  let limit = 0;

  websocketMsgSrv.listConfigurations();
  $scope.$on('configurationsInfo', function(scope, event) {
    limit = event.configurations['zeppelin.websocket.max.text.message.size'];
  });

  $scope.exportNote = function() {
    let noteToExport = angular.copy($scope.note);
    angular.forEach(noteToExport.paragraphs, function(paragraph) {
      paragraph.results = null;
    });
    let jsonContent = JSON.stringify(noteToExport, null, 2);
    if (jsonContent.length > limit) {
      BootstrapDialog.confirm({
        closable: true,
        title: 'Note size exceeds importable limit (' + limit + ')',
        message: 'Do you still want to export this note?',
        callback: function(result) {
          if (result) {
            saveAsService.saveAs(jsonContent, $scope.note.name + '_' + $scope.note.id, 'zpln');
          }
        },
      });
    } else {
      saveAsService.saveAs(jsonContent, $scope.note.name + '_' + $scope.note.id, 'zpln');
    }
  };

  // Export nbformat
  $scope.exportNbformat = function() {
    websocketMsgSrv.convertNote($scope.note.id, $scope.note.name);
  };

  // Export nbformat
  $scope.reloadNote = function() {
    websocketMsgSrv.reloadNote($scope.note.id);
  };

  // Clone note
  $scope.cloneNote = function(noteId) {
    BootstrapDialog.confirm({
      closable: true,
      title: '',
      message: 'Do you want to clone this note?',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.cloneNote(noteId);
          $location.path('/');
        }
      },
    });
  };

  // checkpoint/commit notebook
  $scope.checkpointNote = function(commitMessage) {
    BootstrapDialog.confirm({
      closable: true,
      title: '',
      message: 'Commit note to current repository?',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.checkpointNote($routeParams.noteId, commitMessage);
        }
      },
    });
    document.getElementById('note.checkpoint.message').value = '';
  };

  // set notebook head to given revision
  $scope.setNoteRevision = function() {
    BootstrapDialog.confirm({
      closable: true,
      title: '',
      message: 'Set notebook head to current revision?',
      callback: function(result) {
        if (result) {
          websocketMsgSrv.setNoteRevision($routeParams.noteId, $routeParams.revisionId);
        }
      },
    });
  };

  $scope.preVisibleRevisionsComparator = function() {
    $scope.mergeNoteRevisionsForCompare = null;
    $scope.firstNoteRevisionForCompare = null;
    $scope.secondNoteRevisionForCompare = null;
    $scope.currentFirstRevisionForCompare = 'Choose...';
    $scope.currentSecondRevisionForCompare = 'Choose...';
    $scope.$apply();
  };

  $scope.$on('listRevisionHistory', function(event, data) {
    console.debug('received list of revisions %o', data);
    $scope.noteRevisions = data && angular.isArray(data.revisionList) ? data.revisionList : [];
    if ($scope.noteRevisions) {
      if ($scope.noteRevisions.length === 0 || $scope.noteRevisions[0].id !== 'Head') {
        const headTime = $scope.noteRevisions.length > 0 ? $scope.noteRevisions[0].time : null;
        $scope.noteRevisions.splice(0, 0, {
          id: 'Head',
          message: 'Head',
          time: headTime,
        });
      }
      if ($routeParams.revisionId) {
        let index = _.findIndex($scope.noteRevisions,
          {'id': $routeParams.revisionId});
        if (index > -1) {
          $scope.currentRevision = $scope.noteRevisions[index].message;
        }
      }
    }
  });

  $scope.$on('noteRevision', function(event, data) {
    console.log('received note revision %o', data);
    if (data.note) {
      $scope.note = data.note;
      initializeLookAndFeel();
    } else {
      $location.path('/');
    }
  });

  $scope.$on('setNoteRevisionResult', function(event, data) {
    console.log('received set note revision result %o', data);
    if (data.status) {
      $location.path('/notebook/' + $routeParams.noteId);
    }
  });

  $scope.visitRevision = function(revision) {
    if (revision.id) {
      if (revision.id === 'Head') {
        $location.path('/notebook/' + $routeParams.noteId);
      } else {
        $location.path('/notebook/' + $routeParams.noteId + '/revision/' + revision.id);
      }
    } else {
      ngToast.danger({content: 'There is a problem with this Revision',
        verticalPosition: 'top',
        dismissOnTimeout: false,
      });
    }
  };

  $scope.runAllParagraphs = function(noteId) {
    let count = $scope.note.paragraphs.length;
    BootstrapDialog.confirm({
      closable: true,
      title: '运行全部段落',
      message: '<div style="padding: 4px 0;">' +
        '<div style="margin-bottom: 10px;">即将运行当前笔记中的 <strong>' + count + '</strong> 个代码块。</div>' +
        '<div style="background: #fef3c7; border: 1px solid #fde68a; border-radius: 6px; ' +
          'padding: 10px 12px; font-size: 12px; color: #92400e;">' +
          '<i class="fa fa-exclamation-triangle" style="margin-right: 4px;"></i>' +
          '所有代码块将依次执行，请确认无误后再操作。' +
        '</div>' +
      '</div>',
      btnOKLabel: '确认运行',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          const paragraphs = $scope.note.paragraphs.map((p) => {
            return {
              id: p.id,
              title: p.title,
              paragraph: p.text,
              config: p.config,
              params: p.settings.params,
            };
          });
          websocketMsgSrv.runAllParagraphs(noteId, paragraphs);
        }
      },
    });
  };

  $scope.saveNote = function() {
    if ($scope.note && $scope.note.paragraphs) {
      _.forEach($scope.note.paragraphs, function(par) {
        saveParagraphViaScope(par);
      });
      $scope.isNoteDirty = null;
    }
  };

  $scope.hasNoteOutput = function() {
    let paragraphs = $scope.note && $scope.note.paragraphs;
    return angular.isArray(paragraphs) && paragraphs.some(function(paragraph) {
      let messages = paragraph.results && paragraph.results.msg;
      return angular.isArray(messages) && messages.length > 0;
    });
  };

  $scope.canClearNoteOutput = function() {
    return !$scope.$$destroyed && !$scope.viewOnly && !$scope.revisionView &&
      !$scope.isNoteRunning() && $scope.hasNoteOutput();
  };

  $scope.getClearNoteOutputHint = function() {
    if ($scope.revisionView) {
      return '历史版本中的运行结果不可清理。';
    }
    if ($scope.isNoteRunning()) {
      return '代码运行中，请在运行结束后清理结果。';
    }
    if (!$scope.hasNoteOutput()) {
      return '当前笔记暂无可清理的运行结果。';
    }
    return '清理全部运行结果可减小笔记体积，有助于提升加载和操作的流畅度，代码和段落会保留。';
  };

  $scope.clearAllParagraphOutput = function(noteId) {
    function canClear() {
      return $scope.note && $scope.note.id === noteId && $scope.canClearNoteOutput();
    }
    if (canClear()) {
      // Recheck when confirming: a paragraph may start running while the dialog is open.
      noteActionService.clearAllParagraphOutput(noteId, canClear);
    }
  };

  $scope.$on('clearAllParagraphOutput', function(event, noteId) {
    if ($scope.note && $scope.note.id === noteId && $scope.note.paragraphs) {
      _.forEach($scope.note.paragraphs, function(p) {
        p.results = {};
      });
      $scope.noteStats = computeNoteStats($scope.note);
    }
  });

  $scope.toggleAllEditor = function() {
    if ($scope.editorToggled) {
      $scope.$broadcast('openEditor');
    } else {
      $scope.$broadcast('closeEditor');
    }
    $scope.editorToggled = !$scope.editorToggled;
  };

  $scope.showAllEditor = function() {
    $scope.$broadcast('openEditor');
  };

  $scope.hideAllEditor = function() {
    $scope.$broadcast('closeEditor');
  };

  $scope.toggleAllTable = function() {
    if ($scope.tableToggled) {
      $scope.$broadcast('openTable');
    } else {
      $scope.$broadcast('closeTable');
    }
    $scope.tableToggled = !$scope.tableToggled;
  };

  $scope.showAllTable = function() {
    $scope.$broadcast('openTable');
  };

  $scope.hideAllTable = function() {
    $scope.$broadcast('closeTable');
  };

  /**
   * @returns {boolean} true if one more paragraphs are running. otherwise return false.
   */
  $scope.isNoteRunning = function() {
    if (!$scope.note || !angular.isArray($scope.note.paragraphs)) {
      return false;
    }

    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      if (isParagraphRunning($scope.note.paragraphs[i])) {
        return true;
      }
    }

    return false;
  };

  $scope.killSaveTimer = function() {
    if ($scope.saveTimer) {
      $timeout.cancel($scope.saveTimer);
      $scope.saveTimer = null;
    }
  };

  $scope.startSaveTimer = function() {
    $scope.killSaveTimer();
    $scope.isNoteDirty = true;
    // console.log('startSaveTimer called ' + $scope.note.id);
    $scope.saveTimer = $timeout(function() {
      $scope.saveNote();
    }, 10000);
  };

  $scope.setLookAndFeel = function(looknfeel) {
    $scope.note.config.looknfeel = looknfeel;
    if ($scope.revisionView === true) {
      $rootScope.$broadcast('setLookAndFeel', $scope.note.config.looknfeel);
    } else {
      $scope.setConfig();
    }
  };

  $scope.setNoteFormTitle = function(noteFormTitle) {
    $scope.note.config.noteFormTitle = noteFormTitle;
    $scope.setConfig();
  };

  /** Set cron expression for this note **/
  $scope.setCronScheduler = function(cronExpr) {
    if (cronExpr) {
      if (!$scope.note.config.cronExecutingUser) {
        $scope.note.config.cronExecutingUser = $rootScope.ticket.principal;
      }
      if (!$scope.note.config.cronExecutingRoles) {
        $scope.note.config.cronExecutingRoles = $rootScope.ticket.roles;
      }
    } else {
      $scope.note.config.cronExecutingUser = '';
      $scope.note.config.cronExecutingRoles = '';
    }
    $scope.note.config.cron = cronExpr;
    $scope.setConfig();
  };

  /** Update note config **/
  $scope.setConfig = function(config) {
    if (config) {
      $scope.note.config = config;
    }
    websocketMsgSrv.updateNote($scope.note.id, $scope.note.name, $scope.note.config);
  };

  /** Update the note name */
  $scope.updateNoteName = function(newName) {
    const trimmedNewName = newName.trim();
    if (trimmedNewName.length > 0 && $scope.note.name !== trimmedNewName) {
      $scope.note.name = trimmedNewName;
      websocketMsgSrv.renameNote($scope.note.id, $scope.note.name, true);
    }
  };

  const initializeLookAndFeel = function() {
    if (!$scope.note) {
      return;
    }
    if (!$scope.note.config) {
      $scope.note.config = {};
    }
    if (!$scope.note.config.looknfeel) {
      $scope.note.config.looknfeel = 'default';
    } else {
      $scope.viewOnly = $scope.note.config.looknfeel === 'report' ? true : false;
    }

    if ($scope.note.paragraphs && $scope.note.paragraphs[0]) {
      $scope.note.paragraphs[0].focus = true;
    }
    $rootScope.$broadcast('setLookAndFeel', $scope.note.config.looknfeel);
  };

  let cleanParagraphExcept = function(paragraphId, note) {
    let noteCopy = {};
    noteCopy.id = note.id;
    noteCopy.name = note.name;
    noteCopy.config = note.config;
    noteCopy.info = note.info;
    noteCopy.paragraphs = [];
    for (let i = 0; i < note.paragraphs.length; i++) {
      if (note.paragraphs[i].id === paragraphId) {
        noteCopy.paragraphs[0] = note.paragraphs[i];
        if (!noteCopy.paragraphs[0].config) {
          noteCopy.paragraphs[0].config = {};
        }
        noteCopy.paragraphs[0].config.editorHide = true;
        noteCopy.paragraphs[0].config.tableHide = false;
        break;
      }
    }
    return noteCopy;
  };

  function syncViewportWatchSuspend() {
    $scope.viewportWatchSuspend = Object.keys(initializingParagraphIds).length;
  }

  function refreshViewportWatchLocations() {
    if (scrollMonitor && scrollMonitor.update) {
      scrollMonitor.update();
    } else if (scrollMonitor && scrollMonitor.recalculateLocations) {
      scrollMonitor.recalculateLocations();
    }
  }

  function revealInitializedParagraph(paragraphId) {
    $timeout(function() {
      refreshViewportWatchLocations();
      if (!$scope.note || !_.find($scope.note.paragraphs, {id: paragraphId})) {
        return;
      }
      $scope.scrollToParagraphById(paragraphId);
      $scope.$broadcast('focusParagraph', paragraphId, 0, null, false);
    });
  }

  function beginParagraphInitialization(paragraph) {
    paragraph._initializing = true;
    paragraph._pendingRevealAfterInit = true;
    initializingParagraphIds[paragraph.id] = true;
    $timeout.cancel(initializingParagraphTimeouts[paragraph.id]);
    syncViewportWatchSuspend();

    // If aceLoaded never comes back, release the note-level guard so existing
    // off-screen paragraphs can still be frozen by viewport-watch later.
    initializingParagraphTimeouts[paragraph.id] = $timeout(function() {
      delete initializingParagraphTimeouts[paragraph.id];
      finishParagraphInitialization(paragraph.id, false);
    }, 10000);
  }

  function finishParagraphInitialization(paragraphId, revealAfterRender) {
    if (initializingParagraphTimeouts[paragraphId]) {
      $timeout.cancel(initializingParagraphTimeouts[paragraphId]);
      delete initializingParagraphTimeouts[paragraphId];
    }

    let paragraph = $scope.note && $scope.note.paragraphs ?
      _.find($scope.note.paragraphs, {id: paragraphId}) : null;

    if (!initializingParagraphIds[paragraphId]) {
      if (revealAfterRender && paragraph && paragraph._pendingRevealAfterInit) {
        paragraph._pendingRevealAfterInit = false;
        revealInitializedParagraph(paragraphId);
      }
      return;
    }

    delete initializingParagraphIds[paragraphId];
    syncViewportWatchSuspend();

    if (paragraph) {
      paragraph._initializing = false;
    }

    if (revealAfterRender && paragraph && paragraph._pendingRevealAfterInit) {
      paragraph._pendingRevealAfterInit = false;
      revealInitializedParagraph(paragraphId);
    } else {
      $timeout(refreshViewportWatchLocations);
    }
  }

  let addPara = function(paragraph, index) {
    if (!$scope.note || !$scope.note.paragraphs) {
      return;
    }

    // Mark the data object, not a scope, so both ngRepeat and ParagraphCtrl
    // can see the same initialization state while viewport-watch decides
    // whether it is allowed to disable watchers.
    beginParagraphInitialization(paragraph);

    $scope.note.paragraphs.splice(index, 0, paragraph);
    // Keep the new block visible to the user. The websocket response already
    // added it, but without an explicit reveal it can be inserted outside the
    // current viewport and look like the click did nothing until refresh.
    $scope.note.paragraphs.forEach(function(para) {
      para.focus = para.id === paragraph.id;
    });
    if ($scope.lockedParagraphId) {
      // In pin mode, non-locked paragraphs are hidden by .paragraph-dimmed.
      // Move the pin to the websocket-created paragraph so the insert has
      // immediate visible feedback instead of only appearing after refresh.
      setLockedParagraphId(paragraph.id);
    }
  };

  let removePara = function(paragraphId) {
    let removeIdx;
    _.each($scope.note.paragraphs, function(para, idx) {
      if (para.id === paragraphId) {
        removeIdx = idx;
      }
    });
    if (removeIdx === undefined) {
      return [];
    }
    if ($scope.lockedParagraphId === paragraphId) {
      // Removing the pinned paragraph leaves no visible .paragraph-locked node.
      // Clear pin mode immediately so the remaining paragraphs are not hidden.
      setLockedParagraphId(null);
    }
    return $scope.note.paragraphs.splice(removeIdx, 1);
  };

  $scope.$on('addParagraph', function(event, paragraph, index) {
    if ($scope.paragraphUrl || $scope.revisionView === true) {
      return;
    }
    addPara(paragraph, index);
  });

  $scope.$on('paragraphInitialized', function(event, paragraphId) {
    finishParagraphInitialization(paragraphId, true);
  });

  $scope.$on('removeParagraph', function(event, paragraphId) {
    if ($scope.paragraphUrl || $scope.revisionView === true) {
      return;
    }
    finishParagraphInitialization(paragraphId, false);
    removePara(paragraphId);
  });

  $scope.$on('moveParagraph', function(event, paragraphId, newIdx) {
    if ($scope.revisionView === true) {
      return;
    }
    let removedPara = removePara(paragraphId);
    if (removedPara && removedPara.length === 1) {
      addPara(removedPara[0], newIdx);
    }
  });

  $scope.$on('updateNote', function(event, name, config, info) {
    /** update Note name */
    if (name !== $scope.note.name) {
      console.log('change note name to : %o', $scope.note.name);
      $scope.note.name = name;
    }
    $scope.note.config = config;
    $scope.note.info = info;
    initializeLookAndFeel();
  });

  let getInterpreterBindings = function() {
    websocketMsgSrv.getInterpreterBindings($scope.note.id);
  };

  function scheduleInterpreterBindingsForTitle() {
    if (!$scope.note || !$scope.note.id ||
        (angular.isArray($scope.interpreterBindings) && $scope.interpreterBindings.length > 0)) {
      return;
    }

    if (interpreterBindingsBackgroundTimer) {
      $timeout.cancel(interpreterBindingsBackgroundTimer);
    }

    interpreterBindingsBackgroundTimer = $timeout(function() {
      interpreterBindingsBackgroundTimer = null;
      if (!$scope.note || !$scope.note.id || $scope.showSetting ||
          (angular.isArray($scope.interpreterBindings) && $scope.interpreterBindings.length > 0)) {
        return;
      }
      loadingInterpreterBindingsInBackground = true;
      getInterpreterBindings();
    }, 300);
  }

  $scope.$on('interpreterBindings', function(event, data) {
    if (data.noteId && (!$scope.note || data.noteId !== $scope.note.id)) {
      return;
    }
    let quickNoteBinding = getQuickNoteInterpreterBinding($scope.note);
    $scope.allInterpreterBindings = data.interpreterBindings || [];
    $scope.interpreterBindings = filterQuickNoteInterpreterBindings(data.interpreterBindings);

    let selected = false;
    let key;
    let setting;

    for (key in $scope.interpreterBindings) {
      if($scope.interpreterBindings.hasOwnProperty(key)) {
        setting = $scope.interpreterBindings[key];
        if (setting.selected) {
          selected = true;
          break;
        }
      }
    }

    if (!selected) {
      // make default selection
      let selectedIntp = {};
      for (key in $scope.interpreterBindings) {
        if ($scope.interpreterBindings.hasOwnProperty(key)) {
          setting = $scope.interpreterBindings[key];
          if (!selectedIntp[setting.name]) {
            setting.selected = true;
            selectedIntp[setting.name] = true;
          }
        }
      }
      if (!loadingInterpreterBindingsInBackground) {
        $scope.showSetting = true;
      }
    }

    $scope.interpreterBindingsOrig = angular.copy($scope.interpreterBindings); // to check dirty
    loadingInterpreterBindingsInBackground = false;

    if (quickNoteBinding) {
      refreshNoMagicParagraphEditorSettings();
    }
  });

  $scope.interpreterSelectionListeners = {
    accept: function(sourceItemHandleScope, destSortableScope) {
      return true;
    },
    itemMoved: function(event) {},
    orderChanged: function(event) {},
  };

  $scope.closeAdditionalBoards = function() {
    $scope.closeSetting();
    $scope.closePermissions();
    $scope.closeRevisionsComparator();
  };

  $scope.openSetting = function() {
    $scope.showSetting = true;
    getInterpreterBindings();
  };

  $scope.closeSetting = function() {
    if (!$scope.showSetting) {
      return;
    }
    if (isSettingDirty()) {
      BootstrapDialog.confirm({
        closable: true,
        title: '',
        message: 'Interpreter setting changes will be discarded.',
        callback: function(result) {
          if (result) {
            $scope.$apply(function() {
              $scope.showSetting = false;
            });
          }
        },
      });
    } else {
      $scope.showSetting = false;
    }
  };

  $scope.saveSetting = function() {
    let selectedSettingIds = [];
    for (let no in $scope.interpreterBindings) {
      if ($scope.interpreterBindings.hasOwnProperty(no)) {
        let setting = $scope.interpreterBindings[no];
        if (setting.selected) {
          selectedSettingIds.push(setting.id);
        }
      }
    }
    websocketMsgSrv.saveInterpreterBindings($scope.note.id, selectedSettingIds);
    console.log('Interpreter bindings %o saved', selectedSettingIds);

    _.forEach($scope.note.paragraphs, function(n, key) {
      let regExp = /^\s*%/g;
      if (n.text && !regExp.exec(n.text)) {
        $scope.$broadcast('saveInterpreterBindings', n.id);
      }
    });

    $scope.showSetting = false;
  };

  $scope.toggleSetting = function() {
    if ($scope.showSetting) {
      $scope.closeSetting();
    } else {
      $scope.closeAdditionalBoards();
      $scope.openSetting();
      angular.element('html, body').animate({scrollTop: 0}, 'slow');
    }
  };

  $scope.openRevisionsComparator = function() {
    $scope.showRevisionsComparator = true;
  };

  $scope.closeRevisionsComparator = function() {
    $scope.showRevisionsComparator = false;
  };

  $scope.toggleRevisionsComparator = function() {
    if ($scope.showRevisionsComparator) {
      $scope.closeRevisionsComparator();
    } else {
      $scope.closeAdditionalBoards();
      $scope.openRevisionsComparator();
      angular.element('html, body').animate({scrollTop: 0}, 'slow');
    }
  };

  let getPermissions = function(callback) {
    $http.get(baseUrlSrv.getRestApiBase() + '/notebook/' + $scope.note.id + '/permissions')
    .success(function(data, status, headers, config) {
      $scope.permissions = data.body;
      $scope.permissionsOrig = angular.copy($scope.permissions); // to check dirty

      let selectJson = {
        tokenSeparators: [',', ' '],
        ajax: {
          url: function(params) {
            if (!params.term) {
              return false;
            }
            return baseUrlSrv.getRestApiBase() + '/security/userlist/' + params.term;
          },
          delay: 250,
          processResults: function(data, params) {
            let results = [];

            if (data.body.users.length !== 0) {
              let users = [];
              for (let len = 0; len < data.body.users.length; len++) {
                users.push({
                  'id': data.body.users[len],
                  'text': data.body.users[len],
                });
              }
              results.push({
                'text': 'Users :',
                'children': users,
              });
            }
            if (data.body.roles.length !== 0) {
              let roles = [];
              for (let len = 0; len < data.body.roles.length; len++) {
                roles.push({
                  'id': data.body.roles[len],
                  'text': data.body.roles[len],
                });
              }
              results.push({
                'text': 'Roles :',
                'children': roles,
              });
            }
            return {
              results: results,
              pagination: {
                more: false,
              },
            };
          },
          cache: false,
        },
        width: ' ',
        tags: true,
        minimumInputLength: 3,
      };

      $scope.setMyPermissions();
      angular.element('#selectOwners').select2(selectJson);
      angular.element('#selectReaders').select2(selectJson);
      angular.element('#selectRunners').select2(selectJson);
      angular.element('#selectWriters').select2(selectJson);
      if (callback) {
        callback();
      }
    })
    .error(function(data, status, headers, config) {
      if (status !== 0) {
        console.log('Error %o %o', status, data.message);
      }
    });
  };

  $scope.openPermissions = function() {
    $scope.showPermissions = true;
    getPermissions();
  };

  $scope.closePermissions = function() {
    if (!$scope.showPermissions) {
      return;
    }
    if (isPermissionsDirty()) {
      BootstrapDialog.confirm({
        closable: true,
        title: '',
        message: 'Changes will be discarded.',
        callback: function(result) {
          if (result) {
            $scope.$apply(function() {
              $scope.showPermissions = false;
            });
          }
        },
      });
    } else {
      $scope.showPermissions = false;
    }
  };

  function convertPermissionsToArray() {
    $scope.permissions.owners = angular.element('#selectOwners').val();
    $scope.permissions.readers = angular.element('#selectReaders').val();
    $scope.permissions.runners = angular.element('#selectRunners').val();
    $scope.permissions.writers = angular.element('#selectWriters').val();
    angular.element('.permissionsForm select').find('option:not([is-select2="false"])').remove();
  }

  $scope.hasMatches = function() {
    return $scope.search.occurrencesCount > 0;
  };

  const markAllOccurrences = function() {
    $scope.search.occurrencesCount = 0;
    $scope.search.occurrencesHidden = false;
    currentSearchParagraph = 0;
    $scope.$broadcast('markAllOccurrences', $scope.search.searchText);
    $scope.search.currentOccurrence = $scope.search.occurrencesCount > 0 ? 1 : 0;
  };

  $scope.markAllOccurrencesAndHighlightFirst = function() {
    $scope.search.needHighlightFirst = true;
    markAllOccurrences();
  };

  const increaseCurrentOccurence = function() {
    ++$scope.search.currentOccurrence;
    if ($scope.search.currentOccurrence > $scope.search.occurrencesCount) {
      $scope.search.currentOccurrence = 1;
    }
  };

  const decreaseCurrentOccurence = function() {
    --$scope.search.currentOccurrence;
    if ($scope.search.currentOccurrence === 0) {
      $scope.search.currentOccurrence = $scope.search.occurrencesCount;
    }
  };

  const sendNextOccurrenceMessage = function() {
    if ($scope.search.occurrencesCount === 0) {
      markAllOccurrences();
      if ($scope.search.occurrencesCount === 0) {
        return;
      }
    }
    if ($scope.search.occurrencesHidden) {
      markAllOccurrences();
    }
    $scope.$broadcast('nextOccurrence', $scope.note.paragraphs[currentSearchParagraph].id);
  };

  const sendPrevOccurrenceMessage = function() {
    if ($scope.search.occurrencesCount === 0) {
      markAllOccurrences();
      if ($scope.search.occurrencesCount === 0) {
        return;
      }
    }
    if ($scope.search.occurrencesHidden) {
      markAllOccurrences();
      currentSearchParagraph = $scope.note.paragraphs.length - 1;
    }
    $scope.$broadcast('prevOccurrence', $scope.note.paragraphs[currentSearchParagraph].id);
  };

  const increaseCurrentSearchParagraph = function() {
    ++currentSearchParagraph;
    if (currentSearchParagraph >= $scope.note.paragraphs.length) {
      currentSearchParagraph = 0;
    }
  };

  const decreaseCurrentSearchParagraph = function() {
    --currentSearchParagraph;
    if (currentSearchParagraph === -1) {
      currentSearchParagraph = $scope.note.paragraphs.length - 1;
    }
  };

  $scope.$on('occurrencesExists', function(event, count) {
    $scope.search.occurrencesCount += count;
    if ($scope.search.needHighlightFirst) {
      sendNextOccurrenceMessage();
      $scope.search.needHighlightFirst = false;
    }
  });

  $scope.nextOccurrence = function() {
    sendNextOccurrenceMessage();
    increaseCurrentOccurence();
  };

  $scope.$on('noNextOccurrence', function(event) {
    increaseCurrentSearchParagraph();
    sendNextOccurrenceMessage();
  });

  $scope.prevOccurrence = function() {
    sendPrevOccurrenceMessage();
    decreaseCurrentOccurence();
  };

  $scope.$on('noPrevOccurrence', function(event) {
    decreaseCurrentSearchParagraph();
    sendPrevOccurrenceMessage();
  });

  $scope.$on('editorClicked', function() {
    $scope.search.occurrencesHidden = true;
    $scope.$broadcast('unmarkAll');
  });

  $scope.replace = function() {
    if ($scope.search.occurrencesCount === 0) {
      $scope.markAllOccurrencesAndHighlightFirst();
      if ($scope.search.occurrencesCount === 0) {
        return;
      }
    }
    if ($scope.search.occurrencesHidden) {
      $scope.markAllOccurrencesAndHighlightFirst();
      return;
    }
    $scope.$broadcast('replaceCurrent', $scope.search.searchText, $scope.search.replaceText);
    if ($scope.search.needToSendNextOccurrenceAfterReplace) {
      sendNextOccurrenceMessage();
      $scope.search.needToSendNextOccurrenceAfterReplace = false;
    }
  };

  $scope.$on('occurrencesCountChanged', function(event, cnt) {
    $scope.search.occurrencesCount += cnt;
    if ($scope.search.occurrencesCount === 0) {
      $scope.search.currentOccurrence = 0;
    } else {
      $scope.search.currentOccurrence += cnt + 1;
      if ($scope.search.currentOccurrence > $scope.search.occurrencesCount) {
        $scope.search.currentOccurrence = 1;
      }
    }
  });

  $scope.replaceAll = function() {
    if ($scope.search.occurrencesCount === 0) {
      return;
    }
    if ($scope.search.occurrencesHidden) {
      $scope.markAllOccurrencesAndHighlightFirst();
    }
    $scope.$broadcast('replaceAll', $scope.search.searchText, $scope.search.replaceText);
    $scope.markAllOccurrencesAndHighlightFirst();
  };

  $scope.$on('noNextOccurrenceAfterReplace', function() {
    $scope.search.occurrencesCount = 0;
    $scope.search.needHighlightFirst = false;
    $scope.search.needToSendNextOccurrenceAfterReplace = false;
    $scope.$broadcast('checkOccurrences');
    increaseCurrentSearchParagraph();
    if ($scope.search.occurrencesCount > 0) {
      $scope.search.needToSendNextOccurrenceAfterReplace = true;
    }
  });

  $scope.onPressOnFindInput = function(event) {
    if (event.keyCode === 13) {
      $scope.nextOccurrence();
    }
  };

  let makeSearchBoxVisible = function() {
    if ($scope.search.searchBoxOpened) {
      $scope.search.searchBoxOpened = false;
      $scope.search.left = '0px';
    } else {
      $scope.search.searchBoxOpened = true;
      let searchGroup = angular.element('#searchGroup')[0];
      if (!searchGroup) {
        return;
      }
      let searchGroupRect = searchGroup.getBoundingClientRect();
      let dropdownRight = searchGroupRect.left + $scope.search.searchBoxWidth;
      if (dropdownRight + 5 > window.innerWidth) {
        $scope.search.left = window.innerWidth - dropdownRight - 15 + 'px';
      }
    }
  };

  $scope.searchClicked = function() {
    makeSearchBoxVisible();
  };

  $scope.$on('toggleSearchBox', function() {
    let elem = angular.element('#searchGroup');
    if ($scope.search.searchBoxOpened) {
      elem.removeClass('open');
    } else {
      elem.addClass('open');
    }
    $timeout(makeSearchBoxVisible);
  });

  $scope.restartInterpreter = function(interpreter) {
    interpreterRestartService.restart(interpreter.id, $scope.note.id, interpreter.name);
  };

  $scope.savePermissions = function() {
    if ($scope.isAnonymous || $rootScope.ticket.principal.trim().length === 0) {
      $scope.blockAnonUsers();
    }
    convertPermissionsToArray();
    if ($scope.isOwnerEmpty()) {
      BootstrapDialog.show({
        closable: false,
        title: 'Setting Owners Permissions',
        message: 'Please fill the [Owners] field. If not, it will set as current user.\n\n' +
          'Current user : [ ' + _.escape($rootScope.ticket.principal) + ']',
        buttons: [
          {
            label: 'Set',
            action: function(dialog) {
              dialog.close();
              $scope.permissions.owners = [$rootScope.ticket.principal];
              $scope.setPermissions();
            },
          },
          {
            label: 'Cancel',
            action: function(dialog) {
              dialog.close();
              $scope.openPermissions();
            },
          },
        ],
      });
    } else {
      $scope.setPermissions();
    }
  };

  $scope.setPermissions = function() {
    $http.put(baseUrlSrv.getRestApiBase() + '/notebook/' + $scope.note.id + '/permissions',
      $scope.permissions, {withCredentials: true})
    .success(function(data, status, headers, config) {
      getPermissions(function() {
        console.log('Note permissions %o saved', $scope.permissions);
        BootstrapDialog.alert({
          closable: true,
          title: 'Permissions Saved Successfully',
          message: 'Owners : ' + _.escape($scope.permissions.owners)
          + '\n\n' +
          'Readers : ' + _.escape($scope.permissions.readers) +
          '\n\n' +
          'Runners : ' + _.escape($scope.permissions.runners) +
          '\n\n' +
          'Writers  : ' + _.escape($scope.permissions.writers),
        });
        $scope.showPermissions = false;
      });
    })
    .error(function(data, status, headers, config) {
      console.log('Error %o %o', status, data.message);
      BootstrapDialog.show({
        closable: false,
        closeByBackdrop: false,
        closeByKeyboard: false,
        title: 'Insufficient privileges',
        message: _.escape(data.message),
        buttons: [
          {
            label: 'Login',
            action: function(dialog) {
              dialog.close();
              angular.element('#loginModal').modal({
                show: 'true',
              });
            },
          },
          {
            label: 'Cancel',
            action: function(dialog) {
              dialog.close();
              $location.path('/');
            },
          },
        ],
      });
    });
  };

  $scope.togglePermissions = function() {
    let principal = $rootScope.ticket.principal;
    $scope.isAnonymous = principal === 'anonymous' ? true : false;
    if (!!principal && $scope.isAnonymous) {
      $scope.blockAnonUsers();
    } else {
      if ($scope.showPermissions) {
        $scope.closePermissions();
        angular.element('#selectOwners').select2({});
        angular.element('#selectReaders').select2({});
        angular.element('#selectRunners').select2({});
        angular.element('#selectWriters').select2({});
      } else {
        $scope.closeAdditionalBoards();
        $scope.openPermissions();
      }
    }
  };

  const arrayIntersection = function(arrayFirst, arraySecond) {
    return arrayFirst.filter(function(x) {
      if(arraySecond.indexOf(x) !== -1) {
        return true;
      } else {
        return false;
      }
    });
  };

  $scope.setMyPermissions = function() {
    let myPermissions;
    try {
      myPermissions = JSON.parse($rootScope.ticket.roles);
    } catch(err) {
      myPermissions = [];
    }
    myPermissions.push($rootScope.ticket.principal);

    $scope.isOwner = !($scope.permissions.owners.length > 0 &&
       arrayIntersection(myPermissions, $scope.permissions.owners).length === 0);

    $scope.isWriter = !($scope.permissions.writers.length > 0 &&
       arrayIntersection(myPermissions, $scope.permissions.writers).length === 0);

    if (!$scope.isOwner && !$scope.isWriter) {
      $scope.viewOnly = true;
      $scope.note.config.looknfeel = 'report';
      initializeLookAndFeel();
    }
  };

  $scope.toggleNotePersonalizedMode = function() {
    let personalizedMode = $scope.note.config.personalizedMode;
    if ($scope.isOwner) {
      BootstrapDialog.confirm({
        closable: true,
        title: 'Setting the result display',
        message: function(dialog) {
          let modeText = $scope.note.config.personalizedMode === 'true' ? 'collaborate' : 'personalize';
          return 'Do you want to <span class="text-info">' + modeText + '</span> your analysis?';
        },
        callback: function(result) {
          if (result) {
            if ($scope.note.config.personalizedMode === undefined) {
              $scope.note.config.personalizedMode = 'false';
            }
            $scope.note.config.personalizedMode = personalizedMode === 'true' ? 'false' : 'true';
            websocketMsgSrv.updatePersonalizedMode($scope.note.id, $scope.note.config.personalizedMode);
          }
        },
      });
    }
  };

  const isSettingDirty = function() {
    if (angular.equals($scope.interpreterBindings, $scope.interpreterBindingsOrig)) {
      return false;
    } else {
      return true;
    }
  };

  const isPermissionsDirty = function() {
    if (angular.equals($scope.permissions, $scope.permissionsOrig)) {
      return false;
    } else {
      return true;
    }
  };

  angular.element(document).click(function() {
    angular.element('.ace_autocomplete').hide();
  });

  $scope.isOwnerEmpty = function() {
    if ($scope.permissions.owners.length > 0) {
      for (let i = 0; i < $scope.permissions.owners.length; i++) {
        if ($scope.permissions.owners[i].trim().length > 0) {
          return false;
        } else if (i === $scope.permissions.owners.length - 1) {
          return true;
        }
      }
    } else {
      return true;
    }
  };

  /*
   ** $scope.$on functions below
   */

  $scope.$on('runAllAbove', function(event, paragraph, isNeedConfirm) {
    let allParagraphs = $scope.note.paragraphs;
    let toRunParagraphs = [];

    for (let i = 0; allParagraphs[i] !== paragraph; i++) {
      if (i === allParagraphs.length - 1) {
        return;
      } // if paragraph not in array of all paragraphs
      toRunParagraphs.push(allParagraphs[i]);
    }

    const paragraphs = toRunParagraphs.map((p) => {
      return {
        id: p.id,
        title: p.title,
        paragraph: p.text,
        config: p.config,
        params: p.settings.params,
      };
    });

    if (!isNeedConfirm) {
      websocketMsgSrv.runAllParagraphs($scope.note.id, paragraphs);
    } else {
      BootstrapDialog.confirm({
        closable: true,
        title: '',
        message: 'Run all above?',
        callback: function(result) {
          if (result) {
            websocketMsgSrv.runAllParagraphs($scope.note.id, paragraphs);
          }
        },
      });
    }

    $scope.saveCursorPosition(paragraph);
  });

  $scope.$on('collaborativeModeStatus', function(event, data) {
    $scope.collaborativeMode = Boolean(data.status);
    $scope.collaborativeModeUsers = data.users;
  });

  $scope.$on('patchReceived', function(event, data) {
    $scope.collaborativeMode = true;
  });


  $scope.$on('runAllBelowAndCurrent', function(event, paragraph, isNeedConfirm) {
    let allParagraphs = $scope.note.paragraphs;
    let toRunParagraphs = [];

    for (let i = allParagraphs.length - 1; allParagraphs[i] !== paragraph; i--) {
      if (i < 0) {
        return;
      } // if paragraph not in array of all paragraphs
      toRunParagraphs.push(allParagraphs[i]);
    }

    toRunParagraphs.push(paragraph);
    toRunParagraphs.reverse();

    const paragraphs = toRunParagraphs.map((p) => {
      return {
        id: p.id,
        title: p.title,
        paragraph: p.text,
        config: p.config,
        params: p.settings.params,
      };
    });

    if (!isNeedConfirm) {
      websocketMsgSrv.runAllParagraphs($scope.note.id, paragraphs);
    } else {
      BootstrapDialog.confirm({
        closable: true,
        title: '',
        message: 'Run current and all below?',
        callback: function(result) {
          if (result) {
            websocketMsgSrv.runAllParagraphs($scope.note.id, paragraphs);
          }
        },
      });
    }

    $scope.saveCursorPosition(paragraph);
  });

  $scope.saveCursorPosition = function(paragraph) {
    let paraEl = angular.element('#' + paragraph.id + '_paragraphColumn_main');
    if (!paraEl[0]) {
      return;
    }
    let paraScope = paraEl.scope();
    if (!paraScope || !paraScope.editor) {
      return;
    }
    let angParagEditor = paraScope.editor;
    let col = angParagEditor.selection.lead.column;
    let row = angParagEditor.selection.lead.row;
    $scope.$broadcast('focusParagraph', paragraph.id, row + 1, col);
  };

  let saveParagraphViaScope = function(paragraph) {
    let paraEl = angular.element('#' + paragraph.id + '_paragraphColumn_main');
    if (!paraEl[0]) {
      return;
    }
    let paraScope = paraEl.scope();
    if (paraScope && paraScope.saveParagraph) {
      paraScope.saveParagraph(paragraph);
    }
  };

  $scope.$on('moveParagraphUp', function(event, paragraph) {
    let newIndex = -1;
    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      if ($scope.note.paragraphs[i].id === paragraph.id) {
        newIndex = i - 1;
        break;
      }
    }
    if (newIndex < 0 || newIndex >= $scope.note.paragraphs.length) {
      return;
    }
    // save dirtyText of moving paragraphs.
    let prevParagraph = $scope.note.paragraphs[newIndex];
    saveParagraphViaScope(paragraph);
    saveParagraphViaScope(prevParagraph);
    websocketMsgSrv.moveParagraph(paragraph.id, newIndex);
  });

  $scope.$on('moveParagraphDown', function(event, paragraph) {
    let newIndex = -1;
    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      if ($scope.note.paragraphs[i].id === paragraph.id) {
        newIndex = i + 1;
        break;
      }
    }

    if (newIndex < 0 || newIndex >= $scope.note.paragraphs.length) {
      return;
    }
    // save dirtyText of moving paragraphs.
    let nextParagraph = $scope.note.paragraphs[newIndex];
    saveParagraphViaScope(paragraph);
    saveParagraphViaScope(nextParagraph);
    websocketMsgSrv.moveParagraph(paragraph.id, newIndex);
  });

  $scope.$on('moveFocusToPreviousParagraph', function(event, currentParagraphId) {
    let focus = false;
    for (let i = $scope.note.paragraphs.length - 1; i >= 0; i--) {
      if (focus === false) {
        if ($scope.note.paragraphs[i].id === currentParagraphId) {
          focus = true;
          continue;
        }
      } else {
        $scope.$broadcast('focusParagraph', $scope.note.paragraphs[i].id, -1);
        break;
      }
    }
  });

  $scope.$on('moveFocusToNextParagraph', function(event, currentParagraphId) {
    let focus = false;
    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      if (focus === false) {
        if ($scope.note.paragraphs[i].id === currentParagraphId) {
          focus = true;
          continue;
        }
      } else {
        $scope.$broadcast('focusParagraph', $scope.note.paragraphs[i].id, 0);
        break;
      }
    }
  });

  $scope.$on('insertParagraph', function(event, paragraphId, position) {
    if ($scope.revisionView === true) {
      return;
    }
    let newIndex = -1;
    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      if ($scope.note.paragraphs[i].id === paragraphId) {
        // determine position of where to add new paragraph; default is below
        if (position === 'above') {
          newIndex = i;
        } else {
          newIndex = i + 1;
        }
        break;
      }
    }

    if (newIndex < 0 || newIndex > $scope.note.paragraphs.length) {
      return;
    }
    websocketMsgSrv.insertParagraph(newIndex);
  });

  $scope.$on('setNoteContent', function(event, note) {
    if (note === undefined) {
      if ($routeParams.noteId) {
        removeDeletedNoteFromRecentNotes($routeParams.noteId);
      }
      if (!$scope.note) {
        $location.path('/');
      }
      return;
    }

    if (!isNoteForCurrentRoute(note)) {
      console.debug('Ignore NOTE for %s while route expects %s', note.id, $routeParams.noteId);
      return;
    }

    $scope.note = note;
    if ($scope.lockedParagraphId && !_.find(note.paragraphs, {id: $scope.lockedParagraphId})) {
      setLockedParagraphId(null);
    }
    rememberOpenedNote($scope.note);

    $scope.paragraphUrl = $routeParams.paragraphId;
    $scope.asIframe = $routeParams.asIframe;
    if ($scope.paragraphUrl) {
      $scope.note = cleanParagraphExcept($scope.paragraphUrl, $scope.note);
      $scope.$broadcast('$unBindKeyEvent', $scope.$unBindKeyEvent);
      $rootScope.$broadcast('setIframe', $scope.asIframe);
      initializeLookAndFeel();
      return;
    }

    initializeLookAndFeel();

    // 大型笔记性能优化：检测笔记规模，显示提示
    $scope.noteStats = computeNoteStats($scope.note);

    // interpreterBindings 延迟加载，不在打开笔记时阻塞
    // 后台延迟加载一次用于标题默认解释器 tag；打开设置面板时也会加载 (openSetting)
    scheduleInterpreterBindingsForTitle();
    getPermissions();
    // 延迟显示大型笔记提示，避免阻塞首屏渲染
    if ($scope.noteStats.severity !== 'normal') {
      $timeout(function() {
        showLargeNoteToast($scope.noteStats);
      }, 800);
    }
    let isPersonalized = $scope.note.config.personalizedMode;
    isPersonalized = isPersonalized === undefined ? 'false' : isPersonalized;
    $scope.note.config.personalizedMode = isPersonalized;
  });

  $scope.$on('$routeChangeStart', function(event, next, current) {
    if (interpreterBindingsBackgroundTimer) {
      $timeout.cancel(interpreterBindingsBackgroundTimer);
      interpreterBindingsBackgroundTimer = null;
    }
    if (!$scope.note || !$scope.note.paragraphs) {
      return;
    }
    if ($scope.note && $scope.note.paragraphs) {
      $scope.note.paragraphs.map((par) => {
        if ($scope.allowLeave === true) {
          return;
        }
        let paraEl = angular.element('#' + par.id + '_paragraphColumn_main');
        if (!paraEl[0]) {
          return true;
        }
        let thisScope = paraEl.scope();
        if (!thisScope) {
          return true;
        }

        if (thisScope.dirtyText === undefined ||
          thisScope.originalText === undefined ||
          thisScope.dirtyText === thisScope.originalText) {
          return true;
        } else {
          event.preventDefault();
          $scope.showParagraphWarning(next);
        }
      });
    }
  });

  $scope.showParagraphWarning = function(next) {
    if ($scope.paragraphWarningDialog.opened !== true) {
      $scope.paragraphWarningDialog = BootstrapDialog.show({
        closable: false,
        closeByBackdrop: false,
        closeByKeyboard: false,
        title: 'Do you want to leave this site?',
        message: 'Changes that you have made will not be saved.',
        buttons: [{
          label: 'Stay',
          action: function(dialog) {
            dialog.close();
          },
        }, {
          label: 'Leave',
          action: function(dialog) {
            dialog.close();
            let locationToRedirect = next['$$route']['originalPath'];
            Object.keys(next.pathParams).map((key) => {
              locationToRedirect = locationToRedirect.replace(':' + key,
                next.pathParams[key]);
            });
            $scope.allowLeave = true;
            $location.path(locationToRedirect);
          },
        }],
      });
    }
  };

  $scope.$on('saveNoteForms', function(event, data) {
    $scope.note.noteForms = data.formsData.forms;
    $scope.note.noteParams = data.formsData.params;
  });

  $scope.isShowNoteForms = function() {
    if ($scope.note && !_.isEmpty($scope.note.noteForms) && !$scope.paragraphUrl) {
      return true;
    }
    return false;
  };

  $scope.saveNoteForms = function() {
    websocketMsgSrv.saveNoteForms($scope.note);
  };

  $scope.removeNoteForms = function(formName) {
    websocketMsgSrv.removeNoteForms($scope.note, formName);
  };

  // --- Paragraph Navigation Lock ---

  $scope.toggleParagraphLock = function(paragraphId) {
    if ($scope.lockedParagraphId === paragraphId) {
      setLockedParagraphId(null);
    } else {
      setLockedParagraphId(paragraphId);
    }
  };

  $scope.scrollToParagraphById = function(paragraphId) {
    let el = document.querySelector('[data-paragraph-id="' + paragraphId + '"]');
    if (!el) {
      return;
    }

    let rect = el.getBoundingClientRect();
    let absoluteTop = rect.top + window.pageYOffset;
    let headerHeight = 110;
    let viewportHeight = window.innerHeight;
    let centeredTop = absoluteTop - viewportHeight / 2 + rect.height / 2;

    let targetTop;
    if (absoluteTop < viewportHeight) {
      targetTop = Math.max(0, absoluteTop - headerHeight);
    } else {
      targetTop = Math.max(0, centeredTop);
    }

    angular.element('html, body').stop().animate({scrollTop: targetTop}, 500, 'swing', function() {
      if (highlightTimer) {
        clearTimeout(highlightTimer);
      }
      el.classList.add('paragraph-nav-highlight');
      highlightTimer = setTimeout(function() {
        el.classList.remove('paragraph-nav-highlight');
        highlightTimer = null;
      }, 1500);
    });
  };

  // Double-click on dimmed area to unlock
  function onDblClickUnlock(e) {
    if (!$scope.lockedParagraphId) {
      return;
    }
    let lockedEl = document.querySelector('[data-paragraph-id="' + $scope.lockedParagraphId + '"]');
    if (!lockedEl) {
      return;
    }
    if (lockedEl.contains(e.target)) {
      return;
    }
    setLockedParagraphId(null);
    $scope.$evalAsync();
  }
  document.addEventListener('dblclick', onDblClickUnlock);

  // Esc to exit lock mode
  function onEscKey(e) {
    if (e.keyCode === 27 && $scope.lockedParagraphId) {
      setLockedParagraphId(null);
      $scope.$evalAsync();
    }
  }
  document.addEventListener('keydown', onEscKey);

  // Wheel interception in lock mode
  function onWheel(event) {
    if (!$scope.lockedParagraphId) {
      return;
    }
    let lockedEl = document.querySelector('[data-paragraph-id="' + $scope.lockedParagraphId + '"]');
    if (!lockedEl) {
      return;
    }
    if (!lockedEl.contains(event.target)) {
      event.preventDefault();
    }
  }
  document.addEventListener('wheel', onWheel, {passive: false});

  $scope.$on('$destroy', function() {
    angular.element(window).off('beforeunload');
    $scope.killSaveTimer();
    $scope.saveNote();

    document.removeEventListener('click', $scope.focusParagraphOnClick);
    document.removeEventListener('keydown', $scope.keyboardShortcut);
    document.removeEventListener('keydown', onEscKey);
    document.removeEventListener('wheel', onWheel);
    document.removeEventListener('dblclick', onDblClickUnlock);
    $scope.lockedParagraphId = null;
    togglePinnedPageClass(false);
    if (highlightTimer) {
      clearTimeout(highlightTimer);
    }
  });

  $scope.$on('$unBindKeyEvent', function() {
    document.removeEventListener('click', $scope.focusParagraphOnClick);
    document.removeEventListener('keydown', $scope.keyboardShortcut);
  });

  let content = document.getElementById('content');
  if (content && content.id) {
    $scope.addEvent({
      eventID: content.id,
      eventType: 'resize',
      element: window,
      onDestroyElement: content,
      handler: () => {
        const actionbarHeight = document.getElementById('actionbar').lastElementChild.clientHeight;
        angular.element(document.getElementById('content')).css('padding-top', actionbarHeight - 20);
      },
    });
  }
}
