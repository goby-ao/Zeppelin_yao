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

import {SpellResult} from '../../spell';
import {isParagraphRunning, ParagraphStatus} from './paragraph.status';

import moment from 'moment';
import DiffMatchPatch from 'diff-match-patch';

require('moment-duration-format');

const ParagraphExecutor = {
  SPELL: 'SPELL',
  INTERPRETER: 'INTERPRETER',
  NONE: '', /** meaning `DONE` */
};

const CANCEL_UI_TEXT = {
  CANCELLING: '取消中...',
  ABORTED: '已终止',
  SLOW_HINT: '正在向解释器发送取消请求，Hive / Spark 任务可能需要等待 YARN 响应。',
  STUCK_HINT: '取消耗时较长，解释器可能卡住。可重启解释器释放当前任务。',
  STUCK_HINT_TOOLTIP: '会重启当前解释器，所有会话变量都会丢失。',
  PENDING_BLOCK_TOOLTIP: '任务刚提交，5 秒后可终止',
  RESEND_CANCEL: '重新发送终止',
  RESEND_SENT: '已重新发送',
  FORCE_STOP: '强制终止',
  ABORTED_FOOTER: '用户已取消',
  ABORTED_FOOTER_ABORT: '用户已取消',
  ABORTED_FOOTER_FINISHED: '已请求取消，但任务自然完成',
  ABORTED_FOOTER_ERROR: '已请求取消，任务以错误结束',
  ABORTED_FOOTER_TIMEOUT: '取消超时，解释器可能无响应，请手动重启解释器。',
};
const CANCEL_SLOW_HINT_MS = 7500;
const CANCEL_STUCK_HINT_MS = 37500;
const CANCEL_MAX_WAIT_MS = 150000;
const CANCEL_RESEND_FEEDBACK_MS = 800;
const CANCEL_PENDING_BLOCK_MS = 5000;
const CODE_COLLAPSE_LINE_THRESHOLD = 40;

angular.module('zeppelinWebApp').controller('ParagraphCtrl', ParagraphCtrl);

