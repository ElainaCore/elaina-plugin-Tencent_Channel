(function () {
  'use strict';

  var API = '/api/ext/tencent-channel';
  var BASE = API + '/panel/';
  var state = window.TXPD_PANEL = { router: null, sync: null };
  var root = document.getElementById('app');
  var status = document.getElementById('txpd-startup');

  function readSession(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function normalizeRoute(value) {
    var path = String(value || '').replace(/^\/+/, '');
    // 仅恢复面板内路由，旧缓存或外部 URL 不参与启动。
    return /^(explore|index|g(?:\/[^?#]*)?|search(?:\/[^?#]*)?)(?:\?[^#]*)?$/.test(path) ? path : '';
  }
  function resolveRoute() {
    var loc = window.location;
    var local = loc.pathname.indexOf(BASE) === 0;
    var tail = local ? loc.pathname.slice(BASE.length).replace(/\/+$/, '') : '';
    var explicit = tail && tail !== 'index.html';
    var route = explicit ? normalizeRoute(tail + loc.search) : normalizeRoute(readSession('txpd_last_path'));
    return route || 'explore';
  }
  async function json(path) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch(API + path, { signal: controller.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var result = await response.json();
      if (!result.success) throw new Error(result.message || '读取面板状态失败');
      return result.data;
    } finally { clearTimeout(timer); }
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timer = setTimeout(function () { reject(new Error('面板脚本加载超时')); }, 15000);
      script.src = src;
      script.onload = function () { clearTimeout(timer); resolve(); };
      script.onerror = function () { clearTimeout(timer); reject(new Error('面板脚本加载失败')); };
      document.head.appendChild(script);
    });
  }
  function waitForApp() {
    return new Promise(function (resolve, reject) {
      var observer = new MutationObserver(check);
      var timer = setTimeout(function () {
        observer.disconnect();
        reject(new Error('面板初始化超时，请重试'));
      }, 30000);
      function check() {
        var app = root.__vue_app__;
        var nuxt = app && app.config.globalProperties.$nuxt;
        if (!nuxt || nuxt.isHydrating || !root.querySelector('#app-aside')) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(nuxt);
      }
      observer.observe(root, { childList: true, subtree: true });
      // suspense 完成时可能只改变内部状态，不产生新的 DOM 变更。
      if (window.useNuxtApp) {
        var nuxt = window.useNuxtApp();
        nuxt.hook('app:mounted', check);
        nuxt.hook('app:suspense:resolve', check);
      }
      check();
    });
  }
  function rememberRoute() {
    try {
      if (!state.embed) sessionStorage.setItem('txpd_last_path', location.pathname.slice(BASE.length) + location.search);
    } catch (e) { /* 禁用存储时仍可使用面板 */ }
  }
  function showFailure(error) {
    status.replaceChildren();
    status.hidden = false;
    var message = document.createElement('p');
    message.textContent = '面板加载失败：' + (error.message || String(error));
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新加载';
    retry.onclick = function () { location.reload(); };
    status.append(message, retry);
  }

  async function start() {
    // 在创建路由器之前确定唯一入口，禁止启动后反复 pushState/popstate 抢路由。
    state.route = resolveRoute();
    state.embed = /[?&]txpd_embed=1/.test(location.search) && window.self !== window.top;
    history.replaceState(history.state, '', BASE + state.route);
    var data = await Promise.all([json('/panel-cookie'), json('/accounts')]);
    state.session = data[0];
    state.accounts = data[1].accounts || [];
    state.anyAccount = state.accounts.some(function (account) { return account.logged_in; });
    var savedPage = readSession('txpd_last_page');
    var savedPagePath = readSession('txpd_last_page_path');
    state.page = !state.embed && savedPagePath === location.pathname && /^(manage|schedule|dm)$/.test(savedPage) ? savedPage : '';
    if (!state.embed && !state.anyAccount && !state.page) state.page = 'manage';
    document.body.classList.toggle('txpd-logged-in', state.anyAccount);

    // 旧组件读取此接口；面板只保留兼容方法，不启动官网的统计 SDK。
    var noop = function () {};
    window.AegisV2 = { setConfig: noop, reportEvent: noop, reportTime: noop, info: noop,
      error: noop, time: noop, timeEnd: noop, report: noop };

    // 保留现有全部组件、CSS 与交互代码，只改变启动顺序和首屏来源。
    await loadScript(BASE + 'assets/txpd-inject.js');
    await import(BASE + 'assets/polyfills.BKOhrc52.js');
    await import(BASE + 'assets/entry.B7UWswv3.js');
    var nuxt = await waitForApp();
    state.router = nuxt.$router;
    await state.router.isReady();
    if (state.mount) state.mount();
    if (state.sync) state.sync();
    state.router.afterEach(function () {
      rememberRoute();
      if (state.sync) state.sync();
    });
    rememberRoute();
    // 同一帧内先完成插件导航、登录态、目标视图，再公开组件树。
    document.documentElement.classList.remove('txpd-booting');
    status.hidden = true;
    window.dispatchEvent(new CustomEvent('txpd:ready'));
  }
  start().catch(showFailure);
})();
