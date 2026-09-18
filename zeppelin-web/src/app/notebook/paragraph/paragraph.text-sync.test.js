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

describe('Paragraph editor text synchronization', function() {
  beforeEach(angular.mock.module('zeppelinWebApp'));

  let scope;
  let root;
  let editor;
  let element;
  let websocket;
  const oldText = 'select 20260720';
  const newText = 'select 20260721';

  beforeEach(inject(function($controller, $rootScope, $compile, $q) {
    root = $rootScope;
    scope = root.$new();
    root.notebookScope = root.$new(true, root);
    scope.startSaveTimer = jasmine.createSpy('startSaveTimer');
    websocket = {
      runParagraph: jasmine.createSpy('runParagraph').and.callFake(function(id) {
        root.$broadcast('updateStatus', {id: id, status: 'PENDING'});
      }),
      commitParagraph: jasmine.createSpy('commitParagraph').and.callFake(() => $q.resolve()),
      patchParagraph: jasmine.createSpy('patchParagraph'),
      getEditorSetting: jasmine.createSpy('getEditorSetting'),
    };
    $controller('ParagraphCtrl', {
      $scope: scope,
      $route: {current: {pathParams: {noteId: 'noteId'}}},
      websocketMsgSrv: websocket,
    });
    scope.init({id: 'p1', title: '', text: oldText, status: 'READY',
      config: {editorSetting: {}}, settings: {forms: {}, params: {}}, results: {msg: []}});
    element = angular.element('<div id="p1_paragraphColumn_main"><div id="p1_editor" ' +
      'style="width:600px;height:100px" ui-ace="{onLoad: aceLoaded, useWorker: false}" ' +
      'ng-model="paragraph.text"></div></div>');
    angular.element(document.body).append(element);
    $compile(element)(scope);
    root.$digest();
    editor = scope.editor;
  }));

  afterEach(function() {
    // Do not let Ace's delayed callback leak into the next Jasmine fixture.
    editor._$emitInputEvent.cancel();
    scope.$destroy();
    element.remove();
  });

  function receive(text, status, extra, digest) {
    const paragraph = angular.copy(scope.paragraph);
    paragraph.text = text;
    paragraph.status = status || 'RUNNING';
    angular.extend(paragraph, extra);
    // angular-websocket delivers messages via $applyAsync; preserve that queue order.
    root.$applyAsync(() => root.$broadcast('updateParagraph', {paragraph: paragraph}));
    if (digest !== false) {
      root.$digest();
    }
  }

  it('keeps the submitted code after acknowledgement followed by an old running snapshot', function() {
    editor.setValue(newText, -1);
    scope.paragraphFocused = true;
    root.$broadcast('keyEvent', {keyCode: 13, shiftKey: true, preventDefault: angular.noop});
    receive(newText, 'RUNNING');
    receive(oldText, 'RUNNING');

    expect(websocket.runParagraph.calls.mostRecent().args[2]).toBe(newText);
    expect(editor.getValue()).toBe(newText);
    expect(scope.paragraph.text).toBe(newText);
    expect(scope.paragraph.status).toBe('RUNNING');
  });

  it('saves live Ace text even before its delayed input event updates dirtyText', function() {
    scope.dirtyText = oldText;
    editor.setValue(newText, -1);
    scope.saveParagraph(scope.paragraph);

    expect(websocket.commitParagraph).toHaveBeenCalled();
    if (websocket.commitParagraph.calls.any()) {
      expect(websocket.commitParagraph.calls.mostRecent().args[2]).toBe(newText);
    }
  });

  it('protects live edits from old snapshots before the Ace input event', function() {
    editor.setValue(newText, -1);
    root.$digest();
    receive(oldText);

    expect(editor.getValue()).toBe(newText);
  });

  ['FINISHED', 'ERROR', 'ABORT'].forEach(function(status) {
    it('keeps text but processes a stale ' + status + ' result, then resumes remote editing', function() {
      editor.setValue(newText, -1);
      scope.runParagraphFromButton();
      receive(newText, 'RUNNING');
      const results = {code: 'SUCCESS', msg: [{type: 'TEXT', data: 'completed'}]};
      receive(oldText, status, {results: results, errorMessage: 'detail'});
      expect(editor.getValue()).toBe(newText);
      expect(scope.paragraph.status).toBe(status);
      expect(scope.paragraph.results).toEqual(results);
      expect(scope.paragraph.errorMessage).toBe('detail');
      expect(editor.getReadOnly()).toBe(false);

      receive(newText, status);
      receive('select 20260722', status);
      expect(editor.getValue()).toBe('select 20260722');
    });
  });

  it('protects a run even when collaboration has already advanced originalText', function() {
    scope.collaborativeMode = true;
    editor.setValue(newText, -1);
    scope.aceChanged(null, editor);
    expect(scope.originalText).toBe(newText);
    scope.runParagraphFromButton();
    receive(oldText);
    expect(editor.getValue()).toBe(newText);
  });

  it('keeps a newer local edit when an earlier save is acknowledged', function() {
    editor.setValue(newText, -1);
    scope.saveParagraph(scope.paragraph);
    editor.setValue('select 20260722', -1);
    receive(newText, 'READY');
    expect(editor.getValue()).toBe('select 20260722');
  });

  it('saves and acknowledges an intentionally empty editor', function() {
    editor.setValue('', -1);
    scope.saveParagraph(scope.paragraph);
    expect(websocket.commitParagraph.calls.mostRecent().args[2]).toBe('');
    receive('', 'READY');
    expect(editor.getValue()).toBe('');
    expect(scope.pendingText).toBeUndefined();
  });

  it('accepts consecutive remote edits in one digest without inventing a local change', function() {
    receive(newText, 'READY', {}, false);
    receive('select 20260722', 'READY');
    expect(editor.getValue()).toBe('select 20260722');
    scope.aceChanged(null, editor);
    expect(websocket.commitParagraph).not.toHaveBeenCalled();
    expect(websocket.patchParagraph).not.toHaveBeenCalled();
    expect(scope.startSaveTimer).not.toHaveBeenCalled();
  });

  it('does not resubmit remote text when delayed input fires', function() {
    scope.collaborativeMode = true;
    receive(newText, 'READY');
    scope.aceChanged(null, editor);
    expect(websocket.patchParagraph).not.toHaveBeenCalled();
    expect(scope.startSaveTimer).not.toHaveBeenCalled();
    expect(scope.originalText).toBe(newText);
  });

  it('uses the next run text after completing a previous run', function() {
    editor.setValue(newText, -1);
    scope.runParagraphFromButton();
    receive(newText, 'FINISHED');
    editor.setValue('select 20260722', -1);
    scope.runParagraphFromButton();
    receive('select 20260722');
    receive(newText);
    expect(editor.getValue()).toBe('select 20260722');
  });

  it('processes progress while preserving submitted text', function() {
    editor.setValue(newText, -1);
    scope.runParagraphFromButton();
    receive(newText);
    receive(oldText);
    root.$broadcast('updateProgress', {id: 'p1', progress: 61});
    expect(scope.getProgress()).toBe(61);
    expect(editor.getValue()).toBe(newText);
  });

  it('accepts a collaborative patch while idle', function() {
    const patch = scope.diffMatchPatch.patch_make(oldText, newText).toString();
    root.$applyAsync(() => root.$broadcast('patchReceived', {paragraphId: 'p1', patch: patch}));
    root.$digest();
    expect(editor.getValue()).toBe(newText);
    scope.aceChanged(null, editor);
    expect(websocket.patchParagraph).not.toHaveBeenCalled();
  });

  it('lets the user edit again after an unconfirmed failed run', function() {
    editor.setValue(newText, -1);
    scope.runParagraphFromButton();
    receive(oldText, 'ERROR');
    editor.setValue('select 20260722', -1);
    scope.saveParagraph(scope.paragraph);
    receive('select 20260722', 'ERROR');
    receive('select 20260723', 'ERROR');
    expect(editor.getValue()).toBe('select 20260723');
  });

  it('does not save the old Ace value while an accepted remote model awaits rendering', function() {
    receive(newText, 'READY', {}, false);
    root.$applyAsync(() => scope.toggleOutput(scope.paragraph));
    root.$digest();
    expect(websocket.commitParagraph.calls.mostRecent().args[2]).toBe(newText);
    expect(editor.getValue()).toBe(newText);
  });

  it('does not accept updates for another paragraph or for revision view', function() {
    receive(newText, 'READY', {id: 'other'});
    expect(editor.getValue()).toBe(oldText);
    scope.revisionView = true;
    receive(newText, 'READY');
    expect(editor.getValue()).toBe(oldText);
  });

  it('keeps a legitimate collaborative patch during a locally submitted run', function() {
    editor.setValue(newText, -1);
    scope.runParagraphFromButton();
    receive(newText);
    const merged = newText + ' limit 1';
    const patch = scope.diffMatchPatch.patch_make(newText, merged).toString();
    root.$applyAsync(() => root.$broadcast('patchReceived', {paragraphId: 'p1', patch: patch}));
    root.$digest();
    receive(newText);
    expect(editor.getValue()).toBe(merged);
    receive(merged, 'FINISHED');
    receive('select 20260722', 'FINISHED');
    expect(editor.getValue()).toBe('select 20260722');
  });

  it('rebases an incoming patch without acknowledging an unsent local edit', function() {
    scope.collaborativeMode = true;
    editor.setValue(newText, -1);
    const remoteText = oldText + ' limit 1';
    const patch = scope.diffMatchPatch.patch_make(oldText, remoteText).toString();
    root.$applyAsync(() => root.$broadcast('patchReceived', {paragraphId: 'p1', patch: patch}));
    root.$digest();
    expect(editor.getValue()).toBe(newText + ' limit 1');
    expect(scope.originalText).toBe(remoteText);
    scope.aceChanged(null, editor);
    expect(websocket.patchParagraph).toHaveBeenCalled();
    if (websocket.patchParagraph.calls.any()) {
      const outgoingPatch = websocket.patchParagraph.calls.mostRecent().args[2];
      expect(scope.diffMatchPatch.patch_apply(scope.diffMatchPatch.patch_fromText(outgoingPatch), remoteText)[0])
        .toBe(newText + ' limit 1');
    }
  });

  it('survives 100 quick edit/run cycles with different input and reply timings', function() {
    for (let i = 0; i < 100; i++) {
      const previous = editor.getValue();
      const current = 'select ' + (20260721 + i);
      editor.setValue(current, -1);
      if (i % 2 === 0) {
        scope.aceChanged(null, editor);
      }
      scope.runParagraphFromShortcut(editor.getValue());
      receive(current, i % 3 === 0 ? 'PENDING' : 'RUNNING');
      scope.aceChanged(null, editor);
      receive(previous, 'RUNNING');
      expect(websocket.runParagraph.calls.mostRecent().args[2]).toBe(current);
      expect(editor.getValue()).toBe(current);
      receive(current, 'FINISHED');
    }
  });

  it('preserves local edits when two remote patches arrive before Ace renders', function() {
    scope.collaborativeMode = true;
    editor.setValue(newText, -1);
    const firstRemoteText = oldText + ' limit 1';
    const secondRemoteText = firstRemoteText + ';';
    [scope.diffMatchPatch.patch_make(oldText, firstRemoteText).toString(),
      scope.diffMatchPatch.patch_make(firstRemoteText, secondRemoteText).toString()].forEach(function(patch) {
      root.$applyAsync(() => root.$broadcast('patchReceived', {paragraphId: 'p1', patch: patch}));
    });
    root.$digest();
    expect(editor.getValue()).toBe(newText + ' limit 1;');
    expect(scope.originalText).toBe(secondRemoteText);
    scope.aceChanged(null, editor);
    expect(websocket.patchParagraph).toHaveBeenCalled();
  });

  it('does not let delayed input overwrite an accepted model while viewport watchers are suspended', function() {
    const watchers = scope.$$watchers;
    scope.$$watchers = null;
    try {
      receive(newText, 'READY');
      expect(editor.getValue()).toBe(oldText);
      scope.aceChanged(null, editor);
      expect(scope.paragraph.text).toBe(newText);
    } finally {
      scope.$$watchers = watchers;
    }
    root.$digest();
    expect(editor.getValue()).toBe(newText);
  });
});