function ParagraphCtrl($scope, $rootScope, $route, $window, $routeParams, $location,
                       $timeout, $compile, $http, $q, websocketMsgSrv,
                       baseUrlSrv, ngToast, noteVarShareService,
                       heliumService) {
  'ngInject';

  let ANGULAR_FUNCTION_OBJECT_NAME_PREFIX = '_Z_ANGULAR_FUNC_';
  let completionListLength = undefined;
  $rootScope.keys = Object.keys;
  $scope.parentNote = null;
  $scope.paragraph = {};
  $scope.paragraph.results = {};
  $scope.paragraph.results.msg = [];
  $scope.originalText = '';
  $scope.editor = null;
  $scope.cursorPosition = null;
  $scope.diffMatchPatch = new DiffMatchPatch();
  $scope.isNoteRunning = false;
  $scope.cancelUiState = 'idle';
  $scope.cancelHintLevel = 0;
  $scope.cancelUiText = CANCEL_UI_TEXT;
  $scope.cancelStartedAt = null;
  $scope.cancelDurationMs = null;
  $scope.cancelFinalStatus = null;
  $scope.cancelResendFeedback = false;
  $scope.cancelPendingBlocked = false;
  $scope.codeCollapsed = false;
  $scope.cancelFinalStatusRef = {
    ABORT: ParagraphStatus.ABORT,
    FINISHED: ParagraphStatus.FINISHED,
    ERROR: ParagraphStatus.ERROR,
    TIMEOUT: 'TIMEOUT',
  };
  $scope.frozenProgress = null;

  let cancelSlowHintTimer = null;
  let cancelStuckHintTimer = null;
  let cancelMaxWaitTimer = null;
  let cancelResendFeedbackTimer = null;
  let cancelPendingBlockTimer = null;
  let codeCollapseInitialized = false;

  // transactional info for spell execution
  $scope.spellTransaction = {
    totalResultCount: 0,
    renderedResultCount: 0,
    propagated: false,
    resultsMsg: [],
    paragraphText: '',
  };

  let searchRanges = [];
  const getCurrentRangeDefault = function() {
    return {id: -1, markerId: -1};
  };
  let currentRange = getCurrentRangeDefault();

  let editorSetting = {};
  // flag that is used to set editor setting on paste percent sign
  let pastePercentSign = false;
  // flag that is used to set editor setting on save interpreter bindings
  let setInterpreterBindings = false;
  let paragraphScope = $rootScope.$new(true, $rootScope);

  // to keep backward compatibility
  $scope.compiledScope = paragraphScope;

  paragraphScope.z = {
    // z.runParagraph('20150213-231621_168813393')
    runParagraph: function(paragraphId) {
      if (paragraphId) {
        let filtered = $scope.parentNote.paragraphs.filter(function(x) {
          return x.id === paragraphId;
        });
        if (filtered.length === 1) {
          let paragraph = filtered[0];
          websocketMsgSrv.runParagraph(paragraph.id, paragraph.title, paragraph.text,
            paragraph.config, paragraph.settings.params);
        } else {
          ngToast.danger({
            content: 'Cannot find a paragraph with id \'' + paragraphId + '\'',
            verticalPosition: 'top',
            dismissOnTimeout: false,
          });
        }
      } else {
        ngToast.danger({
          content: 'Please provide a \'paragraphId\' when calling z.runParagraph(paragraphId)',
          verticalPosition: 'top',
          dismissOnTimeout: false,
        });
      }
    },

    // Example: z.angularBind('my_var', 'Test Value', '20150213-231621_168813393')
    angularBind: function(varName, value, paragraphId) {
      // Only push to server if there paragraphId is defined
      if (paragraphId) {
        websocketMsgSrv.clientBindAngularObject($routeParams.noteId, varName, value, paragraphId);
      } else {
        ngToast.danger({
          content: 'Please provide a \'paragraphId\' when calling ' +
          'z.angularBind(varName, value, \'PUT_HERE_PARAGRAPH_ID\')',
          verticalPosition: 'top',
          dismissOnTimeout: false,
        });
      }
    },

    // Example: z.angularUnBind('my_var', '20150213-231621_168813393')
    angularUnbind: function(varName, paragraphId) {
      // Only push to server if paragraphId is defined
      if (paragraphId) {
        websocketMsgSrv.clientUnbindAngularObject($routeParams.noteId, varName, paragraphId);
      } else {
        ngToast.danger({
          content: 'Please provide a \'paragraphId\' when calling ' +
          'z.angularUnbind(varName, \'PUT_HERE_PARAGRAPH_ID\')',
          verticalPosition: 'top',
          dismissOnTimeout: false});
      }
    },
  };

  let angularObjectRegistry = {};

  // Controller init
  $scope.init = function(newParagraph, note) {
    $scope.paragraph = newParagraph;
    $scope.parentNote = note;
    $scope.originalText = angular.copy(newParagraph.text);
    $scope.chart = {};
    $scope.baseMapOption = ['Streets', 'Satellite', 'Hybrid', 'Topo', 'Gray', 'Oceans', 'Terrain'];
    $scope.colWidthOption = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    $scope.fontSizeOption = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    $scope.paragraphFocused = false;
    if (newParagraph.focus) {
      $scope.paragraphFocused = true;
    }
    if (!$scope.paragraph.config) {
      $scope.paragraph.config = {};
    }

    $scope.isNoteRunning = !!(note && note.hasOwnProperty('info') &&
      note.info.hasOwnProperty('isRunning')
      && note.info.isRunning === true);

    noteVarShareService.put($scope.paragraph.id + '_paragraphScope', paragraphScope);

    initializeDefault($scope.paragraph.config);
  };

  $scope.$on('noteRunningStatus', function(event, status) {
    $scope.isNoteRunning = status;
    $scope.editor.setReadOnly(status);
  });

  const initializeDefault = function(config) {
    let forms = $scope.paragraph.settings.forms;

    if (!config.colWidth) {
      config.colWidth = 12;
    }

    if (!config.fontSize) {
      config.fontSize = 9;
    }

    if (config.lineNumbers === undefined) {
      config.lineNumbers = true;
    }

    if (config.enabled === undefined) {
      config.enabled = true;
    }

    for (let idx in forms) {
      if (forms[idx]) {
        if (forms[idx].options) {
          if (config.runOnSelectionChange === undefined) {
            config.runOnSelectionChange = true;
          }
        }
      }
    }

    if (!config.results) {
      config.results = {};
    }

    if (!config.editorSetting) {
      config.editorSetting = {};
    } else if (config.editorSetting.editOnDblClick) {
      editorSetting.isOutputHidden = config.editorSetting.editOnDblClick;
    }
  };

  const isTabCompletion = function() {
    const completionKey = $scope.paragraph.config.editorSetting.completionKey;
    return completionKey === 'TAB';
  };

  $scope.$on('updateParagraphOutput', function(event, data) {
    if ($scope.paragraph.id === data.paragraphId) {
      if (!$scope.paragraph.results) {
        $scope.paragraph.results = {};
      }
      if (!$scope.paragraph.results.msg) {
        $scope.paragraph.results.msg = [];
      }

      let update = typeof $scope.paragraph.results.msg[data.index] !== 'undefined';

      $scope.paragraph.results.msg[data.index] = {
        data: data.data,
        type: data.type,
      };

      if (update) {
        $rootScope.$broadcast(
          'updateResult',
          $scope.paragraph.results.msg[data.index],
          $scope.paragraph.config.results[data.index],
          $scope.paragraph,
          data.index);
      }
    }
  });

  $scope.getIframeDimensions = function() {
    if ($scope.asIframe) {
      let paragraphid = '#' + $routeParams.paragraphId + '_container';
      let height = angular.element(paragraphid).height();
      return height;
    }
    return 0;
  };

  $scope.$watch($scope.getIframeDimensions, function(newValue, oldValue) {
    if ($scope.asIframe && newValue) {
      let message = {};
      message.height = newValue;
      message.url = $location.$$absUrl;
      $window.parent.postMessage(angular.toJson(message), '*');
    }
  });

  $scope.getEditor = function() {
    return $scope.editor;
  };

  $scope.$watch($scope.getEditor, function(newValue, oldValue) {
    if (!$scope.editor) {
      return;
    }
    if (newValue === null || newValue === undefined) {
      console.log('editor isnt loaded yet, returning');
      return;
    }
    if ($scope.revisionView === true || $scope.isNoteRunning === true) {
      $scope.editor.setReadOnly(true);
    } else {
      $scope.editor.setReadOnly(false);
    }
  });

  let isEmpty = function(object) {
    return !object;
  };

  $scope.isRunning = function(paragraph) {
    return isParagraphRunning(paragraph);
  };

  $scope.canCancelParagraph = function(paragraph) {
    return $scope.cancelUiState === 'idle' && !isPendingCancelBlocked(paragraph);
  };

  function getCodeLineCount(paragraph) {
    const text = paragraph && typeof paragraph.text === 'string' ? paragraph.text : '';
    if (!text) {
      return 1;
    }
    return text.split(/\r\n|\r|\n/).length;
  }

  function resizeEditorSoon() {
    $timeout(function() {
      if ($scope.editor) {
        $scope.editor.resize();
      }
    }, 0);
  }

  $scope.getCodeLineCount = function(paragraph) {
    return getCodeLineCount(paragraph);
  };

  $scope.shouldShowCodeCollapse = function(paragraph) {
    return getCodeLineCount(paragraph) > CODE_COLLAPSE_LINE_THRESHOLD;
  };

  $scope.toggleCodeCollapse = function(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    $scope.codeCollapsed = !$scope.codeCollapsed;
    resizeEditorSoon();
  };

  $scope.$watch(function() {
    return getCodeLineCount($scope.paragraph);
  }, function(lineCount) {
    if (lineCount > CODE_COLLAPSE_LINE_THRESHOLD && !codeCollapseInitialized) {
      $scope.codeCollapsed = true;
      codeCollapseInitialized = true;
      resizeEditorSoon();
    } else if (lineCount <= CODE_COLLAPSE_LINE_THRESHOLD) {
      $scope.codeCollapsed = false;
      codeCollapseInitialized = false;
      resizeEditorSoon();
    }
  });

  $scope.getCancelTooltip = function(paragraph) {
    if (isPendingCancelBlocked(paragraph)) {
      return CANCEL_UI_TEXT.PENDING_BLOCK_TOOLTIP;
    }
    if ($scope.cancelUiState === 'cancelling') {
      return CANCEL_UI_TEXT.CANCELLING;
    }
    return '终止 (Ctrl+' + ($rootScope.isMac ? 'Option' : 'Alt') + '+C)';
  };

  $scope.cancelParagraph = function(paragraph) {
    if ($scope.cancelUiState === 'cancelling' || isPendingCancelBlocked(paragraph)) {
      return;
    }
    console.log('Cancel %o', paragraph.id);
    const frozenProgress = (typeof paragraph.progress === 'number') ? paragraph.progress : $scope.getProgress();

    $scope.cancelUiState = 'cancelling';
    $scope.cancelHintLevel = 0;
    $scope.cancelStartedAt = Date.now();
    $scope.frozenProgress = frozenProgress || 0;

    cancelSlowHintTimer = $timeout(function() {
      if ($scope.cancelUiState === 'cancelling') {
        $scope.cancelHintLevel = 1;
      }
    }, CANCEL_SLOW_HINT_MS);

    cancelStuckHintTimer = $timeout(function() {
      if ($scope.cancelUiState === 'cancelling') {
        $scope.cancelHintLevel = 2;
      }
    }, CANCEL_STUCK_HINT_MS);

    cancelMaxWaitTimer = $timeout(function() {
      if ($scope.cancelUiState === 'cancelling') {
        console.warn('Cancel timed out after 150s for paragraph %o', paragraph.id);
        resetCancelUi('aborted', 'TIMEOUT');
      }
    }, CANCEL_MAX_WAIT_MS);

    websocketMsgSrv.cancelParagraphRun(paragraph.id);
  };

  $scope.resendCancelParagraph = function(paragraph, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if ($scope.cancelUiState !== 'cancelling') {
      return;
    }

    console.warn('Cancel re-issued for paragraph %o', paragraph.id);
    websocketMsgSrv.cancelParagraphRun(paragraph.id);

    $scope.cancelResendFeedback = true;
    if (cancelResendFeedbackTimer) {
      $timeout.cancel(cancelResendFeedbackTimer);
    }
    cancelResendFeedbackTimer = $timeout(function() {
      $scope.cancelResendFeedback = false;
      cancelResendFeedbackTimer = null;
    }, CANCEL_RESEND_FEEDBACK_MS);
  };

  $scope.forceStopParagraph = function(paragraph) {
    if ($scope.cancelHintLevel >= 2) {
      const confirmed = $window.confirm(
        '强制终止会重启当前解释器，所有会话变量都会丢失。\n\n确认继续？'
      );
      if (!confirmed) {
        return;
      }

      const settingId = getInterpreterBindingId(paragraph);
      if (settingId) {
        const noteId = getCurrentNoteId();
        $http.put(baseUrlSrv.getRestApiBase() + '/interpreter/setting/restart/' + settingId, {
          noteId: noteId,
        })
          .then(function() {
            console.log('Interpreter setting %s restart requested for note %s', settingId, noteId);
          })
          .catch(function(err) {
            console.error('Failed to restart interpreter setting', err);
          });
      } else {
        console.warn('Force-stop fallback: no setting id resolvable, resending CANCEL_PARAGRAPH');
        websocketMsgSrv.cancelParagraphRun(paragraph.id);
      }
    } else {
      console.warn('Force-stop re-issued for paragraph %o', paragraph.id);
      websocketMsgSrv.cancelParagraphRun(paragraph.id);
    }
  };

  function ensureInterpreterBindingsLoaded() {
    let scope = $scope;
    while (scope && !scope.interpreterBindings) {
      scope = scope.$parent;
    }
    if (scope && scope.interpreterBindings && scope.interpreterBindings.length > 0) {
      return $q.when();
    }
    // 绑定未加载，触发拉取并等待结果
    let noteId = getCurrentNoteId();
    websocketMsgSrv.getInterpreterBindings(noteId);
    return $q(function(resolve) {
      let deregister = $rootScope.$on('interpreterBindings', function() {
        deregister();
        resolve();
      });
    });
  }

  $scope.restartParagraphInterpreter = function(paragraph) {
    let settingId = getInterpreterBindingId(paragraph);
    let intpName = getInterpreterName(paragraph);
    if (settingId) {
      doRestartInterpreter(settingId, intpName);
      return;
    }
    // 绑定可能未加载，先拉取再重试
    ensureInterpreterBindingsLoaded().then(function() {
      settingId = getInterpreterBindingId(paragraph);
      if (!settingId) {
        BootstrapDialog.alert({
          title: '错误',
          message: '无法解析当前段落的解释器绑定。',
        });
        return;
      }
      doRestartInterpreter(settingId, intpName);
    });
  };

  function getInterpreterName(paragraph) {
    let text = (paragraph && paragraph.text) ? paragraph.text : $scope.getEditorValue();
    let magic = getParagraphMagic(text);
    return magic ? magic.replace(/^%/, '') : 'default';
  }

  function doRestartInterpreter(settingId, intpName) {
    let displayName = _.escape(intpName);
    let msgHtml =
      '<div style="padding: 8px 0;">' +
        '<div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">' +
          '<i class="fa fa-exclamation-triangle" style="color:#d97706; font-size:18px;"></i>' +
          '<span style="font-size:14px; font-weight:500;">即将重启 <code>%' + displayName + '</code> 解释器</span>' +
        '</div>' +
        '<div style="background:#fef3c7; border:1px solid #fde68a; border-radius:6px; padding:10px 12px; margin-bottom:12px; font-size:12px; color:#92400e;">' +
          '<i class="fa fa-info-circle" style="margin-right:4px;"></i>' +
          '重启后首次运行会稍慢，因为需要重新初始化解释器进程。' +
        '</div>' +
        '<div style="font-size:12px; color:#6b7280;">' +
          '<i class="fa fa-lightbulb-o" style="margin-right:4px;"></i>' +
          '建议仅在遇到解释器异常（如连接超时、进程卡死）时重启，日常使用无需操作。' +
        '</div>' +
      '</div>';

    BootstrapDialog.confirm({
      closable: true,
      closeByBackdrop: true,
      closeByKeyboard: true,
      title: '<i class="fa fa-refresh" style="margin-right:6px;"></i>重启解释器',
      message: msgHtml,
      btnOKLabel: '确认重启',
      btnCancelLabel: '取消',
      callback: function(result) {
        if (result) {
          const noteId = getCurrentNoteId();
          $http.put(baseUrlSrv.getRestApiBase() + '/interpreter/setting/restart/' + settingId, {
            noteId: noteId,
          })
            .then(function() {
              ngToast.success({
                content: '%' + intpName + ' 解释器已重启',
                dismissOnTimeout: true,
              });
            })
            .catch(function(err) {
              BootstrapDialog.alert({
                title: '重启失败',
                message: _.escape(err.data ? err.data.message : '未知错误'),
              });
            });
        }
      },
    });
  }

  function resetCancelUi(finalState, finalStatus) {
    if (cancelSlowHintTimer) {
      $timeout.cancel(cancelSlowHintTimer);
      cancelSlowHintTimer = null;
    }
    if (cancelStuckHintTimer) {
      $timeout.cancel(cancelStuckHintTimer);
      cancelStuckHintTimer = null;
    }
    if (cancelMaxWaitTimer) {
      $timeout.cancel(cancelMaxWaitTimer);
      cancelMaxWaitTimer = null;
    }
    if (cancelResendFeedbackTimer) {
      $timeout.cancel(cancelResendFeedbackTimer);
      cancelResendFeedbackTimer = null;
    }
    if (cancelPendingBlockTimer) {
      $timeout.cancel(cancelPendingBlockTimer);
      cancelPendingBlockTimer = null;
    }

    if (finalState === 'aborted' && $scope.cancelStartedAt) {
      $scope.cancelDurationMs = Date.now() - $scope.cancelStartedAt;
      $scope.cancelFinalStatus = finalStatus || ParagraphStatus.ABORT;
    } else {
      $scope.cancelStartedAt = null;
      $scope.cancelDurationMs = null;
      $scope.cancelFinalStatus = null;
    }
    $scope.cancelUiState = finalState;
    $scope.cancelHintLevel = 0;
    $scope.cancelResendFeedback = false;
    $scope.cancelPendingBlocked = false;
    $scope.frozenProgress = null;
  }

  function isPendingCancelBlocked(paragraph) {
    return $scope.cancelPendingBlocked &&
      paragraph &&
      (paragraph.status === ParagraphStatus.PENDING || paragraph.status === ParagraphStatus.RUNNING);
  }

  function startPendingCancelBlock() {
    clearPendingCancelBlock();
    $scope.cancelPendingBlocked = true;
    cancelPendingBlockTimer = $timeout(function() {
      $scope.cancelPendingBlocked = false;
      cancelPendingBlockTimer = null;
    }, CANCEL_PENDING_BLOCK_MS);
  }

  function clearPendingCancelBlock() {
    $scope.cancelPendingBlocked = false;
    if (cancelPendingBlockTimer) {
      $timeout.cancel(cancelPendingBlockTimer);
      cancelPendingBlockTimer = null;
    }
  }

  function applyPendingCancelBlock(newStatus, oldStatus) {
    if ((newStatus === ParagraphStatus.PENDING || newStatus === ParagraphStatus.RUNNING) &&
        oldStatus !== ParagraphStatus.PENDING &&
        oldStatus !== ParagraphStatus.RUNNING) {
      startPendingCancelBlock();
    } else if (newStatus !== ParagraphStatus.PENDING && newStatus !== ParagraphStatus.RUNNING) {
      clearPendingCancelBlock();
    }
  }

  function isTerminalParagraphStatus(status) {
    return status === ParagraphStatus.ABORT ||
      status === ParagraphStatus.FINISHED ||
      status === ParagraphStatus.ERROR;
  }

  function applyCancelUiTransition(newStatus) {
    if (isTerminalParagraphStatus(newStatus)) {
      resetCancelUi('idle', null);
    } else if ($scope.cancelUiState === 'aborted' &&
               (newStatus === ParagraphStatus.RUNNING || newStatus === ParagraphStatus.PENDING)) {
      resetCancelUi('idle', null);
    }
  }

  function getCurrentNoteId() {
    if ($scope.parentNote && $scope.parentNote.id) {
      return $scope.parentNote.id;
    }
    if ($route.current && $route.current.pathParams && $route.current.pathParams.noteId) {
      return $route.current.pathParams.noteId;
    }
    return $routeParams.noteId;
  }

  function getInterpreterBindingId(paragraph) {
    let scope = $scope;
    while (scope && !scope.interpreterBindings) {
      scope = scope.$parent;
    }
    const bindings = (scope && scope.interpreterBindings) || [];
    const paragraphText = (paragraph && paragraph.text) ? paragraph.text : $scope.getEditorValue();
    const magic = getParagraphMagic(paragraphText);
    const name = magic ? magic.replace(/^%/, '') : (bindings[0] ? bindings[0].name : '');
    const baseName = name ? name.split('.')[0] : '';

    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (!binding) {
        continue;
      }
      if (binding.name === name || binding.name === baseName) {
        return binding.id;
      }
    }
    return null;
  }

  $scope.propagateSpellResult = function(paragraphId, paragraphTitle,
                                         paragraphText, paragraphResults,
                                         paragraphStatus, paragraphErrorMessage,
                                         paragraphConfig, paragraphSettingsParam,
                                         paragraphDateStarted, paragraphDateFinished) {
    websocketMsgSrv.paragraphExecutedBySpell(
      paragraphId, paragraphTitle,
      paragraphText, paragraphResults,
      paragraphStatus, paragraphErrorMessage,
      paragraphConfig, paragraphSettingsParam,
      paragraphDateStarted, paragraphDateFinished
    );
  };

  $scope.handleSpellError = function(paragraphText, error,
                                     digestRequired, propagated) {
    const errorMessage = error.stack;
    $scope.paragraph.status = ParagraphStatus.ERROR;
    $scope.paragraph.errorMessage = errorMessage;
    console.error('Failed to execute interpret() in spell\n', error);

    if (!propagated) {
      $scope.paragraph.dateFinished = $scope.getFormattedParagraphTime();
    }

    if (!propagated) {
      $scope.propagateSpellResult(
        $scope.paragraph.id, $scope.paragraph.title,
        paragraphText, [], $scope.paragraph.status, errorMessage,
        $scope.paragraph.config, $scope.paragraph.settings.params,
        $scope.paragraph.dateStarted, $scope.paragraph.dateFinished);
    }
  };

  $scope.prepareSpellTransaction = function(resultsMsg, propagated, paragraphText) {
    $scope.spellTransaction.totalResultCount = resultsMsg.length;
    $scope.spellTransaction.renderedResultCount = 0;
    $scope.spellTransaction.propagated = propagated;
    $scope.spellTransaction.resultsMsg = resultsMsg;
    $scope.spellTransaction.paragraphText = paragraphText;
  };

  /**
   * - update spell transaction count and
   * - check transaction is finished based on the result count
   * @returns {boolean}
   */
  $scope.increaseSpellTransactionResultCount = function() {
    $scope.spellTransaction.renderedResultCount += 1;

    const total = $scope.spellTransaction.totalResultCount;
    const current = $scope.spellTransaction.renderedResultCount;
    return total === current;
  };

  $scope.cleanupSpellTransaction = function() {
    const status = ParagraphStatus.FINISHED;
    $scope.paragraph.executor = ParagraphExecutor.NONE;
    $scope.paragraph.status = status;
    $scope.paragraph.results.code = status;

    const propagated = $scope.spellTransaction.propagated;
    const resultsMsg = $scope.spellTransaction.resultsMsg;
    const paragraphText = $scope.spellTransaction.paragraphText;

    if (!propagated) {
      $scope.paragraph.dateFinished = $scope.getFormattedParagraphTime();
    }

    if (!propagated) {
      const propagable = SpellResult.createPropagable(resultsMsg);
      $scope.propagateSpellResult(
        $scope.paragraph.id, $scope.paragraph.title,
        paragraphText, propagable, status, '',
        $scope.paragraph.config, $scope.paragraph.settings.params,
        $scope.paragraph.dateStarted, $scope.paragraph.dateFinished);
    }
  };

  $scope.runParagraphUsingSpell = function(paragraphText,
                                           magic, digestRequired, propagated) {
    $scope.paragraph.status = 'RUNNING';
    $scope.paragraph.executor = ParagraphExecutor.SPELL;
    $scope.paragraph.results = {};
    $scope.paragraph.errorMessage = '';
    if (digestRequired) {
      $scope.$digest();
    }

    try {
      // remove magic from paragraphText
      const splited = paragraphText.slice(paragraphText.indexOf(magic) + magic.length);
      // remove leading spaces
      const textWithoutMagic = splited.replace(/^\s+/g, '');

      if (!propagated) {
        $scope.paragraph.dateStarted = $scope.getFormattedParagraphTime();
      }

      // handle actual result message in promise
      heliumService.executeSpell(magic, textWithoutMagic)
        .then((resultsMsg) => {
          $scope.prepareSpellTransaction(resultsMsg, propagated, paragraphText);

          $scope.paragraph.results.msg = resultsMsg;
          $scope.paragraph.config.tableHide = false;
        })
        .catch((error) => {
          $scope.handleSpellError(paragraphText, error,
            digestRequired, propagated);
        });
    } catch (error) {
      $scope.handleSpellError(paragraphText, error,
        digestRequired, propagated);
    }
  };

  $scope.runParagraphUsingBackendInterpreter = function(paragraphText) {
    websocketMsgSrv.runParagraph($scope.paragraph.id, $scope.paragraph.title,
      paragraphText, $scope.paragraph.config, $scope.paragraph.settings.params);
  };

  $scope.bindBeforeUnload = function() {
    angular.element(window).off('beforeunload');

    let confirmOnPageExit = function(e) {
      // If we haven't been passed the event get the window.event
      e = e || window.event;
      let message = 'Do you want to reload this site?';

      // For IE6-8 and Firefox prior to version 4
      if (e) {
        e.returnValue = message;
      }
      // For Chrome, Safari, IE8+ and Opera 12+
      return message;
    };
    angular.element(window).on('beforeunload', confirmOnPageExit);
  };

  $scope.unBindBeforeUnload = function() {
    angular.element(window).off('beforeunload');
  };

  $scope.saveParagraph = function(paragraph) {
    const dirtyText = paragraph.text;
    if (dirtyText === undefined || dirtyText === $scope.originalText) {
      return;
    }

    $scope.bindBeforeUnload();

    commitParagraph(paragraph).then(function() {
      $scope.originalText = dirtyText;
      $scope.dirtyText = undefined;
      $scope.unBindBeforeUnload();
    });
  };

  $scope.toggleEnableDisable = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    paragraph.config.enabled = !paragraph.config.enabled;
    commitParagraph(paragraph);
  };

  /**
   * @param paragraphText to be parsed
   * @param digestRequired true if calling `$digest` is required
   * @param propagated true if update request is sent from other client
   */
  $scope.runParagraph = function(paragraphText, digestRequired, propagated) {
    if (!paragraphText || $scope.isRunning($scope.paragraph)) {
      return;
    }

    const magic = SpellResult.extractMagic(paragraphText);

    if (heliumService.getSpellByMagic(magic)) {
      $scope.runParagraphUsingSpell(paragraphText, magic, digestRequired, propagated);
    } else {
      $scope.runParagraphUsingBackendInterpreter(paragraphText);
    }

    $scope.originalText = angular.copy(paragraphText);
    $scope.dirtyText = undefined;

    if ($scope.paragraph.config.editorSetting.editOnDblClick) {
      closeEditorAndOpenTable($scope.paragraph);
    } else if (editorSetting.isOutputHidden &&
      !$scope.paragraph.config.editorSetting.editOnDblClick) {
      // %md/%angular repl make output to be hidden by default after running
      // so should open output if repl changed from %md/%angular to another
      openEditorAndOpenTable($scope.paragraph);
    }
    editorSetting.isOutputHidden = $scope.paragraph.config.editorSetting.editOnDblClick;
  };

  $scope.runParagraphFromShortcut = function(paragraphText) {
    // passing `digestRequired` as true to update view immediately
    // without this, results cannot be rendered in view more than once
    $scope.runParagraph(paragraphText, true, false);
  };

  $scope.runParagraphFromButton = function() {
    if ($scope.isNoteRunning) {
      return;
    }
    // we come here from the view, so we don't need to call `$digest()`
    $scope.runParagraph($scope.getEditorValue(), false, false);
  };

  $scope.runAllToThis = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    $scope.$emit('runAllAbove', paragraph, true);
  };

  $scope.runAllFromThis = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    $scope.$emit('runAllBelowAndCurrent', paragraph, true);
  };

  $scope.runAllFromThisFromShortcut = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    $scope.$emit('runAllBelowAndCurrent', paragraph, false);
  };

  $scope.runAllToThisFromShortcut = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    $scope.$emit('runAllAbove', paragraph, false);
  };

  $scope.turnOnAutoRun = function(paragraph) {
    paragraph.config.runOnSelectionChange = !paragraph.config.runOnSelectionChange;
    commitParagraph(paragraph);
  };

  $scope.moveUp = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    $scope.$emit('moveParagraphUp', paragraph);
  };

  $scope.moveDown = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    $scope.$emit('moveParagraphDown', paragraph);
  };

  $scope.insertNew = function(position) {
    if ($scope.isNoteRunning) {
      return;
    }
    $scope.$emit('insertParagraph', $scope.paragraph.id, position);
  };

  $scope.copyPara = function(position) {
    if ($scope.isNoteRunning) {
      return;
    }
    let editorValue = $scope.getEditorValue();
    if (editorValue) {
      $scope.copyParagraph(editorValue, position);
    }
  };

  $scope.copyParagraph = function(data, position) {
    let newIndex = -1;
    for (let i = 0; i < $scope.note.paragraphs.length; i++) {
      if ($scope.note.paragraphs[i].id === $scope.paragraph.id) {
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

    let config = angular.copy($scope.paragraph.config);
    config.editorHide = false;

    websocketMsgSrv.copyParagraph(newIndex, $scope.paragraph.title, data,
      config, $scope.paragraph.settings.params);
  };

  $scope.removeParagraph = function(paragraph) {
    if ($scope.isNoteRunning) {
      return;
    }
    if ($scope.note.paragraphs.length === 1) {
      BootstrapDialog.alert({
        closable: true,
        message: 'All the paragraphs can\'t be deleted.',
      });
    } else {
      BootstrapDialog.confirm({
        closable: true,
        title: '',
        message: 'Do you want to delete this paragraph?',
        callback: function(result) {
          if (result) {
            console.log('Remove paragraph');
            websocketMsgSrv.removeParagraph(paragraph.id);
            $scope.$emit('moveFocusToNextParagraph', $scope.paragraph.id);
          }
        },
      });
    }
  };

  $scope.clearParagraphOutput = function(paragraph) {
    websocketMsgSrv.clearParagraphOutput(paragraph.id);
  };

  $scope.toggleEditor = function(paragraph) {
    if (paragraph.config.editorHide) {
      $scope.openEditor(paragraph);
    } else {
      $scope.closeEditor(paragraph);
    }
  };

  $scope.closeEditor = function(paragraph) {
    console.log('close the note');
    paragraph.config.editorHide = true;
    commitParagraph(paragraph);
  };

  $scope.openEditor = function(paragraph) {
    console.log('open the note');
    paragraph.config.editorHide = false;
    commitParagraph(paragraph);
  };

  $scope.closeTable = function(paragraph) {
    console.log('close the output');
    paragraph.config.tableHide = true;
    commitParagraph(paragraph);
  };

  $scope.openTable = function(paragraph) {
    console.log('open the output');
    paragraph.config.tableHide = false;
    commitParagraph(paragraph);
  };

  let openEditorAndCloseTable = function(paragraph) {
    manageEditorAndTableState(paragraph, false, true);
  };

  const closeEditorAndOpenTable = function(paragraph) {
    manageEditorAndTableState(paragraph, true, false);
  };

  const openEditorAndOpenTable = function(paragraph) {
    manageEditorAndTableState(paragraph, false, false);
  };

  const manageEditorAndTableState = function(paragraph, hideEditor, hideTable) {
    paragraph.config.editorHide = hideEditor;
    paragraph.config.tableHide = hideTable;
    commitParagraph(paragraph);
  };

  $scope.showTitle = function(paragraph) {
    paragraph.config.title = true;
    commitParagraph(paragraph);
  };

  $scope.hideTitle = function(paragraph) {
    paragraph.config.title = false;
    commitParagraph(paragraph);
  };

  $scope.setTitle = function(paragraph) {
    commitParagraph(paragraph);
  };

  $scope.showLineNumbers = function(paragraph) {
    if ($scope.editor) {
      paragraph.config.lineNumbers = true;
      $scope.editor.renderer.setShowGutter(true);
      commitParagraph(paragraph);
    }
  };

  $scope.hideLineNumbers = function(paragraph) {
    if ($scope.editor) {
      paragraph.config.lineNumbers = false;
      $scope.editor.renderer.setShowGutter(false);
      commitParagraph(paragraph);
    }
  };

  $scope.columnWidthClass = function(n) {
    if ($scope.asIframe) {
      return 'col-md-12';
    } else {
      return 'paragraph-col col-md-' + n;
    }
  };

  $scope.changeColWidth = function(paragraph, width) {
    angular.element('.navbar-right.open').removeClass('open');
    paragraph.config.colWidth = width;
    $scope.$broadcast('paragraphResized', $scope.paragraph.id);
    commitParagraph(paragraph);
  };

  $scope.changeFontSize = function(paragraph, fontSize) {
    angular.element('.navbar-right.open').removeClass('open');
    if ($scope.editor) {
      $scope.editor.setOptions({
        fontSize: fontSize + 'pt',
      });
      autoAdjustEditorHeight($scope.editor);
      paragraph.config.fontSize = fontSize;
      commitParagraph(paragraph);
    }
  };

  $scope.toggleOutput = function(paragraph) {
    paragraph.config.tableHide = !paragraph.config.tableHide;
    commitParagraph(paragraph);
  };

  $scope.aceChanged = function(_, editor) {
    let session = editor.getSession();
    let dirtyText = session.getValue();
    $scope.dirtyText = dirtyText;
    if ($scope.dirtyText !== $scope.originalText) {
      if ($scope.collaborativeMode) {
        $scope.sendPatch();
      } else {
        $scope.startSaveTimer();
      }
    }
    setParagraphMode(session, dirtyText, editor.getCursorPosition());
    if ($scope.cursorPosition) {
      editor.moveCursorToPosition($scope.cursorPosition);
      $scope.cursorPosition = null;
    }
  };

  $scope.sendPatch = function() {
    $scope.originalText = $scope.originalText ? $scope.originalText : '';
    let patch = $scope.diffMatchPatch.patch_make($scope.originalText, $scope.dirtyText).toString();
    $scope.originalText = $scope.dirtyText;
    return websocketMsgSrv.patchParagraph($scope.paragraph.id, $route.current.pathParams.noteId, patch);
  };

  $scope.aceLoaded = function(_editor) {
    let langTools = ace.require('ace/ext/language_tools');
    let Range = ace.require('ace/range').Range;

    _editor.$blockScrolling = Infinity;
    $scope.editor = _editor;
    $scope.editor.on('input', $scope.aceChanged);
    if (_editor.container.id !== '{{paragraph.id}}_editor') {
      $scope.editor.renderer.setShowGutter($scope.paragraph.config.lineNumbers);
      $scope.editor.setShowFoldWidgets(false);
      $scope.editor.setHighlightActiveLine(false);
      $scope.editor.getSession().setUseWrapMode(true);
      $scope.editor.setTheme('ace/theme/chrome');
      $scope.editor.setReadOnly($scope.isRunning($scope.paragraph) || $scope.isNoteRunning);
      $scope.editor.setHighlightActiveLine($scope.paragraphFocused);

      if ($scope.paragraphFocused) {
        let prefix = getParagraphMagic($scope.paragraph.text);
        let paragraphText = $scope.paragraph.text ? $scope.paragraph.text.trim() : '';

        $scope.editor.focus();
        $scope.goToEnd($scope.editor);
        if (prefix === paragraphText) {
          $timeout(function() {
            $scope.editor.gotoLine(2, 0);
          }, 0);
        }
      }

      autoAdjustEditorHeight(_editor);

      let adjustEditorListener = () => autoAdjustEditorHeight(_editor);
      angular.element(window).resize(adjustEditorListener);
      $scope.$on('$destroy', () => angular.element(window).unbind('resize', adjustEditorListener));

      if (navigator.appVersion.indexOf('Mac') !== -1) {
        $scope.editor.setKeyboardHandler('ace/keyboard/emacs');
        $rootScope.isMac = true;
      } else if (navigator.appVersion.indexOf('Win') !== -1 ||
        navigator.appVersion.indexOf('X11') !== -1 ||
        navigator.appVersion.indexOf('Linux') !== -1) {
        $rootScope.isMac = false;
        // not applying emacs key binding while the binding override Ctrl-v. default behavior of paste text on windows.
      }

      $scope.$on('completionListLength', function(event, data) {
        completionListLength = data;
      });

      $scope.$on('callCompletion', function(event, data) {
        if($scope.paragraphFocused) {
          websocketMsgSrv.completion($scope.paragraph.id, data.buf, data.pos);
        }
      });

      let sqlKeywords = [
        // ===== 基础 SQL 语法 =====
        'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
        'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'TRUNCATE',
        'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA',
        'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'OUTER JOIN',
        'LEFT SEMI JOIN', 'LEFT ANTI JOIN',
        'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
        'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
        'DISTINCT', 'ALL', 'ANY', 'SOME', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
        'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'COALESCE', 'NULLIF', 'CAST', 'CONVERT',
        'ASC', 'DESC', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'CONSTRAINT', 'DEFAULT',
        'WITH', 'RECURSIVE', 'OVER', 'PARTITION BY', 'ROW', 'ROWS', 'PRECEDING', 'FOLLOWING',
        'UNBOUNDED', 'CURRENT ROW', 'RANGE', 'GROUPS',
        'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'USE', 'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK',
        'BEGIN', 'START TRANSACTION', 'SAVEPOINT', 'BOOLEAN', 'TRUE', 'FALSE',

        // ===== Hive 数据类型 =====
        'STRING', 'INT', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'DATE', 'TIMESTAMP',
        'VARCHAR', 'CHAR', 'TEXT', 'BLOB', 'BINARY', 'BOOLEAN',
        'ARRAY', 'MAP', 'STRUCT', 'UNIONTYPE',
        'TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL',
        'TIMESTAMP', 'DATE', 'INTERVAL', 'BINARY',

        // ===== Hive DDL - 表操作 =====
        'CREATE TABLE', 'CREATE EXTERNAL TABLE', 'CREATE TEMPORARY TABLE', 'CREATE MANAGED TABLE',
        'DROP TABLE', 'DROP TABLE IF EXISTS',
        'ALTER TABLE', 'ALTER TABLE RENAME TO', 'ALTER TABLE SET TBLPROPERTIES',
        'ALTER TABLE ADD COLUMNS', 'ALTER TABLE REPLACE COLUMNS', 'ALTER TABLE CHANGE COLUMN',
        'ALTER TABLE DROP COLUMN', 'ALTER TABLE SET SERDE', 'ALTER TABLE SET SERDEPROPERTIES',
        'TRUNCATE TABLE', 'DESCRIBE TABLE', 'DESCRIBE FORMATTED', 'DESCRIBE EXTENDED',
        'DESCRIBE DATABASE', 'DESCRIBE FUNCTION',
        'SHOW TABLES', 'SHOW TABLES LIKE', 'SHOW TABLE EXTENDED',
        'SHOW CREATE TABLE', 'SHOW COLUMNS', 'SHOW PARTITIONS', 'SHOW TABLE PROPERTIES',
        'MSCK REPAIR TABLE', 'MSCK REPAIR TABLE ADD PARTITIONS', 'MSCK REPAIR TABLE DROP PARTITIONS',

        // ===== Hive DDL - 数据库操作 =====
        'CREATE DATABASE', 'CREATE DATABASE IF NOT EXISTS',
        'DROP DATABASE', 'DROP DATABASE IF EXISTS',
        'ALTER DATABASE', 'ALTER DATABASE SET DBPROPERTIES',
        'SHOW DATABASES', 'SHOW DATABASES LIKE', 'USE DATABASE',

        // ===== Hive DDL - 视图操作 =====
        'CREATE VIEW', 'CREATE VIEW IF NOT EXISTS', 'CREATE TEMPORARY VIEW',
        'DROP VIEW', 'DROP VIEW IF EXISTS', 'ALTER VIEW',
        'SHOW VIEWS', 'SHOW VIEWS LIKE',

        // ===== Hive DDL - 索引操作 =====
        'CREATE INDEX', 'DROP INDEX', 'ALTER INDEX', 'SHOW INDEX',

        // ===== Hive DDL - 函数操作 =====
        'CREATE FUNCTION', 'CREATE TEMPORARY FUNCTION', 'CREATE TEMPORARY MACRO',
        'DROP FUNCTION', 'DROP TEMPORARY FUNCTION', 'DROP TEMPORARY MACRO',
        'SHOW FUNCTIONS', 'SHOW FUNCTIONS LIKE', 'DESCRIBE FUNCTION', 'DESCRIBE FUNCTION EXTENDED',

        // ===== Hive DDL - 分区操作 =====
        'PARTITIONED BY', 'PARTITIONED BY (', 'ADD PARTITION', 'DROP PARTITION',
        'ALTER TABLE ADD PARTITION', 'ALTER TABLE DROP PARTITION',
        'ALTER TABLE RENAME PARTITION', 'ALTER TABLE EXCHANGE PARTITION',
        'ALTER TABLE RECOVER PARTITIONS',

        // ===== Hive DDL - 分桶操作 =====
        'CLUSTERED BY', 'SORTED BY', 'INTO BUCKETS', 'BUCKET',

        // ===== Hive DDL - 存储格式 =====
        'STORED AS', 'STORED BY', 'STORED AS TEXTFILE', 'STORED AS ORC', 'STORED AS PARQUET',
        'STORED AS AVRO', 'STORED AS SEQUENCEFILE', 'STORED AS RCFILE', 'STORED AS JSONFILE',
        'STORED AS INPUTFORMAT', 'STORED AS OUTPUTFORMAT',
        'INPUTFORMAT', 'OUTPUTFORMAT',

        // ===== Hive DDL - 行格式和序列化 =====
        'ROW FORMAT', 'ROW FORMAT DELIMITED', 'ROW FORMAT SERDE',
        'FIELDS TERMINATED BY', 'FIELDS ESCAPED BY',
        'LINES TERMINATED BY', 'MAP KEYS TERMINATED BY',
        'COLLECTION ITEMS TERMINATED BY', 'NULL DEFINED AS',
        'SERDE', 'WITH SERDEPROPERTIES', 'SERDEPROPERTIES',

        // ===== Hive DDL - 表属性 =====
        'LOCATION', 'TBLPROPERTIES', 'TBLPROPERTIES (', 'COMMENT',

        // ===== Hive DDL - 物化视图 =====
        'CREATE MATERIALIZED VIEW', 'DROP MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW',
        'SHOW MATERIALIZED VIEWS', 'REBUILD',

        // ===== Hive DML - 数据操作 =====
        'INSERT INTO', 'INSERT OVERWRITE', 'INSERT OVERWRITE TABLE', 'INSERT INTO TABLE',
        'INSERT OVERWRITE DIRECTORY', 'INSERT INTO DIRECTORY',
        'LOAD DATA', 'LOAD DATA LOCAL', 'LOAD DATA LOCAL INPATH', 'LOAD DATA INPATH',
        'LOAD DATA OVERWRITE', 'INTO TABLE', 'OVERWRITE TABLE',

        // ===== Hive DML - 查询语法 =====
        'SORT BY', 'DISTRIBUTE BY', 'CLUSTER BY',
        'LATERAL VIEW', 'LATERAL VIEW OUTER', 'LATERAL TABLE',
        'TABLESAMPLE', 'TABLESAMPLE (BUCKET', 'TABLESAMPLE (PERCENT',
        'WITH', 'CTE', 'RECURSIVE',

        // ===== Hive DML - 事务操作 (ACID) =====
        'UPDATE', 'DELETE FROM', 'MERGE INTO', 'USING',
        'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK',
        'INSERT', 'VALUES',

        // ===== Hive DML - 导入导出 =====
        'EXPORT TABLE', 'IMPORT TABLE', 'EXPORT DATABASE', 'IMPORT DATABASE',

        // ===== Hive 查询提示 =====
        '/*+ MAPJOIN', '/*+ BROADCASTJOIN', '/*+ STREAMTABLE',
        '/*+ BUCKET', '/*+ SHUFFLE', '/*+ NOSHUFFLE',
        '/*+ MERGE', '/*+ NO_MERGE', '/*+ INFER',
        'SET', 'SET hive.', 'SET mapreduce.', 'SET yarn.',

        // ===== Hive 窗口函数 =====
        'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
        'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE',
        'CUME_DIST', 'PERCENT_RANK', 'PERCENTILE_CONT', 'PERCENTILE_DISC',

        // ===== Hive 聚合函数 =====
        'COLLECT_SET', 'COLLECT_LIST', 'CONCAT_WS', 'GROUPING', 'GROUPING__ID',
        'HISTOGRAM_NUMERIC', 'PERCENTILE', 'PERCENTILE_APPROX',
        'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP',
        'CORR', 'COVARIANCE', 'COVARIANCE_POP', 'COVARIANCE_SAMP',
        'REGR_INTERCEPT', 'REGR_SLOPE', 'REGR_COUNT', 'REGR_R2',
        'BIT_AND', 'BIT_OR', 'BIT_XOR',

        // ===== Hive 日期函数 =====
        'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'DATE_FORMAT',
        'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
        'DAYOFWEEK', 'DAYOFYEAR', 'WEEKOFYEAR', 'QUARTER',
        'FROM_UNIXTIME', 'UNIX_TIMESTAMP', 'TO_DATE', 'TO_UTC_TIMESTAMP', 'FROM_UTC_TIMESTAMP',
        'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'NOW', 'CURRENT_USER',
        'ADD_MONTHS', 'LAST_DAY', 'NEXT_DAY', 'TRUNC', 'MONTHS_BETWEEN',
        'MAKE_DATE', 'MAKE_TIMESTAMP', 'DATE', 'TIMESTAMP',

        // ===== Hive 字符串函数 =====
        'CONCAT', 'CONCAT_WS', 'SUBSTR', 'SUBSTRING', 'LENGTH', 'CHAR_LENGTH',
        'UPPER', 'LOWER', 'UCASE', 'LCASE', 'TRIM', 'LTRIM', 'RTRIM',
        'LPAD', 'RPAD', 'REPEAT', 'REVERSE', 'SPACE', 'SPLIT',
        'INSTR', 'LOCATE', 'POSITION', 'STR_TO_MAP',
        'REGEXP_EXTRACT', 'REGEXP_REPLACE', 'REGEXP',
        'LIKE', 'RLIKE', 'NOT LIKE', 'NOT RLIKE',
        'ENCODE', 'DECODE', 'BASE64', 'UNBASE64',
        'SENTENCES', 'NGRAMS', 'CONTEXT_NGRAMS',
        'LEVENSHTEIN', 'HAMMING_DISTANCE',

        // ===== Hive 数学函数 =====
        'ROUND', 'FLOOR', 'CEIL', 'CEILING', 'ABS', 'MOD', 'POWER', 'SQRT',
        'LOG', 'LOG2', 'LOG10', 'LN', 'EXP', 'PMOD',
        'RAND', 'RAND', 'SIGN', 'POSITIVE', 'NEGATIVE',
        'E', 'PI', 'HEX', 'UNHEX', 'CONV',
        'FACTORIAL', 'CBRT', 'DEGREES', 'RADIANS',

        // ===== Hive 类型转换函数 =====
        'CAST', 'CONVERT', 'BINARY',
        'TYPEOF',

        // ===== Hive 条件函数 =====
        'IF', 'IFNULL', 'NVL', 'NVL2', 'DECODE', 'CASE WHEN',
        'COALESCE', 'NULLIF', 'ASSERT_TRUE',
        'ISNULL', 'ISNOTNULL',

        // ===== Hive 集合函数 =====
        'SIZE', 'MAP_KEYS', 'MAP_VALUES', 'ARRAY_CONTAINS',
        'SORT_ARRAY', 'ARRAY_SORT', 'ARRAY_JOIN',
        'ARRAY', 'MAP', 'STRUCT', 'NAMED_STRUCT',
        'CREATE_UNION',

        // ===== Hive JSON 函数 =====
        'GET_JSON_OBJECT', 'JSON_TUPLE', 'TO_JSON', 'FROM_JSON',
        'JSON_ARRAY', 'JSON_OBJECT', 'JSON_ARRAY_CONTAINS',

        // ===== Hive URL 函数 =====
        'PARSE_URL', 'PARSE_URL_TUPLE', 'URL_EXTRACT_PARAMETER',

        // ===== Hive 表生成函数 =====
        'EXPLODE', 'POSEXPLODE', 'INLINE', 'STACK',
        'JSON_TUPLE', 'PARSE_URL_TUPLE',
        'LATERAL VIEW', 'LATERAL VIEW OUTER',

        // ===== Hive 其他函数 =====
        'REFLECT', 'JAVA_METHOD', 'XPATH', 'XPATH_BOOLEAN',
        'XPATH_FLOAT', 'XPATH_DOUBLE', 'XPATH_NUMBER', 'XPATH_SHORT',
        'XPATH_INT', 'XPATH_LONG', 'XPATH_STRING',
        'MASK', 'MASK_FIRST_N', 'MASK_LAST_N', 'MASK_HASH',
        'CRC32', 'MD5', 'SHA1', 'SHA2', 'AES_ENCRYPT', 'AES_DECRYPT',
        'VERSION', 'BUILD_USER', 'CURRENT_DATABASE',

        // ===== Hive 索引操作 =====
        'CREATE INDEX', 'DROP INDEX', 'ALTER INDEX', 'SHOW INDEX',
        'WITH DEFERRED REBUILD',

        // ===== Hive 权限操作 =====
        'GRANT', 'REVOKE', 'SHOW GRANT', 'SHOW ROLE GRANT',
        'CREATE ROLE', 'DROP ROLE', 'SHOW ROLES', 'SET ROLE',

        // ===== Hive 资源操作 =====
        'ADD JAR', 'ADD FILE', 'ADD ARCHIVE',
        'LIST JAR', 'LIST FILE', 'LIST ARCHIVE',
        'DELETE JAR', 'DELETE FILE', 'DELETE ARCHIVE',
        'CREATE TEMPORARY FUNCTION',

        // ===== Hive 锁操作 =====
        'LOCK TABLE', 'UNLOCK TABLE', 'SHOW LOCKS', 'SHOW COMPACTIONS',

        // ===== Hive 统计信息 =====
        'ANALYZE TABLE', 'ANALYZE TABLE COMPUTE STATISTICS',
        'ANALYZE TABLE COMPUTE STATISTICS FOR COLUMNS',
        'ANALYZE TABLE COMPUTE STATISTICS FOR ALL COLUMNS',
        'SHOW TABLE STATS', 'SHOW COLUMN STATS',

        // ===== Hive 事务管理 =====
        'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK',
        'SHOW TRANSACTIONS', 'ABORT TRANSACTION',

        // ===== Hive EXPLAIN =====
        'EXPLAIN', 'EXPLAIN EXTENDED', 'EXPLAIN FORMATTED', 'EXPLAIN DEPENDENCY',
        'EXPLAIN AUTHORIZATION', 'EXPLAIN ANALYZE',

        // ===== Hive 常量 =====
        'TRUE', 'FALSE', 'NULL', 'UNKNOWN',

        // ===== 其他 SQL 关键字 =====
        'PIVOT', 'UNPIVOT', 'FETCH', 'NEXT', 'ONLY',
        'WINDOW', 'TIES', 'NO OTHERS',
        'IF', 'IFNULL', 'NVL', 'DECODE', 'GREATEST', 'LEAST',
        'CONCAT', 'SUBSTR', 'SUBSTRING', 'LENGTH', 'TRIM', 'UPPER', 'LOWER', 'REPLACE',
        'ROUND', 'FLOOR', 'CEIL', 'ABS', 'MOD', 'POWER', 'SQRT', 'LOG', 'LN', 'EXP',
        'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'DATE_FORMAT', 'YEAR', 'MONTH', 'DAY', 'HOUR',
        'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
        'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
        'COLLECT_SET', 'COLLECT_LIST', 'EXPLODE', 'POSEXPLODE', 'LATERAL VIEW',
        'JSON_TUPLE', 'GET_JSON_OBJECT', 'PARSE_URL', 'REGEXP_EXTRACT', 'REGEXP_REPLACE',
        'INSTR', 'LOCATE', 'LPAD', 'RPAD', 'REPEAT', 'REVERSE', 'SPACE', 'SPLIT',
        'TO_DATE', 'TO_TIMESTAMP', 'FROM_UTC_TIMESTAMP', 'TO_UTC_TIMESTAMP',
        'PERCENTILE', 'PERCENTILE_APPROX', 'STDDEV', 'VARIANCE', 'CORR', 'COVARIANCE',
        'INSERT OVERWRITE', 'INSERT INTO', 'LOAD DATA', 'PARTITION',
        'BUCKET', 'CLUSTERED BY', 'SORTED BY', 'INTO BUCKETS',
        'STORED AS', 'ROW FORMAT', 'FIELDS TERMINATED BY', 'LINES TERMINATED BY',
        'SERDE', 'WITH SERDEPROPERTIES', 'LOCATION', 'TBLPROPERTIES',
        'EXTERNAL TABLE', 'MANAGED TABLE', 'TEMPORARY TABLE', 'MATERIALIZED VIEW',
      ];

      let shellKeywords = [
        'cd', 'ls', 'pwd', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'chown', 'ln',
        'cat', 'head', 'tail', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'paste',
        'grep', 'egrep', 'fgrep', 'sed', 'awk', 'find', 'xargs',
        'echo', 'printf', 'read', 'test', 'exit', 'return', 'source', 'export',
        'alias', 'unalias', 'history', 'jobs', 'bg', 'fg', 'kill', 'wait', 'trap',
        'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
        'case', 'esac', 'function', 'select', 'in', 'time', 'nohup',
        'ssh', 'scp', 'rsync', 'curl', 'wget', 'ping', 'telnet', 'netstat',
        'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'bzip2',
        'ps', 'top', 'df', 'du', 'free', 'uptime', 'whoami', 'who', 'id',
        'date', 'cal', 'bc', 'expr', 'basename', 'dirname', 'realpath',
        '&&', '||', '|', '>>', '2>&1', '/dev/null',
        'true', 'false', 'yes',
        // Hadoop / HDFS
        'hdfs', 'hadoop', 'hdfs dfs', 'hdfs dfs -ls', 'hdfs dfs -cat', 'hdfs dfs -put',
        'hdfs dfs -get', 'hdfs dfs -cp', 'hdfs dfs -mv', 'hdfs dfs -rm', 'hdfs dfs -rm -r',
        'hdfs dfs -mkdir', 'hdfs dfs -mkdir -p', 'hdfs dfs -touchz', 'hdfs dfs -stat',
        'hdfs dfs -du', 'hdfs dfs -du -s', 'hdfs dfs -du -h', 'hdfs dfs -count',
        'hdfs dfs -chmod', 'hdfs dfs -chown', 'hdfs dfs -expunge',
        'hdfs dfs -getmerge', 'hdfs dfs -setrep', 'hdfs dfs -test',
        'hdfs dfs -text', 'hdfs dfs -tail', 'hdfs dfs -checksum',
        'hadoop fs', 'hadoop fs -ls', 'hadoop fs -cat', 'hadoop fs -put', 'hadoop fs -get',
        'hadoop fs -rm', 'hadoop fs -rm -r', 'hadoop fs -mkdir',
        'hadoop fs -du', 'hadoop fs -du -s', 'hadoop fs -count',
        'hadoop jar', 'hadoop classpath', 'hadoop version',
        'hdfs dfsadmin', 'hdfs dfsadmin -report', 'hdfs dfsadmin -safemode',
        'yarn', 'yarn application', 'yarn application -list', 'yarn application -kill',
        'yarn logs', 'mapred job', 'mapred job -list', 'mapred job -kill',
        'beeline', 'hive', 'hive -e', 'hive -f', 'spark-submit', 'spark-shell', 'pyspark',
      ];

      let localCompleter = {
        getCompletions: function(editor, session, pos, prefix, callback) {
          if (!prefix) {
            return callback(null, []);
          }
          let mode = session.getMode().$id || '';
          let isSql = mode.indexOf('sql') !== -1 || mode.indexOf('hive') !== -1 ||
                      mode.indexOf('pgsql') !== -1 || mode.indexOf('mysql') !== -1;
          let isShell = mode.indexOf('sh') !== -1 || mode.indexOf('bash') !== -1 ||
                        mode.indexOf('shell') !== -1;

          if (!isSql && !isShell) {
            return callback(null, []);
          }

          let keywords = isSql ? sqlKeywords : shellKeywords;
          let lowerPrefix = prefix.toLowerCase();
          let results = keywords
            .filter(function(kw) {
              return kw.toLowerCase().indexOf(lowerPrefix) === 0;
            })
            .map(function(kw) {
              return {value: kw, meta: isSql ? 'keyword' : 'command', score: 100};
            });
          callback(null, results);
        },
      };

      let remoteCompleter = {
        getCompletions: function(editor, session, pos, prefix, callback) {
          let langTools = ace.require('ace/ext/language_tools');
          let defaultKeywords = new Set();

          // eslint-disable-next-line handle-callback-err
          let getDefaultKeywords = function(err, completions) {
            if (completions !== undefined) {
              completions.forEach(function(c) {
                defaultKeywords.add(c.value);
              });
            }
          };
          if (langTools.keyWordCompleter !== undefined) {
            langTools.keyWordCompleter.getCompletions(editor, session, pos, prefix, getDefaultKeywords);
          }

          if (!editor.isFocused()) {
            return;
          }

          pos = session.getTextRange(new Range(0, 0, pos.row, pos.column)).length;
          let buf = session.getValue();

          $rootScope.$broadcast('callCompletion', {buf: buf, pos: pos});

          $scope.$on('completionList', function(event, data) {
            let computeCaption = function(value, meta) {
              let metaLength = meta !== undefined ? meta.length : 0;
              let length = 42;
              let whitespaceLength = 3;
              let ellipses = '...';
              let maxLengthCaption = length - metaLength - whitespaceLength - ellipses.length;
              if (value !== undefined && value.length > maxLengthCaption) {
                return value.substr(0, maxLengthCaption) + ellipses;
              }
              return value;
            };
            if (data.completions) {
              let completions = [];
              for (let c in data.completions) {
                if (data.completions.hasOwnProperty(c)) {
                  let v = data.completions[c];
                  if (v.meta !== undefined && v.meta === 'keyword' && defaultKeywords.has(v.value.trim())) {
                    continue;
                  }
                  completions.push({
                    name: v.name,
                    value: v.value,
                    meta: v.meta,
                    caption: computeCaption(v.name, v.meta),
                    score: 300,
                  });
                }
              }
              $rootScope.$broadcast('completionListLength', completions.length);
              callback(null, completions);
            }
          });
        },
      };

      langTools.setCompleters([remoteCompleter, localCompleter, langTools.keyWordCompleter, langTools.snippetCompleter,
        langTools.textCompleter]);

      $scope.editor.setOptions({
        fontSize: $scope.paragraph.config.fontSize + 'pt',
        enableBasicAutocompletion: true,
        enableSnippets: false,
        enableLiveAutocompletion: true,
      });

      $scope.editor.on('focus', function() {
        handleFocus(true);
      });

      $scope.editor.on('blur', function() {
        handleFocus(false);
        $scope.saveParagraph($scope.paragraph);
      });

      $scope.editor.on('paste', function(e) {
        if (e.text.indexOf('%') === 0) {
          pastePercentSign = true;
        }
      });

      $scope.editor.getSession().on('change', function(e, editSession) {
        autoAdjustEditorHeight(_editor);
      });

      setParagraphMode($scope.editor.getSession(), $scope.editor.getSession().getValue());

      // autocomplete on '.'
      /*
       $scope.editor.commands.on("afterExec", function(e, t) {
       if (e.command.name == "insertstring" && e.args == "." ) {
       var all = e.editor.completers;
       //e.editor.completers = [remoteCompleter];
       e.editor.execCommand("startAutocomplete");
       //e.editor.completers = all;
       }
       });
       */

      // remove binding
      $scope.editor.commands.removeCommand('showSettingsMenu');
      $scope.editor.commands.removeCommand('find');
      $scope.editor.commands.removeCommand('replace');

      let isOption = $rootScope.isMac ? 'option' : 'alt';

      $scope.editor.commands.bindKey('ctrl-' + isOption + '-n.', null);
      $scope.editor.commands.bindKey('ctrl-' + isOption + '-l', null);
      $scope.editor.commands.bindKey('ctrl-' + isOption + '-w', null);
      $scope.editor.commands.bindKey('ctrl-' + isOption + '-a', null);
      $scope.editor.commands.bindKey('ctrl-' + isOption + '-k', null);
      $scope.editor.commands.bindKey('ctrl-' + isOption + '-e', null);
      $scope.editor.commands.bindKey('ctrl-' + isOption + '-t', null);
      $scope.editor.commands.bindKey('ctrl-space', null);

      if ($rootScope.isMac) {
        $scope.editor.commands.bindKey('command-l', null);
      } else {
        $scope.editor.commands.bindKey('ctrl-l', null);
      }

      // autocomplete on 'ctrl+.'
      $scope.editor.commands.bindKey('ctrl-.', 'startAutocomplete');

      // Show autocomplete on tab
      $scope.editor.commands.addCommand({
        name: 'tabAutocomplete',
        bindKey: {
          win: 'tab',
          mac: 'tab',
          sender: 'editor|cli',
        },
        exec: function(env, args, request) {
          let iCursor = $scope.editor.getCursorPosition();
          let currentLine = $scope.editor.session.getLine(iCursor.row);
          let isAllTabs = currentLine.substring(0, iCursor.column - 1).split('').every(function(char) {
            return (char === '\t' || char === ' ');
          });

          // If user has pressed tab on first line char or if isTabCompletion() is false, keep existing behavior
          // If user has pressed tab anywhere in between and editor mode is not %md, show autocomplete
          if (!isAllTabs && iCursor.column && isTabCompletion()) {
            $scope.editor.execCommand('startAutocomplete');
          } else {
            ace.config.loadModule('ace/ext/language_tools', function() {
              $scope.editor.indent();
            });
          }
        },
      });

      let keyBindingEditorFocusAction = function(scrollValue) {
        let numRows = $scope.editor.getSession().getLength();
        let currentRow = $scope.editor.getCursorPosition().row;
        if (currentRow === 0 && scrollValue <= 0) {
          // move focus to previous paragraph
          $scope.$emit('moveFocusToPreviousParagraph', $scope.paragraph.id);
        } else if (currentRow === numRows - 1 && scrollValue >= 0) {
          $scope.$emit('moveFocusToNextParagraph', $scope.paragraph.id);
        } else {
          $scope.scrollToCursor($scope.paragraph.id, scrollValue);
        }
      };

      // handle cursor moves
      $scope.editor.keyBinding.origOnCommandKey = $scope.editor.keyBinding.onCommandKey;
      $scope.editor.keyBinding.onCommandKey = function(e, hashId, keyCode) {
        if ($scope.editor.completer && $scope.editor.completer.activated) { // if autocompleter is active
        } else {
          // fix ace editor focus issue in chrome (textarea element goes to top: -1000px after focused by cursor move)
          if (parseInt(angular.element('#' + $scope.paragraph.id + '_editor > textarea')
              .css('top').replace('px', '')) < 0) {
            let position = $scope.editor.getCursorPosition();
            let cursorPos = $scope.editor.renderer.$cursorLayer.getPixelPosition(position, true);
            angular.element('#' + $scope.paragraph.id + '_editor > textarea').css('top', cursorPos.top);
          }

          let ROW_UP = -1;
          let ROW_DOWN = 1;

          switch (keyCode) {
            case 38:
              if (!e.shiftKey) {
                keyBindingEditorFocusAction(ROW_UP);
              }
              break;
            case 80:
              if (e.ctrlKey && !e.altKey) {
                keyBindingEditorFocusAction(ROW_UP);
              }
              break;
            case 40:
              if (!e.shiftKey) {
                keyBindingEditorFocusAction(ROW_DOWN);
              }
              break;
            case 78:
              if (e.ctrlKey && !e.altKey) {
                keyBindingEditorFocusAction(ROW_DOWN);
              }
              break;
          }
        }
        this.origOnCommandKey(e, hashId, keyCode);
      };
    }
  };

  // ref: https://github.com/ajaxorg/ace/blob/5021d0193d9f2bba5a978d0b1d7a4f73d18ce713/lib/ace/autocomplete.js#L454
  const completionSupportWithoutBackend = function(str) {
    let matches;
    if (str.length > this.filterText && str.lastIndexOf(
        this.filterText, 0) === 0) {
      matches = this.filtered;
    } else {
      matches = this.all;
    }

    this.filterText = str;
    matches = this.filterCompletions(matches, this.filterText);
    matches = matches.sort(function(a, b) {
      return b.exactMatch - a.exactMatch || b.score - a.score;
    });
    let prev = null;

    matches = matches.filter(function(item) {
      let caption = item.snippet || item.caption || item.value;
      if (caption === prev) {
        return false;
      }
      prev = caption;
      return true;
    });
    this.filtered = matches;
  };

  const completionSupportWithBackend = function(str) {
    let matches;
    if (str.length > this.filterText && str.lastIndexOf(
        this.filterText, 0) === 0) {
      matches = this.filtered;
    } else {
      matches = this.all;
    }
    this.filterText = str;
    matches = this.filterCompletions(matches, this.filterText);
    matches = matches.sort(function(a, b) {
      return b.exactMatch - a.exactMatch || b.score - a.score;
    });
    let prev = null;

    matches = matches.filter(function(item) {
      if (!_.isEmpty(item.meta)) {
        if (completionListLength !== 0) {
          return false;
        }
      }
      let caption = item.snippet || item.caption || item.value;
      if (caption === prev) {
        return false;
      }
      prev = caption;
      return true;
    });
    this.filtered = matches;
    completionListLength = undefined;
  };

  const handleFocus = function(focused, isDigestPass) {
    $scope.paragraphFocused = focused;
    if (focused) {
      let filteredList = ace.require('ace/autocomplete').FilteredList;
      if ($scope.paragraph.config.editorSetting.completionSupport) {
        filteredList.prototype.setFilter = completionSupportWithBackend;
      } else {
        filteredList.prototype.setFilter = completionSupportWithoutBackend;
      }
    }

    if ($scope.editor) {
      $scope.editor.setHighlightActiveLine(focused);
    }

    if (isDigestPass === false || isDigestPass === undefined) {
      // Protect against error in case digest is already running
      $timeout(function() {
        // Apply changes since they come from 3rd party library
        $scope.$digest();
      });
    }
  };

  let getEditorSetting = function(paragraph, pragraphText) {
    let deferred = $q.defer();
    if (!$scope.revisionView) {
      websocketMsgSrv.getEditorSetting(paragraph.id, pragraphText);
      $timeout(
        $scope.$on('editorSetting', function(event, data) {
          if (paragraph.id === data.paragraphId) {
            deferred.resolve(data);
          }
        }
      ), 1000);
    }
    return deferred.promise;
  };

  let setEditorLanguage = function(session, language) {
    let mode = 'ace/mode/';
    mode += language;
    $scope.paragraph.config.editorMode = mode;
    session.setMode(mode);
  };

  const setParagraphMode = function(session, paragraphText, pos) {
    // Evaluate the mode only if the the position is undefined
    // or the first 30 characters of the paragraph have been modified
    // or cursor position is at beginning of second line.(in case user hit enter after typing %magic)
    if ((typeof pos === 'undefined') || (pos.row === 0 && pos.column < 30) ||
      (pos.row === 1 && pos.column === 0) || pastePercentSign) {
      // If paragraph loading, use config value if exists
      if ((typeof pos === 'undefined') && $scope.paragraph.config.editorMode &&
        !setInterpreterBindings) {
        session.setMode($scope.paragraph.config.editorMode);
      } else {
        let magic = getParagraphMagic(paragraphText);
        if (editorSetting.magic !== magic) {
          editorSetting.magic = magic;
          getEditorSetting($scope.paragraph, paragraphText)
            .then(function(setting) {
              setEditorLanguage(session, setting.editor.language);
              _.merge($scope.paragraph.config.editorSetting, setting.editor);
            });
        }
      }
    }
    pastePercentSign = false;
    setInterpreterBindings = false;
  };

  // return the text that is composed of interpreter name and paragraph properties
  const getParagraphMagic = function(paragraphText) {
    let intpNameRegexp = /^\s*(%.+?)(\s)/g;
    let match = intpNameRegexp.exec(paragraphText);
    if (match) {
      return match[1].trim();
      // get default interpreter name if paragraph text doesn't start with '%'
      // TODO(mina): dig into the cause what makes interpreterBindings to have no element
    } else if ($scope.$parent.interpreterBindings && $scope.$parent.interpreterBindings.length !== 0) {
      return $scope.$parent.interpreterBindings[0].name;
    }
    return '';
  };

  const autoAdjustEditorHeight = function(editor) {
    let height =
      editor.getSession().getScreenLength() *
      editor.renderer.lineHeight;

    angular.element('#' + editor.container.id).height(height.toString() + 'px');
    editor.resize();
  };

  $rootScope.$on('scrollToCursor', function(event) {
    // scroll on 'scrollToCursor' event only when cursor is in the last paragraph
    let paragraphs = angular.element('div[id$="_paragraphColumn_main"]');
    if (paragraphs[paragraphs.length - 1].id.indexOf($scope.paragraph.id) === 0) {
      $scope.scrollToCursor($scope.paragraph.id, 0);
    }
  });

  /** scrollToCursor if it is necessary
   * when cursor touches scrollTriggerEdgeMargin from the top (or bottom) of the screen, it autoscroll to place cursor around 1/3 of screen height from the top (or bottom)
   * paragraphId : paragraph that has active cursor
   * lastCursorMove : 1(down), 0, -1(up) last cursor move event
   **/
  $scope.scrollToCursor = function(paragraphId, lastCursorMove) {
    if (!$scope.editor || !$scope.editor.isFocused()) {
      // only make sense when editor is focused
      return;
    }
    let lineHeight = $scope.editor.renderer.lineHeight;
    let headerHeight = 103; // menubar, notebook titlebar
    let scrollTriggerEdgeMargin = 50;

    let documentHeight = angular.element(document).height();
    let windowHeight = angular.element(window).height();  // actual viewport height

    let scrollPosition = angular.element(document).scrollTop();
    let editorPosition = angular.element('#' + paragraphId + '_editor').offset();
    let position = $scope.editor.getCursorPosition();
    let lastCursorPosition = $scope.editor.renderer.$cursorLayer.getPixelPosition(position, true);

    let calculatedCursorPosition = editorPosition.top + lastCursorPosition.top + lineHeight * lastCursorMove;

    let scrollTargetPos;
    if (calculatedCursorPosition < scrollPosition + headerHeight + scrollTriggerEdgeMargin) {
      scrollTargetPos = calculatedCursorPosition - headerHeight - ((windowHeight - headerHeight) / 3);
      if (scrollTargetPos < 0) {
        scrollTargetPos = 0;
      }
    } else if (calculatedCursorPosition > scrollPosition + scrollTriggerEdgeMargin + windowHeight - headerHeight) {
      scrollTargetPos = calculatedCursorPosition - headerHeight - ((windowHeight - headerHeight) * 2 / 3);

      if (scrollTargetPos > documentHeight) {
        scrollTargetPos = documentHeight;
      }
    }

    // cancel previous scroll animation
    let bodyEl = angular.element('body');
    bodyEl.stop();
    bodyEl.finish();

    // scroll to scrollTargetPos
    if (scrollTargetPos) {
      bodyEl.scrollTo(scrollTargetPos, {axis: 'y', interrupt: true, duration: 100});
    }
  };

  $scope.getEditorValue = function() {
    return !$scope.editor ? $scope.paragraph.text : $scope.editor.getValue();
  };

  $scope.getProgress = function() {
    return $scope.currentProgress || 0;
  };

  $scope.getFormattedParagraphTime = () => {
    return moment().toISOString();
  };

  function formatDurationMs(timeMs) {
    if (timeMs < 1000) {
      return '0 秒';
    }
    return moment.duration((timeMs / 1000), 'seconds').format('h [小时] m [分钟] s [秒]');
  }

  $scope.getExecutionTime = function(pdata) {
    const end = pdata.dateFinished;
    const start = pdata.dateStarted;
    let timeMs = Date.parse(end) - Date.parse(start);
    if (isNaN(timeMs) || timeMs < 0) {
      if ($scope.isResultOutdated(pdata)) {
        return '结果已过期';
      }
      return '';
    }

    const durationFormat = formatDurationMs(timeMs);
    const endFormat = moment(pdata.dateFinished).format('YYYY-MM-DD HH:mm:ss');

    let user = (pdata.user === undefined || pdata.user === null) ? '匿名用户' : pdata.user;
    let desc = `耗时 ${durationFormat}。最后由 ${user} 更新于 ${endFormat}。`;

    if ($scope.isResultOutdated(pdata)) {
      desc += '（结果已过期）';
    }

    return desc;
  };

  $scope.getCancelFooterText = function() {
    switch ($scope.cancelFinalStatus) {
      case ParagraphStatus.ABORT:
        return CANCEL_UI_TEXT.ABORTED_FOOTER_ABORT;
      case ParagraphStatus.FINISHED:
        return CANCEL_UI_TEXT.ABORTED_FOOTER_FINISHED;
      case ParagraphStatus.ERROR:
        return CANCEL_UI_TEXT.ABORTED_FOOTER_ERROR;
      case 'TIMEOUT':
        return CANCEL_UI_TEXT.ABORTED_FOOTER_TIMEOUT;
      default:
        return '';
    }
  };

  $scope.getCancelDurationText = function() {
    if (!$scope.cancelDurationMs) {
      return '';
    }
    const s = Math.round($scope.cancelDurationMs / 1000);
    if (s < 60) {
      return ' · 耗时 ' + s + ' 秒';
    }
    if (s < 3600) {
      return ' · 耗时 ' + Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    }
    return ' · 耗时 ' + Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
  };

  $scope.getElapsedTime = function(paragraph) {
    const startedAt = Date.parse(paragraph.dateStarted);
    if (isNaN(startedAt)) {
      return '';
    }
    return '已运行 ' + formatDurationMs(Math.max(0, Date.now() - startedAt)) + '。';
  };

  $scope.isResultOutdated = function(pdata) {
    if (pdata.dateUpdated !== undefined && Date.parse(pdata.dateUpdated) > Date.parse(pdata.dateStarted)) {
      return true;
    }
    return false;
  };

  $scope.goToEnd = function(editor) {
    editor.navigateFileEnd();
  };

  $scope.parseTableCell = function(cell) {
    if (!isNaN(cell)) {
      if (cell.length === 0 || Number(cell) > Number.MAX_SAFE_INTEGER || Number(cell) < Number.MIN_SAFE_INTEGER) {
        return cell;
      } else {
        return Number(cell);
      }
    }
    let d = moment(cell);
    if (d.isValid()) {
      return d;
    }
    return cell;
  };

  const commitParagraph = function(paragraph) {
    const {
      id,
      title,
      text,
      config,
      settings: {params},
    } = paragraph;

    return websocketMsgSrv.commitParagraph(id, title, text, config, params,
      $route.current.pathParams.noteId);
  };

  /** Utility function */
  $scope.goToSingleParagraph = function() {
    let noteId = $route.current.pathParams.noteId;
    let redirectToUrl = location.protocol + '//' + location.host + location.pathname + '#/notebook/' + noteId +
      '/paragraph/' + $scope.paragraph.id + '?asIframe';
    $window.open(redirectToUrl);
  };

  $scope.showScrollDownIcon = function(id) {
    let doc = angular.element('#p' + id + '_text');
    if (doc[0]) {
      return doc[0].scrollHeight > doc.innerHeight();
    }
    return false;
  };

  $scope.scrollParagraphDown = function(id) {
    let doc = angular.element('#p' + id + '_text');
    doc.animate({scrollTop: doc[0].scrollHeight}, 500);
    $scope.keepScrollDown = true;
  };

  $scope.showScrollUpIcon = function(id) {
    if (angular.element('#p' + id + '_text')[0]) {
      return angular.element('#p' + id + '_text')[0].scrollTop !== 0;
    }
    return false;
  };

  $scope.scrollParagraphUp = function(id) {
    let doc = angular.element('#p' + id + '_text');
    doc.animate({scrollTop: 0}, 500);
    $scope.keepScrollDown = false;
  };

  $scope.$on('angularObjectUpdate', function(event, data) {
    let noteId = $route.current.pathParams.noteId;
    if (!data.noteId || data.noteId === noteId) {
      let scope;
      let registry;

      if (!data.paragraphId || data.paragraphId === $scope.paragraph.id) {
        scope = paragraphScope;
        registry = angularObjectRegistry;
      } else {
        return;
      }
      let varName = data.angularObject.name;

      if (angular.equals(data.angularObject.object, scope[varName])) {
        // return when update has no change
        return;
      }

      if (!registry[varName]) {
        registry[varName] = {
          interpreterGroupId: data.interpreterGroupId,
          noteId: data.noteId,
          paragraphId: data.paragraphId,
        };
      } else {
        registry[varName].noteId = registry[varName].noteId || data.noteId;
        registry[varName].paragraphId = registry[varName].paragraphId || data.paragraphId;
      }

      registry[varName].skipEmit = true;

      if (!registry[varName].clearWatcher) {
        registry[varName].clearWatcher = scope.$watch(varName, function(newValue, oldValue) {
          console.log('angular object (paragraph) updated %o %o', varName, registry[varName]);
          if (registry[varName].skipEmit) {
            registry[varName].skipEmit = false;
            return;
          }
          websocketMsgSrv.updateAngularObject(
            registry[varName].noteId,
            registry[varName].paragraphId,
            varName,
            newValue,
            registry[varName].interpreterGroupId);
        });
      }
      console.log('angular object (paragraph) created %o', varName);
      scope[varName] = data.angularObject.object;

      // create proxy for AngularFunction
      if (varName.indexOf(ANGULAR_FUNCTION_OBJECT_NAME_PREFIX) === 0) {
        let funcName = varName.substring((ANGULAR_FUNCTION_OBJECT_NAME_PREFIX).length);
        scope[funcName] = function() {
          // eslint-disable-next-line prefer-rest-params
          scope[varName] = arguments;
          // eslint-disable-next-line prefer-rest-params
          console.log('angular function (paragraph) invoked %o', arguments);
        };

        console.log('angular function (paragraph) created %o', scope[funcName]);
      }
    }
  });

  $scope.$on('updateParaInfos', function(event, data) {
    if (data.id === $scope.paragraph.id) {
      $scope.paragraph.runtimeInfos = data.infos;
    }
  });

  $scope.$on('angularObjectRemove', function(event, data) {
    let noteId = $route.current.pathParams.noteId;
    if (!data.noteId || data.noteId === noteId) {
      let scope;
      let registry;

      if (!data.paragraphId || data.paragraphId === $scope.paragraph.id) {
        scope = paragraphScope;
        registry = angularObjectRegistry;
      } else {
        return;
      }

      let varName = data.name;

      // clear watcher
      if (registry[varName]) {
        registry[varName].clearWatcher();
        registry[varName] = undefined;
      }

      // remove scope variable
      scope[varName] = undefined;

      // remove proxy for AngularFunction
      if (varName.indexOf(ANGULAR_FUNCTION_OBJECT_NAME_PREFIX) === 0) {
        let funcName = varName.substring((ANGULAR_FUNCTION_OBJECT_NAME_PREFIX).length);
        scope[funcName] = undefined;
      }
    }
  });

  /**
   * @returns {boolean} true if updated is needed
   */
  function isUpdateRequired(oldPara, newPara) {
    return (newPara.id === oldPara.id &&
      (newPara.dateCreated !== oldPara.dateCreated ||
      newPara.text !== oldPara.text ||
      newPara.dateFinished !== oldPara.dateFinished ||
      newPara.dateStarted !== oldPara.dateStarted ||
      newPara.dateUpdated !== oldPara.dateUpdated ||
      newPara.status !== oldPara.status ||
      newPara.jobName !== oldPara.jobName ||
      newPara.title !== oldPara.title ||
      isEmpty(newPara.results) !== isEmpty(oldPara.results) ||
      newPara.errorMessage !== oldPara.errorMessage ||
      !angular.equals(newPara.settings, oldPara.settings) ||
      !angular.equals(newPara.config, oldPara.config) ||
      !angular.equals(newPara.runtimeInfos, oldPara.runtimeInfos)));
  }

  $scope.updateAllScopeTexts = function(oldPara, newPara) {
    if (oldPara.text !== newPara.text) {
      if ($scope.dirtyText) {         // check if editor has local update
        if ($scope.dirtyText === newPara.text) {  // when local update is the same from remote, clear local update
          $scope.paragraph.text = newPara.text;
          $scope.dirtyText = undefined;
          $scope.originalText = angular.copy(newPara.text);
        } else { // if there're local update, keep it.
          $scope.paragraph.text = newPara.text;
        }
      } else {
        $scope.paragraph.text = newPara.text;
        $scope.originalText = angular.copy(newPara.text);
      }
    }
  };

  $scope.updateParagraphObjectWhenUpdated = function(newPara) {
    // resize col width
    if ($scope.paragraph.config.colWidth !== newPara.config.colWidth) {
      $scope.$broadcast('paragraphResized', $scope.paragraph.id);
    }

    if ($scope.paragraph.config.fontSize !== newPara.config.fontSize) {
      $rootScope.$broadcast('fontSizeChanged', newPara.config.fontSize);
    }

    /** push the rest */
    $scope.paragraph.aborted = newPara.aborted;
    $scope.paragraph.user = newPara.user;
    $scope.paragraph.dateUpdated = newPara.dateUpdated;
    $scope.paragraph.dateCreated = newPara.dateCreated;
    $scope.paragraph.dateFinished = newPara.dateFinished;
    $scope.paragraph.dateStarted = newPara.dateStarted;
    $scope.paragraph.errorMessage = newPara.errorMessage;
    $scope.paragraph.jobName = newPara.jobName;
    $scope.paragraph.title = newPara.title;
    $scope.paragraph.lineNumbers = newPara.lineNumbers;
    const oldStatus = $scope.paragraph.status;
    $scope.paragraph.status = newPara.status;
    applyPendingCancelBlock(newPara.status, oldStatus);
    applyCancelUiTransition(newPara.status);
    $scope.paragraph.fontSize = newPara.fontSize;
    if (newPara.status !== ParagraphStatus.RUNNING) {
      $scope.paragraph.results = newPara.results;
    }
    $scope.paragraph.settings = newPara.settings;
    $scope.paragraph.runtimeInfos = newPara.runtimeInfos;
    if ($scope.editor) {
      let isReadOnly = $scope.isRunning(newPara) || $scope.isNoteRunning;
      $scope.editor.setReadOnly(isReadOnly);
    }

    if (!$scope.asIframe) {
      $scope.paragraph.config = newPara.config;
      initializeDefault(newPara.config);
    } else {
      newPara.config.editorHide = true;
      newPara.config.tableHide = false;
      $scope.paragraph.config = newPara.config;
    }
  };

  $scope.updateParagraph = function(oldPara, newPara, updateCallback) {
     // 1. can't update on revision view
    if ($scope.revisionView === true) {
      return;
    }

     // 2. get status, refreshed
    const statusChanged = (newPara.status !== oldPara.status);
    const resultRefreshed = (newPara.dateFinished !== oldPara.dateFinished) ||
       isEmpty(newPara.results) !== isEmpty(oldPara.results) ||
       newPara.status === ParagraphStatus.ERROR ||
       (newPara.status === ParagraphStatus.FINISHED && statusChanged);

     // 3. update texts managed by $scope
    $scope.updateAllScopeTexts(oldPara, newPara);

     // 4. execute callback to update result
    updateCallback();

     // 5. update remaining paragraph objects
    $scope.updateParagraphObjectWhenUpdated(newPara);

     // 6. handle scroll down by key properly if new paragraph is added
    if (statusChanged || resultRefreshed) {
       // when last paragraph runs, zeppelin automatically appends new paragraph.
       // this broadcast will focus to the newly inserted paragraph
      const paragraphs = angular.element('div[id$="_paragraphColumn_main"]');
      if (paragraphs.length >= 2 && paragraphs[paragraphs.length - 2].id.indexOf($scope.paragraph.id) === 0) {
         // rendering output can took some time. So delay scrolling event firing for sometime.
        setTimeout(() => {
          $rootScope.$broadcast('scrollToCursor');
        }, 500);
      }
    }
  };

  /** $scope.$on */

  $scope.$watch(function() {
    return $scope.paragraph && $scope.paragraph.status;
  }, function(newStatus) {
    if (isTerminalParagraphStatus(newStatus)) {
      resetCancelUi('idle', null);
    }
  });

  $scope.$on('runParagraphUsingSpell', function(event, data) {
    const oldPara = $scope.paragraph;
    let newPara = data.paragraph;
    const updateCallback = () => {
      $scope.runParagraph(newPara.text, true, true);
    };

    if (!isUpdateRequired(oldPara, newPara)) {
      return;
    }

    $scope.updateParagraph(oldPara, newPara, updateCallback);
  });

  $scope.$on('updateParagraph', function(event, data) {
    const oldPara = $scope.paragraph;
    const newPara = data.paragraph;

    if (!isUpdateRequired(oldPara, newPara)) {
      return;
    }

    const updateCallback = () => {
      // broadcast `updateResult` message to trigger result update
      if (newPara.results && newPara.results.msg) {
        for (let i in newPara.results.msg) {
          if (newPara.results.msg.hasOwnProperty(i)) {
            const newResult = newPara.results.msg ? newPara.results.msg[i] : {};
            const oldResult = (oldPara.results && oldPara.results.msg)
              ? oldPara.results.msg[i] : {};
            const newConfig = newPara.config.results ? newPara.config.results[i] : {};
            const oldConfig = oldPara.config.results ? oldPara.config.results[i] : {};
            if (!angular.equals(newResult, oldResult) ||
              !angular.equals(newConfig, oldConfig)) {
              $rootScope.$broadcast('updateResult', newResult, newConfig, newPara, parseInt(i));
            }
          }
        }
      }
    };

    $scope.updateParagraph(oldPara, newPara, updateCallback);
  });

  $scope.$on('patchReceived', function(event, data) {
    if (data.paragraphId === $scope.paragraph.id) {
      let patch = data.patch;
      patch = $scope.diffMatchPatch.patch_fromText(patch);
      if (!$scope.paragraph.text || $scope.paragraph.text === undefined) {
        $scope.paragraph.text = '';
      }
      $scope.paragraph.text = $scope.diffMatchPatch.patch_apply(patch, $scope.paragraph.text)[0];
      $scope.originalText = angular.copy($scope.paragraph.text);
      let newPosition = $scope.editor.getCursorPosition();
      if (newPosition && newPosition.row && newPosition.column) {
        $scope.cursorPosition = $scope.editor.getCursorPosition();
      }
    }
  });

  $scope.$on('updateProgress', function(event, data) {
    if (data.id === $scope.paragraph.id) {
      $scope.currentProgress = data.progress;
    }
  });

  $scope.$on('updateStatus', function(event, data) {
    if (data.id === $scope.paragraph.id) {
      const oldStatus = $scope.paragraph.status;
      $scope.paragraph.status = data.status;
      applyPendingCancelBlock(data.status, oldStatus);
      applyCancelUiTransition(data.status);
    }
  });

  $scope.$on('appendParagraphOutput', function(event, data) {
    if (data.paragraphId === $scope.paragraph.id) {
      if (!$scope.paragraph.results) {
        $scope.paragraph.results = {};

        if (!$scope.paragraph.results.msg) {
          $scope.paragraph.results.msg = [];
        }

        $scope.paragraph.results.msg[data.index] = {
          data: data.data,
          type: data.type,
        };

        $rootScope.$broadcast(
          'updateResult',
          $scope.paragraph.results.msg[data.index],
          $scope.paragraph.config.results[data.index],
          $scope.paragraph,
          data.index);
      }
    }
  });

  $scope.$on('keyEvent', function(event, keyEvent) {
    if ($scope.paragraphFocused) {
      let paragraphId = $scope.paragraph.id;
      let keyCode = keyEvent.keyCode;
      let noShortcutDefined = false;
      let editorHide = $scope.paragraph.config.editorHide;

      if (editorHide && (keyCode === 38 || (keyCode === 80 && keyEvent.ctrlKey && !keyEvent.altKey))) { // up
        // move focus to previous paragraph
        $scope.$emit('moveFocusToPreviousParagraph', paragraphId);
      } else if (editorHide && (keyCode === 40 || (keyCode === 78 && keyEvent.ctrlKey && !keyEvent.altKey))) { // down
        // move focus to next paragraph
        // $timeout stops chaining effect of focus propogation
        $timeout(() => $scope.$emit('moveFocusToNextParagraph', paragraphId));
      } else if (!keyEvent.ctrlKey && keyEvent.shiftKey && keyCode === 13) { // Shift + Enter
        $scope.runParagraphFromShortcut($scope.getEditorValue());
      } else if (keyEvent.ctrlKey && keyEvent.shiftKey && keyCode === 38) { // Ctrl + Shift + UP
        $scope.runAllToThisFromShortcut($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.shiftKey && keyCode === 40) { // Ctrl + Shift + Down
        $scope.runAllFromThisFromShortcut($scope.paragraph);
      }else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 67) { // Ctrl + Alt + c
        $scope.cancelParagraph($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 68) { // Ctrl + Alt + d
        $scope.removeParagraph($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 75) { // Ctrl + Alt + k
        $scope.moveUp($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 74) { // Ctrl + Alt + j
        $scope.moveDown($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 65) { // Ctrl + Alt + a
        $scope.insertNew('above');
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 66) { // Ctrl + Alt + b
        $scope.insertNew('below');
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 79) { // Ctrl + Alt + o
        $scope.toggleOutput($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 82) { // Ctrl + Alt + r
        $scope.toggleEnableDisable($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 69) { // Ctrl + Alt + e
        $scope.toggleEditor($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 77) { // Ctrl + Alt + m
        if ($scope.paragraph.config.lineNumbers) {
          $scope.hideLineNumbers($scope.paragraph);
        } else {
          $scope.showLineNumbers($scope.paragraph);
        }
      } else if (keyEvent.ctrlKey && keyEvent.shiftKey && keyCode === 189) { // Ctrl + Shift + -
        $scope.changeColWidth($scope.paragraph, Math.max(1, $scope.paragraph.config.colWidth - 1));
      } else if (keyEvent.ctrlKey && keyEvent.shiftKey && keyCode === 187) { // Ctrl + Shift + =
        $scope.changeColWidth($scope.paragraph, Math.min(12, $scope.paragraph.config.colWidth + 1));
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 84) { // Ctrl + Alt + t
        if ($scope.paragraph.config.title) {
          $scope.hideTitle($scope.paragraph);
        } else {
          $scope.showTitle($scope.paragraph);
        }
      } else if (keyEvent.ctrlKey && keyEvent.shiftKey && keyCode === 67) { // Ctrl + Alt + c
        $scope.copyPara('below');
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 76) { // Ctrl + Alt + l
        $scope.clearParagraphOutput($scope.paragraph);
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 87) { // Ctrl + Alt + w
        $scope.goToSingleParagraph();
      } else if (keyEvent.ctrlKey && keyEvent.altKey && keyCode === 70) { // Ctrl + f
        $scope.$emit('toggleSearchBox');
      } else {
        noShortcutDefined = true;
      }

      if (!noShortcutDefined) {
        keyEvent.preventDefault();
      }
    }
  });

  $scope.$on('focusParagraph', function(event, paragraphId, cursorPosRow, cursorPosCol, mouseEvent) {
    if (cursorPosCol === null || cursorPosCol === undefined) {
      cursorPosCol = 0;
    }
    if ($scope.paragraph.id === paragraphId) {
      // focus editor
      if (!$scope.paragraph.config.editorHide) {
        if (!mouseEvent) {
          $scope.editor.focus();
          // move cursor to the first row (or the last row)
          let row;
          if (cursorPosRow >= 0) {
            row = cursorPosRow;
            $scope.editor.gotoLine(row, cursorPosCol);
          } else {
            row = $scope.editor.session.getLength();
            $scope.editor.gotoLine(row, cursorPosCol);
          }
          $scope.scrollToCursor($scope.paragraph.id, cursorPosCol);
        }
      }
      handleFocus(true);
    } else {
      if ($scope.editor !== undefined && $scope.editor !== null) {
        $scope.editor.blur();
      }
      let isDigestPass = true;
      handleFocus(false, isDigestPass);
    }
  });

  $scope.$on('saveInterpreterBindings', function(event, paragraphId) {
    if ($scope.paragraph.id === paragraphId && $scope.editor) {
      setInterpreterBindings = true;
      setParagraphMode($scope.editor.getSession(), $scope.editor.getSession().getValue());
    }
  });

  $scope.$on('doubleClickParagraph', function(event, paragraphId) {
    if ($scope.paragraph.id === paragraphId && $scope.paragraph.config.editorHide &&
      $scope.paragraph.config.editorSetting.editOnDblClick && $scope.revisionView !== true) {
      let deferred = $q.defer();
      openEditorAndCloseTable($scope.paragraph);
      $timeout(
        $scope.$on('updateParagraph', function(event, data) {
          deferred.resolve(data);
        }
        ), 1000);

      deferred.promise.then(function(data) {
        if ($scope.editor) {
          $scope.editor.focus();
          $scope.goToEnd($scope.editor);
        }
      });
    }
  });

  $scope.$on('openEditor', function(event) {
    $scope.openEditor($scope.paragraph);
  });

  $scope.$on('closeEditor', function(event) {
    $scope.closeEditor($scope.paragraph);
  });

  $scope.$on('openTable', function(event) {
    $scope.openTable($scope.paragraph);
  });

  $scope.$on('closeTable', function(event) {
    $scope.closeTable($scope.paragraph);
  });

  $scope.$on('resultRendered', function(event, paragraphId) {
    if ($scope.paragraph.id !== paragraphId) {
      return;
    }

    /** increase spell result count and return if not finished */
    if (!$scope.increaseSpellTransactionResultCount()) {
      return;
    }

    $scope.cleanupSpellTransaction();
  });

  $scope.$on('fontSizeChanged', function(event, fontSize) {
    if ($scope.editor) {
      $scope.editor.setOptions({
        fontSize: fontSize + 'pt',
      });
    }
  });

  const clearSearchSelection = function() {
    for (let i = 0; i < searchRanges.length; ++i) {
      $scope.editor.session.removeMarker(searchRanges[i].markerId);
    }
    searchRanges = [];
    if (currentRange.id !== -1) {
      $scope.editor.session.removeMarker(currentRange.markerId);
    }
    currentRange = getCurrentRangeDefault();
  };

  $scope.onEditorClick = function() {
    $scope.$emit('editorClicked');
  };

  $scope.$on('unmarkAll', function() {
    clearSearchSelection();
  });

  const markAllOccurrences = function(text) {
    clearSearchSelection();
    if (text === '') {
      return;
    }
    if ($scope.editor.findAll(text) === 0) {
      return;
    }
    let ranges = $scope.editor.selection.getAllRanges();
    $scope.editor.selection.toSingleRange();
    $scope.editor.selection.clearSelection();
    for (let i = 0; i < ranges.length; ++i) {
      let id = $scope.editor.session.addMarker(ranges[i], 'ace_selected-word', 'text');
      searchRanges.push({markerId: id, range: ranges[i]});
    }
  };

  $scope.$on('markAllOccurrences', function(event, text) {
    markAllOccurrences(text);
    if (searchRanges.length > 0) {
      $scope.$emit('occurrencesExists', searchRanges.length);
    }
  });

  $scope.$on('nextOccurrence', function(event, paragraphId) {
    if ($scope.paragraph.id !== paragraphId) {
      return;
    }
    let highlightedRangeExists = currentRange.id !== -1;
    if (highlightedRangeExists) {
      $scope.editor.session.removeMarker(currentRange.markerId);
      currentRange.markerId = -1;
    }
    ++currentRange.id;
    if (currentRange.id >= searchRanges.length) {
      currentRange.id = -1;
      $scope.$emit('noNextOccurrence');
      return;
    }
    currentRange.markerId = $scope.editor.session.addMarker(
      searchRanges[currentRange.id].range, 'ace_selection', 'text');
  });

  $scope.$on('prevOccurrence', function(event, paragraphId) {
    if ($scope.paragraph.id !== paragraphId) {
      return;
    }
    let highlightedRangeExists = currentRange.id !== -1;
    if (highlightedRangeExists) {
      $scope.editor.session.removeMarker(currentRange.markerId);
      currentRange.markerId = -1;
    }
    if (currentRange.id === -1) {
      currentRange.id = searchRanges.length;
    }
    --currentRange.id;
    if (currentRange.id === -1) {
      $scope.$emit('noPrevOccurrence');
      return;
    }
    currentRange.markerId = $scope.editor.session.addMarker(
      searchRanges[currentRange.id].range, 'ace_selection', 'text');
  });

  $scope.$on('replaceCurrent', function(event, from, to) {
    if (currentRange.id === -1) {
      return;
    }
    let indexFromEnd = searchRanges.length - currentRange.id - 1;
    let prevId = currentRange.id;
    $scope.editor.session.removeMarker(currentRange.markerId);
    $scope.editor.session.replace(searchRanges[currentRange.id].range, to);
    markAllOccurrences(from);
    let currentIndex = searchRanges.length - indexFromEnd;
    $scope.$emit('occurrencesCountChanged', currentIndex - prevId - 1);
    currentRange.id = currentIndex;
    if (currentRange.id === searchRanges.length) {
      currentRange.id = -1;
      $scope.$emit('noNextOccurrenceAfterReplace');
    } else {
      currentRange.markerId = $scope.editor.session.addMarker(
        searchRanges[currentRange.id].range, 'ace_selection', 'text');
    }
  });

  $scope.$on('replaceAll', function(event, from, to) {
    clearSearchSelection();
    $scope.editor.replaceAll(to, {needle: from});
  });

  $scope.$on('checkOccurrences', function() {
    if (searchRanges.length > 0) {
      $scope.$emit('occurrencesExists', searchRanges.length);
    }
  });

  // SQL format support
  $scope.isSqlMode = function(paragraph) {
    if (!paragraph || !paragraph.config || !paragraph.config.editorMode) {
      return false;
    }
    let mode = paragraph.config.editorMode;
    return mode.indexOf('sql') !== -1 || mode.indexOf('hive') !== -1 ||
           mode.indexOf('mysql') !== -1 || mode.indexOf('pgsql') !== -1;
  };

  $scope.formatSqlCode = function(paragraph) {
    // 确保 sqlFormatter 可用
    let sf = window.sqlFormatter ||
      (typeof sqlFormatter !== 'undefined' ? sqlFormatter : null); // eslint-disable-line no-undef
    if (!sf && !$scope._sqlFormatterLoading) {
      $scope._sqlFormatterLoading = true;
      let script = document.createElement('script');
      script.src = 'lib/sql-formatter.min.js';
      script.onload = function() {
        $scope._sqlFormatterLoading = false;
        $scope.formatSqlCode(paragraph);
        $scope.$apply();
      };
      script.onerror = function() {
        $scope._sqlFormatterLoading = false;
      };
      document.head.appendChild(script);
      return;
    }
    if (!paragraph || !paragraph.text || !sf) {
      return;
    }
    let magic = getParagraphMagic(paragraph.text).toLowerCase();
    let lowerText = paragraph.text.toLowerCase();
    let dialect = 'sql';
    if (magic.indexOf('hive') !== -1 || magic.indexOf('jdbc') !== -1 || lowerText.indexOf('jdbc') !== -1) {
      dialect = 'hive';
    }
    if (magic.indexOf('mysql') !== -1 || lowerText.indexOf('mysql') !== -1) {
      dialect = 'mysql';
    }
    if (magic.indexOf('spark') !== -1 || lowerText.indexOf('spark') !== -1) {
      dialect = 'spark';
    }
    try {
      // 分离解释器标识和 SQL 内容
      let textToFormat = paragraph.text;
      let magicLine = '';
      let intpMatch = /^\s*(%.+?)[\s\n]/.exec(paragraph.text);
      if (intpMatch) {
        magicLine = intpMatch[0].trim();
        // 获取 magic 行之后的内容
        textToFormat = paragraph.text.substring(intpMatch[0].length);
      }

      // 只格式化 SQL 部分
      let formattedSql = sf.format(textToFormat, {
        language: dialect,
        indent: '  ',
        uppercase: true,
        linesBetweenQueries: 2,
      });

      // 组合 magic 行和格式化后的 SQL
      let formatted = magicLine ? magicLine + '\n' + formattedSql : formattedSql;
      paragraph.text = formatted;
      // 用 replace 代替 setValue，这样 Ctrl+Z 可以撤销
      let session = $scope.editor.getSession();
      let lastRow = session.getLength() - 1;
      session.replace(new ace.Range(0, 0, lastRow, session.getLine(lastRow).length), formatted);
      // 保存到服务器
      commitParagraph(paragraph);
    } catch (e) {
      console.warn('SQL format error:', e);
    }
  };

  $scope.$on('$destroy', function() {
    if (cancelSlowHintTimer) {
      $timeout.cancel(cancelSlowHintTimer);
    }
    if (cancelStuckHintTimer) {
      $timeout.cancel(cancelStuckHintTimer);
    }
    if (cancelMaxWaitTimer) {
      $timeout.cancel(cancelMaxWaitTimer);
    }
    if (cancelResendFeedbackTimer) {
      $timeout.cancel(cancelResendFeedbackTimer);
    }
    if (cancelPendingBlockTimer) {
      $timeout.cancel(cancelPendingBlockTimer);
    }
  });
}
