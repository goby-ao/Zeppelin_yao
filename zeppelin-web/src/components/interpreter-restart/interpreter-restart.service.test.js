describe('interpreterRestartService', function() {
  let service;
  let http;
  let toast;
  let confirm;
  let dialog;
  let previousDialog;

  beforeEach(angular.mock.module('zeppelinWebApp', function($provide) {
    toast = {info: jasmine.createSpy('info')};
    $provide.value('ngToast', toast);
    $provide.value('baseUrlSrv', {getRestApiBase: function() {
      return '/api';
    }});
  }));
  beforeEach(inject(function(interpreterRestartService, $httpBackend) {
    service = interpreterRestartService;
    http = $httpBackend;
    previousDialog = window.BootstrapDialog;
    dialog = {close: jasmine.createSpy('close'), setMessage: jasmine.createSpy('setMessage'),
      $modalFooter: {find: function() {
        return {prop: angular.noop};
      }}};
    window.BootstrapDialog = {
      confirm: jasmine.createSpy('confirm').and.callFake(function(options) {
        confirm = options;
        return dialog;
      }),
      alert: jasmine.createSpy('alert'),
    };
  }));
  afterEach(function() {
    http.verifyNoOutstandingExpectation();
    http.verifyNoOutstandingRequest();
    window.BootstrapDialog = previousDialog;
  });

  it('deduplicates across notebooks and warns after local close succeeds', function() {
    service.restart('hive', 'note1', '%hive');
    service.restart('hive', 'note2', '%hive');
    expect(BootstrapDialog.confirm.calls.count()).toBe(1);
    http.expectPUT('/api/interpreter/setting/restart/hive', {noteId: 'note1'}).respond(200, {});
    expect(confirm.callback(true)).toBe(false);
    http.flush();
    expect(dialog.close).toHaveBeenCalled();
    expect(toast.info.calls.mostRecent().args[0].content).toContain('远端 SQL 可能仍在运行');
    service.restart('hive', 'note2', '%hive');
    expect(BootstrapDialog.confirm.calls.count()).toBe(2);
    confirm.callback(false);
  });

  it('does not present a failed close as success and escapes backend details', function() {
    service.restart('hive', 'note1', '%hive');
    http.expectPUT('/api/interpreter/setting/restart/hive').respond(409, {message: '<script>bad</script>'});
    confirm.callback(true);
    http.flush();
    expect(toast.info).not.toHaveBeenCalled();
    const warning = BootstrapDialog.alert.calls.mostRecent().args[0];
    expect(warning.title).toBe('重启未确认完成');
    expect(warning.message).toContain('&lt;script&gt;');
    expect(dialog.close).toHaveBeenCalled();
  });

  it('releases the pending state after cancelling the confirmation', function() {
    service.restart('hive', 'note1', '%hive');
    confirm.callback(false);
    service.restart('hive', 'note1', '%hive');
    expect(BootstrapDialog.confirm.calls.count()).toBe(2);
    confirm.callback(false);
  });
});
