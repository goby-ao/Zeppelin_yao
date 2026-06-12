describe('Controller: ResultCtrl', function() {
  beforeEach(angular.mock.module('zeppelinWebApp'));

  let scope;
  let rootScope;
  let controller;
  let resultMock = {
    type: 'TEXT',
    data: '',
  };
  let configMock = {
  };
  let paragraphMock = {
    id: 'p1',
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

  beforeEach(inject(function($controller, $rootScope) {
    rootScope = $rootScope;
    scope = $rootScope.$new();
    scope.$parent = $rootScope.$new(true, $rootScope);
    scope.$parent.paragraph = paragraphMock;

    controller = $controller('ResultCtrl', {
      $scope: scope,
      $route: route,
    });

    scope.init(resultMock, configMock, paragraphMock, 1);
  }));

  it('scope should be initialized', function() {
    expect(scope).toBeDefined();
    expect(controller).toBeDefined();
  });

  it('should allow plain text copy when copy disable switch is off', function() {
    rootScope.disableCopyEnabled = false;

    expect(scope.shouldDisablePlainTextCopy()).toBe(false);
  });

  it('should disable plain text copy without enable flag', function() {
    rootScope.disableCopyEnabled = true;
    scope.$parent.paragraph.text = '%sh\necho test';

    expect(scope.shouldDisablePlainTextCopy()).toBe(true);
  });

  it('should allow plain text copy when first two input lines contain enable flag', function() {
    rootScope.disableCopyEnabled = true;
    scope.$parent.getEditorValue = function() {
      return '%sh\n#;;; allow copy\necho test';
    };

    expect(scope.shouldDisablePlainTextCopy()).toBe(false);
  });

  it('should allow plain text copy when SQL table copy flag is configured', function() {
    rootScope.disableCopyEnabled = true;
    scope.$parent.getEditorValue = function() {
      return '%sql\n--;;; allow copy\nselect 1';
    };

    expect(scope.shouldDisablePlainTextCopy()).toBe(false);
  });

  it('should allow plain text copy when SQL copy shortcut flag is configured', function() {
    rootScope.disableCopyEnabled = true;
    scope.$parent.getEditorValue = function() {
      return '%sql\n--## allow copy\nselect 1';
    };

    expect(scope.shouldDisablePlainTextCopy()).toBe(false);
  });

  it('should ignore plain text copy enable flag after the first two input lines', function() {
    rootScope.disableCopyEnabled = true;
    scope.$parent.getEditorValue = function() {
      return '%sh\necho test\n#;;; allow copy';
    };

    expect(scope.shouldDisablePlainTextCopy()).toBe(true);
  });
});
