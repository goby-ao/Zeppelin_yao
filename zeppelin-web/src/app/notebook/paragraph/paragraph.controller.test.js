describe('Controller: ParagraphCtrl', function() {
  beforeEach(angular.mock.module('zeppelinWebApp'));

  let scope;
  let websocketMsgSrvMock;
  let paragraphMock;
  const baseParagraphMock = {
    id: 'p1',
    title: '',
    text: 'select 1',
    status: 'READY',
    config: {
      editorSetting: {},
    },
    settings: {
      forms: {},
      params: {},
    },
    results: {
      msg: [],
    },
  };
  let route = {
    current: {
      pathParams: {
        noteId: 'noteId',
      },
    },
  };

  beforeEach(inject(function($controller, $rootScope, $q) {
    scope = $rootScope.$new();
    $rootScope.notebookScope = $rootScope.$new(true, $rootScope);
    paragraphMock = angular.copy(baseParagraphMock);
    websocketMsgSrvMock = {
      commitParagraph: jasmine.createSpy('commitParagraph').and.callFake(function() {
        return $q.resolve();
      }),
      runParagraph: jasmine.createSpy('runParagraph'),
    };

    $controller('ParagraphCtrl', {
      $scope: scope,
      websocketMsgSrv: websocketMsgSrvMock,
      $element: {},
      $route: route,
    });

    scope.init(paragraphMock);
  }));

  let functions = ['isRunning', 'getIframeDimensions', 'cancelParagraph', 'runParagraph', 'saveParagraph',
    'moveUp', 'moveDown', 'insertNew', 'removeParagraph', 'toggleEditor', 'closeEditor', 'openEditor',
    'closeTable', 'openTable', 'showTitle', 'hideTitle', 'setTitle', 'showLineNumbers', 'hideLineNumbers',
    'changeColWidth', 'columnWidthClass', 'toggleOutput',
    'aceChanged', 'aceLoaded', 'getEditorValue', 'getProgress', 'getExecutionTime', 'isResultOutdated'];

  functions.forEach(function(fn) {
    it('check for scope functions to be defined : ' + fn, function() {
      expect(scope[fn]).toBeDefined();
    });
  });

  it('ignores another notebook binding response and stops waiting on timeout',
    inject(function($rootScope, $timeout) {
      const previous = window.BootstrapDialog;
      window.BootstrapDialog = {alert: jasmine.createSpy('alert')};
      scope.interpreterBindings = [];
      websocketMsgSrvMock.getInterpreterBindings = jasmine.createSpy('getInterpreterBindings');
      try {
        scope.restartParagraphInterpreter(scope.paragraph);
        $rootScope.$broadcast('interpreterBindings', {noteId: 'other', interpreterBindings: []});
        $rootScope.$digest();
        expect(BootstrapDialog.alert).not.toHaveBeenCalled();
        $timeout.flush(5000);
        expect(BootstrapDialog.alert.calls.mostRecent().args[0].message).toContain('超时');
      } finally {
        window.BootstrapDialog = previous;
      }
    }));

  it('should have this array of values for "colWidthOption"', function() {
    expect(scope.colWidthOption).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('should set default value of "paragraphFocused" as false', function() {
    expect(scope.paragraphFocused).toEqual(false);
  });

  it('should save latest dirty editor text instead of stale paragraph text', function() {
    scope.originalText = 'select 1';
    scope.paragraph.text = 'select 1';
    scope.dirtyText = 'select 2';

    scope.saveParagraph(scope.paragraph);

    expect(websocketMsgSrvMock.commitParagraph).toHaveBeenCalledWith(
      'p1', '', 'select 2', scope.paragraph.config, scope.paragraph.settings.params, 'noteId');
    expect(scope.paragraph.text).toBe('select 2');
    expect(scope.dirtyText).toBe('select 2');
    expect(scope.pendingText).toBe('select 2');
  });

  it('should keep local dirty text when stale remote paragraph text arrives', function() {
    scope.originalText = 'select 1';
    scope.paragraph.text = 'select 1';
    scope.dirtyText = 'select 2';

    scope.updateAllScopeTexts(scope.paragraph, angular.extend({}, scope.paragraph, {
      text: 'select 1',
    }));

    expect(scope.paragraph.text).toBe('select 2');
    expect(scope.dirtyText).toBe('select 2');
    expect(scope.originalText).toBe('select 1');
  });

  it('should clear dirty text only after remote paragraph confirms the same text', function() {
    scope.originalText = 'select 1';
    scope.paragraph.text = 'select 2';
    scope.dirtyText = 'select 2';
    scope.pendingText = 'select 2';

    scope.updateAllScopeTexts(scope.paragraph, angular.extend({}, scope.paragraph, {
      text: 'select 2',
    }));

    expect(scope.paragraph.text).toBe('select 2');
    expect(scope.originalText).toBe('select 2');
    expect(scope.dirtyText).toBeUndefined();
    expect(scope.pendingText).toBeUndefined();
  });

  it('should run with latest text and protect it until remote confirmation', function() {
    scope.originalText = 'select 1';
    scope.paragraph.text = 'select 1';

    scope.runParagraph('select 2', false, false);

    expect(websocketMsgSrvMock.runParagraph).toHaveBeenCalledWith(
      'p1', '', 'select 2', scope.paragraph.config, scope.paragraph.settings.params);
    expect(scope.paragraph.text).toBe('select 2');
    expect(scope.dirtyText).toBe('select 2');
    expect(scope.pendingText).toBe('select 2');
  });
});
