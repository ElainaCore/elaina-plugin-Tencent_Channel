(function () {
  'use strict';
  var BASE = '/api/ext/tencent-channel/panel/';
  function read(key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function cached() { try { return JSON.parse(localStorage.getItem('txpd_panel_account') || 'null'); } catch (e) { return null; } }
  function route(value) {
    var path = String(value || '').replace(/^\/+/, '').replace(/\/$/, '');
    var decoded;
    try { decoded = decodeURIComponent(path.split('?')[0]); } catch (e) { return ''; }
    if (/(^|\/)\.{1,2}(\/|$)/.test(decoded)) return '';
    return /^(explore|index|g\/[^?#]+|search)(?:\?[^#]*)?$/.test(path) ? path : '';
  }
  var local = location.pathname.indexOf(BASE) === 0;
  var tail = local ? location.pathname.slice(BASE.length) : '';
  var explicit = tail && tail !== 'index.html';
  var initial = (explicit ? route(tail + location.search) : route(read('txpd_last_path'))) || 'explore';
  var account = cached();
  var state = window.TXPD_PANEL = {
    route: initial,
    session: { user: account ? account.user : '' },
    anyAccount: account ? account.any : null,
    embed: /[?&]txpd_embed=1/.test(location.search) && window.self !== window.top,
    page: '',
    router: { push: function (path) {
      var target = route(path);
      if (!target) return Promise.reject(new Error('无效的面板地址'));
      if (location.pathname + location.search !== BASE + target) history.pushState(null, '', BASE + target);
      changed();
      return Promise.resolve();
    } }
  };
  history.replaceState(history.state, '', BASE + initial);
  try { if (!state.embed) sessionStorage.setItem('txpd_last_path', initial); } catch (e) {}
  var savedPage = read('txpd_last_page');
  if (!state.embed && read('txpd_last_page_path') === location.pathname && /^(manage|schedule|dm)$/.test(savedPage)) state.page = savedPage;
  // 首次访问直接进入可操作的账号管理页；后台状态请求不再决定何时显示页面。
  if (!explicit && !state.embed && !state.page && state.anyAccount !== true) state.page = 'manage';
  function changed() {
    state.route = route(location.pathname.slice(BASE.length) + location.search) || 'explore';
    try { if (!state.embed) sessionStorage.setItem('txpd_last_path', state.route); } catch (e) {}
    if (state.render) state.render();
  }
  window.addEventListener('popstate', changed);
})();
