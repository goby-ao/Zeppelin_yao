describe('Service: noteActionService output cleanup', function() {
  beforeEach(angular.mock.module('zeppelinWebApp'));

  let service;
  let websocket;
  let toast;
  let options;
  let modal;

  beforeEach(inject(function(noteActionService, websocketMsgSrv, ngToast) {
    service = noteActionService;
    websocket = websocketMsgSrv;
    toast = ngToast;
    modal = angular.element('<div></div>');
    spyOn(websocket, 'clearAllParagraphOutput');
    spyOn(toast, 'info');
    spyOn(BootstrapDialog, 'confirm').and.callFake(function(config) {
      options = config;
      return {getModal: function() {
        return modal;
      }};
    });
  }));

  it('keeps results when the user cancels', function() {
    service.clearAllParagraphOutput('note-1');
    options.callback(false);
    expect(websocket.clearAllParagraphOutput).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('rechecks eligibility before sending the clear request', function() {
    let allowed = true;
    service.clearAllParagraphOutput('note-1', function() {
      return allowed;
    });
    allowed = false;
    options.callback(true);
    expect(websocket.clearAllParagraphOutput).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('supports the existing home-page caller and reports submission, not success', function() {
    service.clearAllParagraphOutput('note-1');
    options.callback(true);
    expect(websocket.clearAllParagraphOutput).toHaveBeenCalledWith('note-1');
    expect(toast.info.calls.mostRecent().args[0].content).toContain('请求已提交');
    expect(modal.hasClass('zp-clear-output-dialog')).toBe(true);
  });
});
