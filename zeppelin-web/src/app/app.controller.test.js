describe('Controller: MainCtrl', function() {
  beforeEach(angular.mock.module('zeppelinWebApp'));

  let scope;
  let rootScope;

  beforeEach(inject(function($controller, $rootScope) {
    rootScope = $rootScope;
    scope = $rootScope.$new();
    $controller('MainCtrl', {
      $scope: scope,
    });
  }));

  it('should attach "asIframe" to the scope and the default value should be false', function() {
    expect(scope.asIframe).toBeDefined();
    expect(scope.asIframe).toEqual(false);
  });

  it('should set the default value of "looknfeel to "default"', function() {
    expect(scope.looknfeel).toEqual('default');
  });

  it('should set "asIframe" flag to true when a controller broadcasts setIframe event', function() {
    rootScope.$broadcast('setIframe', true);
    expect(scope.asIframe).toEqual(true);
  });
});

describe('Factory: httpInterceptor', function() {
  beforeEach(angular.mock.module('zeppelinWebApp'));

  let httpInterceptor;
  let rootScope;

  beforeEach(inject(function(_httpInterceptor_, $rootScope) {
    httpInterceptor = _httpInterceptor_;
    rootScope = $rootScope;
  }));

  it('does not broadcast session logout for login endpoint GET 405', function() {
    let sessionLogoutBroadcasted = false;
    rootScope.$on('session_logout', function() {
      sessionLogoutBroadcasted = true;
    });

    httpInterceptor.responseError({
      status: 405,
      config: {
        method: 'GET',
        url: 'https://dc.migu.cn/mgwh/zeppelin/api/login',
      },
    }).catch(angular.noop);
    rootScope.$digest();

    expect(sessionLogoutBroadcasted).toBe(false);
  });

  it('keeps broadcasting session logout for other 405 responses', function() {
    let sessionLogoutBroadcasted = false;
    rootScope.$on('session_logout', function() {
      sessionLogoutBroadcasted = true;
    });

    httpInterceptor.responseError({
      status: 405,
      config: {
        method: 'GET',
        url: 'https://dc.migu.cn/mgwh/zeppelin/api/notebook',
      },
    }).catch(angular.noop);
    rootScope.$digest();

    expect(sessionLogoutBroadcasted).toBe(true);
  });
});
