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

// Isolated browser regression: real Angular/Ace/controller, no application build or backend.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {createRequire} = require('module');
const web = path.resolve(__dirname, '..');
const localRequire = createRequire(path.join(web, 'package.json'));
const babel = localRequire('babel-core');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    // All requests stay in memory, including Ace's optional dynamic asset requests.
    await page.route('**/*', (route) => route.fulfill(route.request().resourceType() === 'document' ?
      {contentType: 'text/html', body: '<html><body></body></html>'} :
      {contentType: 'application/javascript', body: ''}));
    await page.goto('http://text-sync.test/');
    async function script(file) {
      await page.addScriptTag({content: fs.readFileSync(path.join(web, file), 'utf8')});
    }
    await script('node_modules/jasmine-core/lib/jasmine-core/jasmine.js');
    await page.evaluate(() => {
      window.jasmine = jasmineRequire.core(jasmineRequire);
      Object.assign(window, jasmineRequire.interface(jasmine, jasmine.getEnv()));
    });
    for (const file of [
      'bower_components/jquery/dist/jquery.js',
      'bower_components/angular/angular.js',
      'bower_components/angular-mocks/angular-mocks.js',
      'bower_components/ace-builds/src-noconflict/ace.js',
      'bower_components/ace-builds/src-noconflict/ext-language_tools.js',
      'bower_components/ace-builds/src-noconflict/theme-chrome.js',
      'bower_components/ace-builds/src-noconflict/mode-text.js',
      'bower_components/ace-builds/src-noconflict/keybinding-emacs.js',
      'bower_components/angular-ui-ace/ui-ace.js',
      'node_modules/lodash/lodash.js',
      'node_modules/moment/moment.js',
      'node_modules/moment-duration-format/lib/moment-duration-format.js',
    ]) {
      await script(file);
    }
    await page.evaluate(() => {
      window.modules = {moment: window.moment, 'moment-duration-format': {}};
      window.require = (name) => {
        if (!(name in window.modules)) throw Error('Missing module: ' + name);
        return window.modules[name];
      };
      window.module = {exports: {}};
      angular.module('zeppelinWebApp', ['ui.ace'])
        .value('$route', {current: {pathParams: {noteId: 'noteId'}}})
        .value('$routeParams', {noteId: 'noteId'})
        .value('baseUrlSrv', {getRestApiBase: () => '/api'})
        .value('ngToast', {danger: () => {}})
        .value('noteVarShareService', {put: () => {}, remove: () => {}})
        .value('heliumService', {getSpellByMagic: () => null});
    });
    await script('node_modules/diff-match-patch/index.js');
    await page.evaluate(() => { modules['diff-match-patch'] = module.exports; });

    async function source(file, name) {
      // Optional red/green comparison reads git objects without altering the worktree.
      const input = name === 'controller' && process.env.PARAGRAPH_SOURCE_REF ?
        execFileSync('git', ['show', process.env.PARAGRAPH_SOURCE_REF + ':zeppelin-web/' + file],
          {cwd: web, encoding: 'utf8'}) : fs.readFileSync(path.join(web, file), 'utf8');
      const code = babel.transform(input, {babelrc: false,
        plugins: [localRequire.resolve('babel-plugin-transform-es2015-modules-commonjs')]}).code;
      await page.addScriptTag({content: '(function(){var exports={};\n' + code +
        '\nwindow.modules[' + JSON.stringify(name) + ']=exports;})();'});
    }
    await source('src/app/spell/spell-result.js', '../../spell');
    await source('src/app/notebook/paragraph/paragraph.status.js', './paragraph.status');
    await source('src/app/notebook/paragraph/paragraph.controller.js', 'controller');
    await script('src/app/notebook/paragraph/paragraph.controller.test.js');
    await script('src/app/notebook/paragraph/paragraph.text-sync.test.js');
    const results = await page.evaluate(() => new Promise((resolve) => {
      const specs = [];
      jasmine.getEnv().addReporter({
        specDone: (result) => specs.push({name: result.fullName, status: result.status,
          failureCount: result.failedExpectations.length,
          failures: result.failedExpectations.slice(0, 5).map((failure) => failure.message)}),
        jasmineDone: (result) => resolve({status: result.overallStatus, specs,
          errors: result.failedExpectations.map((failure) => failure.message)}),
      });
      jasmine.getEnv().configure({random: false});
      jasmine.getEnv().execute();
    }));
    console.log(JSON.stringify({status: results.status, total: results.specs.length,
      passed: results.specs.filter((spec) => spec.status === 'passed').length,
      failures: results.specs.filter((spec) => spec.status !== 'passed'),
      errors: results.errors.concat(browserErrors)}, null, 2));
    process.exitCode = results.status === 'passed' && results.specs.length > 0 &&
      browserErrors.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
