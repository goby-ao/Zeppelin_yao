describe('Controller: NotebookCtrl', function() {
  beforeEach(angular.mock.module('zeppelinWebApp'));

  let scope;
  let rootScope;
  let scrollMonitorMock;

  let websocketMsgSrvMock = {
    getNote: function() {},
    listRevisionHistory: function() {},
    getInterpreterBindings: function() {},
    updateNote: function() {},
    renameNote: function() {},
    listConfigurations: function() {},
  };

  let baseUrlSrvMock = {
    getRestApiBase: function() {
      return 'http://localhost:8080';
    },
  };
  let routeParamsMock = {
    noteId: '1',
  };

  let noteMock = {
    id: 1,
    name: 'my note',
    config: {},
  };

  beforeEach(inject(function($controller, $rootScope) {
    rootScope = $rootScope;
    scope = rootScope.$new();
    scrollMonitorMock = {
      recalculateLocations: jasmine.createSpy('recalculateLocations'),
      update: jasmine.createSpy('update'),
    };
    $controller('NotebookCtrl', {
      $scope: scope,
      websocketMsgSrv: websocketMsgSrvMock,
      baseUrlSrv: baseUrlSrvMock,
      $routeParams: routeParamsMock,
      scrollMonitor: scrollMonitorMock,
    });
  }));

  beforeEach(function() {
    scope.note = noteMock;
    document.body.classList.remove('zp-pin-mode-active');
    document.documentElement.classList.remove('zp-pin-mode-active');
  });

  let functions = ['getCronOptionNameFromValue', 'removeNote', 'runAllParagraphs', 'saveNote', 'toggleAllEditor',
    'showAllEditor', 'hideAllEditor', 'toggleAllTable', 'hideAllTable', 'showAllTable', 'isNoteRunning',
    'killSaveTimer', 'startSaveTimer', 'setLookAndFeel', 'setCronScheduler', 'setConfig', 'updateNoteName',
    'toggleParagraphLock',
    'openSetting', 'closeSetting', 'saveSetting', 'toggleSetting'];

  functions.forEach(function(fn) {
    it('check for scope functions to be defined : ' + fn, function() {
      expect(scope[fn]).toBeDefined();
    });
  });

  it('should set default value of "editorToggled" to false', function() {
    expect(scope.editorToggled).toEqual(false);
  });

  it('should set "showSetting" to true when openSetting() is called', function() {
    scope.openSetting();
    expect(scope.showSetting).toEqual(true);
  });

  it('should set "showSetting" to false when closeSetting() is called', function() {
    scope.closeSetting();
    expect(scope.showSetting).toEqual(false);
  });

  it('should return the correct value for getCronOptionNameFromValue()', function() {
    let none = scope.getCronOptionNameFromValue();
    let oneMin = scope.getCronOptionNameFromValue('0 0/1 * * * ?');
    let fiveMin = scope.getCronOptionNameFromValue('0 0/5 * * * ?');
    let oneHour = scope.getCronOptionNameFromValue('0 0 0/1 * * ?');
    let threeHours = scope.getCronOptionNameFromValue('0 0 0/3 * * ?');
    let sixHours = scope.getCronOptionNameFromValue('0 0 0/6 * * ?');
    let twelveHours = scope.getCronOptionNameFromValue('0 0 0/12 * * ?');
    let oneDay = scope.getCronOptionNameFromValue('0 0 0 * * ?');

    expect(none).toEqual('');
    expect(oneMin).toEqual('1m');
    expect(fiveMin).toEqual('5m');
    expect(oneHour).toEqual('1h');
    expect(threeHours).toEqual('3h');
    expect(sixHours).toEqual('6h');
    expect(twelveHours).toEqual('12h');
    expect(oneDay).toEqual('1d');
  });

  it('should have "isNoteDirty" as null by default', function() {
    expect(scope.isNoteDirty).toEqual(null);
  });

  it('should first call killSaveTimer() when calling startSaveTimer()', function() {
    expect(scope.saveTimer).toEqual(null);
    spyOn(scope, 'killSaveTimer');
    scope.startSaveTimer();
    expect(scope.killSaveTimer).toHaveBeenCalled();
  });

  it('should set "saveTimer" when saveTimer() and killSaveTimer() are called', function() {
    expect(scope.saveTimer).toEqual(null);
    scope.startSaveTimer();
    expect(scope.saveTimer).toBeTruthy();
    scope.killSaveTimer();
    expect(scope.saveTimer).toEqual(null);
  });

  it('should NOT update note name when updateNoteName() is called with an invalid name', function() {
    spyOn(websocketMsgSrvMock, 'renameNote');
    scope.updateNoteName('');
    expect(scope.note.name).toEqual(noteMock.name);
    expect(websocketMsgSrvMock.renameNote).not.toHaveBeenCalled();
    scope.updateNoteName(' ');
    expect(scope.note.name).toEqual(noteMock.name);
    expect(websocketMsgSrvMock.renameNote).not.toHaveBeenCalled();
    scope.updateNoteName(scope.note.name);
    expect(scope.note.name).toEqual(noteMock.name);
    expect(websocketMsgSrvMock.renameNote).not.toHaveBeenCalled();
  });

  it('should update note name when updateNoteName() is called with a valid name', function() {
    spyOn(websocketMsgSrvMock, 'renameNote');
    let newName = 'Your Note';
    scope.updateNoteName(newName);
    expect(scope.note.name).toEqual(newName);
    expect(websocketMsgSrvMock.renameNote).toHaveBeenCalled();
  });

  it('should reload note info once per one "setNoteMenu" event', function() {
    spyOn(websocketMsgSrvMock, 'getNote');
    spyOn(websocketMsgSrvMock, 'listRevisionHistory');

    scope.$broadcast('setNoteMenu');
    expect(websocketMsgSrvMock.getNote.calls.count()).toEqual(0);
    expect(websocketMsgSrvMock.listRevisionHistory.calls.count()).toEqual(0);

    websocketMsgSrvMock.getNote.calls.reset();
    websocketMsgSrvMock.listRevisionHistory.calls.reset();

    scope.$broadcast('setNoteMenu');
    expect(websocketMsgSrvMock.getNote.calls.count()).toEqual(0);
    expect(websocketMsgSrvMock.listRevisionHistory.calls.count()).toEqual(0);
  });

  it('should handle empty revision history', function() {
    scope.$broadcast('listRevisionHistory', {revisionList: []});

    expect(scope.noteRevisions.length).toEqual(1);
    expect(scope.noteRevisions[0].id).toEqual('Head');
    expect(scope.noteRevisions[0].time).toEqual(null);
  });

  it('should reveal and focus a newly added paragraph', inject(function($controller) {
    let newParagraph = {id: 'paragraph-new', text: '%sh\n', config: {}};
    let scheduledTimeouts = [];
    let fakeTimeout = function(callback) {
      scheduledTimeouts.push(callback);
      return scheduledTimeouts.length;
    };
    fakeTimeout.cancel = angular.noop;
    let localScope = rootScope.$new();
    $controller('NotebookCtrl', {
      $scope: localScope,
      websocketMsgSrv: websocketMsgSrvMock,
      baseUrlSrv: baseUrlSrvMock,
      $routeParams: routeParamsMock,
      $timeout: fakeTimeout,
      scrollMonitor: scrollMonitorMock,
    });
    localScope.note = {
      id: '1',
      name: 'my note',
      config: {},
      paragraphs: [
        {id: 'paragraph-before', focus: true},
        {id: 'paragraph-after'},
      ],
    };
    spyOn(localScope, 'scrollToParagraphById');
    spyOn(localScope, '$broadcast').and.callThrough();

    let timeoutCountBeforeAdd = scheduledTimeouts.length;
    localScope.$broadcast('addParagraph', newParagraph, 1);

    expect(localScope.note.paragraphs[1]).toBe(newParagraph);
    expect(localScope.note.paragraphs[0].focus).toBe(false);
    expect(newParagraph.focus).toBe(true);
    expect(newParagraph._initializing).toBe(true);
    expect(localScope.viewportWatchSuspend).toBe(1);
    expect(localScope.scrollToParagraphById).not.toHaveBeenCalled();

    localScope.$broadcast('paragraphInitialized', 'paragraph-new');
    scheduledTimeouts[timeoutCountBeforeAdd + 1]();

    expect(newParagraph._initializing).toBe(false);
    expect(localScope.viewportWatchSuspend).toBe(0);
    expect(scrollMonitorMock.update).toHaveBeenCalled();
    expect(localScope.scrollToParagraphById).toHaveBeenCalledWith('paragraph-new');
    expect(localScope.$broadcast).toHaveBeenCalledWith('focusParagraph', 'paragraph-new', 0, null, false);
  }));

  it('should keep a newly added paragraph visible in pin mode', inject(function($controller) {
    let newParagraph = {id: 'paragraph-new', text: '%sh\n', config: {}};
    let scheduledTimeouts = [];
    let fakeTimeout = function(callback) {
      scheduledTimeouts.push(callback);
      return scheduledTimeouts.length;
    };
    fakeTimeout.cancel = angular.noop;
    let localScope = rootScope.$new();
    $controller('NotebookCtrl', {
      $scope: localScope,
      websocketMsgSrv: websocketMsgSrvMock,
      baseUrlSrv: baseUrlSrvMock,
      $routeParams: routeParamsMock,
      $timeout: fakeTimeout,
      scrollMonitor: scrollMonitorMock,
    });
    localScope.note = {
      id: '1',
      name: 'my note',
      config: {},
      paragraphs: [
        {id: 'paragraph-before', focus: true},
        {id: 'paragraph-after'},
      ],
    };
    localScope.toggleParagraphLock('paragraph-before');

    let timeoutCountBeforeAdd = scheduledTimeouts.length;
    localScope.$broadcast('addParagraph', newParagraph, 1);
    scheduledTimeouts.slice(timeoutCountBeforeAdd).forEach(function(callback) {
      callback();
    });

    expect(localScope.note.paragraphs[1]).toBe(newParagraph);
    expect(localScope.lockedParagraphId).toEqual('paragraph-new');
    expect(document.body.classList.contains('zp-pin-mode-active')).toEqual(true);
    expect(newParagraph.focus).toBe(true);
  }));

  it('should leave pin mode when the pinned paragraph is removed', function() {
    scope.note = {
      id: '1',
      name: 'my note',
      config: {},
      paragraphs: [
        {id: 'paragraph-before'},
        {id: 'paragraph-pinned'},
      ],
    };
    scope.toggleParagraphLock('paragraph-pinned');

    scope.$broadcast('removeParagraph', 'paragraph-pinned');

    expect(scope.lockedParagraphId).toEqual(null);
    expect(document.body.classList.contains('zp-pin-mode-active')).toEqual(false);
    expect(scope.note.paragraphs.length).toEqual(1);
    expect(scope.note.paragraphs[0].id).toEqual('paragraph-before');
  });

  it('should request revision history after authenticated login', function() {
    spyOn(websocketMsgSrvMock, 'listRevisionHistory');
    rootScope.ticket = {
      principal: 'user1',
      ticket: 'ticket1',
      roles: '[]',
    };

    scope.$broadcast('loginSuccess');

    expect(websocketMsgSrvMock.listRevisionHistory.calls.count()).toEqual(1);
  });

  it('should ignore note content for a different route note id', function() {
    scope.$broadcast('setNoteContent', {
      id: '2',
      name: 'home note',
      config: {},
    });

    expect(scope.note).toBe(noteMock);
  });

  it('should only keep one pinned paragraph at a time', function() {
    scope.toggleParagraphLock('p1');
    expect(scope.lockedParagraphId).toEqual('p1');

    scope.toggleParagraphLock('p2');
    expect(scope.lockedParagraphId).toEqual('p2');

    scope.toggleParagraphLock('p2');
    expect(scope.lockedParagraphId).toEqual(null);
  });

  it('should toggle pin mode class on body when paragraph pin changes', function() {
    document.body.classList.remove('zp-pin-mode-active');
    document.documentElement.classList.remove('zp-pin-mode-active');

    scope.toggleParagraphLock('p1');

    expect(document.body.classList.contains('zp-pin-mode-active')).toEqual(true);
    expect(document.documentElement.classList.contains('zp-pin-mode-active')).toEqual(true);

    scope.toggleParagraphLock('p1');

    expect(document.body.classList.contains('zp-pin-mode-active')).toEqual(false);
    expect(document.documentElement.classList.contains('zp-pin-mode-active')).toEqual(false);
  });
});
