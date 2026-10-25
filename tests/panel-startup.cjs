/* Run with Node and Playwright installed: node tests/panel-startup.cjs */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const panel = path.resolve(__dirname, '../web/panel');
const prefix = '/api/ext/tencent-channel';
let loggedIn = false;
let failAccounts = false;
let baseline = false;
const originals = {};
if (process.env.PANEL_COMPARE_BASELINE) {
  for (const file of ['index.html', 'assets/txpd-inject.js']) {
    originals[file] = execFileSync('git', ['show', 'HEAD:web/panel/' + file], {cwd:path.dirname(panel), maxBuffer:2*1024*1024});
  }
}
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const url = new URL(req.url, 'http://localhost');
  const send = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname.startsWith(prefix + '/panel/')) {
    const tail = url.pathname.slice((prefix + '/panel/').length);
    const file = tail.startsWith('assets/') ? path.join(panel, 'assets', path.basename(tail)) : path.join(panel, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    const relative = path.relative(panel, file).replaceAll('\\', '/');
    res.end(baseline && originals[relative] ? originals[relative] : fs.readFileSync(file));
    return;
  }
  if (url.pathname === prefix + '/accounts') {
    if (failAccounts) { res.writeHead(503); res.end('unavailable'); return; }
    send({success: true, data: {current: 'test', accounts: loggedIn ? [{name:'test', current:true, logged_in:true}] : []}});
  } else if (url.pathname === prefix + '/panel-cookie') {
    send({success: true, data: {user:'test', cookies:{}, session_valid:false}});
  } else if (url.pathname === prefix + '/cli') {
    let body = '';
    req.on('data', b => body += b);
    req.on('end', () => {
      const {action} = JSON.parse(body);
      const data = action === 'guilds' ? {created_guilds:[],managed_guilds:[],joined_guilds:[]} : action === 'channels' ? {channels:[]} : action === 'guild-info' ? {name:'测试频道',guild_number:'123',guild_id:'456'} : action === 'feeds' ? {feeds:[]} : {};
      send({success:true,data:{data}});
    });
  } else if (url.pathname === prefix + '/web-login/status') send({success:true,data:{logged_in:false}});
  else if (url.pathname === prefix + '/notify-settings') send({success:true,data:{dm_merge_window:0,max:600,notify_poll_interval:60,poll_interval_min:10,poll_interval_max:600}});
  else if (url.pathname === prefix + '/admins') send({success:true,data:{admins:[]}});
  else if (url.pathname === prefix + '/schedules') send({success:true,data:{schedules:[],cron_examples:[]}});
  else if (url.pathname === prefix + '/history') send({success:true,data:{history:[]}});
  else send({retcode:0,error:{code:0,message:''},data:{vecFeed:[],topFeeds:[],channels:[],rpt_msg_guild_info_list:[],isFinish:true}});
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('PAGE:', e.stack || e.message); });
    await page.addInitScript(() => {
      window.__startupFrames = [];
      function sample() {
        const root = document.getElementById('app');
        if (root && getComputedStyle(root).visibility !== 'hidden' && root.children.length) {
          window.__startupFrames.push({path:location.pathname, manage:!!document.querySelector('.txpd-manage'), nav:!!document.querySelector('.txpd-nav-admin')});
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    async function ready() {
      try {
        await page.waitForFunction(() => !document.documentElement.classList.contains('txpd-booting'), null, {timeout:40000});
      } catch (error) {
        console.error(await page.evaluate(() => ({status:document.getElementById('txpd-startup').textContent, root:document.getElementById('app').innerHTML.slice(0,1200), app:!!document.getElementById('app').__vue_app__, boot:Object.keys(window.TXPD_PANEL || {})})));
        console.error('Last requests:', requests.slice(-30));
        throw error;
      }
    }
    await page.goto(origin + prefix + '/panel/');
    await ready();
    assert.equal(await page.locator('.txpd-manage').count(), 1, 'no account must enter management directly');
    assert.ok((await page.evaluate(() => window.__startupFrames)).every(f => f.manage && f.nav), 'every visible frame must be adapted');
    console.log('PASS: no account enters management on the first visible frame');

    if (process.env.PANEL_COMPARE_BASELINE) {
      const { PNG } = require('pngjs');
      for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(1800);
        const current = PNG.sync.read(await page.screenshot());
        baseline = true;
        const oldPage = await context.newPage();
        await oldPage.setViewportSize(viewport);
        await oldPage.goto(origin + prefix + '/panel/');
        await oldPage.locator('.txpd-manage').waitFor();
        await oldPage.waitForTimeout(4000);
        const old = PNG.sync.read(await oldPage.screenshot());
        let changed = 0;
        for (let i=0;i<current.data.length;i+=4) {
          if (Math.max(...[0,1,2].map(c=>Math.abs(current.data[i+c]-old.data[i+c]))) > 10) changed++;
        }
        const ratio = changed / (current.width*current.height);
        console.log('Visual difference', viewport.width, (ratio*100).toFixed(3)+'%');
        if (ratio > .005) {
          const os = require('node:os');
          fs.writeFileSync(path.join(os.tmpdir(), 'txpd-current-'+viewport.width+'.png'), PNG.sync.write(current));
          fs.writeFileSync(path.join(os.tmpdir(), 'txpd-baseline-'+viewport.width+'.png'), PNG.sync.write(old));
        }
        assert.ok(ratio < .005, 'the existing management UI must stay visually identical');
        await oldPage.close();
        baseline = false;
      }
      await page.setViewportSize({width:1280,height:720});
    }

    loggedIn = true;
    await page.getByText('定时发帖', {exact:true}).click();
    await page.locator('.txpd-sched-page').waitFor();
    await page.reload();
    await ready();
    assert.equal(await page.locator('.txpd-sched-page').count(), 1);
    console.log('PASS: refresh restores the plugin view without an exploration flash');

    await page.evaluate(() => { sessionStorage.setItem('txpd_last_path', 'index'); sessionStorage.removeItem('txpd_last_page'); });
    await page.goto(origin + prefix + '/panel/');
    await ready();
    assert.equal(new URL(page.url()).pathname, prefix + '/panel/index');
    assert.equal(await page.locator('.txpd-dynamic').count(), 1);
    console.log('PASS: the saved dynamic route mounts directly');

    await page.goto(origin + prefix + '/panel/explore');
    await ready();
    assert.equal(new URL(page.url()).pathname, prefix + '/panel/explore');
    assert.equal(await page.locator('.txpd-nav-explore.txpd-nav-active').count(), 1);
    assert.ok((await page.evaluate(() => window.__startupFrames)).every(f => f.nav));
    console.log('PASS: explicit exploration route wins over saved state');

    await page.goto(origin + prefix + '/panel/g/123');
    await ready();
    assert.equal(new URL(page.url()).pathname, prefix + '/panel/g/123');
    assert.equal(await page.locator('#explorePage').count(), 0);
    console.log('PASS: guild deep link mounts without exploration SSR');

    failAccounts = true;
    await page.goto(origin + prefix + '/panel/');
    await page.getByText('面板加载失败：HTTP 503', {exact:true}).waitFor();
    assert.equal(await page.locator('#txpd-startup button').textContent(), '重新加载');
    console.log('PASS: startup errors offer a visible retry');
    // The mirrored components reject a bare Event when their remote SDK is blocked in this offline test.
    const unexpected = errors.filter(e => e !== 'Event' && !e.includes('Failed to fetch') && !e.includes('Importing a module script failed'));
    assert.deepEqual(unexpected, [], 'no unexpected browser exceptions');
    console.log('Browser errors:', JSON.stringify(errors));
    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
