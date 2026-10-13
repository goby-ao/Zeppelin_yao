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

// Real Angular directive and styles, isolated from the backend and application build.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(__dirname, '..');
const nav = 'src/app/notebook/paragraph-nav/paragraph-nav';
const read = (file) => fs.readFileSync(path.join(web, file), 'utf8');

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.fulfill({
      contentType: 'text/html', body: '<html><body></body></html>',
    }));
    await page.goto('http://paragraph-nav.test/');
    await page.addScriptTag({content: read('bower_components/angular/angular.js')});
    await page.evaluate((template) => {
      angular.module('zeppelinWebApp', []);
      window.require = () => template;
      window.observerCount = 0;
      // Observe real elements while counting unwanted observer rebuilds on status updates.
      const OriginalObserver = window.IntersectionObserver;
      window.IntersectionObserver = function(...args) {
        window.observerCount++;
        return new OriginalObserver(...args);
      };
    }, read(nav + '.html'));
    await page.addScriptTag({content: read(nav + '.js')});
    await page.addStyleTag({content: read(nav + '.css')});
    await page.evaluate(() => {
      const injector = angular.injector(['ng', 'zeppelinWebApp']);
      window.scope = injector.get('$rootScope').$new();
      scope.paragraphs = [
        {id: 'p1', title: 'Query', status: 'FINISHED', text: 'select 1'},
        {id: 'p2', title: 'Another query', status: 'READY', text: 'select 2'},
        {id: 'p3', title: 'Completed query', status: 'FINISHED'},
      ];
      scope.onClick = (id) => { scope.clickedId = id; };
      const element = injector.get('$compile')(
        '<paragraph-nav paragraphs="paragraphs" locked-paragraph-id="lockedId" ' +
        'on-node-click="onClick(paragraphId)"></paragraph-nav>')(scope);
      document.body.appendChild(element[0]);
      scope.$digest();
      window.navScope = element.isolateScope();
    });
    const nodes = page.locator('.paragraph-nav-node');
    assert.equal(await nodes.count(), 3);
    const observers = await page.evaluate(() => observerCount);

    async function status(value, index = 0) {
      await page.evaluate(({value, index}) => {
        // Same paragraph object, matching websocket status updates and local run actions.
        scope.paragraphs[index].status = value;
        scope.$digest();
      }, {value, index});
      assert.equal(await page.evaluate((i) => navScope.nodes[i].status, index), value,
        'Navigation must track in-place paragraph status updates');
    }

    await status('PENDING');
    assert.match(await nodes.first().getAttribute('class'), /pending/);
    await status('RUNNING');
    assert.match(await nodes.first().getAttribute('class'), /running/);
    const dot = nodes.first().locator('.nav-node-dot');
    const animation = await dot.evaluate((el) => {
      const style = getComputedStyle(el, '::after');
      return {name: style.animationName, duration: style.animationDuration,
        iteration: style.animationIterationCount};
    });
    assert.deepEqual(animation, {name: 'nav-spin', duration: '1s', iteration: 'infinite'});
    await page.screenshot({path: '/tmp/zeppelin-paragraph-nav-running.png'});
    const before = await dot.evaluate((el) => getComputedStyle(el, '::after').transform);
    await page.waitForFunction((before) => {
      const dot = document.querySelector('.paragraph-nav-node.running .nav-node-dot');
      return getComputedStyle(dot, '::after').transform !== before;
    }, before, {timeout: 3000});
    await status('RUNNING', 1);
    assert.equal(await page.locator('.paragraph-nav-node.running').count(), 2);
    await page.evaluate(() => { scope.lockedId = 'p1'; scope.$digest(); });
    assert.match(await nodes.first().getAttribute('class'), /locked/);
    await nodes.first().click();
    assert.equal(await page.evaluate(() => scope.clickedId), 'p1');
    await nodes.first().hover();
    assert.equal(await page.locator('.status-label').textContent(), 'Running');
    await page.mouse.move(600, 450);
    await page.waitForTimeout(250);
    await page.screenshot({path: '/tmp/zeppelin-paragraph-nav-running.png'});

    for (const value of ['FINISHED', 'ERROR', 'ABORT', 'READY']) {
      await status(value);
      assert.doesNotMatch(await nodes.first().getAttribute('class'), /\brunning\b/);
      assert.equal(await dot.evaluate((el) => getComputedStyle(el, '::after').animationName), 'none');
    }
    assert.equal(await page.evaluate(() => observerCount), observers,
      'Status updates must not recreate navigation observers');
    await page.evaluate(() => { scope.paragraphs.reverse(); scope.$digest(); });
    assert.equal(await page.evaluate(() => navScope.nodes[2].id), 'p1');
    await status('RUNNING', 2);
    assert.match(await nodes.nth(2).getAttribute('class'), /running/);
    await page.evaluate(() => {
      scope.paragraphs = Array.from({length: 31}, (_, i) => ({id: 'p' + i, status: 'READY'}));
      scope.$digest();
    });
    assert.equal(await nodes.count(), 0);
    await page.evaluate(() => {
      scope.paragraphs.pop();
      scope.$digest();
    });
    assert.equal(await nodes.count(), 30);
    await page.setViewportSize({width: 375, height: 812});
    assert.equal(await page.locator('.paragraph-nav-container').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: live status, rotating indicator, concurrent runs, pin, click, tooltip, ' +
      'terminal states, reorder, paragraph limit and mobile visibility');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
