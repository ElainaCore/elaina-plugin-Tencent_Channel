(function () {
  'use strict';

  var TXPD_API = '/api/ext/tencent-channel';
  var PROXY_PREFIX = TXPD_API + '/pd/';
  var PANEL_BASE = TXPD_API + '/panel/';
  // 命中 qq 域的浏览器请求一律改写成本地 404，不触达 qq.com
  var BLOCKED_PATH = TXPD_API + '/__blocked';

  // 嵌入模式（帖子详情浮层里的 iframe）：不参与会话路径恢复，只渲染正文
  var TXPD_EMBED = false;
  try {
    TXPD_EMBED = /[?&]txpd_embed=1/.test(window.location.search) && window.self !== window.top;
    if (TXPD_EMBED) document.documentElement.className += ' txpd-embed';
  } catch (e) { /* 顶层跨域访问失败 → 视为非嵌入 */ }

  // ---------- iframe 地址对齐：必须在应用 bundle 之前执行 ----------
  // Nuxt 的 app.baseURL 是 PANEL_BASE，但 iframe 文档地址是宿主的 /api/web-pages/tencent-channel-panel，
  // 不含 base 前缀 → vue-router 剥离 base 失败 → 静默白屏。
  // 仅当地址不在 base 下时才改写：优先恢复会话里最后访问的深层路径（刷新不丢位置），
  // 没有则回到 explore；深层路由（/g/xxx/post/yyy 整页加载）已在 base 下，保留原地址。
  try {
    var loc = window.location;
    if (!TXPD_EMBED && loc.pathname.indexOf(PANEL_BASE) !== 0) {
      var savedPath = null;
      try { savedPath = window.sessionStorage.getItem('txpd_last_path'); } catch (e) { }
      var targetPath = savedPath ? savedPath.replace(/^\/+/, '') : 'explore';
      if (targetPath === 'explore' || !targetPath) {
        window.history.replaceState(window.history.state, '', PANEL_BASE + 'explore');
      } else {
        // 深层路径整页替换加载：入口文档内存里的探索页载荷会把地址拉回 /explore，
        // 必须换成载荷剥离后的深层文档（服务端按路径剥离）才能正确恢复位置
        window.location.replace(PANEL_BASE + targetPath);
      }
    }
  } catch (e) { /* replaceState 失败则退回原地址，不阻断 */ }

  // ---------- document.cookie 清洗 + 虚拟会话 Cookie ----------
  // 1) 过滤 undefined/null 值对（外部统计脚本 parseCookie 会 trim 报错）
  // 2) 页面 JS 靠 document.cookie 判登录态（p_skey/p_uin），镜像页跑在宿主域名下
  //    没有 pd.qq.com 的浏览器 Cookie，这里把当前槽位的 Cookie 从 /panel-cookie
  //    合并进 getter；真实数据鉴权仍由代理在服务端完成。
  var VIRTUAL_COOKIES = {};
  var TXPD_USER = '';
  var TXPD_WEB_LOGGED_IN = false;   // 网页登录态（只影响显示），由下面的 /panel-cookie 赋值
  var _cliLoggedIn = null;          // CLI 账号登录态快照：null = 还没查过
  // 注意：页面上的「网页登录」只用于按登录态显示内容，点赞/评论/发帖等操作**始终**由
  // CLI 账号完成（不随网页登录态切换账号），所以这里没有「CLI 模式」开关了。
  try {
    var _origCookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (_origCookie && _origCookie.get && _origCookie.set) {
      Object.defineProperty(document, 'cookie', {
        get: function () {
          var raw = _origCookie.get.call(this) || '';
          var real = raw.split(/;\s*/).filter(function (p) {
            var i = p.indexOf('=');
            if (i <= 0) return false;
            var v = p.slice(i + 1);
            return v !== 'undefined' && v !== 'null' && v !== '';
          });
          var virtual = Object.keys(VIRTUAL_COOKIES).filter(function (k) {
            // 与真实 Cookie 同口径：丢掉空值 / undefined / null（槽位 Cookie 文件里的残留值）
            var v = String(VIRTUAL_COOKIES[k]).trim();
            return k && v !== '' && v !== 'undefined' && v !== 'null';
          }).map(function (k) {
            // 值里出现 ; 或换行会把一个 cookie 拆成两段，解析器碰到空段就 trim 报错
            return k + '=' + String(VIRTUAL_COOKIES[k]).replace(/[;\r\n]+/g, '');
          });
          var out = virtual.concat(real).join('; ');
          // 一个 cookie 都没有时必须给个占位：空串会被
          // `.split(';').forEach(x => x.split('=')[1].trim())` 这类解析器判成 undefined 抛错
          // （实测 static-res.qq.com 的统计脚本就是这样崩的），空串还会让解析结果全是脏键。
          return out || 'txpd_noop=1';
        },
        set: function (v) { _origCookie.set.call(this, v); },
        configurable: true,
      });
    }
  } catch (e) { /* 忽略，不影响主流程 */ }

  // 同步取一次槽位 Cookie（在应用 bundle 之前，保证首帧登录态判定就能读到）
  (function loadVirtualCookies() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', TXPD_API + '/panel-cookie', false);
      xhr.send(null);
      if (xhr.status === 200) {
        var r = JSON.parse(xhr.responseText);
        var c = (r && r.data && r.data.cookies) || {};
        for (var k in c) VIRTUAL_COOKIES[k] = c[k];
        TXPD_USER = (r && r.data && r.data.user) || '';
        TXPD_WEB_LOGGED_IN = !!(r && r.data && r.data.session_valid);
        // 不给页面注入假 p_skey：实测假登录态会让探索页走登录态数据流（推荐接口需真实会话）而报
        // 「加载失败」。真实会话由面板里的「网页登录」提供，只影响显示；操作一律走 CLI。
      }
    } catch (e) { /* 未登录/网络失败时保持空，不阻断 */ }
  })();

  // ---------- qq 域封锁：浏览器侧禁止任何到 *.qq.com 的请求 ----------
  function isQqUrl(u) {
    if (typeof u !== 'string') return false;
    var m = /^(https?|wss?):\/\/([^\/?#]+)/i.exec(u);
    if (!m) return false;
    var host = m[2].split(':')[0].toLowerCase();
    return host === 'qq.com' || (host.length > 7 && host.slice(-7) === '.qq.com');
  }

  // 动态 script/iframe 的封锁必须在「插入之前」完成：MutationObserver 只是微任务，
  // 事后移除时浏览器往往已经开始下载并执行（实测 static-res.qq.com 的统计脚本照样跑），
  // 所以这里在 createElement / src 赋值阶段就把 qq 域地址拦掉——既不发请求也不执行。
  // 拦截方式保持「不报错、不触发 onload/onerror」：app 的加载器是基于 promise 的，
  // 若让它 reject，页面上会多出 Uncaught (in promise)。
  function blockSrcProp(el) {
    var proto = el.tagName === 'IFRAME' ? HTMLIFrameElement.prototype : HTMLScriptElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc || !desc.get || !desc.set) return;
    try {
      Object.defineProperty(el, 'src', {
        configurable: true,
        enumerable: true,
        get: function () { return desc.get.call(this); },
        set: function (v) {
          // 直接把地址吞掉：元素照旧可插入，但不会发起任何请求，也不会执行远端代码
          if (isQqUrl(v)) { this.setAttribute('data-txpd-blocked', String(v)); return; }
          desc.set.call(this, v);
        },
      });
    } catch (e) { /* 个别环境无法重定义则退回 MutationObserver */ }
  }
  try {
    var _createElement = document.createElement;
    document.createElement = function (tag) {
      var el = _createElement.apply(document, arguments);
      try {
        if (el && (el.tagName === 'SCRIPT' || el.tagName === 'IFRAME')) blockSrcProp(el);
      } catch (e) { /* 忽略 */ }
      return el;
    };
    var _setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (String(name).toLowerCase() === 'src' && isQqUrl(value) && (this.tagName === 'SCRIPT' || this.tagName === 'IFRAME')) {
          _setAttribute.call(this, 'data-txpd-blocked', String(value));
          return;
        }
      } catch (e) { /* 忽略 */ }
      return _setAttribute.call(this, name, value);
    };
  } catch (e) { /* 封锁失败不阻断主流程 */ }

  // pd.qq.com 站内链接（帖子 /g/xxx/post/yyy、频道 /g/xxx 等）改写为镜像相对路径，
  // 点击走本应用自己的路由（帖子详情/频道视图），不再跳去真实站点，也不算 qq 域请求
  function normalizeQqAnchor(a) {
    var href = a.getAttribute && a.getAttribute('href');
    if (!href || typeof href !== 'string') return;
    var m = /^(?:https?:)?\/\/pd\.qq\.com(\/[^#]*)?(#.*)?$/i.exec(href);
    if (m) a.setAttribute('href', (m[1] || '/') + (m[2] || ''));
  }

  // 「未加入的频道」分组的即时清理（MutationObserver 触发，插入瞬间隐藏避免闪烁）
  function hideTempNodes(node) {
    if (!_joinedKeys && !_joinedNames || !node || node.nodeType !== 1 || !node.closest) return;
    if (!node.closest('.aside-group--my-temp-guild')) return;
    if (node.classList && node.classList.contains('my-guild-item')) {
      tempHideItem(node);
    }
    var sub = node.querySelectorAll ? node.querySelectorAll('.my-guild-item') : [];
    for (var i = 0; i < sub.length; i++) tempHideItem(sub[i]);
  }

  // 所有图片强制 referrerpolicy=no-referrer（meta 可能被应用显式策略绕过；图片 CDN 有防盗链）
  function enforceImgPolicy(n) {
    if (!n || n.nodeType !== 1) return;
    var imgs = n.tagName === 'IMG' ? [n] : (n.querySelectorAll ? n.querySelectorAll('img') : []);
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].getAttribute('referrerpolicy') !== 'no-referrer') imgs[i].setAttribute('referrerpolicy', 'no-referrer');
    }
  }
  // 动态插入的 iframe/script（ptlogin 登录 iframe、统计脚本等）→ 移除；qq 域图片保留（只去 referer）
  function purgeQqNode(n) {
    if (n.nodeType !== 1) return;
    var tag = n.tagName;
    if (tag === 'A') { normalizeQqAnchor(n); enforceImgPolicy(n); return; }
    if ((tag === 'IFRAME' || tag === 'SCRIPT') && isQqUrl(n.getAttribute && n.getAttribute('src'))) {
      if (n.parentNode) n.parentNode.removeChild(n);
      return;
    }
    if (tag === 'IMG') { enforceImgPolicy(n); return; }
    if (n.querySelectorAll) {
      var sub = n.querySelectorAll('iframe[src], script[src], img, a[href]');
      for (var i = 0; i < sub.length; i++) {
        var s = sub[i];
        if (s.tagName === 'A') normalizeQqAnchor(s);
        else if (s.tagName === 'IMG') enforceImgPolicy(s);
        else if (isQqUrl(s.getAttribute('src')) && s.parentNode) s.parentNode.removeChild(s);
      }
    }
  }
  try {
    var _mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') {
          purgeQqNode(m.target);
          if (m.attributeName === 'class') hideTempNodes(m.target);
          continue;
        }
        var added = m.addedNodes;
        for (var j = 0; j < added.length; j++) {
          purgeQqNode(added[j]);
          hideTempNodes(added[j]);
        }
        if (!_uiSyncQueued) queueUiSync();
      }
    });
    _mo.observe(document.documentElement || document, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'class'],
    });
  } catch (e) { /* 封锁失败不阻断主流程 */ }

  // ---------- 网络重定向：本站 API → pd.qq.com 代理；qq 域 → 本地拦截 ----------
  var PATH_PREFIXES = ['/qunng/', '/cgi-bin/', '/webconn/', '/trpc.'];
  function needRewrite(u) {
    if (typeof u !== 'string') return false;
    if (u.indexOf(PROXY_PREFIX) === 0 || u.indexOf(TXPD_API + '/') === 0) return false;
    if (isQqUrl(u)) return false; // qq 域走拦截，不走代理
    if (/^https?:\/\//i.test(u)) return false;
    for (var i = 0; i < PATH_PREFIXES.length; i++) {
      if (u.indexOf(PATH_PREFIXES[i]) === 0 || u.indexOf('&' + PATH_PREFIXES[i]) > 0) return true;
    }
    return false;
  }
  function toProxy(u) {
    // 相对路径（/qunng/...）→ /api/ext/tencent-channel/pd/qunng/...
    if (u.indexOf('&') > 0 && u.indexOf('/trpc') > 0 && u.charAt(0) !== '/') {
      // mobile 形态: "<finalPath>?<query>&origin_url=..." 整体作为 tail
      return PROXY_PREFIX + u;
    }
    return PROXY_PREFIX + u.replace(/^\//, '');
  }

  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (isQqUrl(typeof input === 'string' ? input : input && input.url)) {
        input = BLOCKED_PATH; // 本地 404，不触达 qq.com
      } else if (typeof input === 'string' && needRewrite(input)) {
        input = toProxy(input);
      } else if (input && typeof input.url === 'string' && needRewrite(input.url)) {
        input = new Request(toProxy(input.url), input);
      }
    } catch (e) { /* 保持原请求 */ }
    return _origFetch.call(window, input, init);
  };

  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (isQqUrl(url)) {
        url = BLOCKED_PATH;
      } else if (needRewrite(url)) {
        url = toProxy(url);
      }
    } catch (e) { /* 保持原请求 */ }
    return _origOpen.apply(this, [method, url].concat([].slice.call(arguments, 2)));
  };

  // 上报类通道一并封口
  try {
    var _origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (_origBeacon) {
      navigator.sendBeacon = function (url, data) {
        if (isQqUrl(url)) return true;
        return _origBeacon(url, data);
      };
    }
    var _WS = window.WebSocket;
    if (_WS) {
      window.WebSocket = function (url, protocols) {
        if (isQqUrl(url)) throw new TypeError('txpd: qq domain blocked');
        return protocols === undefined ? new _WS(url) : new _WS(url, protocols);
      };
      window.WebSocket.prototype = _WS.prototype;
      window.WebSocket.OPEN = _WS.OPEN;
      window.WebSocket.CONNECTING = _WS.CONNECTING;
      window.WebSocket.CLOSING = _WS.CLOSING;
      window.WebSocket.CLOSED = _WS.CLOSED;
    }
  } catch (e) { /* 忽略 */ }

  // ---------- 账号弹窗（插件自己的扫码登录，不经 qq 域） ----------
  function api(path, opts) {
    opts = opts || {};
    return fetch(TXPD_API + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) { return r.json(); });
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text) e.textContent = text;
    return e;
  }

  var mask, dlg, pollTimer = null;

  function ensureMask() {
    if (mask) return;
    mask = el('div', { id: 'txpd-acct-mask' });
    dlg = el('div', { id: 'txpd-acct-dlg' });
    mask.appendChild(dlg);
    mask.addEventListener('click', function (e) { if (e.target === mask) closeDlg(); });
    document.body.appendChild(mask);
  }
  function openAccountList() {
    ensureMask();
    mask.style.display = 'flex';
    renderAccountList();
  }
  function openQrStage() {
    ensureMask();
    mask.style.display = 'flex';
    renderQrStage();
  }
  function closeDlg() {
    stopPoll();
    if (mask) mask.style.display = 'none';
  }

  function stopPoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function renderAccountList() {
    stopPoll();
    dlg.innerHTML = '';
    dlg.appendChild(el('button', { id: 'txpd-acct-close' }, '×')).addEventListener('click', closeDlg);
    dlg.appendChild(el('h3', null, '选择账号'));
    var box = el('div');
    dlg.appendChild(box);
    api('/accounts').then(function (r) {
      var accs = (r.data && r.data.accounts) || [];
      if (!accs.length) {
        box.appendChild(el('div', { style: 'color:#888;font-size:14px;padding:16px 0;text-align:center;' }, '还没有登录的账号'));
      }
      accs.forEach(function (a) {
        var label = (a.logged_in ? '' : '[未登录] ') + (a.nickname || a.name);
        var item = el('div', { 'class': 'txpd-acct-item' + (a.current ? ' current' : ''), 'data-name': a.name });
        item.appendChild(el('span', { 'class': 'txpd-acct-dot' }));
        item.appendChild(el('span', { 'class': 'txpd-acct-name' }, label));
        if (a.current) item.appendChild(el('span', { 'class': 'txpd-acct-tag' }, '当前'));
        else {
          item.addEventListener('click', function () {
            api('/accounts/switch', { method: 'POST', body: { name: a.name } }).then(function () {
              location.reload();
            });
          });
          var del = el('span', { 'class': 'txpd-acct-del' }, '删除');
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            if (confirm('确定删除账号「' + (a.nickname || a.name) + '」？')) {
              api('/accounts/delete', { method: 'POST', body: { name: a.name } }).then(renderAccountList);
            }
          });
          item.appendChild(del);
        }
        box.appendChild(item);
        // 异步取 QQ 昵称与真实登录状态（users/status 会缓存昵称），完成后就地更新
        if (a.logged_in) {
          api('/users/status', { method: 'POST', body: { name: a.name } }).then(function (s) {
            var row = box.querySelector('.txpd-acct-item[data-name="' + a.name + '"] .txpd-acct-name');
            if (!row) return;
            var st = s && s.data && s.data.status;
            var payload = st && st.data && st.data.data;
            var valid = !!(st && st.success && payload && payload.valid !== false);
            var nick = (s && s.data && s.data.nickname) || '';
            row.textContent = (valid ? '' : '[未登录] ') + (nick || a.nickname || a.name);
          }).catch(function () { /* 忽略 */ });
        }
      });
      var add = el('button', { 'class': 'txpd-acct-add' }, '+ 添加账号');
      add.addEventListener('click', function () { renderQrStage(); });
      dlg.appendChild(add);
    }).catch(function () {
      box.appendChild(el('div', { style: 'color:#e5484d;font-size:13px;' }, '加载账号列表失败'));
    });
  }

  function renderQrStage() {
    stopPoll();
    dlg.innerHTML = '';
    dlg.appendChild(el('button', { id: 'txpd-acct-close' }, '×')).addEventListener('click', closeDlg);
    dlg.appendChild(el('h3', null, '扫码登录'));
    var stage = el('div', { id: 'txpd-qr-stage' });
    stage.appendChild(el('div', { id: 'txpd-qr-tip' }, '正在获取登录二维码…'));
    stage.appendChild(el('div', { id: 'txpd-qr-status' }));
    dlg.appendChild(stage);
    var back = el('button', { 'class': 'txpd-acct-add' }, '← 返回账号列表');
    back.addEventListener('click', renderAccountList);
    dlg.appendChild(back);

    api('/accounts/add', { method: 'POST', body: {} }).then(function (r) {
      if (!r.success) {
        stage.innerHTML = '';
        stage.appendChild(el('div', { id: 'txpd-qr-tip', 'class': 'txpd-qr-err' }, r.message || '获取二维码失败'));
        return;
      }
      var user = r.data.user;
      stage.innerHTML = '';
      var img = el('img', { src: 'data:image/png;base64,' + r.data.qr_code, alt: '登录二维码' });
      stage.appendChild(img);
      stage.appendChild(el('div', { id: 'txpd-qr-tip' }, '请使用手机 QQ 扫描二维码完成登录'));
      var status = el('div', { id: 'txpd-qr-status' }, '等待扫码…');
      stage.appendChild(status);
      pollLogin(user, status);
    }).catch(function () {
      stage.innerHTML = '';
      stage.appendChild(el('div', { id: 'txpd-qr-tip', 'class': 'txpd-qr-err' }, '网络错误，请重试'));
    });
  }

  function pollLogin(user, statusEl) {
    stopPoll();
    pollTimer = setTimeout(function () {
      api('/accounts/poll', { method: 'POST', body: { user: user } }).then(function (r) {
        var st = (r.data && r.data.status) || 'waiting';
        if (st === 'ok') {
          statusEl.textContent = '登录成功！';
          setTimeout(function () { location.reload(); }, 800);
          return;
        }
        if (st === 'expired') {
          statusEl.textContent = '二维码已过期，正在刷新…';
          api('/accounts/add', { method: 'POST', body: { user: user } }).then(function () { renderQrStage(); });
          return;
        }
        if (st === 'denied') {
          statusEl.textContent = '已取消授权，可返回重新扫码';
          return;
        }
        if (st === 'failed') {
          statusEl.textContent = (r.data && r.data.message) || '登录失败';
          statusEl.classList.add('txpd-qr-err');
          return;
        }
        if (statusEl) statusEl.textContent = '等待扫码…';
        pollLogin(user, statusEl);
      }).catch(function () { pollLogin(user, statusEl); });
    }, 2500);
  }

  // ---------- 弹窗样式 ----------
  var style = el('style');
  style.textContent = [
    // 有已登录的 CLI 账号时隐藏官方登录卡（应用自身仍认为未登录，属预期）
    '.txpd-logged-in .app-login{display:none!important;}',
    // 宽屏（>=1024）桌面 UA：侧栏静态常显（收窄 230、锁位置、去抽屉动画、隐藏遮罩与展开按钮）；
    // 窄屏（<1024）完全交还官方抽屉行为——展开按钮可开可关、遮罩可用（手机端可收回）
    // ≥768px（电脑屏幕）：侧栏默认展开、锁死不可收回、隐藏展开按钮与遮罩
    '@media (min-width: 768px){'
    + 'body.force-full-width .app-aside{display:flex!important;width:230px!important;left:0!important;transform:none!important;transition:none!important;box-shadow:none!important;}'
    + 'body.force-full-width .app-layout{padding-left:230px!important;}'
    + 'body.force-full-width .aside-nav{width:230px!important;padding-left:6px!important;}'
    + 'body.force-full-width .app-header .app-header-left .icon-menu{display:none!important;}'
    + 'body.force-full-width .icon-menu-in-app-header{display:none!important;}'
    + 'body.force-full-width .aside-overlay{display:none!important;opacity:0!important;}'
    + '}',
    // <768px（手机尺寸）：自实现抽屉——默认收起，展开按钮开合、遮罩点击关闭
    '@media (max-width: 767.98px){'
    + 'body.force-full-width:not(.txpd-drawer-open) .app-aside{display:none!important;}'
    + 'body.force-full-width:not(.txpd-drawer-open) .aside-overlay{display:none!important;opacity:0!important;}'
    + 'body.force-full-width.txpd-drawer-open .app-aside{display:flex!important;width:230px!important;left:0!important;top:0!important;height:100%!important;transform:none!important;transition:none!important;box-shadow:0 0 24px rgba(0,0,0,.18);z-index:1001!important;}'
    + 'body.force-full-width.txpd-drawer-open .aside-overlay{display:block!important;opacity:1!important;visibility:visible!important;transition:none!important;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;}'
    + 'body.force-full-width.txpd-drawer-open .app-header .app-header-left .icon-menu{display:flex!important;}'
    + '}',
    // 移入的会话列表默认 3 条；点击「查看全部」展开（其余含「展开全部」隐藏）
    '.channel-list[data-txpd-moved="1"] > *:nth-child(n+4){display:none!important;}',
    '.channel-list[data-txpd-moved="1"].txpd-show-all > *:nth-child(n+4){display:flex!important;}',

    // 会话条目靠左（官方样式在窄侧栏里像居中）
    '.channel-list[data-txpd-moved="1"]{padding:2px 0 6px 6px!important;margin:0!important;text-align:left!important;}',
    '.channel-list[data-txpd-moved="1"] .channel-item{margin:0!important;justify-content:flex-start!important;text-align:left!important;}',
    // 手机端会话界面顶栏的 QQ 推广条隐藏
    '.mobile-header-container{display:none!important;}',
    // 发布器展开态：解除官方收起态的 44px 高度裁剪（否则输入区在裁剪区外不可见不可点）
    '.publish-editor-container[data-txpd-expanded="1"] .editor-area{height:auto!important;min-height:130px;overflow:visible!important;}',
    // 插件管理（整页视图）
    '.txpd-manage{display:flex;flex-direction:column;gap:14px;height:100%;overflow:auto;padding:18px 22px;box-sizing:border-box;}',
    '.txpd-mg-head{display:flex;align-items:center;gap:12px;}',
    '.txpd-mg-title{font-size:16px;font-weight:600;color:var(--text-primary,#222);}',
    '.txpd-mg-card{background:var(--bg-middle-light,#fff);border:1px solid var(--border-primary,rgba(219,220,224,.9));border-radius:12px;padding:16px 18px;}',
    '.txpd-mg-card h3{margin:0 0 6px;font-size:14px;font-weight:600;color:var(--text-primary,#222);}',
    '.txpd-mg-desc{margin:0 0 12px;font-size:12px;line-height:1.7;color:var(--text-secondary,#8a8a8a);}',
    '.txpd-mg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.txpd-mg-status{font-size:13px;color:var(--text-primary,#222);}',
    '.txpd-mg-btn{height:34px;padding:0 16px;border:1px solid var(--border-primary,rgba(219,220,224,.9));border-radius:100px;background:var(--bg-middle-light,#fff);color:var(--text-link,#2b64f5);font-size:13px;font-family:inherit;cursor:pointer;}',
    '.txpd-mg-btn:hover{background:#f2f4f8;}',
    '.txpd-mg-btn.primary{background:var(--feedback-brand,#2b64f5);border-color:transparent;color:#fff;}',
    '.txpd-mg-btn.primary:hover{opacity:.92;background:var(--feedback-brand,#2b64f5);}',
    '.txpd-mg-btn:disabled{opacity:.5;cursor:default;}',
    '.txpd-mg-qr{display:none;margin-top:14px;text-align:center;}',
    '.txpd-mg-qr img{width:168px;height:168px;border:1px solid var(--border-primary,rgba(219,220,224,.9));border-radius:8px;background:#fff;}',
    '.txpd-mg-qr-tip{margin-top:8px;font-size:12px;color:var(--text-secondary,#8a8a8a);}',
    '.txpd-mg-textarea{width:100%;min-height:110px;box-sizing:border-box;border:1px solid var(--border-primary,rgba(219,220,224,.9));border-radius:8px;padding:10px 12px;font-size:13px;font-family:inherit;line-height:1.6;resize:vertical;color:var(--text-primary,#222);background:var(--bg-middle-light,#fff);}',
    // 主页导航固定为这五项：官方导航项一律纯样式隐藏（首帧即生效，之后不动 DOM），
    // 插件自己那五项带 data-txpd-nav，不受这条影响
    '.aside-group--nav .app-menu-list > .menu-item:not([data-txpd-nav]){display:none!important;}',
    // 插件自己插的导航项高亮（拿不到官方的 router-link-active）
    '.app-menu-list .menu-item.txpd-nav-active{background:var(--overlay-active,rgba(0,0,0,.06));font-weight:600;}',
    // 新建定时计划的表单：一行两个设置
    '.txpd-sched-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;}',
    '@media (max-width:560px){.txpd-sched-form{grid-template-columns:1fr;}}',
    '.txpd-sched-form select,.txpd-sched-form input{width:100%;box-sizing:border-box;}',
    // 定时计划条目
    '.txpd-sched-item{border-top:1px solid var(--border-primary,rgba(219,220,224,.6));padding:12px 0;}',
    '.txpd-sched-item:first-child{border-top:none;padding-top:2px;}',
    '.txpd-sched-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.txpd-sched-name{font-size:14px;font-weight:600;color:var(--text-primary,#222);}',
    '.txpd-sched-tag{font-size:11px;padding:1px 8px;border-radius:100px;background:#f0f1f5;color:#8a8a8a;}',
    '.txpd-sched-tag.on{background:#e8f6ee;color:#15a361;}',
    '.txpd-sched-cron{font-size:12px;color:var(--text-link,#2b64f5);}',
    '.txpd-sched-meta{margin-top:4px;font-size:12px;color:var(--text-secondary,#8a8a8a);}',
    '.txpd-sched-body{margin-top:4px;font-size:13px;color:var(--text-primary,#333);line-height:1.6;word-break:break-word;}',
    // ---------- 交互顺滑化：过渡/进入动画（尊重系统「减少动态效果」）----------
    '.txpd-mg-btn,.txpd-join-btn,.txpd-cli-more,.app-menu-list .menu-item{transition:background-color .16s ease,opacity .16s ease,transform .12s ease,color .16s ease;}',
    '.txpd-mg-btn:active,.txpd-join-btn:active,.txpd-cli-more:active{transform:scale(.97);}',
    '.txpd-mg-card,.txpd-sched-item{transition:box-shadow .2s ease,border-color .2s ease;}',
    '.txpd-mg-card:hover{border-color:rgba(43,100,245,.35);}',
    '@keyframes txpd-fade-up{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
    '@keyframes txpd-fade-in{from{opacity:0;}to{opacity:1;}}',
    '@keyframes txpd-slide-left{from{opacity:0;transform:translateX(24px);}to{opacity:1;transform:none;}}',
    '@keyframes txpd-pop{from{opacity:0;transform:translateY(8px) scale(.985);}to{opacity:1;transform:none;}}',
    '.txpd-manage{animation:txpd-fade-up .22s cubic-bezier(.2,.8,.25,1);}',
    '#txpd-drawer{animation:txpd-slide-left .22s cubic-bezier(.2,.8,.25,1);}',
    '#txpd-acct-mask{animation:txpd-fade-in .16s ease;}',
    '#txpd-acct-dlg{animation:txpd-pop .2s cubic-bezier(.2,.8,.25,1);}',
    '#txpd-cli-panel,#txpd-cli-body>*{animation:txpd-fade-in .2s ease;}',
    '#txpd-cli-body .txpd-cli-grid>*{animation:txpd-fade-up .24s ease both;}',
    '.txpd-dynamic .feed-list-item,.txpd-dyn-list>*{animation:txpd-fade-up .22s ease both;}',
    '@media (prefers-reduced-motion: reduce){'
    + '.txpd-manage,#txpd-drawer,#txpd-acct-mask,#txpd-acct-dlg,#txpd-cli-panel,#txpd-cli-body>*{animation:none!important;}'
    + '.txpd-mg-btn,.txpd-join-btn,.txpd-cli-more,.app-menu-list .menu-item{transition:none!important;}'
    + '}',
    // 缺登录态时的整页提示
    '.txpd-login-notice{display:flex;align-items:flex-start;justify-content:center;height:100%;padding:64px 22px 0;box-sizing:border-box;}',
    '.txpd-notice-card{max-width:520px;width:100%;}',
    '.txpd-notice-card h3{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--text-primary,#222);}',
    // 未加入频道的顶栏「加入」按钮（贴在频道名旁边）
    '.txpd-join-slot{display:inline-flex;align-items:center;margin-left:10px;flex:none;vertical-align:middle;}',
    '.txpd-join-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 12px;border:none;border-radius:100px;background:var(--feedback-brand,#2b64f5);color:#fff;font-size:12px;font-family:inherit;cursor:pointer;flex:none;}',
    '.txpd-join-btn:hover{opacity:.92;}',
    '.txpd-join-btn:disabled{opacity:.6;cursor:default;}',
    '.txpd-join-btn svg{width:14px;height:14px;}',
    // 右侧抽屉（私信/插件管理员）
    '#txpd-drawer{position:fixed;top:0;right:0;bottom:0;width:380px;max-width:94vw;background:#fff;z-index:2147483003;box-shadow:-8px 0 32px rgba(0,0,0,.18);display:none;flex-direction:column;font-family:inherit;}',
    '#txpd-drawer-head{padding:14px 16px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}',
    '#txpd-drawer-body{flex:1;overflow:auto;padding:12px 16px;}',
    '#txpd-acct-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;}',
    '#txpd-acct-dlg{width:min(420px,92vw);background:#fff;border-radius:14px;padding:22px;box-shadow:0 12px 48px rgba(0,0,0,.3);font-family:inherit;}',
    '#txpd-acct-dlg h3{margin:0 0 14px;font-size:18px;font-weight:600;line-height:26px;color:var(--text-primary,#222);}',
    '.txpd-acct-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;}',
    '.txpd-acct-item:hover{background:#f2f4f8;}',
    '.txpd-acct-item.current{background:#eef3ff;}',
    '.txpd-acct-dot{width:8px;height:8px;border-radius:50%;background:#bbb;flex:none;}',
    '.txpd-acct-item.current .txpd-acct-dot{background:#2b64f5;}',
    '.txpd-acct-name{font-size:14px;color:#222;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.txpd-acct-tag{font-size:12px;color:#2b64f5;flex:none;}',
    '.txpd-acct-del{font-size:12px;color:#e5484d;flex:none;cursor:pointer;padding:2px 6px;border-radius:6px;}',
    '.txpd-acct-del:hover{background:#fdebec;}',
    '.txpd-acct-add{margin-top:10px;width:100%;height:40px;border:none;border-radius:10px;background:#f2f4f8;color:#2b64f5;font-size:14px;cursor:pointer;}',
    '.txpd-acct-add:hover{background:#e8edf8;}',
    '#txpd-qr-stage{text-align:center;padding:8px 0 2px;}',
    '#txpd-qr-stage img{width:220px;height:220px;border-radius:8px;border:1px solid #eee;}',
    '#txpd-qr-tip{font-size:13px;color:#666;margin-top:10px;line-height:1.6;}',
    '#txpd-qr-status{font-size:13px;color:#2b64f5;margin-top:6px;min-height:18px;}',
    '.txpd-qr-err{color:#e5484d !important;}',
    '#txpd-acct-close{float:right;border:none;background:none;font-size:20px;color:#999;cursor:pointer;line-height:1;}',
    '#txpd-acct-close:hover{color:#333;}',

    // ---------- 官方「互动消息/通知」风格浮层（贴图标弹出，替代居中弹窗） ----------
    '#txpd-pop{position:fixed;z-index:2147483004;display:none;flex-direction:column;width:min(390px,94vw);max-height:min(72vh,620px);background:var(--bg-toast,#fff);border:1px solid var(--border-primary,rgba(219,220,224,.5));border-radius:10px;box-shadow:4px 0 12px rgba(0,0,0,.15);overflow:hidden;font-family:inherit;color:var(--text-primary,#222);}',
    '#txpd-pop-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border-primary,rgba(219,220,224,.5));flex-shrink:0;}',
    '#txpd-pop-title{font-size:17px;font-weight:600;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#txpd-pop-actions{display:flex;align-items:center;gap:10px;margin-left:auto;font-size:12px;color:var(--text-link,#2b64f5);}',
    '#txpd-pop-actions>*{cursor:pointer;}',
    '#txpd-pop-close{border:none;background:none;font-size:20px;color:var(--text-tertiary,#bdbdbd);cursor:pointer;line-height:1;padding:0 2px;flex-shrink:0;}',
    '#txpd-pop-close:hover{color:var(--text-primary,#222);}',
    '#txpd-pop-body{flex:1;overflow:auto;padding:12px 16px 18px;}',
    // ---------- 官方风格表单控件（浮层与弹窗共用） ----------
    '.txpd-fld{font-size:12px;color:var(--text-secondary,#8a8a8a);margin-bottom:4px;}',
    '.txpd-inp{width:100%;box-sizing:border-box;border:1px solid var(--border-input-box,rgba(219,220,224,.9));border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;color:var(--text-primary,#222);background:var(--bg-middle-light,#fff);}',
    '.txpd-inp:focus{border-color:var(--feedback-brand,#2b64f5);}',
    '.txpd-btn{width:100%;height:36px;margin-top:8px;border:none;border-radius:100px;background:var(--button-primary-bg,#2b64f5);color:var(--button-primary-text-white,#fff);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;}',
    '.txpd-btn:hover{filter:brightness(1.06);}',
    '.txpd-btn:disabled{opacity:.5;cursor:default;}',
    '.txpd-sts{font-size:12px;color:var(--text-secondary,#8a8a8a);margin-top:8px;min-height:16px;}',
    // ---------- 频道卡 operation 行：插件图标按钮（继承官方 operation-item 外观） ----------
    '.txpd-op-btns{display:flex;align-items:center;gap:12px;}',
    // ---------- 帖子详情浮层 ----------
    '#txpd-embed-overlay{position:fixed;inset:0;z-index:2147483002;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);}',
    '#txpd-embed-card{display:flex;flex-direction:column;width:min(1100px,94vw);height:min(88vh,900px);background:var(--bg-middle-light,#fff);border-radius:12px;box-shadow:0 16px 56px rgba(0,0,0,.3);overflow:hidden;}',
    '#txpd-embed-bar{display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 8px 0 16px;border-bottom:1px solid var(--border-primary,rgba(219,220,224,.5));flex-shrink:0;}',
    '#txpd-embed-title{font-size:15px;font-weight:600;color:var(--text-primary,#222);}',
    '#txpd-embed-close{border:none;background:none;font-size:22px;color:var(--text-tertiary,#bdbdbd);cursor:pointer;line-height:1;padding:0 6px;}',
    '#txpd-embed-close:hover{color:var(--text-primary,#222);}',
    '#txpd-embed-frame{flex:1;width:100%;border:none;background:var(--bg-middle-light,#fff);}',
    // 嵌入模式内部：只留帖子正文
    'html.txpd-embed .app-aside,html.txpd-embed .app-header,html.txpd-embed .aside-overlay,html.txpd-embed .mobile-header-container{display:none!important;}',
    'html.txpd-embed .app-layout{padding-left:0!important;}',
    'html.txpd-embed #txpd-mobile-back,html.txpd-embed #txpd-drawer,html.txpd-embed #txpd-pop{display:none!important;}',
    // ---------- 内联评论输入条（官方底部输入栏样式） ----------
    '.bottom-input[data-txpd-editor="1"]{height:auto!important;min-height:36px;padding:4px 6px 4px 8px!important;gap:6px;align-items:center;border-color:var(--feedback-brand,#2b64f5)!important;cursor:text;}',
    '.bottom-input[data-txpd-editor="1"] textarea{flex:1;min-width:0;border:none;outline:none;resize:none;background:transparent;font-size:13px;line-height:20px;height:20px;font-family:inherit;color:var(--text-primary,#222);padding:0;}',
    '.txpd-inline-emoji,.txpd-inline-cancel{border:none;background:none;cursor:pointer;padding:2px;display:inline-flex;align-items:center;flex-shrink:0;color:var(--text-tertiary,#bdbdbd);}',
    '.txpd-inline-emoji:hover,.txpd-inline-cancel:hover{color:var(--feedback-brand,#2b64f5);}',
    '.txpd-inline-send{border:none;background:none;color:var(--text-link,#2b64f5);font-size:13px;font-weight:600;cursor:pointer;padding:2px 4px;font-family:inherit;white-space:nowrap;flex-shrink:0;}',
    '.txpd-inline-send:disabled{color:var(--text-tertiary,#bdbdbd);cursor:default;}',
    // 评论输入框（富文本：表情显示为图）
    '.txpd-rich{flex:1;min-width:0;outline:none;font-size:13px;line-height:20px;max-height:88px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:var(--text-primary,#222);-webkit-user-select:text;user-select:text;}',
    '.txpd-rich:empty:before{content:attr(data-ph);color:var(--text-tertiary,#bdbdbd);pointer-events:none;}',
    '.txpd-rich img{width:20px;height:20px;vertical-align:-4px;margin:0 1px;}',
    '.txpd-rich br{line-height:20px;}',
    '.txpd-editor{display:flex;align-items:center;gap:6px;border:1px solid var(--feedback-brand,#2b64f5);border-radius:8px;min-height:36px;padding:4px 6px 4px 8px;margin-top:14px;background:var(--bg-middle-light,#fff);}',
    '.txpd-editor textarea{flex:1;min-width:0;border:none;outline:none;resize:none;background:transparent;font-size:13px;line-height:20px;height:20px;font-family:inherit;color:var(--text-primary,#222);padding:0;}',
    // ---------- 访客限制频道的 CLI 兜底 ----------
    '#txpd-cli-panel{width:100%;margin:24px 0 0;font-family:inherit;color:var(--text-primary,#222);text-align:left;}',
    // 公开频道（官方自己的卡片）也统一收紧图片大小：单图 ≤300 高 / ≤480 宽，多图方格固定 180
    // 官方给的是内联尺寸（单图写在 img 上、多图写在 .short-feed-image 的 width/padding-top 上），所以必须 !important 覆盖
    '.game-guild-main__short-content__image-single img{max-height:300px!important;max-width:480px!important;width:auto!important;height:auto!important;}',
    '.game-guild-main__short-content__image-multiple .short-feed-image{width:180px!important;padding-top:180px!important;}',
    // 官方 .game-guild-main 有 padding-top:24px（未对访客开放的页面上官方不给这个间距）
    '#txpd-guild-head{margin-top:24px;}',
    '.txpd-cli-loading{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--text-secondary,#8a8a8a);font-size:13px;padding:28px 0;}',
    '.txpd-cli-loading:before{content:"";width:14px;height:14px;border:2px solid var(--border-primary,rgba(219,220,224,.9));border-top-color:var(--feedback-brand,#2b64f5);border-radius:50%;animation:txpd-spin .8s linear infinite;}',
    '@keyframes txpd-spin{to{transform:rotate(360deg);}}',
    '.transition-open{background-color:transparent!important;}',
    // 官方主页是单列（每行一个帖子，卡片约 870 宽），每条上下留 12px（官方虚拟列表的节奏）
    '.txpd-cli-grid{display:block;padding:0 12px;}',
    '.txpd-cli-grid > a{display:block;margin:12px 0;}',
    // 帖子详情：官方两栏（左图 / 右栏评论）——需要官方容器祖先，且要覆盖它为大窗准备的固定高度
    '#txpd-embed-dom .feed-container-wrapper{height:100%!important;min-height:0!important;margin-top:0!important;border:none!important;border-radius:0!important;background:transparent!important;}',
    '#txpd-embed-dom .bottom-comment-input{position:sticky!important;bottom:0;width:100%!important;}',
    '.txpd-cli-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary,#8a8a8a);margin:0 2px 12px;line-height:18px;}',
    '.txpd-cli-badge{background:rgba(43,100,245,.1);color:var(--text-link,#2b64f5);border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600;flex:none;}',
    '#txpd-embed-dom.txpd-dom-detail{display:flex;flex-direction:column;overflow:hidden;padding:12px;}',
    // 详情：把高度约束一路传下去（否则 .feed-container-wrapper 的 height:100% 无处解析 → 左栏图片按原始高度撑高、底栏被裁掉）
    '#txpd-embed-dom.txpd-dom-detail .txpd-cli-detail{flex:1;display:flex;flex-direction:column;min-height:0;}',
    '#txpd-embed-dom .game-guild-detail{flex:1;display:flex;flex-direction:column;min-height:0;}',
    '#txpd-embed-dom .game-guild-detail-container{flex:1;display:flex;flex-direction:column;min-height:0;}',
    '#txpd-embed-dom .feed-container-wrapper{flex:1;height:auto!important;min-height:0!important;margin-top:0!important;border:none!important;border-radius:0!important;background:transparent!important;}',
    // 详情左栏：官方规则是 contain 适配（不裁切、不撑高）——把高度链一路给到 img
    '#txpd-embed-dom .short-imagecontent-container{height:100%;}',
    '#txpd-embed-dom .short-imagecontent-container .swiper,#txpd-embed-dom .short-imagecontent-container .swiper-wrapper,#txpd-embed-dom .short-imagecontent-container .swiper-slide{height:100%;}',
    '#txpd-embed-dom .feed-container__left .short-feed-image,#txpd-embed-dom .feed-container__left .short-feed-image__placeholder{height:100%;}',
    '#txpd-embed-dom .feed-container__left img{max-height:100%;max-width:100%;height:auto;width:auto;object-fit:contain;}',
    '#txpd-embed-dom .feed-container__right{height:100%;}',
    '.txpd-cli-liked .icon-like{color:var(--feedback-brand,#2b64f5)!important;}',
    '.txpd-cli-liked .like-text,.txpd-cli-liked .comment-list-item__like-count{color:var(--feedback-brand,#2b64f5)!important;}',
    '#txpd-embed-dom .bottom-comment-input{position:sticky;bottom:0;width:100%;}',
    // ---------- 动态页（官方 .page-index/.feed-list 结构，仅补必要的小样式） ----------
    '.txpd-dynamic{display:block!important;height:100%;}',
    '.txpd-dynamic .feed-list-content{overscroll-behavior:contain;}',
    '.txpd-dyn-more{text-align:center;color:var(--text-tertiary,#bdbdbd);font-size:12px;padding:14px 0;}',
    '.txpd-dynamic .feed-list-item .operation-item.txpd-dyn-liked{color:var(--feedback-brand,#2b64f5);}',
    '.txpd-cli-more{display:block;margin:16px auto 0;padding:8px 22px;border:1px solid var(--border-primary,rgba(219,220,224,.9));background:var(--bg-middle-light,#fff);border-radius:100px;color:var(--text-link,#2b64f5);font-size:13px;cursor:pointer;font-family:inherit;}',
    '.txpd-cli-more:disabled{color:var(--text-tertiary,#bdbdbd);cursor:default;}',
    '.txpd-cli-empty{color:var(--text-secondary,#8a8a8a);font-size:13px;padding:14px 2px;}',
    '.txpd-cli-detail{width:100%;}',
    '#txpd-lightbox{position:fixed;inset:0;z-index:2147483006;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;cursor:zoom-out;}',
    '#txpd-lightbox img{max-width:92%;max-height:92%;border-radius:6px;}',
    '#txpd-embed-dom{flex:1;overflow:auto;padding:18px 22px;display:none;}',
  ].join('');
  document.head.appendChild(style);

  // ---------- 账号状态（缓存 10s）：决定登录按钮的形态 ----------
  var _acctAny = null, _acctTs = 0;
  // 登录态快照（TXPD_WEB_LOGGED_IN / _cliLoggedIn）声明在文件顶部：
  // 那里先声明再赋值，避免 var 初始化顺序把 loadVirtualCookies 写入的值覆盖回 false
  function acctCacheKey() { return 'txpd_acct_state_v1_' + (TXPD_USER || 'default'); }
  function setAcctState(any) {
    _acctAny = any; _acctTs = Date.now();
    try { window.localStorage.setItem(acctCacheKey(), JSON.stringify({ ts: _acctTs, any: any })); } catch (e) { /* 忽略 */ }
  }
  function getAccountsState() {
    var now = Date.now();
    if (_acctAny !== null && now - _acctTs < 10000) return Promise.resolve(_acctAny);
    // 3 小时本地缓存：页面打开瞬间先套用上次的登录态（UI 立即到位），随后接口确认
    if (_acctAny === null) {
      try {
        var raw = window.localStorage.getItem(acctCacheKey());
        if (raw) {
          var box = JSON.parse(raw);
          if (box && Date.now() - box.ts < 10800000) { _acctAny = !!box.any; _acctTs = box.ts; }
        }
      } catch (e) { /* 忽略 */ }
    }
    if (_acctAny !== null && now - _acctTs < 10000) return Promise.resolve(_acctAny);
    return api('/accounts').then(function (r) {
      var accs = (r.data && r.data.accounts) || [];
      setAcctState(accs.some(function (a) { return a.logged_in; }));
      _cliLoggedIn = _acctAny;   // 未登录时页面要显示「CLI 未登录，无法查看」
      return _acctAny;
    });
  }
  function invalidateAccounts() {
    _acctAny = null; _acctTs = 0;
    try { window.localStorage.removeItem(acctCacheKey()); } catch (e) { /* 忽略 */ }
  }
  function invalidateGuilds() {
    _guildsCache = null; _joinedKeys = null; _joinedNames = null;
    try { window.localStorage.removeItem(guildCacheKey()); } catch (e) { /* 忽略 */ }
  }

  function findVisibleButton(text) {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b.closest && b.closest('#txpd-acct-mask')) continue;
      if (b.textContent && b.textContent.trim() === text && b.offsetParent !== null) return b;
    }
    return null;
  }

  // 插件有已登录账号 → 页面「登录」按钮改显「切换账号」（用户要求）；
  // 同时维护侧栏「已加入的频道」分区（Vue 重渲染后自动补回），
  // 并修正官方侧栏的两处失真：
  //   1) 访问过的已加入频道不应出现在「未加入的频道」（应用无法验证成员身份所致）
  //   2) 已加入频道的视图不应再显示「加入频道」按钮
  setInterval(function () {
    getAccountsState().then(function (any) {
      if (!document.body) return;   // 解析早期（还没到 body）：这轮跳过，3 秒后重来
      if (any) {
        var b = findVisibleButton('登录');
        if (b) b.textContent = '切换账号';
      } else {
        var b2 = findVisibleButton('切换账号');
        if (b2) b2.textContent = '登录';
      }
      var entry = document.getElementById('txpd-acct-entry');
      if (entry) entry.textContent = any ? '切换账号' : '扫码登录';
      // 有已登录账号 → 隐藏官方登录卡
      if (any) document.body.classList.add('txpd-logged-in');
      else document.body.classList.remove('txpd-logged-in');
      ensureMobileBackButton();
      ensureNarrowDrawer();
      loadJoinedGuilds().then(function () {
        syncTempGuildSection();
        syncMyGuildDuplicates();
        syncGuildViewJoinBtn();
        moveChannelList();
        ensureTopbarButtons();
        ensureNavEntries();
        syncPublishArea();
        syncLikedMarks();
        ensureGuildMeta();
        ensureGatedFallback();
      }).catch(function () { /* 忽略 */ });
    }).catch(function () { /* 忽略 */ });
    // 记录当前深层路径，宿主页面刷新后恢复位置
    try {
      var p = window.location.pathname + window.location.search;
      if (!TXPD_EMBED && p.indexOf(PANEL_BASE) === 0) window.sessionStorage.setItem('txpd_last_path', p.slice(PANEL_BASE.length) || 'explore');
    } catch (e) { /* 忽略 */ }
    ensureJoinedSection();
  }, 3000);

  // ---------- 官方「互动消息/通知」风格浮层：贴图标弹出的小面板（替代居中弹窗） ----------
  var _popEl = null, _popAnchor = null, _popOutside = null;
  function positionPopover() {
    if (!_popEl || _popEl.style.display === 'none') return;
    var w = _popEl.offsetWidth || 390;
    var h = _popEl.offsetHeight || 300;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left, top;
    var r = null;
    try { r = (_popAnchor && _popAnchor.getBoundingClientRect) ? _popAnchor.getBoundingClientRect() : null; } catch (e) { r = null; }
    if (r && (r.width || r.height)) {
      left = Math.round(Math.min(Math.max(12, r.right - w), Math.max(12, vw - w - 12)));
      top = Math.round(r.bottom + 8);
      if (top + h > vh - 12) {
        var above = Math.round(r.top - h - 8);
        top = above >= 12 ? above : Math.max(12, vh - h - 12);
      }
    } else {
      left = Math.round(Math.max(12, (vw - w) / 2));
      top = Math.round(Math.max(12, (vh - h) / 2));
    }
    _popEl.style.left = left + 'px';
    _popEl.style.top = top + 'px';
  }
  function closePopover() {
    if (_popEl) _popEl.style.display = 'none';
    _popAnchor = null;
    if (_popOutside) {
      document.removeEventListener('mousedown', _popOutside, true);
      window.removeEventListener('keydown', _popOutside, true);
      window.removeEventListener('resize', _popOutside, true);
      window.removeEventListener('scroll', _popOutside, true);
      _popOutside = null;
    }
  }
  function openPopover(anchor, title) {
    if (!_popEl) {
      _popEl = el('div', { id: 'txpd-pop' });
      var head = el('div', { id: 'txpd-pop-head' });
      var titleEl = el('div', { id: 'txpd-pop-title' });
      var actions = el('div', { id: 'txpd-pop-actions' });
      var close = el('button', { id: 'txpd-pop-close', type: 'button', title: '关闭' }, '×');
      close.addEventListener('click', closePopover);
      head.appendChild(titleEl);
      head.appendChild(actions);
      head.appendChild(close);
      var body = el('div', { id: 'txpd-pop-body' });
      _popEl.appendChild(head);
      _popEl.appendChild(body);
      document.body.appendChild(_popEl);
      _popEl._title = titleEl; _popEl._body = body; _popEl._actions = actions;
    }
    _popEl._title.textContent = title || '';
    _popEl._actions.innerHTML = '';
    _popEl._body.innerHTML = '';
    _popEl.style.display = 'flex';
    _popAnchor = anchor || null;
    positionPopover();
    setTimeout(positionPopover, 0);
    _popOutside = function (ev) {
      if (ev.type === 'keydown') { if (ev.key === 'Escape') closePopover(); return; }
      if (ev.type === 'resize' || ev.type === 'scroll') { positionPopover(); return; }
      var tg = ev.target;
      if (_popEl && tg && _popEl.contains(tg)) return;
      if (_popAnchor && _popAnchor.contains && tg && _popAnchor.contains(tg)) return;
      closePopover();
    };
    document.addEventListener('mousedown', _popOutside, true);
    window.addEventListener('keydown', _popOutside, true);
    window.addEventListener('resize', _popOutside, true);
    window.addEventListener('scroll', _popOutside, true);
    return _popEl._body;
  }

  // ---------- 右侧抽屉（私信 / 插件管理员等，替代居中弹窗） ----------
  function openDrawer(title) {
    var dr = document.getElementById('txpd-drawer');
    if (!dr) {
      dr = el('div', { id: 'txpd-drawer' });
      var head = el('div', { id: 'txpd-drawer-head' });
      var tEl = el('div', { style: 'font-size:16px;font-weight:600;color:#111;' }, title);
      var close = el('button', { style: 'border:none;background:none;font-size:20px;color:#666;cursor:pointer;line-height:1;' }, '×');
      close.addEventListener('click', function () { dr.style.display = 'none'; });
      head.appendChild(tEl);
      head.appendChild(close);
      var body = el('div', { id: 'txpd-drawer-body' });
      dr.appendChild(head);
      dr.appendChild(body);
      document.body.appendChild(dr);
      dr._title = tEl;
      dr._body = body;
    }
    dr.style.display = 'flex';
    dr._title.textContent = title;
    dr._body.innerHTML = '';
    return dr._body;
  }

  // ---------- 会话列表移位：官方把当前频道的会话列表(.channel-list)渲染在
  // 「未加入的频道」分组里当前频道条目下方；按用户要求移到左侧边栏
  // 「已加入的频道」里对应频道名下，未加入分组只留真正的临时条目 ----------
  var _movedChannelList = null;
  var _movedChannelHome = null;   // 官方会话列表原来的父节点（收起时放回去，不删）

  // 收起重排的会话列表：优先「放回原位」，保持应用自己的 DOM 形状。
  // 直接 remove 会让 Vue 之后 insertBefore 找不到参照节点（报 is not a child of this node）。
  function restoreChannelList() {
    var node = _movedChannelList;
    _movedChannelList = null;
    if (!node || !node.parentNode) return;
    node.removeAttribute('data-txpd-moved');
    node.style.cssText = '';
    // 之前隐藏的官方「展开全部」也恢复（它只在列表被移走时才需要藏）
    Array.prototype.forEach.call(node.querySelectorAll('[data-txpd-hidden]'), function (ch) {
      ch.style.removeProperty('display');
      ch.removeAttribute('data-txpd-hidden');
    });
    if (_movedChannelHome && _movedChannelHome.isConnected) {
      _movedChannelHome.appendChild(node);
    } else {
      node.parentNode.removeChild(node);   // 原位置已经没了（换过频道/被应用重建）→ 只能移除
    }
    _movedChannelHome = null;
  }

  function moveChannelList() {
    var num = currentGuildNumber();
    var dst = num ? document.querySelector('.aside-group--txpd-joined .my-guild-item[data-gnum="' + num + '"]') : null;
    // 非频道视图，或当前频道未加入（不在我的分区）→ 收起已移入的会话列表
    if (!dst) {
      restoreChannelList();
      return;
    }
    var src = document.querySelector('.aside-group--my-temp-guild .channel-list');
    if (!src || src.getAttribute('data-txpd-moved') === '1') return;
    restoreChannelList();
    _movedChannelHome = src.parentNode;
    src.setAttribute('data-txpd-moved', '1');
    src.style.cssText = 'padding:0 0 6px 6px;';
    src.classList.remove('txpd-show-all');
    // 官方「展开全部」节点隐藏即可（同样不删：它是应用管理的节点）。
    // 用 inline !important 才能压过官方的展开态样式（普通 display:none 会被重新显示出来）
    Array.prototype.forEach.call(src.children, function (ch) {
      if ((ch.innerText || '').indexOf('展开全部') !== -1) {
        ch.style.setProperty('display', 'none', 'important');
        ch.setAttribute('data-txpd-hidden', '1');
      }
    });
    dst.parentNode.insertBefore(src, dst.nextSibling);
    _movedChannelList = src;
    // 「查看全部/收起」切换行（会话数 > 3 时才有意义）
    var convCount = src.children.length - src.querySelectorAll('.txpd-expand-link').length;
    var toggle = document.getElementById('txpd-chlist-toggle');
    if (!toggle) {
      toggle = el('div', { id: 'txpd-chlist-toggle' });
      toggle.style.cssText = 'font-size:12px;color:#2b64f5;padding:4px 6px;cursor:pointer;';
      toggle.addEventListener('click', function () {
        var list = document.querySelector('.channel-list[data-txpd-moved="1"]');
        if (!list) return;
        var showAll = list.classList.toggle('txpd-show-all');
        toggle.textContent = showAll ? '收起' : '查看全部';
      });
    }
    if (convCount > 3) {
      toggle.textContent = src.classList.contains('txpd-show-all') ? '收起' : '查看全部';
      toggle.style.display = 'block';
      src.parentNode.insertBefore(toggle, src.nextSibling);
    } else if (toggle.parentNode) {
      toggle.style.display = 'none';
    }
  }

  // 官方「我的频道」分组里的条目（= 网页登录账号已加入的频道）：
  // 官方的「未加入的频道」是访问记录缓存（tempGuild_*），不认成员身份，
  // 所以「网页账号加了、CLI 账号没加」的频道会在两个分组里各出现一次。
  // 这里把官方我的频道里的频道也算作「已加入」，只用于从「未加入的频道」里剔除。
  var _officialMyKeys = { ts: 0, gids: {}, names: {} };
  function officialMemberKeys() {
    var now = Date.now();
    if (now - _officialMyKeys.ts < 500) return _officialMyKeys;
    var gids = {}, names = {};
    var group = document.querySelector('.aside-group--my-guild');
    if (group) {
      Array.prototype.forEach.call(group.querySelectorAll('.my-guild-item'), function (it) {
        var img = it.querySelector('img.item-avatar') || it.querySelector('img');
        var m = img ? /groupprohead\.gtimg\.cn\/(\d+)/.exec(img.getAttribute('src') || '') : null;
        if (m) gids[m[1]] = 1;
        var nameEl = it.querySelector('.item-name');
        var t = nameEl ? (nameEl.textContent || '').trim() : '';
        if (t) names[t] = 1;
      });
    }
    _officialMyKeys = { ts: now, gids: gids, names: names };
    return _officialMyKeys;
  }

  // 「未加入的频道」分区清理（轮询兜底 + MutationObserver 即时触发）：
  // 1) 隐藏实为已加入的频道条目（CLI 账号的 guild_id/名称，或官方「我的频道」里的频道）
  // 2) 当前频道的展开条目（含对话分组）仅在「已加入」时隐藏；
  //    未加入的频道访问后要正常显示在「未加入的频道」里（官方行为，用户要求保留）
  function tempHideItem(item) {
    var img = item.querySelector('img.item-avatar');
    var m = img ? /groupprohead\.gtimg\.cn\/(\d+)/.exec(img.getAttribute('src') || '') : null;
    var gid = m ? m[1] : '';
    var nameEl = item.querySelector('.item-name');
    var name = nameEl ? nameEl.textContent.trim() : '';
    if (!item.getAttribute('data-txpd-gnum') && name) item.setAttribute('data-txpd-gnum', name);
    var cls = (item.className || '').toString();
    var expanded = cls.indexOf('router-link-active') !== -1 || !!item.querySelector('.router-link-active') || (item.innerText || '').indexOf('展开全部') !== -1;
    var num = currentGuildNumber();
    var currentIsJoined = !!(num && _joinedKeys && _joinedKeys[num]);
    var off = officialMemberKeys();
    var officialJoined = !!((gid && off.gids[gid]) || (name && off.names[name]));
    var numHit = numVariants(item.getAttribute('data-txpd-gnum') || gid).some(function (k) { return _joinedKeys && _joinedKeys[k]; });
    if (officialJoined || numHit || (gid && _joinedKeys && _joinedKeys[gid]) || (name && _joinedNames && _joinedNames[name]) || (expanded && currentIsJoined)) {
      item.style.display = 'none';
      return true;
    }
    return false;
  }
  // 官方「我的频道」（按网页登录态）与插件「已加入的频道」（按 CLI 账号）重复时，只显示在「已加入的频道」。
  // 只改 display，不删不动官方节点（Vue 托管）。
  function syncMyGuildDuplicates() {
    var group = document.querySelector('.aside-group--my-guild');
    if (!group) return;
    Array.prototype.forEach.call(group.querySelectorAll('.my-guild-item'), function (it) {
      var img = it.querySelector('img.item-avatar') || it.querySelector('img');
      var m = img ? /groupprohead\.gtimg\.cn\/(\d+)/.exec(img.getAttribute('src') || '') : null;
      var gid = m ? m[1] : '';
      var nameEl = it.querySelector('.item-name');
      var name = nameEl ? (nameEl.textContent || '').trim() : '';
      var dup = !!((gid && _joinedKeys && _joinedKeys[gid])
        || (name && _joinedNames && _joinedNames[name])
        || numVariants(gid || name).some(function (k) { return _joinedKeys && _joinedKeys[k]; }));
      if (dup) {
        it.style.display = 'none';
        it.setAttribute('data-txpd-dup', '1');
      } else if (it.getAttribute('data-txpd-dup')) {
        it.style.removeProperty('display');
        it.removeAttribute('data-txpd-dup');
      }
    });
  }

  function syncTempGuildSection() {
    if (!_joinedKeys) return;
    var group = document.querySelector('.aside-group--my-temp-guild');
    if (!group) return;
    var items = group.querySelectorAll('.my-guild-item');
    for (var i = 0; i < items.length; i++) tempHideItem(items[i]);
    try {
      var off = officialMemberKeys();
      var lsKeys = [];
      for (var k = 0; k < window.localStorage.length; k++) lsKeys.push(window.localStorage.key(k));
      for (var j = 0; j < lsKeys.length; j++) {
        var key = lsKeys[j];
        if (key.indexOf('tempGuild_') !== 0) continue;
        var raw = window.localStorage.getItem(key);
        if (!raw || raw.indexOf('guildId') === -1) continue;
        var arr = JSON.parse(raw);
        if (!Array.isArray(arr)) continue;
        // 丢掉：CLI 账号已加入的 / 官方「我的频道」里的 / 条目自己标了 hasJoined 的
        var filtered = arr.filter(function (x) {
          if (!x) return false;
          if (_joinedKeys[x.guildNum] || _joinedKeys[x.guildId]) return false;
          if (off.gids[x.guildId] || (x.guildName && off.names[x.guildName])) return false;
          return !x.hasJoined;
        });
        if (filtered.length !== arr.length) window.localStorage.setItem(key, JSON.stringify(filtered));
      }
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  // 已加入频道的视图：把「加入频道」按钮（button 或 join-guild-button DIV）替换为「已加入」
  function syncGuildViewJoinBtn() {
    if (!_joinedKeys) return;
    var num = currentGuildNumber();
    if (!num || !_joinedKeys[num]) return;
    var els = document.querySelectorAll('button, .join-guild-button');
    for (var i = 0; i < els.length; i++) {
      var b = els[i];
      if (b.textContent && b.textContent.trim() === '加入频道' && b.offsetParent !== null) {
        b.disabled = true;
        b.style.pointerEvents = 'none';
        b.style.opacity = '0.6';
        b.textContent = '✓ 已加入';
      }
    }
  }

  // ---------- 轻提示 ----------
  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = el('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483002;background:rgba(20,20,30,.92);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;max-width:80vw;transition:opacity .4s;pointer-events:none;';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.style.opacity = '0'; }, 2600);
  }

  // ---------- 加入频道：卡片/链接 → CLI（搜索频道号 → 确认 → join-guild） ----------
  function extractGuildNumber(s) {
    var m = /(?:pd\.qq\.com)?\/g\/([^\/?#]+)/i.exec(s || '');
    return m ? decodeURIComponent(m[1]) : '';
  }
  function currentGuildNumber() {
    return extractGuildNumber(window.location.pathname);
  }
  function openJoinFlow(guildNumber) {
    ensureMask();
    stopPoll();
    mask.style.display = 'flex';
    dlg.innerHTML = '';
    dlg.appendChild(el('button', { id: 'txpd-acct-close' }, '×')).addEventListener('click', closeDlg);
    dlg.appendChild(el('h3', null, '加入频道'));
    var stage = el('div', { style: 'font-size:14px;color:#333;' }, '正在查询频道「' + guildNumber + '」…');
    dlg.appendChild(stage);

    function line(label, val) {
      var p = el('div', { style: 'margin:6px 0;' });
      p.appendChild(el('span', { style: 'color:#888;font-size:13px;' }, label + ' '));
      p.appendChild(el('span', { style: 'color:#222;font-size:14px;' }, val));
      return p;
    }
    api('/cli', { method: 'POST', body: { action: 'search-guild', params: { keyword: guildNumber, scope: 'channel' } } }).then(function (r) {
      var channels = (r.data && r.data.data && r.data.data.channels) || [];
      var ch = null;
      for (var i = 0; i < channels.length; i++) {
        if (String(channels[i].guild_number) === guildNumber) { ch = channels[i]; break; }
      }
      if (!r.success || !ch) {
        stage.textContent = '未找到频道「' + guildNumber + '」' + (r.message ? '：' + r.message : '');
        stage.style.color = '#e5484d';
        return;
      }
      stage.innerHTML = '';
      stage.appendChild(line('频道', ch.name || guildNumber));
      stage.appendChild(line('成员', String(ch.member_count != null ? ch.member_count : '?')));
      if (ch.profile) stage.appendChild(line('简介', String(ch.profile).replace(/\s+/g, ' ').slice(0, 60)));
      var joinBtn = el('button', { 'class': 'txpd-btn', type: 'button' }, '确认加入');
      stage.appendChild(joinBtn);
      var status = el('div', { style: 'font-size:13px;color:#2b64f5;margin-top:8px;min-height:18px;' });
      stage.appendChild(status);
      joinBtn.addEventListener('click', function () {
        joinBtn.disabled = true;
        joinBtn.textContent = '正在加入…';
        api('/cli', { method: 'POST', body: { action: 'join-guild', params: { guild_id: ch.guild_id } } }).then(function (r2) {
          if (r2.success) {
            status.textContent = '✓ 已加入频道「' + (ch.name || guildNumber) + '」';
            status.style.color = '#15a361';
            joinBtn.textContent = '已完成';
            invalidateAccounts();
            invalidateGuilds();
          } else {
            status.textContent = r2.message || '加入失败';
            status.style.color = '#e5484d';
            joinBtn.disabled = false;
            joinBtn.textContent = '重试加入';
          }
        }).catch(function () {
          status.textContent = '网络错误，请重试';
          status.style.color = '#e5484d';
          joinBtn.disabled = false;
          joinBtn.textContent = '重试加入';
        });
      });
    }).catch(function () {
      stage.textContent = '网络错误，请重试';
      stage.style.color = '#e5484d';
    });
  }

  // ---------- 侧栏「已加入的频道」：数据走 CLI guilds，localStorage 缓存 1 小时 ----------
  // 注意：TXPD_USER 声明在文件顶部（loadVirtualCookies 会先于此处赋值，不能重复初始化）
  var _guildsCache = null;
  var _joinedKeys = null;   // guild_number / guild_id 集合
  var _joinedNames = null;  // 名称集合

  function guildCacheKey() { return 'txpd_joined_guilds_v1_' + (TXPD_USER || 'default'); }

  // 频道号的两种形态：地址栏里是 base64（如 scz8r23h27），接口/CLI 里常是纯数字。
  // 两者互为编码，比较前统一展开成「原样 + 数字」两个键，避免同一频道被判成未加入。
  function numVariants(v) {
    var out = [];
    var raw = String(v == null ? '' : v).trim();
    if (!raw) return out;
    out.push(raw);
    // base64 → 数字（去掉 -_ 补齐与空白）
    try {
      var b = raw.replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      var txt = atob(b);
      var digits = txt.replace(/[^0-9]/g, '');
      if (digits && digits.length >= 6) out.push(digits);
    } catch (e) { /* 不是 base64 就跳过 */ }
    // 纯数字 → base64
    if (/^\d{6,}$/.test(raw)) {
      try {
        out.push(btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
      } catch (e) { /* 忽略 */ }
    }
    return out.filter(function (x, i, a) { return x && a.indexOf(x) === i; });
  }

  // 页面顶部标题栏里的频道名（频道号两套编码对不上时，用它兜底认频道）
  function pageGuildName() {
    var el1 = document.querySelector('.guild-info__basic__name') || document.querySelector('.top_title_name') ||
      document.querySelector('.guild-web-main-title-bar .guild-info__basic__name') ||
      document.querySelector('.game-guild-main__not-permit__name');
    var t = el1 ? (el1.textContent || '').trim() : '';
    return t.replace(/频道$/, '').trim();
  }

  function setJoinedCache(guilds) {
    _guildsCache = guilds;
    _joinedKeys = {};
    _joinedNames = {};
    guilds.forEach(function (g) {
      numVariants(g.guild_number).forEach(function (k) { _joinedKeys[k] = 1; });
      if (g.guild_id) _joinedKeys[g.guild_id] = 1;
      if (g.name) _joinedNames[g.name.trim()] = 1;
    });
  }

  var _guildsLoading = null;
  function loadJoinedGuilds() {
    if (_guildsCache) return Promise.resolve(_guildsCache);
    if (_guildsLoading) return _guildsLoading;
    // localStorage 1 小时缓存：频道列表加载慢（CLI 约 4s），缓存后秒出且无闪烁
    try {
      var raw = window.localStorage.getItem(guildCacheKey());
      if (raw) {
        var box = JSON.parse(raw);
        if (box && Array.isArray(box.guilds) && Date.now() - box.ts < 3600000 && box.guilds.length) {
          setJoinedCache(box.guilds);
          return Promise.resolve(_guildsCache);
        }
      }
    } catch (e) { /* 忽略损坏缓存 */ }
    _guildsLoading = api('/cli', { method: 'POST', body: { action: 'guilds', params: {} } }).then(function (r) {
      if (!r.success) return []; // 未登录等：不缓存，登录后下次轮询重取
      var data = (r.data && r.data.data) || {};
      var seen = {}, all = [];
      // 三个列表都要算「已加入」：created（我创建的）/ managed（我是管理员·小管家）/
      // joined（普通成员）。漏掉 managed 会让管理员身份在面板里显示成「未加入」。
      (data.created_guilds || []).concat(data.managed_guilds || [], data.joined_guilds || []).forEach(function (g) {
        if (g && g.guild_id && !seen[g.guild_id]) { seen[g.guild_id] = 1; all.push(g); }
      });
      setJoinedCache(all);
      try { window.localStorage.setItem(guildCacheKey(), JSON.stringify({ ts: Date.now(), guilds: all })); } catch (e) { /* 忽略 */ }
      return all;
    }).then(function (all) {
      _guildsLoading = null;
      return all;
    }, function (e) {
      _guildsLoading = null;
      throw e;
    });
    return _guildsLoading;
  }

  // 点击已加入的频道 → 应用内路由进入频道视图（与「未加入的频道」卡片一致，不刷新页面）
  function spaNavigate(path) {
    // pushState(null) + popstate：vue-router 视为手动地址变更，走应用内 replace（不整页刷新）
    try {
      var target = PANEL_BASE + path;
      if (window.location.pathname === target) return true;
      window.history.pushState(null, '', target);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
      setTimeout(function () {
        // 兜底：路由未接管（如深链不识别）再整页加载
        if (window.location.pathname !== target) window.location.href = target;
      }, 400);
      return true;
    } catch (e) { return false; }
  }
  function openGuildView(g) {
    var num = (g && g.guild_number) || '';
    if (!num) { toast('该频道缺少频道号，无法打开'); return; }
    if (!spaNavigate('g/' + encodeURIComponent(num))) {
      window.location.href = PANEL_BASE + 'g/' + encodeURIComponent(num);
    }
  }

  function ensureJoinedSection() {
    var nav = document.querySelector('.aside-nav');
    if (!nav) return;
    if (nav.querySelector('.aside-group--txpd-joined')) return;
    var group = el('div', { 'class': 'aside-group aside-group--txpd-joined' });
    var header = el('div', { 'class': 'group-header' });
    header.style.cssText = 'position:relative;';
    header.appendChild(el('h3', { 'class': 'group-title' }, '已加入的频道'));
    // 账号入口：虚拟会话下官方登录卡不再出现，账号管理移到分区标题右侧
    var entryLabel = '账号';
    try {
      var rawL = window.localStorage.getItem(acctCacheKey());
      if (rawL) {
        var boxL = JSON.parse(rawL);
        if (boxL && Date.now() - boxL.ts < 10800000) entryLabel = boxL.any ? '切换账号' : '扫码登录';
      }
    } catch (e) { /* 忽略 */ }
    var entry = el('span', {
      id: 'txpd-acct-entry',
      style: 'position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;color:#2b64f5;cursor:pointer;white-space:nowrap;',
    }, entryLabel);
    entry.addEventListener('click', function (ev) {
      ev.stopPropagation();
      getAccountsState().then(function (any) { if (any) openAccountList(); else openQrStage(); }).catch(function () { openQrStage(); });
    });
    header.appendChild(entry);
    group.appendChild(header);
    var list = el('div', { 'class': 'unjoin-guild-list' });
    list.appendChild(el('div', { style: 'font-size:12px;color:#999;padding:6px 8px;' }, '加载中…'));
    group.appendChild(list);
    var navGroup = nav.querySelector('.aside-group--nav');
    if (navGroup && navGroup.nextSibling) nav.insertBefore(group, navGroup.nextSibling);
    else nav.insertBefore(group, nav.firstChild);

    getAccountsState().then(function (any) {
      var entry2 = document.getElementById('txpd-acct-entry');
      if (entry2) entry2.textContent = any ? '切换账号' : '扫码登录';
    }).catch(function () { /* 忽略 */ });
    loadJoinedGuilds().then(function (guilds) {
      var list2 = document.querySelector('.aside-group--txpd-joined .unjoin-guild-list');
      if (!list2) return;
      list2.innerHTML = '';
      if (!guilds.length) {
        list2.appendChild(el('div', { style: 'font-size:12px;color:#999;padding:6px 8px;' }, '暂无已加入的频道'));
      }
      guilds.forEach(function (g, idx) {
        var wrap = el('div');
        wrap.setAttribute('index', String(idx));
        var item = el('div', {
          'class': 'my-guild-item',
          'data-gnum': g.guild_number || '',
          'title': (g.name || '') + '（' + (g.role || '成员') + '），点击进入频道',
        });
        var av = el('div', { 'class': 'item-avatar-wrap' });
        var img = el('img', {
          'class': 'item-avatar',
          'src': 'https://groupprohead.gtimg.cn/' + g.guild_id + '/100',
          'alt': g.name || '',
          'loading': 'lazy',
        });
        img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
        av.appendChild(img);
        item.appendChild(av);
        item.appendChild(el('div', { 'class': 'item-name ellipsis' }, g.name || g.guild_number || ''));
        item.addEventListener('click', function () { openGuildView(g); });
        wrap.appendChild(item);
        list2.appendChild(wrap);
      });

    }).catch(function () { /* CLI 未登录等，忽略 */ });
  }

  // ---------- 通用小面板（对话框内容切换用） ----------
  function openPanel(title, width) {
    ensureMask();
    stopPoll();
    mask.style.display = 'flex';
    dlg.innerHTML = '';
    dlg.style.width = width || 'min(480px,92vw)';
    // 限高 + 内部滚动：表单再长也不会超出屏幕
    dlg.style.maxHeight = '86vh';
    dlg.style.overflowY = 'auto';
    dlg.appendChild(el('button', { id: 'txpd-acct-close', style: 'float:right;border:none;background:none;font-size:20px;color:#999;cursor:pointer;line-height:1;' }, '×')).addEventListener('click', closeDlg);
    dlg.appendChild(el('h3', { style: 'margin:0 0 12px;font-size:17px;color:#111;display:inline-block;' }, title));
    return dlg;
  }
  function fieldRow(labelText, inputEl) {
    var row = el('div', { style: 'margin:8px 0;' });
    var lab = el('div', { 'class': 'txpd-fld' }, labelText);
    row.appendChild(lab);
    row.appendChild(inputEl);
    return row;
  }
  function textInput(placeholder, value) {
    var i = el('input', { 'class': 'txpd-inp', placeholder: placeholder || '' });
    if (value) i.value = value;
    return i;
  }
  function areaInput(placeholder, value, h) {
    var i = el('textarea', { 'class': 'txpd-inp', placeholder: placeholder || '' });
    i.style.height = (h || 80) + 'px';
    i.style.resize = 'vertical';
    if (value) i.value = value;
    return i;
  }
  function primaryBtn(text) {
    var b = el('button', { 'class': 'txpd-btn', type: 'button' }, text);
    return b;
  }
  function statusLine() {
    return el('div', { 'class': 'txpd-sts' }, '');
  }
  function panelError(status, msg) {
    status.textContent = String(msg || '操作失败').slice(0, 160);
    status.style.color = '#e5484d';
  }
  function currentGuild() {
    var num = currentGuildNumber();
    var g = null;
    if (num && _guildsCache) {
      var want = numVariants(num);
      for (var i = 0; i < _guildsCache.length; i++) {
        var gi = numVariants(_guildsCache[i].guild_number);
        if (gi.some(function (x) { return want.indexOf(x) !== -1; })) { g = _guildsCache[i]; break; }
      }
      if (!g) {
        // 兜底：按频道名认（频道号存在多种编码形态，地址栏里的那个不一定能对上接口返回的）
        var pn = pageGuildName();
        if (pn) {
          for (var j = 0; j < _guildsCache.length; j++) {
            if (String(_guildsCache[j].name || '').trim().replace(/频道$/, '').trim() === pn) { g = _guildsCache[j]; break; }
          }
        }
      }
    }
    return { num: num, g: g, id: g ? g.guild_id : '' };
  }

  // ---------- 图片选择器助手（选图/缩略图/顺序上传，供发帖与定时共用） ----------
  function setupImagePicker(imgBox, imagesArr) {
    var input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif', multiple: true, style: 'display:none;' });
    imgBox.appendChild(input);
    var add = el('div', { style: 'width:60px;height:60px;border:1px dashed #bbb;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#999;flex-shrink:0;' });
    add.appendChild(svgIcon('assets/common.svg#add-upload', 26));
    add.title = '添加图片';
    add.addEventListener('click', function () { input.click(); });
    imgBox.appendChild(add);
    function renderThumbs() {
      Array.prototype.forEach.call(imgBox.querySelectorAll('.txpd-thumb'), function (n) { n.parentNode.removeChild(n); });
      imagesArr.forEach(function (im) {
        var th = el('div', { 'class': 'txpd-thumb' });
        th.style.cssText = 'position:relative;width:60px;height:60px;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;';
        var im2 = el('img', { src: im.dataUrl, style: 'width:100%;height:100%;object-fit:cover;' });
        var x = el('div', { style: 'position:absolute;top:0;right:0;width:16px;height:16px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;text-align:center;line-height:16px;cursor:pointer;' }, '×');
        x.addEventListener('click', function () {
          var i2 = imagesArr.indexOf(im);
          if (i2 !== -1) imagesArr.splice(i2, 1);
          renderThumbs();
        });
        th.appendChild(im2); th.appendChild(x);
        imgBox.insertBefore(th, add);
      });
    }
    input.addEventListener('change', function () {
      Array.prototype.forEach.call(input.files || [], function (f) {
        if (!/^image\//.test(f.type)) return;
        var rd = new FileReader();
        rd.onload = function () { imagesArr.push({ name: f.name, dataUrl: rd.result }); renderThumbs(); };
        rd.readAsDataURL(f);
      });
      input.value = '';
    });
    return {
      uploadAll: function (onProgress) {
        return new Promise(function (resolve, reject) {
          var paths = [];
          (function next(i) {
            if (i >= imagesArr.length) { resolve(paths); return; }
            api('/upload-image', { method: 'POST', body: { name: imagesArr[i].name, data: imagesArr[i].dataUrl } }).then(function (r) {
              if (!r.success) throw new Error(r.message || '图片上传失败');
              paths.push(r.data.path);
              if (onProgress) onProgress(i + 1, imagesArr.length);
              next(i + 1);
            }).catch(reject);
          })(0);
        });
      }
    };
  }

  var _channelsCache = {};
  function loadGuildChannels(g) {
    var c = _channelsCache[g.guild_id];
    if (c && Date.now() - c.ts < 600000) return Promise.resolve(c.channels);
    return api('/cli', { method: 'POST', body: { action: 'channels', params: { guild_id: g.guild_id } } }).then(function (r) {
      var channels = (r.data && r.data.data && r.data.data.channels) || [];
      _channelsCache[g.guild_id] = { ts: Date.now(), channels: channels };
      return channels;
    });
  }
  function selectStyle() {
    return 'width:100%;box-sizing:border-box;border:1px solid var(--border-input-box,rgba(219,220,224,.9));border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;background:var(--bg-middle-light,#fff);color:var(--text-primary,#222);';
  }
  function buildScheduleForm(dlgP, preGuild) {
    var cur = preGuild && preGuild.num ? preGuild.num : currentGuildNumber();
    var gSel = el('select'); gSel.style.cssText = selectStyle();
    _guildsCache.forEach(function (g) {
      var o = el('option', { value: g.guild_id }, (g.name || g.guild_number) + (g.role && g.role !== '成员' ? '（' + g.role + '）' : ''));
      o.value = g.guild_id;
      gSel.appendChild(o);
    });
    if (cur) {
      for (var gi = 0; gi < _guildsCache.length; gi++) {
        if (_guildsCache[gi].guild_number === cur) { gSel.value = _guildsCache[gi].guild_id; break; }
      }
    }
    var cSel = el('select'); cSel.style.cssText = selectStyle();
    function loadChannelOptions() {
      cSel.innerHTML = '';
      cSel.appendChild(el('option', { value: '' }, '版块加载中…'));
      var gid = gSel.value;
      loadGuildChannels({ guild_id: gid }).then(function (channels) {
        if (gSel.value !== gid) return;
        cSel.innerHTML = '';
        if (!channels.length) { cSel.appendChild(el('option', { value: '' }, '无版块')); return; }
        channels.forEach(function (ch) {
          var o = el('option', { value: ch.channel_id }, ch.channel_name || ch.channel_id);
          o.value = ch.channel_id;
          cSel.appendChild(o);
        });
      }).catch(function () {
        cSel.innerHTML = '';
        cSel.appendChild(el('option', { value: '' }, '版块加载失败'));
      });
    }
    loadChannelOptions();
    gSel.addEventListener('change', loadChannelOptions);
    var nameInput = textInput('计划名称（可选）', '');
    var cronSel = el('select'); cronSel.style.cssText = selectStyle();
    [['daily', '每天'], ['weekly', '每周'], ['every30', '每30分钟'], ['custom', '自定义 Cron']].forEach(function (pp) {
      var o = el('option', { value: pp[0] }, pp[1]);
      cronSel.appendChild(o);
    });
    var timeInput = textInput('', '09:00');
    timeInput.setAttribute('type', 'time');
    var wdSel = el('select'); wdSel.style.cssText = selectStyle();
    [['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六'], ['0', '周日']].forEach(function (pp) {
      var o = el('option', { value: pp[0] }, pp[1]);
      wdSel.appendChild(o);
    });
    var cronInput = textInput('分 时 日 月 周', '0 9 * * *');
    var titleInput = textInput('标题（可选）', '');
    var fmtSel = el('select'); fmtSel.style.cssText = selectStyle();
    [['text', '纯文本'], ['md', 'Markdown'], ['html', 'HTML']].forEach(function (pp) {
      var o = el('option', { value: pp[0] }, pp[1]);
      fmtSel.appendChild(o);
    });
    var contentInput = areaInput('帖子内容', '', 70);
    var schedImages = [];
    var imgBox = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;' });
    var imgPicker = setupImagePicker(imgBox, schedImages);
    // 两列栅格：一行放两个设置，内容/图片占满整行（窄屏自动回落一列）
    var grid = el('div', { 'class': 'txpd-sched-form' });
    grid.appendChild(fieldRow('频道', gSel));
    grid.appendChild(fieldRow('版块', cSel));
    grid.appendChild(fieldRow('计划名称', nameInput));
    grid.appendChild(fieldRow('发送频率', cronSel));
    var weeklyRow = fieldRow('星期', wdSel); weeklyRow.style.display = 'none'; grid.appendChild(weeklyRow);
    var timeRow = fieldRow('时间', timeInput); timeRow.style.display = 'none'; grid.appendChild(timeRow);
    var cronRow = fieldRow('Cron 表达式', cronInput); cronRow.style.display = 'none'; grid.appendChild(cronRow);
    grid.appendChild(fieldRow('标题', titleInput));
    grid.appendChild(fieldRow('格式', fmtSel));
    var contentRow = fieldRow('内容', contentInput);
    contentRow.style.gridColumn = '1 / -1';
    grid.appendChild(contentRow);
    var imgRow = fieldRow('图片（可选）', imgBox);
    imgRow.style.gridColumn = '1 / -1';
    grid.appendChild(imgRow);
    dlgP.appendChild(grid);
    var send = primaryBtn('保存计划');
    send.style.width = '100%';
    var status = statusLine();
    dlgP.appendChild(send);
    dlgP.appendChild(status);
    function syncCronUI() {
      var v = cronSel.value;
      weeklyRow.style.display = v === 'weekly' ? '' : 'none';
      timeRow.style.display = (v === 'daily' || v === 'weekly') ? '' : 'none';
      cronRow.style.display = v === 'custom' ? '' : 'none';
    }
    cronSel.addEventListener('change', syncCronUI);
    syncCronUI();
    send.addEventListener('click', function () {
      var cron;
      var v = cronSel.value;
      if (v === 'daily') {
        var t1 = (timeInput.value || '09:00').split(':');
        cron = parseInt(t1[1], 10) + ' ' + parseInt(t1[0], 10) + ' * * *';
      } else if (v === 'weekly') {
        var t2 = (timeInput.value || '09:00').split(':');
        cron = parseInt(t2[1], 10) + ' ' + parseInt(t2[0], 10) + ' * * ' + wdSel.value;
      } else if (v === 'every30') {
        cron = '*/30 * * * *';
      } else {
        cron = cronInput.value.trim();
      }
      var content = contentInput.value;
      if (!content.trim()) { panelError(status, '内容不能为空'); return; }
      if (!cSel.value) { panelError(status, '请选择版块'); return; }
      send.disabled = true;
      status.style.color = '#888';
      var doSave = function (imagePaths) {
        status.textContent = '正在保存…';
        api('/schedules/save', { method: 'POST', body: { cron: cron, guild_id: gSel.value, channel_id: cSel.value, name: nameInput.value.trim(), title: titleInput.value.trim(), content: content, images: imagePaths, format: fmtSel.value, user: TXPD_USER, enabled: true } }).then(function (r) {
          if (!r.success) throw new Error(r.message || '保存失败');
          status.textContent = '✓ 计划已保存';
          status.style.color = '#15a361';
          send.style.display = 'none';
        }).catch(function (e) { panelError(status, e.message); send.disabled = false; });
      };
      imgPicker.uploadAll(function (done, total) {
        status.textContent = '正在上传图片 ' + done + '/' + total + '…';
      }).then(doSave).catch(function (e) { panelError(status, e.message); send.disabled = false; });
    });
  }
  // ---------- 频道配置（改名/改简介；主/管理员可见） ----------
  function openGuildConfig(anchor) {
    var ctx = currentGuild();
    if (!ctx.g) { toast('未识别当前频道'); return; }
    var dlgP = openPopover(anchor, '频道配置');
    var nameInput = textInput('频道名称', ctx.g.name || '');
    var profileInput = areaInput('频道简介', ctx.g.profile || '', 90);
    var send = primaryBtn('保存');
    var status = statusLine();
    dlgP.appendChild(fieldRow('频道名称', nameInput));
    dlgP.appendChild(fieldRow('频道简介', profileInput));
    dlgP.appendChild(send);
    dlgP.appendChild(status);
    send.addEventListener('click', function () {
      send.disabled = true;
      status.style.color = '#888';
      status.textContent = '正在保存…';
      api('/cli', { method: 'POST', body: { action: 'update-guild-name', params: { guild_id: ctx.id, guild_name: nameInput.value.trim(), guild_profile: profileInput.value.trim() } } }).then(function (r) {
        if (!r.success) throw new Error(r.message || '保存失败');
        status.textContent = '✓ 已保存';
        status.style.color = '#15a361';
      }).catch(function (e) { panelError(status, e.message); }).then(function () { send.disabled = false; });
    });
  }

  // ---------- 成员列表（分页 + 搜索），点成员名可发私信 ----------
  function openMemberList(anchor) {
    var ctx = currentGuild();
    if (!ctx.id) { toast('未识别当前频道'); return; }
    var dlgP = openPopover(anchor, '成员列表');
    var search = textInput('搜索成员昵称…', '');
    var box = el('div', { style: 'margin-top:8px;' });
    var more = el('div', { style: 'font-size:12px;color:#2b64f5;text-align:center;padding:6px;cursor:pointer;' }, '加载更多');
    dlgP.appendChild(search);
    dlgP.appendChild(box);
    dlgP.appendChild(more);
    var token = '', kw = '', allMembers = [];
    function renderRows(members) {
      members.forEach(function (m) {
        var row = el('div', { 'class': 'txpd-acct-item', 'data-tiny': m.tinyid || '' });
        row.appendChild(el('span', { 'class': 'txpd-acct-dot' }));
        var nameEl = el('span', { 'class': 'txpd-acct-name', style: 'cursor:pointer;text-decoration:underline;' }, (m['昵称'] || m.nickname || m.tinyid || '') + (m.role && m.role !== '成员' ? '（' + m.role + '）' : ''));
        nameEl.addEventListener('click', function (e) {
          e.stopPropagation();
          openDmSend(m['昵称'] || m.tinyid, m.tinyid, ctx.id, true);
        });
        row.appendChild(nameEl);
        box.appendChild(row);
      });
    }
    function query(reset) {
      if (reset) { box.innerHTML = ''; token = ''; allMembers = []; }
      more.textContent = '加载成员中…';
      var params = { guild_id: ctx.id };
      if (kw) { params.keyword = kw; }
      else if (token) { params.next_page_token = token; }
      var action = kw ? 'member-search' : 'members';
      api('/cli', { method: 'POST', body: { action: action, params: params } }).then(function (r) {
        var data = (r.data && r.data.data) || {};
        var members = data.members || [];
        if (reset) box.innerHTML = '';
        allMembers = allMembers.concat(members);
        renderRows(members);
        token = data.next_page_token || '';
        var hasMore = data.has_more === true || data.has_more === 'True' || (!!token && !kw);
        if (!box.children.length) box.appendChild(el('div', { style: 'color:#999;font-size:13px;padding:14px 0;text-align:center;' }, kw ? '无匹配成员' : '暂无成员'));
        more.textContent = '已加载 ' + allMembers.length + ' 名成员';
        // 自动翻页补全（最多 20 页，防止超大频道失控）
        if (!kw && hasMore && token && allMembers.length < 20 * 120) {
          setTimeout(function () { if (kw === search.value.trim()) query(false); }, 150);
        } else {
          more.style.display = 'none';
        }
      }).catch(function () { more.textContent = '加载失败'; });
    }
    search.addEventListener('input', function () {
      kw = search.value.trim();
      clearTimeout(search._t);
      search._t = setTimeout(function () { query(true); }, 400);
    });
    more.addEventListener('click', function () { query(false); });
    query(true);
  }

  // ---------- 私信发送（CLI push-dm） ----------
  // 发私信：整页（与私信列表同一套页面机制，返回即回列表）
  var _dmCompose = { nick: '', tiny: '', guildId: '' };
  function openDmSend(nick, tinyId, sourceGuildId) {
    _dmCompose = { nick: nick || '', tiny: tinyId || '', guildId: sourceGuildId || '' };
    openPage('dmSend');
  }
  function buildDmSendPage() {
    var page = el('div', { 'class': 'app-page txpd-manage txpd-dm-send-page' });
    var head = el('div', { 'class': 'txpd-mg-head' });
    var back = mgBtn('← 返回私信列表');
    back.addEventListener('click', function () { openPage('dm'); });
    head.appendChild(back);
    head.appendChild(el('span', { 'class': 'txpd-mg-title', id: 'txpd-dm-peer' }, '发私信'));
    page.appendChild(head);
    var card = mgCard(null, '消息由频道账号（CLI）发送，因此不需要网页登录。');
    var ta = areaInput('消息内容…', '', 120);
    card.appendChild(ta);
    var row = el('div', { 'class': 'txpd-mg-row', style: 'margin-top:10px;' });
    var send = mgBtn('发送', true);
    var status = el('span', { 'class': 'txpd-mg-status' }, '');
    row.appendChild(send);
    row.appendChild(status);
    card.appendChild(row);
    page.appendChild(card);
    send.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { panelError(status, '请输入内容'); return; }
      send.disabled = true;
      status.style.color = '#888';
      status.textContent = '正在发送…';
      var params = { text: text };
      if (_dmCompose.tiny) params.peer_tiny_id = _dmCompose.tiny;
      if (_dmCompose.guildId) params.source_guild_id = _dmCompose.guildId;
      api('/cli', { method: 'POST', body: { action: 'push-dm', params: params } }).then(function (r) {
        if (!r.success) throw new Error(r.message || '发送失败');
        status.style.color = '#15a361';
        status.textContent = '✓ 已发送';
        try {
          var hist = JSON.parse(window.localStorage.getItem('txpd_dm_history') || '[]');
          hist.unshift({ nick: _dmCompose.nick, tiny: _dmCompose.tiny, text: text, ts: Date.now() });
          window.localStorage.setItem('txpd_dm_history', JSON.stringify(hist.slice(0, 50)));
        } catch (e) { /* 忽略 */ }
        ta.value = '';
        toast('✓ 已发送');
        setTimeout(function () { openPage('dm'); }, 900);   // 回到列表，能看到新记录
      }).catch(function (e) {
        panelError(status, e.message);
      }).then(function () { send.disabled = false; });
    });
    return page;
  }
  function syncDmSendPage() {
    var t = document.getElementById('txpd-dm-peer');
    if (t) t.textContent = '发私信：' + (_dmCompose.nick || _dmCompose.tiny || '');
  }

  // ---------- 私信列表（本地发送历史按联系人聚合） ----------
  // ---------- 整页视图：插件管理 / 定时发帖 / 私信列表 ----------
  // 三页共用「盖住应用内容 + 返回还原」的机制；节点缓存在 _pageViews 里复用，
  // 应用重渲染把节点挪走/删掉时只负责贴回去（重建会让元素身份变化，按钮点一半就失效）。
  var _pageViews = {};   // key -> 节点
  var _pageOpen = '';    // 当前打开的页面 key（'' = 没有）
  var _pagePath = '';    // 打开时的路由（路由变了自动收起）
  var PAGE_BUILDERS = {};   // key -> build 函数（各自的 build 函数定义后填充）
  var _wlPollTimer = null;
  var _wlActive = false;   // 一条轮询链是否在跑（定时器等待中 + 请求中）
  var _wlImgUrl = '';
  var _wlDone = false;   // 本轮二维码已到终态（成功/失效/失败），不再轮询

  function openPage(key) {
    _pageOpen = key;
    _pagePath = routeKey();
    ensurePageView();
  }
  function closePage() {
    _pageOpen = '';
    ensurePageView();
  }
  function openManagePage() { openPage('manage'); }
  function closeManagePage() { closePage(); }
  function ensurePageView() {
    // 用户点了别的导航/频道 → 自动收起（整页视图不跟随应用路由）
    if (_pageOpen && _pagePath && routeKey() !== _pagePath) _pageOpen = '';
    var explore = document.getElementById('explorePage');
    var dyn = document.querySelector('.txpd-dynamic');
    var guildMain = document.querySelector('.game-guild-main');
    Object.keys(_pageViews).forEach(function (k) {
      var n = _pageViews[k];
      if (k !== _pageOpen && n && n.parentNode) n.parentNode.removeChild(n);
    });
    if (!_pageOpen) {
      if (dyn) dyn.style.display = '';
      if (guildMain) guildMain.style.display = '';
      return;
    }
    var host = (explore && explore.parentNode) || document.querySelector('main') || document.querySelector('.app-main') || document.body;
    if (!host) return;
    if (explore) explore.style.display = 'none';
    if (dyn) dyn.style.display = 'none';
    if (guildMain) guildMain.style.display = 'none';
    var node = _pageViews[_pageOpen];
    if (!node) {
      var build = PAGE_BUILDERS[_pageOpen];
      if (!build) return;
      node = build();
      _pageViews[_pageOpen] = node;
    }
    if (node.parentNode !== host) host.appendChild(node);
    if (_pageOpen === 'manage') { restoreWebLoginUi(); syncManageStatus(); }
    else if (_pageOpen === 'schedule') syncSchedulePage();
    else if (_pageOpen === 'dm') syncDmPage();
    else if (_pageOpen === 'dmSend') syncDmSendPage();
  }
  function stopWebLoginPoll() {
    if (_wlPollTimer) { clearTimeout(_wlPollTimer); _wlPollTimer = null; }
  }
  // 路由标识：应用有时会把地址规范化成不带 baseURL 的形态，所以统一只比「尾段」
  function routeKey() {
    var p = window.location.pathname;
    if (p.indexOf(PANEL_BASE) === 0) p = p.slice(PANEL_BASE.length);
    return p.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  // 整页视图被应用重渲染后贴回：把仍在轮询中的二维码也贴回去并继续轮询
  function restoreWebLoginUi() {
    if (!_wlImgUrl) return;
    var img = document.getElementById('txpd-wl-qr');
    var box = document.getElementById('txpd-wl-qrbox');
    if (img && box) {
      if (img.getAttribute('src') !== _wlImgUrl) img.setAttribute('src', _wlImgUrl);
      box.style.display = 'block';
    }
    if (!_wlActive) pollWebLogin();
  }

  function mgBtn(text, primary) {
    var b = el('button', { 'class': 'txpd-mg-btn' + (primary ? ' primary' : ''), type: 'button' }, text);
    return b;
  }
  function mgCard(title, desc) {
    var c = el('div', { 'class': 'txpd-mg-card' });
    if (title) c.appendChild(el('h3', null, title));
    if (desc) c.appendChild(el('p', { 'class': 'txpd-mg-desc' }, desc));
    return c;
  }

  function buildManagePage() {
    var page = el('div', { 'class': 'app-page txpd-manage' });
    var head = el('div', { 'class': 'txpd-mg-head' });
    var back = mgBtn('← 返回');
    back.addEventListener('click', closeManagePage);
    head.appendChild(back);
    head.appendChild(el('span', { 'class': 'txpd-mg-title' }, '插件管理'));
    page.appendChild(head);

    // ① 网页登录
    var card = mgCard('网页登录',
      '用来按登录态显示频道内容（能看成员可见的频道 / 帖子）。点赞、评论、发帖等操作始终由下面的频道账号（CLI）完成，'
      + '这里的登录不参与那些操作。只允许登录一个。');
    var row = el('div', { 'class': 'txpd-mg-row' });
    var st = el('span', { 'class': 'txpd-mg-status', id: 'txpd-wl-status' }, '状态：读取中…');
    var btnStart = mgBtn('获取登录二维码', true);
    var btnOut = mgBtn('退出登录');
    row.appendChild(st);
    row.appendChild(btnStart);
    row.appendChild(btnOut);
    card.appendChild(row);
    var qrBox = el('div', { 'class': 'txpd-mg-qr', id: 'txpd-wl-qrbox' });
    var img = el('img', { id: 'txpd-wl-qr', alt: '登录二维码' });
    img.setAttribute('src', '');
    var tip = el('div', { 'class': 'txpd-mg-qr-tip', id: 'txpd-wl-tip' }, '');
    qrBox.appendChild(img);
    qrBox.appendChild(tip);
    card.appendChild(qrBox);
    page.appendChild(card);

    btnStart.addEventListener('click', function () {
      btnStart.disabled = true;
      _wlDone = false;
      st.style.color = '#888';
      st.textContent = '状态：正在获取二维码…';
      api('/web-login/start', { method: 'POST', body: {} }).then(function (r) {
        if (!r.success || !r.data || !r.data.qrcode) throw new Error(r.message || '获取二维码失败');
        _wlImgUrl = r.data.qrcode;
        img.setAttribute('src', _wlImgUrl);
        qrBox.style.display = 'block';
        tip.textContent = '请用手机 QQ 扫码并确认（' + Math.round((r.data.expires_in_s || 180) / 60) + ' 分钟内有效）';
        st.style.color = '';
        st.textContent = '状态：等待扫码…';
        pollWebLogin();
      }).catch(function (e) {
        panelError(st, e.message || '获取二维码失败');
      }).then(function () { btnStart.disabled = false; });
    });
    btnOut.addEventListener('click', function () {
      btnOut.disabled = true;
      api('/web-login/logout', { method: 'POST', body: {} }).then(function (r) {
        stopWebLoginPoll();
        _wlActive = false;
        _wlDone = true;
        qrBox.style.display = 'none';
        img.setAttribute('src', '');
        _wlImgUrl = '';
        st.style.color = '#888';
        st.textContent = '状态：' + (r.message || '已退出网页登录');
        syncManageStatus(true);
      }).catch(function (e) {
        panelError(st, e.message || '退出失败');
      }).then(function () { btnOut.disabled = false; });
    });

    // ② 频道账号（CLI）
    var card2 = mgCard('频道账号（CLI）', '发帖、评论、点赞、私信等操作都由这个账号完成，与上面的网页登录互不影响。');
    var row2 = el('div', { 'class': 'txpd-mg-row' });
    var st2 = el('span', { 'class': 'txpd-mg-status', id: 'txpd-cli-status' }, '状态：读取中…');
    var btnAcct = mgBtn('登录 / 切换账号', true);
    btnAcct.addEventListener('click', openAccountList);
    row2.appendChild(st2);
    row2.appendChild(btnAcct);
    card2.appendChild(row2);
    page.appendChild(card2);

    // ③ 插件管理员
    var card3 = mgCard('插件管理员', '一行一个 openid；留空并保存即清空。');
    var ta = el('textarea', { 'class': 'txpd-mg-textarea', placeholder: '管理员 openid（每行一个）' });
    var row3 = el('div', { 'class': 'txpd-mg-row', style: 'margin-top:10px;' });
    var save = mgBtn('保存', true);
    var st3 = el('span', { 'class': 'txpd-mg-status' }, '');
    row3.appendChild(save);
    row3.appendChild(st3);
    card3.appendChild(ta);
    card3.appendChild(row3);
    page.appendChild(card3);
    api('/admins').then(function (r) {
      if (r.success && r.data && r.data.admins) ta.value = r.data.admins.join('\n');
    }).catch(function () { /* 忽略 */ });
    save.addEventListener('click', function () {
      save.disabled = true;
      st3.style.color = '#888';
      st3.textContent = '正在保存…';
      var admins = ta.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      api('/admins', { method: 'POST', body: { admins: admins } }).then(function (r) {
        if (!r.success) throw new Error(r.message || '保存失败');
        st3.textContent = '✓ 已保存 ' + admins.length + ' 个管理员';
        st3.style.color = '#15a361';
      }).catch(function (e) { panelError(st3, e.message); }).then(function () { save.disabled = false; });
    });
    return page;
  }

  function pollWebLogin() {
    stopWebLoginPoll();
    _wlActive = true;
    _wlPollTimer = setTimeout(function () {
      // 每轮重新取元素：整页视图可能被应用重渲染，闭包里缓存的节点会失效
      var st = document.getElementById('txpd-wl-status');
      var qrBox = document.getElementById('txpd-wl-qrbox');
      var tip = document.getElementById('txpd-wl-tip');
      if (!st && !qrBox) { stopWebLoginPoll(); return; }
      api('/web-login/poll').then(function (r) {
        var d = (r && r.data) || {};
        switch (d.status) {
          case 'ok':
            _wlDone = true;
            _wlActive = false;
            _wlImgUrl = '';
            if (st) { st.style.color = '#15a361'; st.textContent = '状态：✓ 已登录' + (d.nick ? '（' + d.nick + '）' : (d.uin ? '（' + d.uin + '）' : '')) + '，正在刷新页面…'; }
            if (tip) tip.textContent = '登录成功，页面将按登录态重新渲染';
            stopWebLoginPoll();
            setTimeout(function () { window.location.reload(); }, 1200);
            return;
          case 'expired':
          case 'denied':
          case 'failed':
            _wlDone = true;
            _wlActive = false;
            _wlImgUrl = '';
            if (tip) tip.textContent = d.message || '二维码已失效';
            if (st) { st.style.color = '#e5484d'; st.textContent = '状态：' + (d.message || '登录失败') + '（可重新获取二维码）'; }
            if (d.status !== 'failed') { if (qrBox) qrBox.style.display = 'none'; }
            stopWebLoginPoll();
            return;
          default:
            if (st) st.textContent = '状态：' + (d.message || '等待扫码…');
            pollWebLogin();
        }
      }).catch(function () {
        pollWebLogin();
      });
    }, 2000);
  }

  var _mgStatusTs = 0;
  function syncManageStatus(force) {
    var now = Date.now();
    if (!force && now - _mgStatusTs < 5000) return;
    _mgStatusTs = now;
    api('/web-login/status').then(function (r) {
      // 正在轮询二维码时状态行归 pollWebLogin() 管，这里别把它覆盖掉
      if (_wlPollTimer || _wlImgUrl) return;
      var st = document.getElementById('txpd-wl-status');
      if (!st) return;
      var d = (r && r.data) || {};
      st.style.color = d.logged_in ? '#15a361' : '';
      st.textContent = '状态：' + (d.logged_in ? ('已登录' + (d.nick ? '（' + d.nick + '）' : (d.uin ? '（' + d.uin + '）' : ''))) : '未登录');
    }).catch(function () { /* 忽略 */ });
    api('/accounts').then(function (r) {
      var st2 = document.getElementById('txpd-cli-status');
      if (!st2) return;
      var accs = ((r && r.data && r.data.accounts) || []);
      var inOnes = accs.filter(function (a) { return a.logged_in; });
      if (!accs.length) st2.textContent = '状态：还没有账号槽位';
      else if (!inOnes.length) st2.textContent = '状态：未登录（' + accs.length + ' 个槽位）';
      else st2.textContent = '状态：已登录 ' + inOnes.map(function (a) { return a.nickname || a.name; }).join('、');
    }).catch(function () { /* 忽略 */ });
  }

  // ---------- 定时发帖（整页视图：全部计划列表 + 新建 + 逐条删除/启停/立即运行） ----------
  function cronText(cron) {
    var m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(String(cron || '').trim());
    if (!m) return cron || '';
    var mi = m[1], h = m[2], dom = m[3], mon = m[4], dow = m[5];
    var pad = function (x) { return String(x).length < 2 ? '0' + x : String(x); };
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return '每天 ' + pad(h) + ':' + pad(mi);
    if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*' && /^\d$/.test(dow)) {
      return '每' + wd[Number(dow)] + ' ' + pad(h) + ':' + pad(mi);
    }
    if (mi.indexOf('*/') === 0 && h === '*' && dom === '*' && mon === '*' && dow === '*') return '每 ' + mi.slice(2) + ' 分钟';
    return cron;
  }
  function scheduleGuildName(gid) {
    if (_guildsCache) {
      for (var i = 0; i < _guildsCache.length; i++) {
        if (String(_guildsCache[i].guild_id) === String(gid)) return _guildsCache[i].name || gid;
      }
    }
    return gid || '—';
  }
  function buildSchedulePage() {
    var page = el('div', { 'class': 'app-page txpd-manage txpd-sched-page' });
    var head = el('div', { 'class': 'txpd-mg-head' });
    var back = mgBtn('← 返回');
    back.addEventListener('click', closePage);
    head.appendChild(back);
    head.appendChild(el('span', { 'class': 'txpd-mg-title' }, '定时发帖'));
    var refresh = mgBtn('刷新');
    refresh.addEventListener('click', function () { syncSchedulePage(true); });
    head.appendChild(refresh);
    var add = mgBtn('+ 新建计划', true);
    head.appendChild(add);
    page.appendChild(head);

    var listCard = mgCard('全部定时计划', '到点由插件账号（CLI）自动发帖；可单独启停、立即运行或删除。');
    listCard.appendChild(el('div', { id: 'txpd-sched-list' }));
    page.appendChild(listCard);

    var formCard = mgCard('新建计划', '选择频道与版块、设置频率与内容，保存后即生效。');
    formCard.style.display = 'none';
    page.appendChild(formCard);
    add.addEventListener('click', function () {
      var opened = formCard.style.display !== 'none';
      formCard.style.display = opened ? 'none' : '';
      add.textContent = opened ? '+ 新建计划' : '收起表单';
      if (!opened && !formCard._built) {
        formCard._built = 1;
        loadJoinedGuilds().then(function () {
          if (!_guildsCache || !_guildsCache.length) {
            formCard.appendChild(el('div', { 'class': 'txpd-mg-status' }, '暂无已加入的频道，先加入频道再设置定时发帖'));
            return;
          }
          buildScheduleForm(formCard, currentGuild());
        }).catch(function (e) {
          formCard.appendChild(el('div', { 'class': 'txpd-mg-status', style: 'color:#e5484d;' }, '加载失败：' + String((e && e.message) || e).slice(0, 160)));
        });
      }
    });
    return page;
  }
  var _schedTs = 0;
  function syncSchedulePage(force) {
    var box = document.getElementById('txpd-sched-list');
    if (!box) return;
    var now = Date.now();
    if (!force && now - _schedTs < 3000) return;
    _schedTs = now;
    api('/schedules').then(function (r) {
      var list = (r && r.data && r.data.schedules) || [];
      // 数据没变就不重建 DOM：避免每 3 秒闪一次、把滚动位置顶回去
      var sig = JSON.stringify(list);
      if (sig === box._sig) return;
      box._sig = sig;
      box.innerHTML = '';
      if (!list.length) {
        box.appendChild(el('div', { 'class': 'txpd-mg-status' }, '暂无定时计划，点右上角「+ 新建计划」添加'));
        return;
      }
      list.forEach(function (sc) {
        var item = el('div', { 'class': 'txpd-sched-item' });
        var top = el('div', { 'class': 'txpd-sched-top' });
        top.appendChild(el('span', { 'class': 'txpd-sched-name' }, sc.name || '未命名计划'));
        top.appendChild(el('span', { 'class': 'txpd-sched-tag' + (sc.enabled ? ' on' : '') }, sc.enabled ? '启用中' : '已停用'));
        top.appendChild(el('span', { 'class': 'txpd-sched-cron' }, cronText(sc.cron)));
        item.appendChild(top);
        var meta = ['频道 ' + scheduleGuildName(sc.guild_id)];
        if (sc.user) meta.push('账号 ' + sc.user);
        if (sc.last_run) meta.push('上次 ' + sc.last_run + (sc.last_result ? '（' + String(sc.last_result).slice(0, 20) + '）' : ''));
        item.appendChild(el('div', { 'class': 'txpd-sched-meta' }, meta.join(' · ')));
        item.appendChild(el('div', { 'class': 'txpd-sched-body' },
          (sc.title ? sc.title + '：' : '') + String(sc.content || '').replace(/\s+/g, ' ').slice(0, 90)));
        var acts = el('div', { 'class': 'txpd-mg-row', style: 'margin-top:8px;' });
        var st = el('span', { 'class': 'txpd-mg-status' }, '');
        var bToggle = mgBtn(sc.enabled ? '停用' : '启用');
        var bRun = mgBtn('立即运行');
        var bDel = mgBtn('删除');
        bDel.style.color = '#e5484d';
        bToggle.addEventListener('click', function () {
          bToggle.disabled = true;
          api('/schedules/toggle', { method: 'POST', body: { id: sc.id } }).then(function (rr) {
            st.style.color = rr.success ? '#15a361' : '#e5484d';
            st.textContent = rr.message || '';
            syncSchedulePage(true);
          }).catch(function (e) { st.textContent = String(e.message || e); });
        });
        bRun.addEventListener('click', function () {
          bRun.disabled = true;
          st.style.color = '#888';
          st.textContent = '正在发送…';
          api('/schedules/run', { method: 'POST', body: { id: sc.id } }).then(function (rr) {
            st.style.color = rr.success ? '#15a361' : '#e5484d';
            st.textContent = rr.message || (rr.success ? '✓ 已发送' : '执行失败');
            bRun.disabled = false;
            syncSchedulePage(true);
          }).catch(function (e) { st.style.color = '#e5484d'; st.textContent = String(e.message || e); bRun.disabled = false; });
        });
        // 删除：两段式确认（再点一次才真删），避免误删
        var arming = false;
        bDel.addEventListener('click', function () {
          if (!arming) {
            arming = true;
            bDel.textContent = '确认删除';
            st.style.color = '#e5484d';
            st.textContent = '再点一次将删除该计划';
            return;
          }
          bDel.disabled = true;
          api('/schedules/delete', { method: 'POST', body: { id: sc.id } }).then(function (rr) {
            if (!rr.success) throw new Error(rr.message || '删除失败');
            st.style.color = '#15a361';
            st.textContent = '✓ 已删除';
            syncSchedulePage(true);
          }).catch(function (e) {
            st.style.color = '#e5484d';
            st.textContent = String(e.message || e);
            bDel.disabled = false;
            arming = false;
            bDel.textContent = '删除';
          });
        });
        acts.appendChild(bToggle);
        acts.appendChild(bRun);
        acts.appendChild(bDel);
        acts.appendChild(st);
        item.appendChild(acts);
        box.appendChild(item);
      });
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(el('div', { 'class': 'txpd-mg-status', style: 'color:#e5484d;' }, '加载失败：' + String((e && e.message) || e).slice(0, 160)));
    });
  }

  // ---------- 私信列表（整页视图） ----------
  function buildDmPage() {
    var page = el('div', { 'class': 'app-page txpd-manage txpd-dm-page' });
    var head = el('div', { 'class': 'txpd-mg-head' });
    var back = mgBtn('← 返回');
    back.addEventListener('click', closePage);
    head.appendChild(back);
    head.appendChild(el('span', { 'class': 'txpd-mg-title' }, '私信列表'));
    var refresh = mgBtn('刷新');
    refresh.addEventListener('click', function () { syncDmPage(true); });
    head.appendChild(refresh);
    page.appendChild(head);
    var card = mgCard('最近联系人', '这里只显示本机记录过的私信会话；点一行继续给对方发私信（由频道账号 CLI 发送）。');
    card.appendChild(el('div', { id: 'txpd-dm-list' }));
    page.appendChild(card);
    return page;
  }
  var _dmTs = 0;
  function syncDmPage(force) {
    var box = document.getElementById('txpd-dm-list');
    if (!box) return;
    var now = Date.now();
    if (!force && now - _dmTs < 2000) return;
    _dmTs = now;
    var hist = [];
    try { hist = JSON.parse(window.localStorage.getItem('txpd_dm_history') || '[]'); } catch (e) { /* 忽略 */ }
    var byPeer = {};
    hist.forEach(function (h) {
      var key = h.tiny || h.nick || '?';
      if (!byPeer[key]) byPeer[key] = { nick: h.nick, tiny: h.tiny, last: h.text, ts: h.ts };
    });
    var keys = Object.keys(byPeer);
    var sig = JSON.stringify(byPeer);
    if (sig === box._sig) return;   // 没变化就不重建（防闪烁、防滚动位置被顶回）
    box._sig = sig;
    box.innerHTML = '';
    if (!keys.length) {
      box.appendChild(el('div', { 'class': 'txpd-mg-status' }, '暂无私信记录（从成员列表点击成员名字可发起私信）'));
      return;
    }
    keys.forEach(function (k) {
      var pp = byPeer[k];
      var row = el('div', { 'class': 'txpd-acct-item' });
      row.appendChild(el('span', { 'class': 'txpd-acct-dot' }));
      var main = el('div', { style: 'flex:1;min-width:0;' });
      main.appendChild(el('div', { 'class': 'txpd-acct-name', style: 'font-weight:600;' }, pp.nick || pp.tiny || k));
      main.appendChild(el('div', { style: 'font-size:12px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, (pp.last || '').slice(0, 60)));
      row.appendChild(main);
      row.addEventListener('click', function () { openDmSend(pp.nick, pp.tiny, '', true); });
      box.appendChild(row);
    });
  }

  PAGE_BUILDERS.manage = buildManagePage;
  PAGE_BUILDERS.schedule = buildSchedulePage;
  PAGE_BUILDERS.dm = buildDmPage;
  PAGE_BUILDERS.dmSend = buildDmSendPage;

  // 没有 CLI 账号（未登录/无槽位）时自动打开插件管理，引导先登录
  var _manageAutoTried = false;
  function maybeAutoOpenManage() {
    if (_manageAutoTried || _pageOpen) return;
    api('/accounts').then(function (r) {
      var accs = ((r && r.data && r.data.accounts) || []);
      var anyIn = accs.some(function (a) { return a.logged_in; });
      if (anyIn) { _manageAutoTried = true; return; }
      _manageAutoTried = true;
      openManagePage();
      toast('还没有登录频道账号，先在这里完成登录');
    }).catch(function () { /* 忽略 */ });
  }

  // ---------- 频道卡 operation 行：插件图标按钮（配置/定时/成员）
  // 官方 .operation-item 是 34px 半透明圆钮（分享按钮同款），图标在其左侧一字排开；
  // 官方 CSS 选择器带 data-v-5aaa2b70 作用域属性，挂上该属性即可原样继承官方外观与 hover/active
  function clockIcon(size) {
    var tmp = el('div');
    tmp.innerHTML = '<svg viewBox="0 0 14 14" style="width:' + size + 'px;height:' + size + 'px;display:block;">'
      + '<circle cx="7.00016" cy="6.99967" r="5.54167" fill="none" stroke="currentColor" stroke-width="0.875"></circle>'
      + '<path d="M6.88306 3.79199V7.58366H9.9165" fill="none" stroke="currentColor" stroke-width="0.875"></path></svg>';
    return tmp.firstChild;
  }
  // 管理身份判定：CLI 的角色文案是「腾讯频道主 / 频道主 / 管理员」，宽松匹配防止文案差异漏判
  function isAdminRole(role) {
    var r = String(role || '');
    return r.indexOf('频道主') !== -1 || r.indexOf('管理员') !== -1;
  }
  function ensureTopbarButtons() {
    // 旧的带文字顶栏按钮：删除（用户要求只保留图标）
    Array.prototype.forEach.call(document.querySelectorAll('.top_title > .txpd-top-btns'), function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    var ctx = currentGuild();
    if (!ctx.num) return;
    // 已加入的频道列表还没加载出来（本地缓存 / CLI）→ 先不画，加载完会自动重来：
    // 否则「加入」按钮会在已加入的频道上闪一下
    if (!_joinedKeys) return;
    var joined = !!(_joinedKeys[ctx.num] || (ctx.g && ctx.g.guild_id && _joinedKeys[ctx.g.guild_id]));
    var isAdmin = !!(ctx.g && isAdminRole(ctx.g.role));
    // 未加入该频道：只给「加入」（配置 / 定时 / 成员对非成员没有意义，点了也是报错）；
    // 加入按钮贴在频道名旁边，见下面的 joinSlot。
    var want = joined ? (isAdmin ? ['config', 'schedule', 'members'] : ['schedule', 'members']) : [];
    var meta = {
      config: ['频道配置', 'assets/common.svg#guildSetting'],
      schedule: ['定时发帖', null],
      members: ['成员列表', 'assets/common.svg#user'],
    };
    var box = document.querySelector('.txpd-op-btns');
    if (!box) {
      box = el('div', { 'class': 'txpd-op-btns' });
      var opRow = document.querySelector('.guild-info__operation') || document.querySelector('.guild-operation');
      var share = opRow ? opRow.querySelector('.operation-item.share') : null;
      if (opRow && share) opRow.insertBefore(box, share);
      else if (opRow) opRow.appendChild(box);
      else {
        // 兜底：官方 operation 行缺失（窄屏标题栏变体）→ 仍贴频道名右侧，保持纯图标
        var top = document.querySelector('.guild-info__basic__top.top_title');
        if (!top) return;
        box.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:auto;';
        top.appendChild(box);
      }
    }
    Array.prototype.forEach.call(Array.prototype.slice.call(box.children), function (c) {
      if (want.indexOf(c.getAttribute('data-txpd-op')) === -1) box.removeChild(c);
    });
    want.forEach(function (k, idx) {
      var btn = box.querySelector('[data-txpd-op="' + k + '"]');
      if (!btn) {
        btn = el('div', { 'class': 'operation-item txpd-op-btn', title: meta[k][0], 'data-txpd-op': k });
        btn.setAttribute('data-v-5aaa2b70', '');
        var bg = el('div', { 'class': 'operation-item-bg' });
        bg.style.cssText = 'display:flex;align-items:center;justify-content:center;color:#fff;';
        bg.appendChild(meta[k][1] ? svgIcon(meta[k][1], 22) : clockIcon(22));
        btn.appendChild(bg);
      }
      if (box.children[idx] !== btn) box.insertBefore(btn, box.children[idx] || null);
    });
    ensureJoinButton(joined);
  }

  // 未加入该频道（插件账号没加入）→ 在频道名旁边放一个「加入」按钮，点击用 CLI 账号加入。
  // 注意：官方「加入频道」是网页账号的入口，两者互不影响；这里点的始终是插件账号。
  function ensureJoinButton(joined) {
    var slot = document.querySelector('.txpd-join-slot');
    if (joined) {
      if (slot && slot.parentNode) slot.parentNode.removeChild(slot);
      return;
    }
    var titleRow = document.querySelector('.guild-info__basic__top.top_title') || document.querySelector('.guild-info__basic__top');
    if (!titleRow) return;
    if (!slot) {
      slot = el('span', { 'class': 'txpd-join-slot' });
      // 带文字的胶囊按钮（纯图标看不出是「加入」）；点击由 mount() 的 window 捕获层统一分派
      var btn = el('button', { 'class': 'txpd-join-btn', type: 'button', 'data-txpd-op': 'join', title: '用插件账号（CLI）加入该频道' });
      btn.appendChild(svgIcon('assets/common.svg#add', 14));
      btn.appendChild(el('span', null, '加入'));
      slot.appendChild(btn);
    }
    var nameEl = titleRow.querySelector('.guild-info__basic__name, .top_title_name');
    if (nameEl) titleRow.insertBefore(slot, nameEl.nextSibling);   // 名字右边
    else titleRow.appendChild(slot);
  }

  // ---------- 未登录时页面提示（导航固定显示五项，缺登录态的页面显示「无法查看」） ----------
  // 官方内容页（探索发现 / 频道主页 / 帖子详情）按「腾讯频道网页登录」渲染；
  // 频道动态页的数据来自「频道账号（CLI）」。缺哪个就提示哪个，并给一个去登录的入口。
  function pageLoginNeed() {
    var tail = routeKey();
    if (!tail || tail === 'explore' || tail.indexOf('g/') === 0) return 'web';
    if (tail.indexOf('index') === 0) return 'cli';
    return '';
  }
  var _noticeMissing = '';
  function ensureLoginNotice() {
    var need = pageLoginNeed();
    var missing = '';
    if (need === 'web' && !TXPD_WEB_LOGGED_IN) missing = '腾讯频道网页未登录';
    else if (need === 'cli' && _cliLoggedIn === false) missing = '频道账号（CLI）未登录';
    var box = document.querySelector('.txpd-login-notice');
    var explore = document.getElementById('explorePage');
    var dyn = document.querySelector('.txpd-dynamic');
    var guildMain = document.querySelector('.game-guild-main');
    if (_pageOpen) {
      if (box && box.parentNode) box.parentNode.removeChild(box);
      _noticeMissing = '';
      return;   // 整页视图开着：提示让位（内容显隐由视图层管）
    }
    if (!missing) {
      if (box && box.parentNode) box.parentNode.removeChild(box);
      _noticeMissing = '';
      if (guildMain) guildMain.style.display = '';
      return;
    }
    if (explore) explore.style.display = 'none';
    if (dyn) dyn.style.display = 'none';
    if (guildMain) guildMain.style.display = 'none';
    if (!box) {
      box = el('div', { 'class': 'app-page txpd-login-notice' });
      box.appendChild(el('div', { 'class': 'txpd-mg-card txpd-notice-card' }));
      var host = (explore && explore.parentNode) || document.querySelector('main') || document.querySelector('.app-main') || document.body;
      host.appendChild(box);
    }
    if (_noticeMissing !== missing) {
      _noticeMissing = missing;
      var card = box.firstChild;
      card.innerHTML = '';
      card.appendChild(el('h3', null, missing + '，无法查看'));
      card.appendChild(el('p', { 'class': 'txpd-mg-desc' }, need === 'web'
        ? '这个页面的内容按腾讯频道网页登录态渲染。到「插件管理 → 网页登录」扫码登录后即可查看；'
          + '登录只影响显示，点赞 / 评论 / 发帖等操作始终由频道账号（CLI）完成。'
        : '这个页面的数据来自插件账号（CLI）。到「插件管理 → 频道账号」登录后即可查看。'));
      var btn = mgBtn('去登录', true);
      btn.addEventListener('click', openManagePage);
      card.appendChild(btn);
    }
  }

  // ---------- 手机端返回按钮：版块流/帖子详情等深视图提供退出出口 ----------
  function ensureMobileBackButton() {
    // 按视口宽度判断（<1024 视为移动布局），不用 UA 相关的 body 类
    var isMobile = !window.matchMedia('(min-width: 1024px)').matches;
    var btn = document.getElementById('txpd-mobile-back');
    if (!isMobile) {
      if (btn) btn.style.display = 'none';
      return;
    }
    var path = window.location.pathname;
    var deep = path.indexOf('/text/') !== -1 || path.indexOf('/post/') !== -1 || path.indexOf('/voice/') !== -1;
    if (!btn) {
      btn = el('button', { id: 'txpd-mobile-back', title: '返回' });
      btn.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483000;width:34px;height:34px;border-radius:17px;border:none;background:rgba(255,255,255,.92);box-shadow:0 2px 10px rgba(0,0,0,.22);cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;';
      btn.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px;height:18px;color:#222;"><path d="M15.5 4.5 8 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      btn.addEventListener('click', function () {
        var m = /\/g\/([^\/?#]+)/.exec(window.location.pathname);
        if (m) spaNavigate('g/' + decodeURIComponent(m[1]));
        else spaNavigate('explore');
      });
      document.body.appendChild(btn);
    }
    btn.style.display = deep ? 'flex' : 'none';
  }

  // ---------- 桌面 UA 窄屏抽屉控制（<768；应用抽屉开关是移动 UA 门控的） ----------
  function ensureNarrowDrawer() {
    var body = document.body;
    if (!body) return;   // 解析早期还没有 body（head 里的阻塞样式表能拖住很久）
    var narrow = !window.matchMedia('(min-width: 768px)').matches;
    var desktopUA = body.classList.contains('force-full-width');
    var active = narrow && desktopUA;
    if (!active) {
      if (body.classList.contains('txpd-drawer-open')) body.classList.remove('txpd-drawer-open');
      return;
    }
    var btn = document.querySelector('.app-header-left .icon-menu');
    if (btn && !btn.getAttribute('data-txpd-drawer')) {
      btn.setAttribute('data-txpd-drawer', '1');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        body.classList.toggle('txpd-drawer-open');
      }, true);
    }
    var overlay = document.querySelector('.aside-overlay');
    if (overlay && !overlay.getAttribute('data-txpd-drawer')) {
      overlay.setAttribute('data-txpd-drawer', '1');
      overlay.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        body.classList.remove('txpd-drawer-open');
      }, true);
    }
    var aside = document.querySelector('aside');
    if (aside && !aside.getAttribute('data-txpd-drawer')) {
      aside.setAttribute('data-txpd-drawer', '1');
      aside.addEventListener('click', function (e) {
        var target = e.target;
        if (target && target.closest && target.closest('.menu-item, .my-guild-item, .channel-item')) {
          body.classList.remove('txpd-drawer-open');
        }
      }, false);
    }
  }

  // ---------- 主页导航插入：私信 / 插件管理员 / 定时发帖（SVG 图标跟随官方风格） ----------
  function svgIcon(href, size) {
    // 注意：必须经由 div 的 innerHTML 解析，createElement('svg') 会落在 HTML 命名空间导致图标不渲染
    var tmp = el('div');
    tmp.innerHTML = '<svg class="icon-svg-symbol" style="color:currentColor;width:' + (size || 24) + 'px;height:' + (size || 24) + 'px;flex-shrink:0;display:inline-block;vertical-align:middle;"><use xlink:href="' + href + '"></use></svg>';
    return tmp.firstChild;
  }
  function navIcon(href) {
    return svgIcon(href, 24);
  }
  // 主页导航**固定五项**（顺序固定，不随登录态变化）：
  // 频道动态 / 探索发现 / 定时发帖 / 私信列表 / 插件管理
  // 只隐藏官方多余的入口（管理中心等），绝不删官方节点：那些是 Vue 托管的，
  // 删掉会让水合/重渲染时 insertBefore 找不到参照节点。
  var NAV_FIXED = [
    { key: 'dynamic', label: '频道动态', icon: 'assets/nav.svg#home', go: function () { spaNavigate('index'); } },
    { key: 'explore', label: '探索发现', icon: 'assets/nav.svg#compass', go: function () { spaNavigate('explore'); } },
    { key: 'schedule', label: '定时发帖', icon: 'assets/common.svg#setting', go: function () { openPage('schedule'); } },
    { key: 'dm', label: '私信列表', icon: 'assets/nav.svg#discuss', go: function () { openPage('dm'); } },
    { key: 'admin', label: '插件管理', icon: 'assets/nav.svg#manage', go: openManagePage },
  ];
  var TXPD_NAV_CLASSES = ['txpd-nav-dynamic', 'txpd-nav-explore', 'txpd-nav-schedule', 'txpd-nav-dm', 'txpd-nav-admin'];

  function navItemText(it) {
    return ((it.textContent || '').trim());
  }
  function isTxpdNavItem(it) {
    for (var i = 0; i < TXPD_NAV_CLASSES.length; i++) {
      if (it.classList && it.classList.contains(TXPD_NAV_CLASSES[i])) return true;
    }
    return false;
  }

  function mkNavItem(slot) {
    var a = el('a', { 'class': 'menu-item txpd-nav-' + slot.key, title: slot.label });
    a.style.cssText = 'cursor:pointer;';
    a.setAttribute('data-txpd-nav', slot.key);
    a.appendChild(navIcon(slot.icon));
    a.appendChild(el('span', { 'class': 'item-text' }, slot.label));
    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      slot.go();
    });
    return a;
  }

  function ensureNavEntries() {
    var nav = document.querySelector('.app-menu-list');
    if (!nav) return;
    // 五项只插一次，之后不再有任何 DOM 变动：
    // - 官方导航项由 CSS 隐藏（不删不挪，避免破坏 Vue 水合）；
    // - 顺序按 NAV_FIXED 追加到末尾，插完即为最终状态。
    var mine = {};
    NAV_FIXED.forEach(function (slot) {
      var node = nav.querySelector('.txpd-nav-' + slot.key);
      if (!node) {
        node = mkNavItem(slot);
        nav.appendChild(node);
      }
      mine[slot.key] = node;
      if (!node.getAttribute('data-txpd-wired')) {
        node.setAttribute('data-txpd-wired', '1');
        node.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          slot.go();
        });
      }
    });
    markNavActive(mine);
  }

  var _navActiveKey = '';
  function markNavActive(mine) {
    var tail = routeKey();
    var cur = tail.indexOf('index') === 0 ? 'dynamic' : ((tail.indexOf('explore') === 0 || !tail) ? 'explore' : '');
    if (cur === _navActiveKey) return;   // 路由没变就不写（避免 class 反复变动）
    _navActiveKey = cur;
    Object.keys(mine).forEach(function (k) {
      if (!mine[k] || !mine[k].classList) return;
      if (k === cur) mine[k].classList.add('txpd-nav-active');
      else mine[k].classList.remove('txpd-nav-active');
    });
  }

  // ---------- 发帖修复：已加入频道隐藏「登录后…」+ 接管「发表」为 CLI ----------
  function syncPublishArea() {
    var ctx = currentGuild();
    var joined = !!(ctx.num && _joinedKeys && _joinedKeys[ctx.num]);
    var container = document.querySelector('.publish-editor-container');
    if (!container) return;
    if (!joined) {
      // 未加入频道：恢复官方行为（移除接管标记）
      if (container.getAttribute('data-txpd-hooked')) container.removeAttribute('data-txpd-hooked');
      return;
    }
    var hint = container.querySelector('.editor-header .user-name');
    if (hint) hint.textContent = '发帖将以 CLI 当前账号身份发表，点击输入框开始';
    // 关键：捕获监听挂在容器（祖先）上——应用自己的处理器注册更早，
    // 挂在按钮同元素上会因顺序输掉；祖先捕获可先于目标元素触发并阻断
    if (!container.getAttribute('data-txpd-hooked')) {
      container.setAttribute('data-txpd-hooked', '1');
      container.addEventListener('click', function (e) {
        // 已展开：放行（内联编辑器自身阻止冒泡）
        if (container.getAttribute('data-txpd-expanded') === '1') return;
        var insideMyEditor = e.target && e.target.closest && e.target.closest('.txpd-inline-editor');
        if (insideMyEditor) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        expandPublishEditor();
      }, true);
    }
  }
  // ---------- 点赞状态：本地持久化 + 计数 +1 / 取消 ----------
  function likedSet() {
    try { return JSON.parse(window.localStorage.getItem('txpd_liked_feeds') || '{}'); } catch (e) { return {}; }
  }
  function saveLikedSet(s) {
    try { window.localStorage.setItem('txpd_liked_feeds', JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }
  function likeItemFeedId(item) {
    var card = item;
    for (var depth = 0; card && depth < 8; depth++) {
      var pa = card.querySelector ? card.querySelector('a[href*="/post/"]') : null;
      if (pa) { var pm = /\/post\/([^\/?#]+)/.exec(pa.getAttribute('href')); if (pm) return decodeURIComponent(pm[1]); }
      card = card.parentElement;
    }
    // 帖子详情页：卡片无帖子链接，feed_id 从 URL 取（评论内的项除外）
    if (!item.closest || !item.closest('.comment-list-item')) {
      var um = /\/post\/([^\/?#]+)/.exec(window.location.pathname);
      if (um) return decodeURIComponent(um[1]);
    }
    return '';
  }
  function likedCommentsSet() {
    try { return JSON.parse(window.localStorage.getItem('txpd_liked_comments') || '{}'); } catch (e) { return {}; }
  }
  function saveLikedComments(s) {
    try { window.localStorage.setItem('txpd_liked_comments', JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }
  // 评论点赞（do-like：3=赞评论 4=取消）
  function commentLikeFlow(item, commentEl) {
    // 注意：CLI 的 comment-id 必须带 c_ 前缀（实测去掉前缀上游报 retCode 1000701）
    var cid = commentEl.id || '';
    var ctx = getFeedContext();
    if (!cid || !ctx.feedId) { toast('未识别评论，无法点赞'); return; }
    var cset = likedCommentsSet();
    var liked = !!cset[cid];
    toast(liked ? '取消点赞中…' : '点赞中…');
    api('/cli', { method: 'POST', body: { action: 'feed-detail', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId } } }).then(function (r1) {
      var feed = (r1.data && r1.data.data && r1.data.data.feed) || {};
      if (!r1.success || !feed.author_id) throw new Error(r1.message || '获取帖子信息失败');
      var gid = feed.guild_id || ctx.guildId;
      return api('/cli', { method: 'POST', body: { action: 'comments', params: { feed_id: ctx.feedId } } }).then(function (rc) {
        var comments = (rc.data && rc.data.data && rc.data.data.comments) || [];
        var c = null;
        for (var i = 0; i < comments.length; i++) {
          if (String(comments[i].comment_id) === 'c_' + cid || String(comments[i].comment_id) === cid) { c = comments[i]; break; }
        }
        if (!c) throw new Error('未找到该评论（可能不在第一页）');
        return api('/cli', { method: 'POST', body: { action: 'like-comment', params: { feed_id: ctx.feedId, comment_id: cid, feed_author_id: feed.author_id, feed_create_time: String(feed.create_time_raw || feed.create_time), comment_author_id: c.author_id, comment_create_time: String(c.create_time_raw || c.create_time), like_type: liked ? '4' : '3', guild_id: gid, channel_id: ctx.channelId } } });
      });
    }).then(function (r) {
      if (!r.success) { toast((liked ? '取消失败：' : '点赞失败：') + (r.message || '').slice(0, 60)); return; }
      var s2 = likedCommentsSet();
      if (liked) delete s2[cid]; else s2[cid] = 1;
      saveLikedComments(s2);
      applyLikeVisual(item, !liked);
      toast(liked ? '已取消点赞' : '✓ 已点赞');
    }).catch(function (e) { toast('操作失败：' + String((e && e.message) || '').slice(0, 50)); });
  }
  function setItemText(item, txt) {
    var done = false;
    (function walk(n) {
      if (done) return;
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType === 3 && c.textContent.trim()) { c.textContent = txt; done = true; return; }
        if (c.nodeType === 1) walk(c);
        if (done) return;
      }
    })(item);
    if (!done) item.appendChild(document.createTextNode(txt));
  }
  function applyLikeVisual(item, liked) {
    var base = item.getAttribute('data-txpd-like-base');
    if (base === null && item.getAttribute('data-txpd-like-text') !== '1') {
      var cur = (item.textContent || '').trim();
      if (/^\d+$/.test(cur)) { item.setAttribute('data-txpd-like-base', cur); base = cur; }
      else if (cur === '点赞' || cur === '赞') item.setAttribute('data-txpd-like-text', '1');
    }
    var isText = item.getAttribute('data-txpd-like-text') === '1';
    if (liked) {
      if (isText) setItemText(item, '已赞');
      else if (base !== null) setItemText(item, String(parseInt(base, 10) + 1));
      item.style.color = '#2b64f5';
    } else {
      if (isText) setItemText(item, '点赞');
      else if (base !== null) setItemText(item, base);
      item.style.color = '';
    }
  }
  function syncLikedMarks() {
    var set = likedSet();
    var cset = likedCommentsSet();
    // 评论点赞显示（.comment-list-item__like-count）
    var cCounts = document.querySelectorAll('.comment-list-item__like-count');
    for (var ci = 0; ci < cCounts.length; ci++) {
      var cEl = cCounts[ci];
      var cHost = cEl.closest ? cEl.closest('.comment-list-item') : null;
      if (!cHost) continue;
      var cId = cHost.id || '';
      if (!cId) continue;
      applyLikeVisual(cEl, !!cset[cId]);
    }
    var items = document.querySelectorAll('[class*="operation__item"]');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var row = item.parentElement;
      if (!row) continue;
      var rowItems = row.querySelectorAll('[class*="operation__item"]');
      if (rowItems[0] !== item) continue;
      if (!item.offsetParent) continue;
      var cOwner = item.closest ? item.closest('.comment-list-item') : null;
      if (cOwner) {
        var cid = cOwner.id || '';
        if (cid) applyLikeVisual(item, !!cset[cid]);
        continue;
      }
      var fid = likeItemFeedId(item);
      if (!fid) continue;
      applyLikeVisual(item, !!set[fid]);
    }
  }

  // ---------- 频道头部元信息：频道号 / 加入方式 / 我的身份 ----------
  var _joinSettingCache = {};
  function joinTypeText(raw) {
    var s = String(raw || '');
    if (s.indexOf('DIRECT') !== -1) return '公开频道（无需审核）';
    if (s.indexOf('QUESTION') !== -1 || s.indexOf('QUIZ') !== -1) return '答题/审核加入';
    if (s.indexOf('AUDIT') !== -1) return '需审核加入';
    if (s.indexOf('DISABLE') !== -1) return '禁止加入';
    return s ? s.replace('JOIN_GUILD_TYPE_', '') : '';
  }
  // 幂等刷新：身份/加入方式随时可能从「未知」变为已知，每轮都按当前状态重绘同一行
  var _joinSettingTry = {};   // 频道号 -> 上次查询时间（8s 节流，避免卡死后再也不重试）
  function guildMetaIdentity(num) {
    if (_guildsCache && _guildsCache.length) {
      var want = numVariants(num);
      for (var i = 0; i < _guildsCache.length; i++) {
        var gi = numVariants(_guildsCache[i].guild_number);
        if (gi.some(function (x) { return want.indexOf(x) !== -1; })) {
          return { role: _guildsCache[i].role || '成员', gid: _guildsCache[i].guild_id || '', known: true };
        }
      }
      var pn = pageGuildName();
      if (pn) {
        for (var j = 0; j < _guildsCache.length; j++) {
          if (String(_guildsCache[j].name || '').trim().replace(/频道$/, '').trim() === pn) {
            return { role: _guildsCache[j].role || '成员', gid: _guildsCache[j].guild_id || '', known: true };
          }
        }
      }
      return { role: '未加入', gid: '', known: true };
    }
    return { role: '', gid: '', known: false };   // 列表还没拉回来 → 显示「加载中…」
  }
  function paintGuildMeta(row, num, ident, joinTxt) {
    var texts = [
      '频道号: ' + num,
      joinTxt ? ('加入方式: ' + joinTxt) : '加入方式: 查询中…',
      '我的身份: ' + (ident.known ? ident.role : '加载中…')
    ];
    texts.forEach(function (s, i) {
      if (!row.children[i]) row.appendChild(el('span'));
      if (row.children[i].textContent !== s) row.children[i].textContent = s;
    });
  }
  function fetchJoinSettingText(num, gid) {
    var p = gid
      ? Promise.resolve(gid)
      : api('/cli', { method: 'POST', body: { action: 'search-guild', params: { keyword: num, scope: 'channel' } } }).then(function (r) {
        var channels = (r.data && r.data.data && r.data.data.channels) || [];
        for (var j = 0; j < channels.length; j++) {
          if (String(channels[j].guild_number) === String(num)) return channels[j].guild_id;
        }
        return '';
      });
    return p.then(function (id2) {
      if (!id2) throw new Error('未找到频道');
      return api('/cli', { method: 'POST', body: { action: 'join-setting', params: { guild_id: id2 } } }).then(function (r2) {
        var m = /JOIN_GUILD_TYPE_[A-Z_]+/.exec(JSON.stringify(r2 || {}));
        _joinSettingCache[num] = joinTypeText(m ? m[0] : '') || '未知';
      });
    }).catch(function () {
      delete _joinSettingTry[num];   // 失败：允许下轮重试
    }).then(function () {
      setTimeout(ensureGuildMeta, 0);
    });
  }
  function ensureGuildMeta() {
    var h4 = document.querySelector('.guild-info__basic__statistics');
    var hostBasic = (h4 && h4.parentNode) ? h4.parentNode : document.querySelector('.guild-info__basic');
    if (!hostBasic) return;
    var num = currentGuildNumber();
    if (!num) return;
    var ident = guildMetaIdentity(num);
    var joinTxt = _joinSettingCache[num] || '';
    var row = hostBasic.querySelector('.txpd-guild-meta');
    if (!row) {
      row = el('div', { 'class': 'txpd-guild-meta', style: 'font-size:12px;color:#888;margin-top:4px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;' });
      if (h4) h4.parentNode.insertBefore(row, h4.nextSibling);
      else hostBasic.appendChild(row);
    }
    paintGuildMeta(row, num, ident, joinTxt);
    // 已加入频道列表未就绪 → 拉一次（内部有 1h 缓存 + 进行中判断），到位后自动重绘
    if (!ident.known) {
      loadJoinedGuilds().then(function () { setTimeout(ensureGuildMeta, 0); }).catch(function () { });
    }
    // 加入方式未知 → 查询（8s 内只试一次，避免一次请求卡死就永远「查询中…」）
    if (!joinTxt && (Date.now() - (_joinSettingTry[num] || 0)) > 8000) {
      _joinSettingTry[num] = Date.now();
      fetchJoinSettingText(num, ident.gid);
    }
  }

  // ---------- QQ 表情选择器（复刻官方表情面板） ----------
  var TXPD_EMOJI_DATA = [{"n":"超级表情","items":[["5","流泪",1],["311","打call",1],["312","变形",1],["314","仔细分析",1],["317","菜汪",1],["318","崇拜",1],["319","比心",1],["320","庆祝",1],["324","吃糖",1],["325","惊吓",1],["337","花朵脸",1],["338","我想开了",1],["339","舔屏",1],["341","打招呼",1],["342","酸Q",1],["343","我方了",1],["344","大怨种",1],["345","红包多多",1],["346","你真棒棒",1],["181","戳一戳",1],["74","太阳",1],["75","月亮",1],["351","敲敲",1],["349","坚强",1],["350","贴贴",1],["395","略略略",1],["114","篮球",2],["326","生气",1],["53","蛋糕",1],["137","鞭炮",1],["333","烟花",1],["392","龙年快乐",3]]},{"n":"小黄脸表情","items":[["14","微笑",1],["1","撇嘴",1],["2","色",1],["3","发呆",1],["4","得意",1],["6","害羞",1],["7","闭嘴",1],["8","睡",1],["9","大哭",1],["10","尴尬",1],["11","发怒",1],["12","调皮",1],["13","呲牙",1],["0","惊讶",1],["15","难过",1],["16","酷",1],["96","冷汗",1],["18","抓狂",1],["19","吐",1],["20","偷笑",1],["21","可爱",1],["22","白眼",1],["23","傲慢",1],["24","饥饿",1],["25","困",1],["26","惊恐",1],["27","流汗",1],["28","憨笑",1],["29","悠闲",1],["30","奋斗",1],["31","咒骂",1],["32","疑问",1],["33","嘘",1],["34","晕",1],["35","折磨",1],["36","衰",1],["37","骷髅",1],["38","敲打",1],["39","再见",1],["97","擦汗",1],["98","抠鼻",1],["99","鼓掌",1],["100","糗大了",1],["101","坏笑",1],["102","左哼哼",1],["103","右哼哼",1],["104","哈欠",1],["105","鄙视",1],["106","委屈",1],["107","快哭了",1],["108","阴险",1],["305","右亲亲",1],["109","左亲亲",1],["110","吓",1],["111","可怜",1],["172","眨眼睛",1],["182","笑哭",1],["179","doge",1],["173","泪奔",1],["174","无奈",1],["212","托腮",1],["175","卖萌",1],["178","斜眼笑",1],["177","喷血",1],["176","小纠结",1],["183","我最美",1],["262","脑阔疼",1],["263","沧桑",1],["264","捂脸",1],["265","辣眼睛",1],["266","哦哟",1],["267","头秃",1],["268","问号脸",1],["269","暗中观察",1],["270","emm",1],["271","吃瓜",1],["272","呵呵哒",1],["277","汪汪",1],["307","喵喵",1],["306","牛气冲天",1],["281","无眼笑",1],["282","敬礼",1],["283","狂笑",1],["284","面无表情",1],["285","摸鱼",1],["293","摸锦鲤",1],["286","魔鬼笑",1],["287","哦",1],["289","睁眼",1],["294","期待",1],["297","拜谢",1],["298","元宝",1],["299","牛啊",1],["300","胖三斤",1],["323","嫌弃",1],["332","举牌牌",1],["336","豹富",1],["353","拜托",1],["355","耶",1],["356","666",1],["354","尊嘟假嘟",1],["352","咦",1],["357","裂开",1],["334","虎虎生威",1],["347","大展宏兔",1],["303","右拜年",1],["302","左拜年",1],["295","拿到红包",1],["49","拥抱",1],["66","爱心",1],["63","玫瑰",1],["64","凋谢",1],["187","幽灵",1],["146","爆筋",1],["116","示爱",1],["67","心碎",1],["60","咖啡",1],["185","羊驼",1],["76","赞",1],["124","OK",1],["118","抱拳",1],["78","握手",1],["119","勾引",1],["79","胜利",1],["120","拳头",1],["121","差劲",1],["77","踩",1],["123","NO",1],["201","点赞",1],["273","我酸了",1],["46","猪头",1],["112","菜刀",1],["56","刀",1],["171","茶",1],["59","便便",1],["144","喝彩",1],["147","棒棒糖",1],["89","西瓜",1],["41","发抖",1],["125","转圈",1],["42","爱情",1],["43","跳跳",1],["86","怄火",1],["129","挥手",1],["85","飞吻",1]]},{"n":"emoji 表情","items":[["😊","嘿嘿",2],["😌","羞涩",2],["😚","亲亲",2],["😓","汗",2],["😰","紧张",2],["😝","吐舌",2],["😁","呲牙",2],["😜","淘气",2],["☺","可爱",2],["😍","花痴",2],["😔","失落",2],["😄","高兴",2],["😏","哼哼",2],["😒","不屑",2],["😳","瞪眼",2],["😘","飞吻",2],["😭","大哭",2],["😱","害怕",2],["😂","激动",2],["💪","肌肉",2],["👊","拳头",2],["👍","厉害",2],["👏","鼓掌",2],["👎","鄙视",2],["👌","好的",2],["👆","向上",2],["👀","眼睛",2],["🍜","拉面",2],["🍧","刨冰",2],["🍞","面包",2],["🍺","啤酒",2],["🍻","干杯",2],["☕","咖啡",2],["🍎","苹果",2],["🍓","草莓",2],["🍉","西瓜",2],["🌹","玫瑰",2],["🎉","庆祝",2],["💝","礼物",2],["💣","炸弹",2],["✨","闪光",2],["💨","吹气",2],["💦","水",2],["🔥","火",2],["💤","睡觉",2],["💩","便便",2],["💉","打针",2],["📫","邮箱",2],["🐎","骑马",2],["👧","女孩",2],["👦","男孩",2],["🐵","猴",2],["🐷","猪",2],["🐮","牛",2],["🐔","公鸡",2],["🐸","青蛙",2],["👻","幽灵",2],["🐛","虫",2],["🐶","狗",2],["🐳","鲸鱼",2],["👢","靴子",2],["☀","晴天",2],["❔","问号",2],["💓","爱心",2],["🏪","便利店",2]]}];
  function emojiImgUrl(id, type) {
    return 'https://framework.cdn-go.cn/qqmoji/latest/sysface/' + (type === 1 ? 'static/s' + id + '.png' : 'gif/s' + id + '.gif') + '?max_age=2592000';
  }
  function emojiInsertText(item) {
    if (String(item[2]) === '2') return String(item[0]);
    return '[](mqqapi://markdown/node?id=emoji&emoji_id=' + item[0] + '&emoji_type=' + item[2] + ')';
  }
  // ---------- 评论输入框的「富文本」能力：表情显示为图，提交时还原为节点语法 ----------
  function richEmojiChip(item) {
    return el('img', {
      src: emojiImgUrl(item[0], item[2]),
      'data-emj': emojiInsertText(item),
      title: item[1],
      style: 'width:20px;height:20px;vertical-align:-4px;margin:0 1px;',
    });
  }
  function richInsertEmoji(host, item) {
    try { host.focus(); } catch (e) { }
    if (String(item[2]) === '2') insertNodeAtCaret(host, document.createTextNode(String(item[0])));
    else insertNodeAtCaret(host, richEmojiChip(item));
  }
  function richText(host) {
    return String(host.innerText || '').replace(/\u200b/g, '').trim();
  }
  function richValue(host) {
    return serializeComposerContent(host).trim();
  }
  function richClear(host) {
    host.innerHTML = '';
  }
  // 输入过程中的小整理：只剩 <br> 时清空（否则 :empty 占位符不显示）
  function richNormalize(host) {
    var html = host.innerHTML || '';
    if (html === '<br>' || html === '<div><br></div>' || html === '<p><br></p>') host.innerHTML = '';
  }
  // 评论插图：选图 → 上传到插件 uploads → 发送时作为 do-comment 的 image_path
  function attachCommentImage(host) {
    var fi = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    document.body.appendChild(fi);
    fi.addEventListener('change', function () {
      var f = fi.files && fi.files[0];
      if (f) {
        var rd = new FileReader();
        rd.onload = function () {
          toast('图片上传中…');
          api('/upload-image', { method: 'POST', body: { data: rd.result, name: f.name } }).then(function (r) {
            if (!r.success) throw new Error(r.message || '上传失败');
            host._imgPath = (r.data && r.data.path) || '';
            var old = host.querySelector('[data-txpd-imgchip]');
            if (old && old.parentNode) old.parentNode.removeChild(old);
            var chip = el('img', { src: rd.result, title: '将随评论一起发送（点此移除）', 'data-txpd-imgchip': '1', style: 'width:30px;height:30px;object-fit:cover;border-radius:5px;margin:0 2px;vertical-align:-9px;cursor:pointer;' });
            chip.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              host._imgPath = '';
              chip.parentNode.removeChild(chip);
            });
            host.appendChild(chip);
            toast('✓ 图片已附加');
          }).catch(function (e) { toast('图片上传失败：' + String((e && e.message) || e).slice(0, 40)); });
        };
        rd.readAsDataURL(f);
      }
      fi.value = '';
    });
    fi.click();
  }
  function makeRichEditor(ph, cls) {
    var d = el('div', { 'class': 'txpd-rich' + (cls ? ' ' + cls : ''), contenteditable: 'true', 'data-ph': ph || '' });
    // 粘贴一律走纯文本，避免带进外部样式
    d.addEventListener('paste', function (e) {
      e.preventDefault();
      var txt = (e.clipboardData || window.clipboardData).getData('text') || '';
      insertNodeAtCaret(d, document.createTextNode(txt));
    });
    return d;
  }

  function openEmojiPicker(anchor, onPick) {
    var exist = document.getElementById('txpd-emoji-picker');
    if (exist && exist.parentNode) exist.parentNode.removeChild(exist);
    var panel = el('div', { id: 'txpd-emoji-picker' });
    panel.style.cssText = 'position:fixed;z-index:2147483005;background:#fff;border:1px solid #e5e5e5;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.16);width:346px;padding:8px;max-height:320px;overflow-y:auto;';
    var r = anchor.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 362)) + 'px';
    panel.style.top = Math.max(8, r.top - 330) + 'px';
    TXPD_EMOJI_DATA.forEach(function (grp) {
      panel.appendChild(el('div', { style: 'font-size:12px;color:#999;padding:6px 4px 2px;' }, grp.n));
      var grid = el('div', { style: 'display:grid;grid-template-columns:repeat(9,1fr);gap:2px;' });
      grp.items.forEach(function (item) {
        var cell = el('div', { title: item[1], style: 'width:34px;height:34px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:6px;font-size:20px;line-height:1;' });
        if (String(item[2]) === '2') cell.textContent = String(item[0]);
        else cell.appendChild(el('img', { src: emojiImgUrl(item[0], item[2]), style: 'width:26px;height:26px;' }));
        cell.addEventListener('mouseenter', function () { cell.style.background = '#f2f4f8'; });
        cell.addEventListener('mouseleave', function () { cell.style.background = ''; });
        cell.addEventListener('click', function (e) {
          e.stopPropagation();
          onPick(item);
        });
        grid.appendChild(cell);
      });
      panel.appendChild(grid);
    });
    var close = function (e) {
      if (!panel.contains(e.target) && e.target !== anchor) {
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(function () { document.addEventListener('click', close, true); }, 0);
    document.body.appendChild(panel);
    return panel;
  }
  function insertTextAtCursor(ta, text) {
    try {
      var s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      var e2 = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e2);
      ta.selectionStart = ta.selectionEnd = s + text.length;
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) { ta.value += text; }
  }
  function insertNodeAtCaret(root, node) {
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) { root.appendChild(node); }
      else {
        var range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) { root.appendChild(node); }
    root.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function makeEmojiButton(onPick) {
    var b = el('button', { style: 'border:none;background:#f2f4f8;border-radius:8px;padding:4px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#2b64f5;font-family:inherit;' });
    b.type = 'button';
    b.appendChild(svgIcon('assets/common.svg#emoji', 16));
    b.appendChild(el('span', null, '表情'));
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openEmojiPicker(b, onPick);
    });
    return b;
  }
  function serializeComposerContent(root) {
    var out = '';
    (function walk(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType === 3) out += c.textContent;
        else if (c.nodeType === 1) {
          if (c.getAttribute && c.getAttribute('data-emj') !== null) out += c.getAttribute('data-emj');
          else if (c.tagName === 'BR') out += '\n';
          else if (c.tagName === 'IMG') { /* 其他图片忽略 */ }
          else {
            walk(c);
            if (c.tagName === 'DIV' || c.tagName === 'P') out += '\n';
          }
        }
      }
    })(root);
    return out.replace(/\n+$/, '');
  }

  // ---------- 内联发帖编辑器（复刻官方：点击发布卡原地下拉展开） ----------
  var _pubImages = [];

  function collapsePublishEditor() {
    var container = document.querySelector('.publish-editor-container');
    if (!container) return;
    var ed = container.querySelector('.txpd-inline-editor');
    if (ed) ed.parentNode.removeChild(ed);
    var area = container.querySelector('.editor-area');
    if (area) area.style.display = '';
    container.removeAttribute('data-txpd-expanded');
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderPreview(content) {
    var html = escHtml(content);
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" style="color:#2b64f5;">$1</a>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return html.replace(/\n/g, '<br>');
  }

  var OFFICIAL_COMPOSER_HTML = "<div class=\"editor-area\" data-v-1c099b7e><div class=\"editor-header pointer\" data-v-1c099b7e><div class=\"user-info\" data-v-1c099b7e><img src=\"https://qqchannel-profile-1251316161.file.myqcloud.com/wxxcxdefault\" class=\"avatar\" alt=\"\" data-v-1c099b7e><span class=\"user-name\" data-v-1c099b7e>\u53d1\u5e16\u5c06\u4ee5 CLI \u5f53\u524d\u8d26\u53f7\u8eab\u4efd\u53d1\u8868\uff0c\u70b9\u51fb\u6b64\u5904\u8f93\u5165</span></div><div class=\"toolbar-area\" data-v-1c099b7e><!--[--><!--[--><span class=\"toolbar-button\" data-v-1c099b7e><svg class=\"icon-svg-symbol icon-emoji\" style=\"color:currentColor;width:20px;height:20px;\" data-v-1c099b7e><use xlink:href=\"assets/common.svg#emoji\"></use></svg></span><!--]--><!----><!--]--><!--[--><!--[--><span class=\"toolbar-button\" data-v-1c099b7e><svg class=\"icon-svg-symbol icon-at\" style=\"color:currentColor;width:20px;height:20px;\" data-v-1c099b7e><use xlink:href=\"assets/common.svg#at\"></use></svg></span><!--]--><!----><!--]--><!--[--><!--[--><span class=\"toolbar-button\" data-v-1c099b7e><svg class=\"icon-svg-symbol icon-image\" style=\"color:currentColor;width:20px;height:20px;\" data-v-1c099b7e><use xlink:href=\"assets/common.svg#image\"></use></svg></span><!--]--><!----><!--]--><!--[--><!--[--><span class=\"toolbar-button\" data-v-1c099b7e><svg width=\"20\" height=\"20\" class=\"icon-svg\" viewbox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\" data-v-1c099b7e><path d=\"M10.078 13.797C9.60006 13.4587 8.96861 13.0501 8.43374 12.8338C7.26763 12.3622 5.6115 12.4205 4.38399 12.5621C3.53188 12.6605 2.72986 12.0143 2.72986 11.1565C2.72986 9.83204 2.72986 8.72527 2.72986 7.38215C2.72986 6.57948 3.43379 5.95326 4.23474 6.00586C5.4523 6.08583 7.16672 6.12682 8.43374 5.86935C10.1696 5.51659 12.1915 4.37484 13.7037 3.38356C14.641 2.76907 15.9691 3.42615 15.9691 4.54697C15.9691 6.31738 15.9691 7.78715 15.9691 9.88398\" stroke=\"currentColor\" style=\"stroke:currentColor;stroke-opacity:1;\" stroke-width=\"1.14167\" stroke-linecap=\"square\"></path><path d=\"M7.03646 12.4248L7.91263 15.3797C8.1828 16.2908 7.50008 17.2053 6.54973 17.2053V17.2053C5.92028 17.2053 5.36578 16.7914 5.18683 16.1879L4.071 12.4248\" stroke=\"currentColor\" style=\"stroke:currentColor;stroke-opacity:1;\" stroke-width=\"1.14167\"></path><path d=\"M14.6181 11.8909C14.7569 11.5392 15.2546 11.5392 15.3934 11.8909L16.0345 13.5165C16.0769 13.6239 16.1619 13.7089 16.2693 13.7513L17.8949 14.3924C18.2467 14.5312 18.2467 15.0289 17.8949 15.1677L16.2693 15.8088C16.1619 15.8512 16.0769 15.9362 16.0345 16.0436L15.3934 17.6692C15.2546 18.0209 14.7569 18.0209 14.6181 17.6692L13.977 16.0436C13.9346 15.9362 13.8496 15.8512 13.7423 15.8088L12.1166 15.1677C11.7649 15.0289 11.7649 14.5312 12.1166 14.3924L13.7423 13.7513C13.8496 13.7089 13.9346 13.6239 13.977 13.5165L14.6181 11.8909Z\" fill=\"currentColor\" style=\"fill:currentColor;fill-opacity:1;\"></path></svg></span><!--]--><!----><!--]--><!----><!--[--><!--[--><!--]--><!----><!--]--><span data-v-1c099b7e></span></div></div><div class=\"editor-divider\" data-v-1c099b7e></div><div class=\"editor-root-container\" data-v-1c099b7e><div class=\"ProseMirror\" contenteditable=\"true\" data-txpd-content data-v-1c099b7e></div></div><div class=\"upload-area\" data-v-1c099b7e><div class=\"upload-left\" data-v-1c099b7e><!--[--><div class=\"image-video-container\" data-v-90ae7ef7><div class=\"preview-list\" data-v-90ae7ef7><!----><!----><div class=\"upload-button\" style=\"top:0;left:0;\" data-v-90ae7ef7><svg class=\"icon-svg-symbol icon-add-upload\" style=\"color:currentColor;width:36px;height:36px;\" data-v-90ae7ef7><use xlink:href=\"assets/common.svg#add-upload\"></use></svg></div></div></div><!----><!--]--><!----></div><div class=\"bottom-bar\" data-v-1c099b7e><div class=\"word-count\" data-v-1c099b7e>0/1000</div><div class=\"chose-channel\" data-v-1c099b7e><button class=\"g-button g-button--default g-button--small chose-channel-btn\" style=\"overflow:hidden;white-space:nowrap;\" data-v-1c099b7e><!--[--><!----> \u4e0d\u9009\u62e9\u7248\u5757 <svg class=\"icon-svg-symbol icon-arrow-right\" style=\"color:currentColor;width:10px;height:10px;margin-left:4px;\" data-v-1c099b7e><use xlink:href=\"assets/common.svg#arrow-right\"></use></svg><!--]--></button></div><!----><div class=\"publish-button\" data-v-1c099b7e><button class=\"g-button g-button--primary g-button--small btn\" disabled style=\"overflow:hidden;white-space:nowrap;\" data-v-1c099b7e><!--[--> \u53d1\u8868<!--]--></button></div></div></div></div>";


  function expandPublishEditor() {
    var container = document.querySelector('.publish-editor-container');
    if (!container || container.getAttribute('data-txpd-expanded') === '1') return;
    container.setAttribute('data-txpd-expanded', '1');
    container.innerHTML = OFFICIAL_COMPOSER_HTML;
    var ctx = currentGuild();
    // 展开后自动聚焦输入区
    setTimeout(function () {
      var ce0 = container.querySelector('[data-txpd-content]');
      if (ce0) ce0.focus();
    }, 80);
    var contentEl = container.querySelector('[data-txpd-content]');
    var wordCount = container.querySelector('.word-count');
    var choseBtn = container.querySelector('.chose-channel-btn');
    var pubBtn = container.querySelector('.publish-button button');
    var uploadBtn = container.querySelector('.upload-button');
    var previewList = container.querySelector('.preview-list');
    var userName = container.querySelector('.user-name');
    if (userName) userName.textContent = '发帖将以 CLI 当前账号身份发表，点击下方输入';
    var _pubImages = [];
    var chosen = null;
    function updatePubState() {
      if (!pubBtn) return;
      var has = (contentEl && (contentEl.textContent || '').trim().length > 0) || _pubImages.length > 0;
      pubBtn.disabled = !has;
    }
    if (contentEl) {
      contentEl.setAttribute('contenteditable', 'true');
      contentEl.style.cssText = 'min-height:72px;outline:none;font-size:14px;line-height:1.6;padding:8px 4px;word-break:break-word;';
      contentEl.addEventListener('input', function () {
        var len = (contentEl.textContent || '').length;
        if (wordCount) wordCount.textContent = Math.min(len, 1000) + '/1000';
        updatePubState();
      });
    }
    var fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif', multiple: true, style: 'display:none;' });
    container.appendChild(fileInput);
    if (uploadBtn) uploadBtn.addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
    function renderThumbs() {
      if (!previewList) return;
      Array.prototype.forEach.call(previewList.querySelectorAll('.txpd-thumb'), function (n) { n.parentNode.removeChild(n); });
      _pubImages.forEach(function (im) {
        var th = el('div', { 'class': 'txpd-thumb' });
        th.style.cssText = 'position:relative;width:75px;height:75px;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;';
        var im2 = el('img', { src: im.dataUrl, style: 'width:100%;height:100%;object-fit:cover;' });
        var x = el('div', { style: 'position:absolute;top:0;right:0;width:16px;height:16px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;text-align:center;line-height:16px;cursor:pointer;' }, '×');
        x.addEventListener('click', function () {
          _pubImages = _pubImages.filter(function (pp) { return pp !== im; });
          renderThumbs(); updatePubState();
        });
        th.appendChild(im2); th.appendChild(x);
        previewList.insertBefore(th, uploadBtn);
      });
      updatePubState();
    }
    fileInput.addEventListener('change', function () {
      Array.prototype.forEach.call(fileInput.files || [], function (f) {
        if (!/^image\//.test(f.type)) return;
        var rd = new FileReader();
        rd.onload = function () { _pubImages.push({ name: f.name, dataUrl: rd.result }); renderThumbs(); };
        rd.readAsDataURL(f);
      });
      fileInput.value = '';
    });
    // 官方工具栏表情图标 → 表情选择器（插入表情芯片，发布时序列化回节点语法）
    var emojiTbIcon = container.querySelector('.toolbar-button .icon-emoji');
    if (emojiTbIcon) {
      var emojiTb = emojiTbIcon.closest('.toolbar-button');
      if (emojiTb) emojiTb.addEventListener('click', function (e) {
        e.stopPropagation();
        openEmojiPicker(emojiTb, function (item) {
          if (String(item[2]) === '2') {
            contentEl.focus();
            insertNodeAtCaret(contentEl, document.createTextNode(String(item[0])));
          } else {
            var chip = el('img', {
              src: emojiImgUrl(item[0], item[2]),
              'data-emj': emojiInsertText(item),
              title: item[1],
              style: 'width:22px;height:22px;vertical-align:-4px;margin:0 1px;',
            });
            contentEl.focus();
            insertNodeAtCaret(contentEl, chip);
          }
          updatePubState();
        });
      });
    }
    // 官方工具栏图片图标也触发选图
    var imgTb = container.querySelector('.toolbar-button .icon-image');
    if (imgTb) {
      var tbWrap = imgTb.closest('.toolbar-button');
      if (tbWrap) tbWrap.addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
    }
    // 版块选择下拉（chose-channel 按钮）
    var channels = [];
    loadGuildChannels({ guild_id: ctx.id }).then(function (chs) { channels = chs; }).catch(function () { /* 忽略 */ });
    if (choseBtn) {
      choseBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var exist = container.querySelector('.txpd-channel-dropdown');
        if (exist) { exist.parentNode.removeChild(exist); return; }
        var dd = el('div', { 'class': 'txpd-channel-dropdown' });
        dd.style.cssText = 'position:absolute;bottom:52px;right:12px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.14);z-index:20;min-width:170px;max-height:230px;overflow:auto;';
        if (!channels.length) dd.appendChild(el('div', { style: 'padding:10px 12px;font-size:13px;color:#999;' }, '版块加载中…'));
        channels.forEach(function (ch) {
          var row = el('div', { style: 'padding:8px 12px;font-size:13px;cursor:pointer;color:#222;' }, ch.channel_name || ch.channel_id);
          row.addEventListener('mouseenter', function () { row.style.background = '#f2f4f8'; });
          row.addEventListener('mouseleave', function () { row.style.background = ''; });
          row.addEventListener('click', function () {
            chosen = ch;
            for (var i = 0; i < choseBtn.childNodes.length; i++) {
              var n = choseBtn.childNodes[i];
              if (n.nodeType === 3 && n.textContent.trim()) { n.textContent = ' ' + (ch.channel_name || ''); break; }
            }
            dd.parentNode.removeChild(dd);
          });
          dd.appendChild(row);
        });
        choseBtn.parentNode.style.position = 'relative';
        choseBtn.parentNode.appendChild(dd);
      });
    }
    // 发表：图片上传 → /publish
    if (pubBtn) pubBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var content = serializeComposerContent(contentEl).trim();
      if (!content && !_pubImages.length) return;
      if (!chosen) { panelError(status, '请先选择版块'); status.style.color = '#e5484d'; return; }
      if (content.length > 1000) { panelError(status, '内容超过 1000 字'); return; }
      pubBtn.disabled = true;
      status.style.color = '#888';
      var doPublish = function (imagePaths) {
        status.textContent = '正在发表…';
        api('/publish', { method: 'POST', body: { guild_id: ctx.id, channel_id: chosen.channel_id, content: content, images: imagePaths, format: 'text', user: TXPD_USER } }).then(function (r) {
          if (!r.success) throw new Error(r.message || '发表失败');
          status.textContent = '✓ 已发表';
          status.style.color = '#15a361';
          contentEl.innerHTML = '';
          _pubImages = []; chosen = null; renderThumbs();
          if (wordCount) wordCount.textContent = '0/1000';
          for (var i = 0; i < choseBtn.childNodes.length; i++) {
            var n = choseBtn.childNodes[i];
            if (n.nodeType === 3 && n.textContent.trim()) { n.textContent = ' 不选择版块'; break; }
          }
          updatePubState();
          setTimeout(function () { if (status.textContent === '✓ 已发表') status.textContent = ''; }, 2500);
        }).catch(function (e) { panelError(status, e.message); pubBtn.disabled = false; });
      };
      if (!_pubImages.length) { doPublish([]); return; }
      status.textContent = '正在上传图片 0/' + _pubImages.length + '…';
      var paths = [], failed = false;
      (function next(idx) {
        if (failed) return;
        if (idx >= _pubImages.length) { doPublish(paths); return; }
        var im = _pubImages[idx];
        api('/upload-image', { method: 'POST', body: { name: im.name, data: im.dataUrl } }).then(function (r) {
          if (!r.success) throw new Error(r.message || '图片上传失败');
          paths.push(r.data.path);
          status.textContent = '正在上传图片 ' + (idx + 1) + '/' + _pubImages.length + '…';
          next(idx + 1);
        }).catch(function (e) { failed = true; panelError(status, e.message); pubBtn.disabled = false; });
      })(0);
    });
    updatePubState();
  }


  // ---------- 作者名点击 → CLI 私聊（应用未登录态会跳官方登录） ----------
  function openDmByNick(nick, commentId, feedIdOverride) {
    var ctx = getFeedContext();
    if (feedIdOverride) ctx.feedId = feedIdOverride;
    if (!ctx.feedId) { toast('未识别当前帖子，无法发起私聊'); return; }
    toast('正在定位用户…');
    api('/cli', { method: 'POST', body: { action: 'feed-detail', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId } } }).then(function (r1) {
      var feed = (r1.data && r1.data.data && r1.data.data.feed) || {};
      if (!r1.success) throw new Error(r1.message || '获取帖子信息失败');
      var guildId = feed.guild_id || ctx.guildId;
      if (!commentId) {
        if (!feed.author_id) throw new Error('未获取到作者信息');
        openDmSend(feed.author || nick, feed.author_id, guildId, true);
        return null;
      }
      return api('/cli', { method: 'POST', body: { action: 'comments', params: { feed_id: ctx.feedId } } }).then(function (rc) {
        var comments = (rc.data && rc.data.data && rc.data.data.comments) || [];
        var c = null;
        for (var i = 0; i < comments.length; i++) {
          if (String(comments[i].comment_id) === 'c_' + commentId || String(comments[i].comment_id) === String(commentId)) { c = comments[i]; break; }
        }
        if (!c) throw new Error('该评论不在第一页，暂无法定位用户');
        openDmSend(c.author || nick, c.author_id, guildId, true);
        return null;
      });
    }).catch(function (e) {
      toast('私聊打开失败：' + String((e && e.message) || e).slice(0, 80));
    });
  }

  // ---------- 评论/回复：拦截官方登录门控，改走 CLI（do-comment / do-reply） ----------
  // 应用在未登录态（虚拟 Cookie 无 p_skey）下点评论/回复会跳官方登录；这里接管为
  // 插件自己的评论弹窗，用 CLI 以当前槽位账号发表。页面原生可用（有 p_skey）时不拦截。
  function getFeedContext() {
    var fm = /\/post\/([^\/?#]+)/.exec(window.location.pathname);
    var cm = /[?&]subc=([^&]+)/.exec(window.location.search);
    var av = document.querySelector('img[src*="groupprohead.gtimg.cn"]');
    var am = av ? /groupprohead\.gtimg\.cn\/(\d+)/.exec(av.getAttribute('src') || '') : null;
    return {
      feedId: fm ? decodeURIComponent(fm[1]) : '',
      channelId: cm ? cm[1] : '',
      guildId: am ? am[1] : '',
    };
  }

  function openCommentFlow(mode, commentId) {
    ensureMask();
    stopPoll();
    mask.style.display = 'flex';
    dlg.innerHTML = '';
    dlg.appendChild(el('button', { id: 'txpd-acct-close' }, '×')).addEventListener('click', closeDlg);
    dlg.appendChild(el('h3', null, mode === 'reply' ? '回复评论' : '发表评论'));
    var ta = el('textarea');
    ta.style.cssText = 'width:100%;box-sizing:border-box;height:88px;border:1px solid #ddd;border-radius:10px;padding:10px;font-size:14px;resize:none;outline:none;font-family:inherit;';
    ta.setAttribute('maxlength', '500');
    ta.setAttribute('placeholder', mode === 'reply' ? '回复该评论…' : '说点什么…');
    dlg.appendChild(ta);
    var status = el('div', { style: 'font-size:13px;color:#888;margin-top:6px;min-height:18px;' }, '');
    var send = el('button', { 'class': 'txpd-acct-add' }, '发送');
    var emojiRow = el('div', { style: 'margin-top:6px;' });
    emojiRow.appendChild(makeEmojiButton(function (item) {
      insertTextAtCursor(ta, emojiInsertText(item));
    }));
    dlg.appendChild(emojiRow);
    dlg.appendChild(send);
    dlg.appendChild(status);

    send.addEventListener('click', function () {
      var content = ta.value.trim();
      if (!content) { status.textContent = '请输入内容'; status.style.color = '#e5484d'; return; }
      send.disabled = true; ta.disabled = true;
      status.style.color = '#888';
      status.textContent = '正在获取帖子信息…';
      var ctx = getFeedContext();
      if (!ctx.feedId) {
        status.textContent = '无法识别当前帖子';
        status.style.color = '#e5484d';
        send.disabled = false; ta.disabled = false;
        return;
      }
      api('/cli', { method: 'POST', body: { action: 'feed-detail', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId } } }).then(function (r1) {
        var feed = (r1.data && r1.data.data && r1.data.data.feed) || {};
        if (!r1.success || !(feed.create_time_raw || feed.create_time)) throw new Error(r1.message || '获取帖子信息失败');
        if (feed.guild_id) ctx.guildId = feed.guild_id;
        var fct = String(feed.create_time_raw || feed.create_time);
        if (mode === 'comment') {
          status.textContent = '正在发表评论…';
          return api('/cli', { method: 'POST', body: { action: 'do-comment', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId, feed_create_time: fct, content: content, comment_type: '1' } } }).then(function (r2) {
            if (!r2.success) throw new Error(r2.message || '评论失败');
            status.textContent = '✓ 评论已发表（CLI 账号身份）';
            status.style.color = '#15a361';
            send.style.display = 'none';
          });
        }
        status.textContent = '正在获取评论信息…';
        return api('/cli', { method: 'POST', body: { action: 'comments', params: { feed_id: ctx.feedId } } }).then(function (rc) {
          var comments = (rc.data && rc.data.data && rc.data.data.comments) || [];
          var c = null;
          for (var i = 0; i < comments.length; i++) {
            if (String(comments[i].comment_id) === String(commentId) || 'c_' + String(comments[i].comment_id) === String(commentId)) { c = comments[i]; break; }
          }
          if (!rc.success || !c) throw new Error('未找到该评论，请刷新后重试');
          status.textContent = '正在发表回复…';
          return api('/cli', { method: 'POST', body: { action: 'do-reply', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId, feed_create_time: fct, comment_id: commentId, comment_author_id: c.author_id, comment_create_time: String(c.create_time_raw || c.create_time), content: content, reply_type: '1' } } }).then(function (r2) {
            if (!r2.success) throw new Error(r2.message || '回复失败');
            status.textContent = '✓ 回复已发表（CLI 账号身份）';
            status.style.color = '#15a361';
            send.style.display = 'none';
          });
        });
      }).catch(function (err) {
        status.textContent = String((err && err.message) || err || '操作失败').slice(0, 140);
        status.style.color = '#e5484d';
        send.disabled = false; ta.disabled = false;
      });
    });
    setTimeout(function () { ta.focus(); }, 60);
  }

  // ---------- 访客限制频道的 CLI 兜底：官方只给一张提示卡时，用插件账号渲染内容 ----------
  var _gidByNumber = {};
  function gatedGateEl() {
    return document.querySelector('.game-guild-main__not-permit')
      || document.querySelector('.m-game-guild-main__not-permit__content');
  }
  function resolveGuildIdByNumber(num, cb) {
    var ctx = currentGuild();
    if (ctx && ctx.id) { cb(ctx.id); return; }
    if (_gidByNumber[num]) { cb(_gidByNumber[num]); return; }
    api('/cli', { method: 'POST', body: { action: 'search-guild', params: { keyword: num, scope: 'channel' } } }).then(function (r) {
      var channels = (r.data && r.data.data && r.data.data.channels) || [];
      for (var i = 0; i < channels.length; i++) {
        if (String(channels[i].guild_number) === String(num)) {
          _gidByNumber[num] = channels[i].guild_id;
          cb(channels[i].guild_id);
          return;
        }
      }
      cb('');
    }).catch(function () { cb(''); });
  }
  function cliImageUrls(list) {
    var out = [];
    (list || []).forEach(function (im) {
      if (typeof im === 'string') out.push(im);
      else if (im && im.picUrl) out.push(im.picUrl);
      else if (im && im.url) out.push(im.url);
    });
    return out;
  }
  function openLightbox(url) {
    var lb = document.getElementById('txpd-lightbox');
    if (!lb) {
      lb = el('div', { id: 'txpd-lightbox' });
      var im = el('img');
      lb.appendChild(im);
      lb.addEventListener('click', function () { lb.style.display = 'none'; });
      document.body.appendChild(lb);
      lb._img = im;
    }
    lb._img.setAttribute('src', url);
    lb.style.display = 'flex';
  }
  // ---------- 官方图标（直接取自官方 DOM，避免自绘） ----------
  var TXPD_SVG = {
    like22: '<svg width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.0135 5.70025L10.2983 4.96978C8.48863 3.12156 5.54982 3.11271 3.72941 4.94984C1.90381 6.79219 1.89494 9.79212 3.70976 11.6456L9.5636 17.6241L9.56362 17.6242C9.58509 17.6461 9.60697 17.6674 9.62921 17.6881L9.63878 17.697L9.94751 18.0147L10.3778 17.5965C10.4869 18.5697 11.3639 18.5741 11.9086 18.0249L18.2781 11.6033C20.0971 9.76938 20.1025 6.78021 18.29 4.93959C16.4866 3.10816 13.566 3.10816 11.7626 4.93959L11.0135 5.70025Z" stroke="currentColor" stroke-width="1.2"></path></svg>',
    cmt22: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none"><mask id="txpd-mc22" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="M19.8147 16.4669C20.5687 15.1506 20.9998 13.6256 20.9998 12C20.9998 7.02943 16.9703 3 11.9998 3C7.02919 3 2.99976 7.02943 2.99976 12C2.99976 16.9705 7.02919 21 11.9998 21C13.6166 21 15.1339 20.5736 16.4453 19.8272L19.4626 20.4976C20.1135 20.6423 20.6903 20.0535 20.5321 19.4056L19.8147 16.4669Z"></path></mask><path d="M19.8147 16.4669L18.6788 15.8162L18.4191 16.2697L18.543 16.7774L19.8147 16.4669ZM16.4453 19.8272L16.7292 18.5493L16.2364 18.4398L15.7977 18.6895L16.4453 19.8272ZM19.4626 20.4976L19.7465 19.2197L20.5321 19.4056ZM19.6907 12C19.6907 13.3914 19.3224 14.6928 18.6788 15.8162L20.9507 17.1176C21.8151 15.6085 22.3088 13.8599 22.3088 12H19.6907ZM11.9998 4.30909C16.2473 4.30909 19.6907 7.75242 19.6907 12H22.3088C22.3088 6.30644 17.6933 1.69091 11.9998 1.69091V4.30909ZM4.30884 12C4.30884 7.75242 7.75218 4.30909 11.9998 4.30909V1.69091C6.30621 1.69091 1.69067 6.30644 1.69067 12H4.30884ZM11.9998 19.6909C7.75218 19.6909 4.30884 16.2475 4.30884 12H1.69067C1.69067 17.6935 6.30621 22.309 11.9998 22.309V19.6909ZM15.7977 18.6895C14.6785 19.3265 13.3836 19.6909 11.9998 19.6909V22.309C13.8496 22.309 15.5893 21.8207 17.0928 20.9649L15.7977 18.6895ZM19.7465 19.2197L16.7292 18.5493L16.1613 21.1051L19.1786 21.7756L19.7465 19.2197ZM19.2604 19.7161C19.1885 19.4216 19.4506 19.154 19.7465 19.2197L19.1786 21.7756C20.7765 22.1306 22.192 20.6853 21.8039 19.0952L19.2604 19.7161ZM18.543 16.7774L19.2604 19.7161L21.8039 19.0952L21.0865 16.1565L18.543 16.7774Z" fill="currentColor" mask="url(#txpd-mc22)"></path><path d="M9 9.97656H15" stroke="currentColor" stroke-width="1.30909"></path><path d="M9 14.0234H15" stroke="currentColor" stroke-width="1.30909"></path></svg>',
    share22: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none"><mask id="txpd-ms22" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="M20.4412 13.1774C21.1117 12.4805 21.1117 11.3784 20.4412 10.6815L13.6076 3.57861C13.0459 2.99473 12.059 3.39236 12.059 4.20259V8.25024H9.40026C5.86549 8.25024 3 11.1157 3 14.6505V18.7019C3 19.0911 3.49927 19.2511 3.72547 18.9345L4.76322 17.4819C5.56418 16.3608 6.85721 15.6955 8.23504 15.6955H12.059V19.6564C12.059 20.4666 13.0459 20.8642 13.6076 20.2803L20.4412 13.1774Z"></path></mask><path d="M20.4412 10.6815L19.4978 11.5891ZM20.4412 13.1774L19.4978 12.2698ZM13.6076 3.57861L12.6642 4.48622ZM12.059 8.25024V9.55933H13.3681V8.25024H12.059ZM3.72547 18.9345L2.6603 18.1735ZM4.76322 17.4819L5.82839 18.2429ZM12.059 15.6955H13.3681V14.3864H12.059V15.6955ZM13.6076 20.2803L14.551 21.188ZM19.4978 11.5891C19.6807 11.7792 19.6807 12.0798 19.4978 12.2698L21.3846 14.085C22.5426 12.8813 22.5426 10.9776 21.3846 9.77392L19.4978 11.5891ZM12.6642 4.48622L19.4978 11.5891L21.3846 9.77392L14.551 2.67101L12.6642 4.48622ZM13.3681 4.20259C13.3681 4.57087 12.9196 4.75162 12.6642 4.48622L14.551 2.67101C13.1722 1.23785 10.75 2.21385 10.75 4.20259H13.3681ZM13.3681 8.25024V4.20259H10.75V8.25024H13.3681ZM9.40026 9.55933H12.059V6.94115H9.40026V9.55933ZM4.30909 14.6505C4.30909 11.8387 6.58848 9.55933 9.40026 9.55933V6.94115C5.14251 6.94115 1.69091 10.3927 1.69091 14.6505H4.30909ZM4.30909 18.7019V14.6505H1.69091V18.7019H4.30909ZM2.6603 18.1735C3.17439 17.4539 4.30909 17.8176 4.30909 18.7019H1.69091C1.69091 20.3645 3.82415 21.0483 4.79064 19.6955L2.6603 18.1735ZM3.69805 16.7209L2.6603 18.1735L4.79064 19.6955L5.82839 18.2429L3.69805 16.7209ZM8.23504 14.3864C6.43449 14.3864 4.74475 15.2559 3.69805 16.7209L5.82839 18.2429C6.38361 17.4658 7.27994 17.0046 8.23504 17.0046V14.3864ZM12.059 14.3864H8.23504V17.0046H12.059V14.3864ZM13.3681 19.6564V15.6955H10.75V19.6564H13.3681ZM12.6642 19.3727C12.9196 19.1074 13.3681 19.2881 13.3681 19.6564H10.75C10.75 21.6451 13.1722 22.6211 14.551 21.188L12.6642 19.3727ZM19.4978 12.2698L12.6642 19.3727L14.551 21.188L21.3846 14.085L19.4978 12.2698Z" fill="currentColor" mask="url(#txpd-ms22)"></path></svg>',
    like16: '<svg class="icon-svg-symbol icon-like" style="color:currentcolor;width:16px;height:16px;"><use xlink:href="assets/common.svg#like"></use></svg>',
    reply16: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"><mask id="txpd-mc16" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="M19.8147 16.4669C20.5687 15.1506 20.9998 13.6256 20.9998 12C20.9998 7.02943 16.9703 3 11.9998 3C7.02919 3 2.99976 7.02943 2.99976 12C2.99976 16.9705 7.02919 21 11.9998 21C13.6166 21 15.1339 20.5736 16.4453 19.8272L19.4626 20.4976C20.1135 20.6423 20.6903 20.0535 20.5321 19.4056L19.8147 16.4669Z"></path></mask><path d="M19.8147 16.4669L18.6788 15.8162L18.4191 16.2697L18.543 16.7774L19.8147 16.4669ZM16.4453 19.8272L16.7292 18.5493L16.2364 18.4398L15.7977 18.6895L16.4453 19.8272ZM19.4626 20.4976L19.7465 19.2197L20.5321 19.4056ZM19.6907 12C19.6907 13.3914 19.3224 14.6928 18.6788 15.8162L20.9507 17.1176C21.8151 15.6085 22.3088 13.8599 22.3088 12H19.6907ZM11.9998 4.30909C16.2473 4.30909 19.6907 7.75242 19.6907 12H22.3088C22.3088 6.30644 17.6933 1.69091 11.9998 1.69091V4.30909ZM4.30884 12C4.30884 7.75242 7.75218 4.30909 11.9998 4.30909V1.69091C6.30621 1.69091 1.69067 6.30644 1.69067 12H4.30884ZM11.9998 19.6909C7.75218 19.6909 4.30884 16.2475 4.30884 12H1.69067C1.69067 17.6935 6.30621 22.309 11.9998 22.309V19.6909ZM15.7977 18.6895C14.6785 19.3265 13.3836 19.6909 11.9998 19.6909V22.309C13.8496 22.309 15.5893 21.8207 17.0928 20.9649L15.7977 18.6895ZM19.7465 19.2197L16.7292 18.5493L16.1613 21.1051L19.1786 21.7756L19.7465 19.2197ZM19.2604 19.7161C19.1885 19.4216 19.4506 19.154 19.7465 19.2197L19.1786 21.7756C20.7765 22.1306 22.192 20.6853 21.8039 19.0952L19.2604 19.7161ZM18.543 16.7774L19.2604 19.7161L21.8039 19.0952L21.0865 16.1565L18.543 16.7774Z" fill="currentColor" mask="url(#txpd-mc16)"></path><path d="M9 9.97656H15" stroke="currentColor" stroke-width="1.30909"></path><path d="M9 14.0234H15" stroke="currentColor" stroke-width="1.30909"></path></svg>',
    barLike24: '<svg class="icon-svg-symbol icon-like" style="color:currentcolor;width:24px;height:24px;"><use xlink:href="assets/common.svg#like"></use></svg>',
    barCmt24: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><mask id="txpd-mc24" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="M19.8147 16.4669C20.5687 15.1506 20.9998 13.6256 20.9998 12C20.9998 7.02943 16.9703 3 11.9998 3C7.02919 3 2.99976 7.02943 2.99976 12C2.99976 16.9705 7.02919 21 11.9998 21C13.6166 21 15.1339 20.5736 16.4453 19.8272L19.4626 20.4976C20.1135 20.6423 20.6903 20.0535 20.5321 19.4056L19.8147 16.4669Z"></path></mask><path d="M19.8147 16.4669L18.6788 15.8162L18.4191 16.2697L18.543 16.7774L19.8147 16.4669ZM16.4453 19.8272L16.7292 18.5493L16.2364 18.4398L15.7977 18.6895L16.4453 19.8272ZM19.4626 20.4976L19.7465 19.2197L20.5321 19.4056ZM19.6907 12C19.6907 13.3914 19.3224 14.6928 18.6788 15.8162L20.9507 17.1176C21.8151 15.6085 22.3088 13.8599 22.3088 12H19.6907ZM11.9998 4.30909C16.2473 4.30909 19.6907 7.75242 19.6907 12H22.3088C22.3088 6.30644 17.6933 1.69091 11.9998 1.69091V4.30909ZM4.30884 12C4.30884 7.75242 7.75218 4.30909 11.9998 4.30909V1.69091C6.30621 1.69091 1.69067 6.30644 1.69067 12H4.30884ZM11.9998 19.6909C7.75218 19.6909 4.30884 16.2475 4.30884 12H1.69067C1.69067 17.6935 6.30621 22.309 11.9998 22.309V19.6909ZM15.7977 18.6895C14.6785 19.3265 13.3836 19.6909 11.9998 19.6909V22.309C13.8496 22.309 15.5893 21.8207 17.0928 20.9649L15.7977 18.6895ZM19.7465 19.2197L16.7292 18.5493L16.1613 21.1051L19.1786 21.7756L19.7465 19.2197ZM19.2604 19.7161C19.1885 19.4216 19.4506 19.154 19.7465 19.2197L19.1786 21.7756C20.7765 22.1306 22.192 20.6853 21.8039 19.0952L19.2604 19.7161ZM18.543 16.7774L19.2604 19.7161L21.8039 19.0952L21.0865 16.1565L18.543 16.7774Z" fill="currentColor" mask="url(#txpd-mc24)"></path><path d="M9 9.97656H15" stroke="currentColor" stroke-width="1.30909"></path><path d="M9 14.0234H15" stroke="currentColor" stroke-width="1.30909"></path></svg>',
    barShare24: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><mask id="txpd-ms24" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="M20.4412 13.1774C21.1117 12.4805 21.1117 11.3784 20.4412 10.6815L13.6076 3.57861C13.0459 2.99473 12.059 3.39236 12.059 4.20259V8.25024H9.40026C5.86549 8.25024 3 11.1157 3 14.6505V18.7019C3 19.0911 3.49927 19.2511 3.72547 18.9345L4.76322 17.4819C5.56418 16.3608 6.85721 15.6955 8.23504 15.6955H12.059V19.6564C12.059 20.4666 13.0459 20.8642 13.6076 20.2803L20.4412 13.1774Z"></path></mask><path d="M20.4412 10.6815L19.4978 11.5891ZM20.4412 13.1774L19.4978 12.2698ZM13.6076 3.57861L12.6642 4.48622ZM12.059 8.25024V9.55933H13.3681V8.25024H12.059ZM3.72547 18.9345L2.6603 18.1735ZM4.76322 17.4819L5.82839 18.2429ZM12.059 15.6955H13.3681V14.3864H12.059V15.6955ZM13.6076 20.2803L14.551 21.188ZM19.4978 11.5891C19.6807 11.7792 19.6807 12.0798 19.4978 12.2698L21.3846 14.085C22.5426 12.8813 22.5426 10.9776 21.3846 9.77392L19.4978 11.5891ZM12.6642 4.48622L19.4978 11.5891L21.3846 9.77392L14.551 2.67101L12.6642 4.48622ZM13.3681 4.20259C13.3681 4.57087 12.9196 4.75162 12.6642 4.48622L14.551 2.67101C13.1722 1.23785 10.75 2.21385 10.75 4.20259H13.3681ZM13.3681 8.25024V4.20259H10.75V8.25024H13.3681ZM9.40026 9.55933H12.059V6.94115H9.40026V9.55933ZM4.30909 14.6505C4.30909 11.8387 6.58848 9.55933 9.40026 9.55933V6.94115C5.14251 6.94115 1.69091 10.3927 1.69091 14.6505H4.30909ZM4.30909 18.7019V14.6505H1.69091V18.7019H4.30909ZM2.6603 18.1735C3.17439 17.4539 4.30909 17.8176 4.30909 18.7019H1.69091C1.69091 20.3645 3.82415 21.0483 4.79064 19.6955L2.6603 18.1735ZM3.69805 16.7209L2.6603 18.1735L4.79064 19.6955L5.82839 18.2429L3.69805 16.7209ZM8.23504 14.3864C6.43449 14.3864 4.74475 15.2559 3.69805 16.7209L5.82839 18.2429C6.38361 17.4658 7.27994 17.0046 8.23504 17.0046V14.3864ZM12.059 14.3864H8.23504V17.0046H12.059V14.3864ZM13.3681 19.6564V15.6955H10.75V19.6564H13.3681ZM12.6642 19.3727C12.9196 19.1074 13.3681 19.2881 13.3681 19.6564H10.75C10.75 21.6451 13.1722 22.6211 14.551 21.188L12.6642 19.3727ZM19.4978 12.2698L12.6642 19.3727L14.551 21.188L21.3846 14.085L19.4978 12.2698Z" fill="currentColor" mask="url(#txpd-ms24)"></path></svg>',
    sort16: '<svg class="icon-svg-symbol icon-sort" style="color:currentcolor;width:16px;height:16px;"><use xlink:href="assets/common.svg#sort"></use></svg>'
  };
  // 官方头像容器（CLI 拿不到头像 URL → 用官方 .avatar-placeholder 底色 + 昵称首字）
  function avatarBox(size, extraCls, nick) {
    var box = el('div', { 'class': 'avatar no-copy avatar--circle avatar--hover_dark' + (extraCls ? ' ' + extraCls : ''), style: 'width:' + size + 'px;height:' + size + 'px;' });
    box.setAttribute('data-v-4007f4c0', '');
    var phs = el('div', { 'class': 'avatar-placeholder', style: 'display:flex;align-items:center;justify-content:center;font-size:' + Math.round(size / 2.2) + 'px;color:#8a97ab;' }, String(nick || '·').slice(0, 1));
    phs.setAttribute('data-v-4007f4c0', '');
    box.appendChild(phs);
    return box;
  }
  // 官方瀑布流卡片结构（class/data-v 与官方一致 → 样式全部来自官方 CSS）
  function buildCliCard(f, gnum, guildId) {
    var a = el('a', { 'class': 'game-guild-main__short-content pointer', href: PANEL_BASE + 'g/' + encodeURIComponent(gnum) + '/post/' + encodeURIComponent(f.feed_id) });
    a.setAttribute('data-v-b34f4f3d', '');
    a.setAttribute('data-v-3cee7fac', '');
    a.setAttribute('data-txpd-cli-detail', '1');
    a.setAttribute('data-feed', f.feed_id);
    a.setAttribute('data-guild', guildId);
    a.innerHTML = ''
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__content"><div data-v-b34f4f3d="" class="game-guild-main__short-content__info">'
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__info__header"><div data-v-b34f4f3d="" class="user-info">'
      + '<span data-v-69f3dba3=""><div data-v-b34f4f3d="" class="user-info__base"><span class="txpd-av-slot"></span>'
      + '<h3 data-v-b34f4f3d="" class="nick hover-underline"></h3></div></span>'
      + '<div data-v-b34f4f3d="" class="dot"></div><h3 data-v-b34f4f3d="" class="edit-time"></h3></div>'
      + '<div data-v-b34f4f3d="" class="tag-container"><!----></div></div>'
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__media-detail"><div data-v-b34f4f3d=""><span class="feed-detail-text"></span></div></div>'
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__image game-guild-main__short-content__image-single">'
      + '<div data-v-b34f4f3d="" class="short-feed-image shown-last-image"><div class="short-feed-image__placeholder"></div></div></div>'
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__operation">'
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__operation__item game-guild-main__short-content__like"><svg width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.0135 5.70025L10.2983 4.96978C8.48863 3.12156 5.54982 3.11271 3.72941 4.94984C1.90381 6.79219 1.89494 9.79212 3.70976 11.6456L9.5636 17.6241L9.56362 17.6242C9.58509 17.6461 9.60697 17.6674 9.62921 17.6881L9.63878 17.697L9.94751 18.0147L10.3778 17.5965C10.4869 18.5697 11.3639 18.5741 11.9086 18.0249L18.2781 11.6033C20.0971 9.76938 20.1025 6.78021 18.29 4.93959C16.4866 3.10816 13.566 3.10816 11.7626 4.93959L11.0135 5.70025Z" stroke="currentColor" stroke-width="1.2"></path></svg><div data-v-b34f4f3d="" class="game-guild-main__short-content__text"></div></div>'
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__operation__item game-guild-main__short-content__comment"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none"><mask id="txpd-mc22" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="M19.8147 16.4669C20.5687 15.1506 20.9998 13.6256 20.9998 12C20.9998 7.02943 16.9703 3 11.9998 3C7.02919 3 2.99976 7.02943 2.99976 12C2.99976 16.9705 7.02919 21 11.9998 21C13.6166 21 15.1339 20.5736 16.4453 19.8272L19.4626 20.4976C20.1135 20.6423 20.6903 20.0535 20.5321 19.4056L19.8147 16.4669Z"></path></mask><path d="M19.8147 16.4669L18.6788 15.8162L18.4191 16.2697L18.543 16.7774L19.8147 16.4669ZM16.4453 19.8272L16.7292 18.5493L16.2364 18.4398L15.7977 18.6895L16.4453 19.8272ZM19.4626 20.4976L19.7465 19.2197L20.5321 19.4056ZM19.6907 12C19.6907 13.3914 19.3224 14.6928 18.6788 15.8162L20.9507 17.1176C21.8151 15.6085 22.3088 13.8599 22.3088 12H19.6907ZM11.9998 4.30909C16.2473 4.30909 19.6907 7.75242 19.6907 12H22.3088C22.3088 6.30644 17.6933 1.69091 11.9998 1.69091V4.30909ZM4.30884 12C4.30884 7.75242 7.75218 4.30909 11.9998 4.30909V1.69091C6.30621 1.69091 1.69067 6.30644 1.69067 12H4.30884ZM11.9998 19.6909C7.75218 19.6909 4.30884 16.2475 4.30884 12H1.69067C1.69067 17.6935 6.30621 22.309 11.9998 22.309V19.6909ZM15.7977 18.6895C14.6785 19.3265 13.3836 19.6909 11.9998 19.6909V22.309C13.8496 22.309 15.5893 21.8207 17.0928 20.9649L15.7977 18.6895ZM19.7465 19.2197L16.7292 18.5493L16.1613 21.1051L19.1786 21.7756L19.7465 19.2197ZM19.2604 19.7161C19.1885 19.4216 19.4506 19.154 19.7465 19.2197L19.1786 21.7756C20.7765 22.1306 22.192 20.6853 21.8039 19.0952L19.2604 19.7161ZM18.543 16.7774L19.2604 19.7161L21.8039 19.0952L21.0865 16.1565L18.543 16.7774Z" fill="currentColor" mask="url(#txpd-mc22)"></path><path d="M9 9.97656H15" stroke="currentColor" stroke-width="1.30909"></path><path d="M9 14.0234H15" stroke="currentColor" stroke-width="1.30909"></path></svg><div data-v-b34f4f3d="" class="game-guild-main__short-content__text"></div></div>'
      + '<div data-v-b34f4f3d="" class="game-guild-main__short-content__operation__item game-guild-main__short-content__share"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none"><mask id="txpd-ms22" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="M20.4412 13.1774C21.1117 12.4805 21.1117 11.3784 20.4412 10.6815L13.6076 3.57861C13.0459 2.99473 12.059 3.39236 12.059 4.20259V8.25024H9.40026C5.86549 8.25024 3 11.1157 3 14.6505V18.7019C3 19.0911 3.49927 19.2511 3.72547 18.9345L4.76322 17.4819C5.56418 16.3608 6.85721 15.6955 8.23504 15.6955H12.059V19.6564C12.059 20.4666 13.0459 20.8642 13.6076 20.2803L20.4412 13.1774Z"></path></mask><path d="M20.4412 10.6815L19.4978 11.5891ZM20.4412 13.1774L19.4978 12.2698ZM13.6076 3.57861L12.6642 4.48622ZM12.059 8.25024V9.55933H13.3681V8.25024H12.059ZM3.72547 18.9345L2.6603 18.1735ZM4.76322 17.4819L5.82839 18.2429ZM12.059 15.6955H13.3681V14.3864H12.059V15.6955ZM13.6076 20.2803L14.551 21.188ZM19.4978 11.5891C19.6807 11.7792 19.6807 12.0798 19.4978 12.2698L21.3846 14.085C22.5426 12.8813 22.5426 10.9776 21.3846 9.77392L19.4978 11.5891ZM12.6642 4.48622L19.4978 11.5891L21.3846 9.77392L14.551 2.67101L12.6642 4.48622ZM13.3681 4.20259C13.3681 4.57087 12.9196 4.75162 12.6642 4.48622L14.551 2.67101C13.1722 1.23785 10.75 2.21385 10.75 4.20259H13.3681ZM13.3681 8.25024V4.20259H10.75V8.25024H13.3681ZM9.40026 9.55933H12.059V6.94115H9.40026V9.55933ZM4.30909 14.6505C4.30909 11.8387 6.58848 9.55933 9.40026 9.55933V6.94115C5.14251 6.94115 1.69091 10.3927 1.69091 14.6505H4.30909ZM4.30909 18.7019V14.6505H1.69091V18.7019H4.30909ZM2.6603 18.1735C3.17439 17.4539 4.30909 17.8176 4.30909 18.7019H1.69091C1.69091 20.3645 3.82415 21.0483 4.79064 19.6955L2.6603 18.1735ZM3.69805 16.7209L2.6603 18.1735L4.79064 19.6955L5.82839 18.2429L3.69805 16.7209ZM8.23504 14.3864C6.43449 14.3864 4.74475 15.2559 3.69805 16.7209L5.82839 18.2429C6.38361 17.4658 7.27994 17.0046 8.23504 17.0046V14.3864ZM12.059 14.3864H8.23504V17.0046H12.059V14.3864ZM13.3681 19.6564V15.6955H10.75V19.6564H13.3681ZM12.6642 19.3727C12.9196 19.1074 13.3681 19.2881 13.3681 19.6564H10.75C10.75 21.6451 13.1722 22.6211 14.551 21.188L12.6642 19.3727ZM19.4978 12.2698L12.6642 19.3727L14.551 21.188L21.3846 14.085L19.4978 12.2698Z" fill="currentColor" mask="url(#txpd-ms22)"></path></svg><div data-v-b34f4f3d="" class="game-guild-main__short-content__text">分享</div></div>'
      + '</div></div></div>';
    var nick = f.author || '匿名';
    a.querySelector('.txpd-av-slot').appendChild(avatarBox(24, '', nick));
    a.querySelector('.nick').textContent = nick;
    a.querySelector('.edit-time').textContent = cliTime(f.create_time);
    a.querySelector('.feed-detail-text').textContent = f.content_snippet || f.title || '';
    var imgs = cliImageUrls(f.images);
    var imgWrap = a.querySelector('.game-guild-main__short-content__image');
    if (!imgs.length) {
      imgWrap.style.display = 'none';
    } else if (imgs.length === 1) {
      // 官方单图：.image-single > .short-feed-image.shown-last-image > .placeholder > img（尺寸算在 img 上）
      var ph1 = a.querySelector('.short-feed-image__placeholder');
      var im1 = el('img', { src: imgs[0], referrerpolicy: 'no-referrer' });
      im1.addEventListener('load', function () {
        var holder = a.querySelector('.game-guild-main__short-content__content') || a;
        var box = officialImageSize(holder.clientWidth || 0, im1.naturalWidth, im1.naturalHeight);
        im1.style.width = box.width;
        im1.style.height = box.height;
      });
      im1.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openLightbox(imgs[0]); });
      ph1.appendChild(im1);
    } else {
      // 官方多图：包装 .short-feed-image 带宽度/内边距（2 或 4+ 张 → 四列；3 张 → 三列），末图角标显示总数
      var many = imgs.length !== 3;   // 官方：3 张走三列，其余（2/4/5+）都是四列方格
      // 官方是按百分比铺满整行（3 图 ~296px、4 图 ~222px 的方格）；按用户要求统一缩到固定小方格
      var wrapStyle = 'width:' + MULTI_IMG_TILE + 'px;padding-top:' + MULTI_IMG_TILE + 'px;';
      var shown = Math.min(imgs.length, many ? 4 : 3);
      var area = a.querySelector('.game-guild-main__short-content__image');
      area.className = 'game-guild-main__short-content__image game-guild-main__short-content__image-multiple';
      area.setAttribute('data-v-b34f4f3d', '');
      area.innerHTML = '';
      for (var ii = 0; ii < shown; ii++) {
        var box2 = el('div', { 'class': 'short-feed-image' + (ii === shown - 1 ? ' shown-last-image' : ''), style: wrapStyle });
        box2.setAttribute('data-v-b34f4f3d', '');
        var inr = el('div', { 'class': 'short-feed-image__placeholder' });
        var im2 = el('img', { src: imgs[ii], referrerpolicy: 'no-referrer', style: 'height:100%;width:100%;' });
        (function (u) { im2.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openLightbox(u); }); })(imgs[ii]);
        inr.appendChild(im2);
        if (ii === shown - 1 && imgs.length > shown) {
          inr.appendChild(el('div', { 'class': 'image-num', 'data-v-b34f4f3d': '' }, '共' + imgs.length + '图'));
        }
        box2.appendChild(inr);
        area.appendChild(box2);
      }
    }
    a.querySelector('.game-guild-main__short-content__like .game-guild-main__short-content__text').textContent = String(f.prefer_count || 0);
    a.querySelector('.game-guild-main__short-content__comment .game-guild-main__short-content__text').textContent = String(f.comment_count || 0);
    return a;
  }
  // 官方详情左栏图片（swiper 结构，官方 CSS 负责布局）
  function buildCliImages(imgs) {
    var box = el('div', { 'class': 'short-imagecontent-container swiper-container' });
    box.setAttribute('data-v-df986c55', '');
    var sw = el('div', { 'class': 'swiper swiper-initialized swiper-horizontal swiper-backface-hidden' });
    var w1 = el('div', { 'class': 'swiper-wrapper' });
    imgs.forEach(function (u, i) {
      var slide = el('div', { 'class': 'swiper-slide' + (i === 0 ? ' swiper-slide-active' : '') });
      var inner = el('div', { 'class': 'short-feed-image' });
      inner.setAttribute('data-v-df986c55', '');
      var ph = el('div', { 'class': 'short-feed-image__placeholder' });
      var im = el('img', { src: u, referrerpolicy: 'no-referrer', style: 'height:100%;width:100%;object-fit:contain;' });
      im.addEventListener('click', function () { openLightbox(u); });
      ph.appendChild(im);
      inner.appendChild(ph);
      slide.appendChild(inner);
      w1.appendChild(slide);
    });
    sw.appendChild(w1);
    if (imgs.length > 1) {
      var pag = el('div', { 'class': 'swiper-pagination swiper-pagination-clickable swiper-pagination-bullets swiper-pagination-horizontal' });
      imgs.forEach(function (u, i) {
        var b = el('span', { 'class': 'swiper-pagination-bullet' + (i === 0 ? ' swiper-pagination-bullet-active' : '') });
        b.addEventListener('click', function () {
          var cur = w1.querySelector('.swiper-slide-active');
          if (cur) cur.classList.remove('swiper-slide-active');
          w1.children[i].classList.add('swiper-slide-active');
          w1.style.transform = 'translate3d(-' + (i * 100) + '%,0,0)';
          var bs = pag.children;
          for (var k = 0; k < bs.length; k++) bs[k].classList.toggle('swiper-pagination-bullet-active', k === i);
        });
        pag.appendChild(b);
      });
      sw.appendChild(pag);
    }
    box.appendChild(sw);
    return box;
  }
  // 官方 guild-waterfall-feed 的单图尺寸算法（逐行照搬），并额外限制单图高度上限
  // （官方竖图可到 580 高，一张卡片就占掉大半个屏幕；按用户要求收紧到 SINGLE_IMG_MAX_H）
  var SINGLE_IMG_MAX_H = 300;
  var MULTI_IMG_TILE = 180;      // 多图方格的边长（官方按百分比铺满，此处收紧为固定小方格）
  function officialImageSize(containerW, natW, natH) {
    var o = containerW * 0.68;
    if (o >= 580) o = 580;
    if (o <= 446) o = 446;
    if (o > SINGLE_IMG_MAX_H * 1.6) o = SINGLE_IMG_MAX_H * 1.6;   // 宽上限随之收紧（446→480/300→480）
    var box;
    if (!natW || !natH) {
      box = { w: o, h: o };
    } else {
      var ratio = natW / natH;
      if (ratio > 1) box = (o / ratio < containerW / 2) ? { w: o, h: o * 9 / 16 } : { w: o, h: o / ratio };
      else if (ratio < 1) box = (o * ratio < containerW / 2) ? { w: o * 5 / 7, h: o } : { w: o * ratio, h: o };
      else box = { w: o, h: o };
    }
    if (box.h > SINGLE_IMG_MAX_H) {
      box.w = box.w * (SINGLE_IMG_MAX_H / box.h);
      box.h = SINGLE_IMG_MAX_H;
    }
    return { width: Math.round(box.w) + 'px', height: Math.round(box.h) + 'px' };
  }
  function cliTime(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(String(v || ''));
    return m ? (m[2] + '-' + m[3] + ' ' + m[4]) : String(v || '');
  }
  // 与正常频道一致的主页骨架（官方 class/data-v；缺数据的块用官方空态占位）
  var _gatedTab = '';        // '' = 全部；否则为版块 channel_id
  var _gatedTabsKey = '';    // 已渲染页签对应的频道号
  var TXPD_TB_FOURTH = '<span class=\"toolbar-button\" data-v-1c099b7e><svg width=\"20\" height=\"20\" class=\"icon-svg\" viewbox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\" data-v-1c099b7e><path d=\"M10.078 13.797C9.60006 13.4587 8.96861 13.0501 8.43374 12.8338C7.26763 12.3622 5.6115 12.4205 4.38399 12.5621C3.53188 12.6605 2.72986 12.0143 2.72986 11.1565C2.72986 9.83204 2.72986 8.72527 2.72986 7.38215C2.72986 6.57948 3.43379 5.95326 4.23474 6.00586C5.4523 6.08583 7.16672 6.12682 8.43374 5.86935C10.1696 5.51659 12.1915 4.37484 13.7037 3.38356C14.641 2.76907 15.9691 3.42615 15.9691 4.54697C15.9691 6.31738 15.9691 7.78715 15.9691 9.88398\" stroke=\"currentColor\" style=\"stroke:currentColor;stroke-opacity:1;\" stroke-width=\"1.14167\" stroke-linecap=\"square\"></path><path d=\"M7.03646 12.4248L7.91263 15.3797C8.1828 16.2908 7.50008 17.2053 6.54973 17.2053V17.2053C5.92028 17.2053 5.36578 16.7914 5.18683 16.1879L4.071 12.4248\" stroke=\"currentColor\" style=\"stroke:currentColor;stroke-opacity:1;\" stroke-width=\"1.14167\"></path><path d=\"M14.6181 11.8909C14.7569 11.5392 15.2546 11.5392 15.3934 11.8909L16.0345 13.5165C16.0769 13.6239 16.1619 13.7089 16.2693 13.7513L17.8949 14.3924C18.2467 14.5312 18.2467 15.0289 17.8949 15.1677L16.2693 15.8088C16.1619 15.8512 16.0769 15.9362 16.0345 16.0436L15.3934 17.6692C15.2546 18.0209 14.7569 18.0209 14.6181 17.6692L13.977 16.0436C13.9346 15.9362 13.8496 15.8512 13.7423 15.8088L12.1166 15.1677C11.7649 15.0289 11.7649 14.5312 12.1166 14.3924L13.7423 13.7513C13.8496 13.7089 13.9346 13.6239 13.977 13.5165L14.6181 11.8909Z\" fill=\"currentColor\" style=\"fill:currentColor;fill-opacity:1;\"></path></svg></span>';
  function gatedBuildTabBar(bar, guildId) {
    var wrap = bar.querySelector('.swiper-wrapper');
    if (!wrap) return;
    wrap.innerHTML = '';
    var mkItem = function (label, channelId, active, first) {
      var slide = el('div', { 'class': 'swiper-slide swiper-slide-visible' });
      var item = el('div', { 'class': 'tab-bar__item' + (first ? ' first-item' : '') + (active ? ' is-active' : '') });
      item.setAttribute('data-v-2bac90f6', '');
      var h3 = el('h3', { 'class': 'tab-bar__item__text' }, label);
      h3.setAttribute('data-v-2bac90f6', '');
      item.appendChild(h3);
      slide.appendChild(item);
      item.addEventListener('click', function () {
        if (_gatedTab === channelId) return;
        _gatedTab = channelId;
        Array.prototype.forEach.call(wrap.querySelectorAll('.tab-bar__item'), function (x) { x.classList.remove('is-active'); });
        item.classList.add('is-active');
        var body = document.getElementById('txpd-cli-body');
        var gid = body && body.getAttribute('data-guild');
        if (body && gid) { body.setAttribute('data-key', ''); renderCliFeedList(body, gid); }
      });
      wrap.appendChild(slide);
    };
    mkItem('全部', '', !_gatedTab, true);
    api('/cli', { method: 'POST', body: { action: 'channels', params: { guild_id: guildId } } }).then(function (r) {
      var chs = (r.data && r.data.data && r.data.data.channels) || [];
      chs.forEach(function (ch, i) { mkItem(ch.channel_name || ch.channel_id, String(ch.channel_id), _gatedTab === String(ch.channel_id), false); });
    }).catch(function () { /* 没有版块接口时就只留「全部」 */ });
  }
  function gatedPanelBody(useSkeleton, gidForTabs) {
    var panel = document.getElementById('txpd-cli-panel');
    if (!panel) {
      // 不再加「插件账号」说明行：保持与正常频道一致的观感
      panel = el('div', { id: 'txpd-cli-panel' });
      if (useSkeleton) {
        // ── 官方主页骨架 ──────────────────────────────────────────────
        panel.className = 'game-guild-main__content';
        panel.setAttribute('data-v-7cca9fe6', '');
        var left = el('div', { 'class': 'game-guild-main__content__left' });
        left.setAttribute('data-v-7cca9fe6', '');
        // 发帖框（官方结构；插件既有的 CLI 发帖接管会认这个容器）
        var pub = el('div', { 'class': 'publish-editor-container' });
        pub.setAttribute('data-v-1c099b7e', '');
        pub.setAttribute('data-v-7cca9fe6', '');
        // 工具栏与官方一致（表情 / @ / 图片 / 其他）；点开后由插件的 CLI 发帖器接管
        var tb = function (cls, href) {
          return '<span class="toolbar-button" data-v-1c099b7e=""><svg class="icon-svg-symbol ' + cls + '" style="color:currentColor;width:20px;height:20px;" data-v-1c099b7e=""><use xlink:href="' + href + '"></use></svg></span>';
        };
        pub.innerHTML = '<div class="editor-area" data-v-1c099b7e="">'
          + '<div class="editor-header pointer" data-v-1c099b7e=""><div class="user-info" data-v-1c099b7e="">'
          + '<span class="user-name" data-v-1c099b7e="">发帖将以 CLI 当前账号身份发表，点击输入框开始</span></div>'
          + '<div class="toolbar-area" data-v-1c099b7e="">'
          + tb('icon-emoji', 'assets/common.svg#emoji')
          + tb('icon-at', 'assets/common.svg#at')
          + tb('icon-image', 'assets/common.svg#image')
          + TXPD_TB_FOURTH
          + '</div></div>'
          + '<div class="editor-divider" data-v-1c099b7e=""></div>'
          + '<div class="editor-root-container" data-v-1c099b7e=""><div data-v-1c099b7e=""></div></div></div>';
        left.appendChild(pub);
        // 版块页签行
        var op = el('div', { 'class': 'game-guild-main__content__left__operation', style: 'flex-direction:row;' });
        op.setAttribute('data-v-7cca9fe6', '');
        var bar = el('div', { 'class': 'game-guild-main-tab-bar' });
        bar.setAttribute('data-v-2bac90f6', '');
        var swiper = el('div', { 'class': 'swiper swiper-initialized swiper-horizontal swiper-free-mode tab-bar__item-list' });
        swiper.appendChild(el('div', { 'class': 'swiper-wrapper' }));
        bar.appendChild(swiper);
        // 「全部」默认就在，不等帖子加载完（版块列表随后异步补上）
        if (gidForTabs) {
          _gatedTabsKey = gidForTabs;
          gatedBuildTabBar(bar, gidForTabs);
        }
        op.appendChild(bar);
        var pubBtn = el('div', { 'class': 'publish-feed-btn' });
        pubBtn.setAttribute('data-v-7cca9fe6', '');
        op.appendChild(pubBtn);
        left.appendChild(op);
        // 瀑布流滚动容器（官方高度/滚动由官方 CSS 负责）
        var scroller = el('div', { 'class': 'game-guild-main__waterfalls-scroller', id: 'scrollableDiv' });
        scroller.setAttribute('data-v-3cee7fac', '');
        scroller.setAttribute('data-v-7cca9fe6', '');
        var box = el('div', { id: 'txpd-cli-body' });
        scroller.appendChild(box);
        scroller.addEventListener('scroll', function () {
          // 与公开频道一致：滚动就收起顶栏（simple 30px），回到顶部再展开
          gatedHeadSetCollapsed(scroller.scrollTop > 0);
          if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 300) {
            var m = document.querySelector('#txpd-cli-body .txpd-cli-more');
            if (m && m.style.display !== 'none' && !m.disabled) m.click();
          }
        });
        // 应用的全局 wheel 处理会对非官方列表 preventDefault（它自己的虚拟列表自己滚），
        // 因此这里在 window 捕获层自己滚动（捕获先于应用的冒泡处理）
        if (!window.__txpdGatedWheel) {
          window.__txpdGatedWheel = 1;
          window.addEventListener('wheel', function (e) {
            var sc = document.querySelector('#txpd-cli-panel .game-guild-main__waterfalls-scroller');
            if (!sc || !e.target || !sc.contains(e.target)) return;
            e.preventDefault();
            sc.scrollTop += (e.deltaY || 0);
          }, { passive: false, capture: true });
        }
        // 触摸滑动（同样可能被应用拦掉默认行为）
        var _touchY = null;
        scroller.addEventListener('touchstart', function (e) { _touchY = e.touches[0] ? e.touches[0].clientY : null; }, { passive: true });
        scroller.addEventListener('touchmove', function (e) {
          var y = e.touches[0] ? e.touches[0].clientY : null;
          if (y != null && _touchY != null) scroller.scrollTop += (_touchY - y);
          _touchY = y;
          if (e.cancelable) e.preventDefault();
        }, { passive: false });
        scroller.addEventListener('touchend', function () { _touchY = null; }, { passive: true });
        left.appendChild(scroller);
        panel.appendChild(left);
        // 右栏：公告 / 直播（官方空态占位，与没有公告的正常频道一模一样）
        var right = el('div', { 'class': 'game-guild-main__content__right custom-scrollbar' });
        right.setAttribute('data-v-7cca9fe6', '');
        right.innerHTML = '<div class="game-guild-main__top-feed" data-v-43d35d11="" data-v-7cca9fe6="">'
          + '<h3 class="game-guild-main__top-feed__title" data-v-43d35d11="">公告</h3>'
          + '<div class="game-guild-main__top-feed-empty" data-v-43d35d11=""><span data-v-43d35d11="">暂无公告</span></div></div>'
          + '<div class="game-guild-main__top-live" data-v-294648c4="" data-v-7cca9fe6="">'
          + '<h3 class="game-guild-main__top-live__title" data-v-294648c4="">直播</h3>'
          + '<div class="game-guild-main__top-live-empty" data-v-294648c4=""><span data-v-294648c4="">暂无直播</span></div></div>';
        panel.appendChild(right);
        panel._body = box;
        panel._tabs = bar;
      } else {
        panel.className = 'txpd-cli-panel';
        var box2 = el('div', { id: 'txpd-cli-body' });
        panel.appendChild(box2);
        panel._body = box2;
      }
    }
    var gate = gatedGateEl();
    var host = (gate && (gate.closest('.game-guild-main') || gate.parentNode)) || document.querySelector('.app-page') || document.body;
    if (panel.parentNode !== host) host.appendChild(panel);
    // 若外层已是滚动状态（切换路由回来），保持折叠态
    var sc = panel.querySelector('.game-guild-main__waterfalls-scroller');
    if (sc) gatedHeadSetCollapsed(sc.scrollTop > 0);
    return panel._body;
  }
  // 帖子列表（频道页）
  function renderCliFeedList(body, guildId) {
    body.setAttribute('data-guild', guildId);
    body.innerHTML = '';
    var grid = el('div', { 'class': 'txpd-cli-grid' });
    body.appendChild(grid);
    var more = el('button', { 'class': 'txpd-cli-more', type: 'button' }, '加载更多');
    more.style.display = 'none';
    body.appendChild(more);
    var gnum = currentGuildNumber() || '';
    var cursor = null;
    var loadingEl = null;
    function load() {
      more.disabled = true;
      more.textContent = cursor ? '加载中…' : '正在加载…';
      if (!cursor && !grid.children.length) {
        loadingEl = el('div', { 'class': 'txpd-cli-loading' }, '正在从 CLI 获取帖子，请稍后…');
        body.insertBefore(loadingEl, grid);
      }
      var params = { guild_id: guildId, count: 20 };
      if (cursor) params.feed_attach_info = cursor;
      var action = 'feeds';
      if (_gatedTab) {                       // 选中版块 → 用该版块的时间线
        action = 'feed-timeline';
        params.channel_id = _gatedTab;
      }
      api('/cli', { method: 'POST', body: { action: action, params: params } }).then(function (r) {
        var d = (r.data && r.data.data) || {};
        if (!r.success) throw new Error(r.message || '加载失败');
        (d.feeds || []).forEach(function (f) {
          grid.appendChild(buildCliCard(f, gnum, guildId));
        });
        if (!grid.children.length) grid.appendChild(el('div', { 'class': 'txpd-cli-empty' }, '这个频道暂时没有可见帖子'));
        cursor = d.feed_attach_info || null;
        var hasMore = d.has_more === true || d.has_more === 'True';
        if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
        more.style.display = (cursor && hasMore) ? 'block' : 'none';
        more.disabled = false;
        more.textContent = '加载更多';
      }).catch(function (e) {
        if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
        more.style.display = 'block';
        more.disabled = false;
        more.textContent = '加载失败，点击重试（' + String((e && e.message) || e).slice(0, 30) + '）';
      });
    }
    more.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); load(); });
    load();
  }
  // 评论区一行
  // 官方评论区条目结构（class/data-v 与官方一致，样式全部来自官方 CSS）
  function cliCommentRow(c, ctx, feed, onChanged) {
    var nick = c.author || c.nickname || '用户';
    var cid = c.comment_id || '';
    var row = el('div', { 'class': 'comment-list-item', id: cid });
    row.setAttribute('data-v-76bde4c4', '');
    row.setAttribute('data-v-2cbccead', '');
    row.setAttribute('data-txpd-cli-comment', '1');
    row.innerHTML = '<div data-v-76bde4c4="" class="comment-list-item__info">'
      + '<div data-v-76bde4c4="" class="comment-list-item__info__title"><div data-v-76bde4c4="" class="comment-list-item__info__base"><span class="txpd-av-slot"></span></div></div>'
      + '<div data-v-76bde4c4="" class="comment-list-item__info-content"><div data-v-76bde4c4="" class="comment-list-item__info__base">'
      + '<div data-v-76bde4c4="" class="comment-list-item__info__title-name hover-underline"></div>'
      + '<div data-v-76bde4c4="" class="comment-list-item__info__title-time"><span data-v-76bde4c4="" class="comment-list-item__info__title-time-circle"></span></div></div>'
      + '<div data-v-966f655c="" class="comment-richcontent"><span data-v-966f655c="" class="comment-richcontent__item"><span class="feed-detail-text"></span></span></div>'
      + '<div data-v-76bde4c4="" class="comment-list-item__info__operation">'
      + '<div data-v-76bde4c4="" class="comment-list-item__like"><!---->' + TXPD_SVG.like16 + '<div data-v-76bde4c4="" class="comment-list-item__like-count"></div></div>'
      + '<div data-v-76bde4c4="" class="comment-list-item__rely"><!---->' + TXPD_SVG.reply16 + '<div data-v-76bde4c4="" class="comment-list-item__rely-count">回复</div></div>'
      + '</div></div></div>';
    row.querySelector('.txpd-av-slot').appendChild(avatarBox(30, 'comment-list-item__avatar', nick));
    row.querySelector('.comment-list-item__info__title-name').textContent = nick;
    row.querySelector('.comment-list-item__info__title-time').appendChild(document.createTextNode(' ' + cliTime(c.create_time)));
    row.querySelector('.feed-detail-text').textContent = c.content_text || (c.content && c.content.text) || '';
    var liked0 = !!likedCommentsSet()[cid];
    var likeEl = row.querySelector('.comment-list-item__like');
    var likeCountEl = row.querySelector('.comment-list-item__like-count');
    if (liked0) likeEl.classList.add('txpd-cli-liked');
    likeCountEl.setAttribute('data-txpd-like-text', '1');
    likeCountEl.textContent = liked0 ? '已赞' : '点赞';
    likeEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var liked = !!likedCommentsSet()[cid];
      toast(liked ? '取消点赞中…' : '点赞中…');
      api('/cli', { method: 'POST', body: { action: 'like-comment', params: {
        feed_id: ctx.feedId, comment_id: cid, feed_author_id: feed.author_id || '',
        feed_create_time: ctx.feedCreateTime, comment_author_id: c.author_id || '',
        comment_create_time: String(c.create_time_raw || c.create_time), like_type: liked ? '4' : '3',
        guild_id: ctx.guildId, channel_id: ctx.channelId,
      } } }).then(function (r) {
        if (!r.success) throw new Error(r.message || '操作失败');
        var s2 = likedCommentsSet();
        if (liked) delete s2[cid]; else s2[cid] = 1;
        saveLikedComments(s2);
        c.like_count = Math.max(0, Number(c.like_count || 0) + (liked ? -1 : 1));
        likeCountEl.textContent = !liked ? '已赞' : '点赞';
        likeEl.classList.toggle('txpd-cli-liked', !liked);
        toast(liked ? '已取消点赞' : '✓ 已点赞');
      }).catch(function (err) { toast('操作失败：' + String((err && err.message) || err).slice(0, 50)); });
    });
    row.querySelector('.comment-list-item__rely').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var root = row.closest('.txpd-cli-detail');
      var ed = root && root._editor;
      if (ed && ed._setMode) ed._setMode('reply', cid, nick, c);
    });
    return row;
  }

  // 内联编辑器（CLI 详情用；与官方底部输入条同一套视觉）
  function buildCliEditor(ctx, onSent) {
    var bar = el('div', { 'class': 'txpd-editor', style: 'border:none;padding:0;margin:0;flex:1;min-width:0;' });
    var ta = makeRichEditor('说点什么…');
    bar.appendChild(ta);
    var cancel = el('button', { 'class': 'txpd-inline-cancel', type: 'button', title: '取消回复' }, '×');
    cancel.style.display = 'none';
    bar.appendChild(cancel);
    var imgBtn = el('button', { 'class': 'txpd-inline-emoji', type: 'button', title: '图片' });
    imgBtn.appendChild(svgIcon('assets/common.svg#image', 18));
    imgBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      attachCommentImage(ta);
    });
    bar.appendChild(imgBtn);
    var emoji = el('button', { 'class': 'txpd-inline-emoji', type: 'button', title: '表情' });
    emoji.appendChild(svgIcon('assets/common.svg#emoji', 18));
    emoji.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openEmojiPicker(emoji, function (item) { richInsertEmoji(ta, item); });
    });
    bar.appendChild(emoji);
    var send = el('button', { 'class': 'txpd-inline-send', type: 'button' }, '发送');
    send.disabled = true;
    bar.appendChild(send);
    var mode = 'comment', cid = '', cobj = null;
    function grow() { /* contenteditable 自适应高度 */ }
    function setMode(m, id, nick, c) {
      mode = m || 'comment';
      cid = id || '';
      cobj = c || null;
      cancel.style.display = (mode === 'reply') ? 'inline-flex' : 'none';
      ta.setAttribute('data-ph', mode === 'reply' ? ('回复 ' + (nick || '') + '…') : '说点什么…');
      try { ta.focus(); } catch (e) { }
    }
    bar._setMode = setMode;
    ta.addEventListener('input', function () { richNormalize(ta); send.disabled = !richText(ta); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!send.disabled) send.click(); }
      else if (e.key === 'Escape') setMode('comment', '', '', null);
    });
    cancel.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); setMode('comment', '', '', null); });
    send.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var content = richValue(ta);
      if (!richText(ta)) return;
      send.disabled = true;
      send.textContent = '发送中…';
      submitComment(mode, cid, content, {
        ctx: ctx,
        imagePath: ta._imgPath || '',
        commentAuthorId: cobj ? cobj.author_id : '',
        commentCreateTime: cobj ? String(cobj.create_time_raw || cobj.create_time) : '',
      }).then(function () {
        ta._imgPath = '';
        var chipOld2 = ta.querySelector('[data-txpd-imgchip]');
        if (chipOld2 && chipOld2.parentNode) chipOld2.parentNode.removeChild(chipOld2);
        richClear(ta);
        send.textContent = '发送';
        send.disabled = true;
        grow();
        toast(mode === 'reply' ? '✓ 回复已发表（CLI 账号身份）' : '✓ 评论已发表（CLI 账号身份）');
        setMode('comment', '', '', null);
        if (onSent) onSent();
      }).catch(function (err) {
        send.textContent = '发送';
        send.disabled = !richText(ta);
        toast('发送失败：' + String((err && err.message) || err).slice(0, 60));
      });
    });
    return { bar: bar, setMode: setMode, _setMode: setMode };
  }
  // 帖子详情（帖子页 / 浮层）
  function renderCliFeedDetail(body, feedId, guildId, channelId) {
    body.innerHTML = '';
    var wrap = el('div', { 'class': 'txpd-cli-detail' });
    body.appendChild(wrap);
    wrap.appendChild(el('div', { 'class': 'txpd-cli-empty' }, '正在通过插件账号加载帖子…'));
    api('/cli', { method: 'POST', body: { action: 'feed-detail', params: { feed_id: feedId, guild_id: guildId || '', channel_id: channelId || '' } } }).then(function (r) {
      var feed = (r.data && r.data.data && r.data.data.feed) || {};
      if (!r.success || !(feed.create_time_raw || feed.create_time)) throw new Error(r.message || '加载失败');
      var ctx = {
        feedId: feedId,
        guildId: feed.guild_id || guildId || '',
        channelId: feed.channel_id || channelId || '',
        feedAuthorId: feed.author_id || '',
        feedCreateTime: String(feed.create_time_raw || feed.create_time),
      };
      wrap.innerHTML = '';
      // ── 官方详情结构：左图右文 + 官方评论区 + 官方底部条（样式全部来自官方 CSS）──────
      var detail = el('div', { 'class': 'game-guild-detail short-feed-detail' });
      detail.setAttribute('data-v-5663de1f', '');
      // 官方两栏布局（左图 / 右栏评论）由 .game-guild-detail .game-guild-detail-container .feed-container-wrapper 提供
      var dcont = el('div', { 'class': 'game-guild-detail-container' });
      dcont.setAttribute('data-v-5663de1f', '');
      var fwrap = el('div', { 'class': 'feed-container-wrapper short-feed-container-wrapper' });
      fwrap.setAttribute('data-v-5663de1f', '');
      var left = el('div', { 'class': 'feed-container__left' });
      left.setAttribute('data-v-5663de1f', '');
      var imgs = cliImageUrls(feed.images);
      if (imgs.length) left.appendChild(buildCliImages(imgs));
      fwrap.appendChild(left);
      var right = el('div', { 'class': 'feed-container__right' });
      right.setAttribute('data-v-5663de1f', '');
      var poster = el('div', { 'class': 'game-guild-detail-poster-userInfo' });
      poster.setAttribute('data-v-2f1a7bfb', '');
      poster.setAttribute('data-v-5663de1f', '');
      poster.innerHTML = '<div data-v-2f1a7bfb="" class="user-info"><span data-v-69f3dba3=""><div data-v-2f1a7bfb="" class="user-info__base"><span class="txpd-av-slot"></span>'
        + '<div data-v-2f1a7bfb="" class="user-info__name-text hover-underline"></div></div></span><div data-v-2f1a7bfb="" class="user-info__detail"><!----></div></div>';
      var author = feed.author || '匿名';
      poster.querySelector('.txpd-av-slot').appendChild(avatarBox(30, 'user-info__avatar', author));
      poster.querySelector('.user-info__name-text').textContent = author;
      right.appendChild(poster);
      var fcontent = el('div', { 'class': 'feed-content', style: 'height:100%;' });
      fcontent.setAttribute('data-v-5663de1f', '');
      var title = feed.title || '';
      var bodyText = feed.content || '';
      if (title || (bodyText && bodyText !== title)) {
        var tb = el('div', { 'class': 'short-textcontent-container-right' });
        tb.setAttribute('data-v-df986c55', '');
        var inner = el('div');
        inner.setAttribute('data-v-df986c55', '');
        if (title) inner.appendChild(el('span', { 'class': 'feed-detail-text', style: 'font-weight:600;' }, title));
        if (bodyText && bodyText !== title) {
          if (title) inner.appendChild(el('br'));
          inner.appendChild(el('span', { 'class': 'feed-detail-text', style: 'white-space:pre-wrap;' }, bodyText));
        }
        tb.appendChild(inner);
        fcontent.appendChild(tb);
      }
      var infoBox = el('div', { 'class': 'game-guild-detail-feed-detail' });
      infoBox.setAttribute('data-v-06831fbd', '');
      infoBox.setAttribute('data-v-5663de1f', '');
      infoBox.innerHTML = '<div data-v-06831fbd="" class="feed-info"><div data-v-06831fbd="" class="feed-info__detail">'
        + '<div data-v-06831fbd="" class="feed-info__detail__time"></div><div data-v-06831fbd="" class="feed-info__detail__divider"></div>'
        + '<div data-v-06831fbd="" class="feed-info__detail__read-count"></div></div><!----></div>';
      infoBox.querySelector('.feed-info__detail__time').textContent = feed.create_time || '';
      infoBox.querySelector('.feed-info__detail__read-count').textContent = feed.channel_name ? ('版块：' + feed.channel_name) : '';
      fcontent.appendChild(infoBox);
      var cmtBox = el('div', { 'class': 'comment-container' });
      cmtBox.setAttribute('data-v-2cbccead', '');
      cmtBox.setAttribute('data-v-5663de1f', '');
      var cbar = el('div', { 'class': 'comment-bar' });
      cbar.setAttribute('data-v-2cbccead', '');
      cbar.innerHTML = '<div data-v-2cbccead="" class="comment-bar__comment-count">评论' + (feed.comment_count || 0) + '</div>'
        + '<div data-v-2cbccead="" class="comment-split"></div>'
        + '<div data-v-2cbccead="" class="comment-bar__comment-filter pointer"><span data-v-2cbccead="">热门</span>' + TXPD_SVG.sort16 + '</div>';
      cmtBox.appendChild(cbar);
      var clist = el('div', { 'class': 'comment-list' });
      clist.setAttribute('data-v-2cbccead', '');
      cmtBox.appendChild(clist);
      fcontent.appendChild(cmtBox);
      right.appendChild(fcontent);
      // 官方底部条：输入区（官方 .bottom-input 外观）+ 官方右键区（赞/评论/分享）
      var bar = el('div', { 'class': 'bottom-comment-input' });
      bar.setAttribute('data-v-26913313', '');
      bar.setAttribute('data-v-5663de1f', '');
      var inputBox = el('div', { 'class': 'bottom-input', 'data-txpd-editor': '1' });
      inputBox.setAttribute('data-v-26913313', '');
      bar.appendChild(inputBox);
      var right2 = el('div', { 'class': 'bottom-right' });
      right2.setAttribute('data-v-26913313', '');
      right2.innerHTML = '<div data-v-26913313="" class="like-container data-ready"><div data-v-26913313="" class="like-icon">' + TXPD_SVG.barLike24 + '</div>'
        + '<div data-v-26913313="" class="like-text"></div></div>'
        + '<div data-v-26913313="" class="comment-container data-ready"><div data-v-26913313="" class="comment-icon">' + TXPD_SVG.barCmt24 + '</div>'
        + '<div data-v-26913313="" class="comment-text">' + (feed.comment_count || 0) + '</div></div>'
        + '<div data-v-26913313="" class="share-container data-ready"><div data-v-26913313="" class="share-icon">' + TXPD_SVG.barShare24 + '</div>'
        + '<div data-v-26913313="" class="share-text">分享</div></div>';
      bar.appendChild(right2);
      right.appendChild(bar);
      fwrap.appendChild(right);
      dcont.appendChild(fwrap);
      detail.appendChild(dcont);
      wrap.appendChild(detail);
      // 图片区为空时不留空白列
      if (!imgs.length) left.style.display = 'none';
      var likeCount = Number(feed.prefer_count || 0);
      var liked0 = !!likedSet()[feedId];
      var likeEl = right2.querySelector('.like-container');
      var likeTextEl = right2.querySelector('.like-text');
      if (liked0) likeEl.classList.add('txpd-cli-liked');
      likeTextEl.textContent = likeCount;
      likeEl.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var liked = !!likedSet()[feedId];
        toast(liked ? '取消点赞中…' : '点赞中…');
        api('/cli', { method: 'POST', body: { action: 'like-feed', params: { feed_id: feedId, guild_id: ctx.guildId, channel_id: ctx.channelId, action: liked ? '3' : '1' } } }).then(function (rr) {
          if (!rr.success) throw new Error(rr.message || '操作失败');
          var s2 = likedSet();
          if (liked) delete s2[feedId]; else s2[feedId] = 1;
          saveLikedSet(s2);
          likeCount = Math.max(0, likeCount + (liked ? -1 : 1));
          likeTextEl.textContent = likeCount;
          likeEl.classList.toggle('txpd-cli-liked', !liked);
          toast(liked ? '已取消点赞' : '✓ 已点赞');
        }).catch(function (err) { toast('操作失败：' + String((err && err.message) || err).slice(0, 50)); });
      });
      // 分享 → 复制链接（CLI feed-detail 自带 share_url）
      right2.querySelector('.share-container').addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (!feed.share_url) { toast('该帖子没有分享链接'); return; }
        try { navigator.clipboard.writeText(feed.share_url); toast('✓ 链接已复制'); } catch (e2) { toast('复制失败'); }
      });
      var editor = buildCliEditor(ctx, function () { loadComments(); });
      inputBox.appendChild(editor.bar);
      wrap._editor = editor;
      function loadComments() {
        clist.innerHTML = '';
        clist.appendChild(el('div', { 'class': 'txpd-cli-empty' }, '评论加载中…'));
        api('/cli', { method: 'POST', body: { action: 'comments', params: { feed_id: feedId, guild_id: ctx.guildId, channel_id: ctx.channelId, count: '20' } } }).then(function (rc) {
          var list = (rc.data && rc.data.data && rc.data.data.comments) || [];
          clist.innerHTML = '';
          if (!rc.success) { clist.appendChild(el('div', { 'class': 'txpd-cli-empty' }, '评论加载失败：' + String(rc.message || '').slice(0, 60))); return; }
          if (!list.length) { clist.appendChild(el('div', { 'class': 'txpd-cli-empty' }, '还没有评论')); return; }
          list.forEach(function (c) { clist.appendChild(cliCommentRow(c, ctx, feed, loadComments)); });
        }).catch(function () {
          clist.innerHTML = '';
          clist.appendChild(el('div', { 'class': 'txpd-cli-empty' }, '评论加载失败'));
        });
      }
      loadComments();
    }).catch(function (e) {
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { 'class': 'txpd-cli-empty' }, '加载失败：' + String((e && e.message) || e).slice(0, 120)));
    });
  }
  // 官方频道头卡片（.title-bar-container.full.default-bg-color > .guild-web-main-title-bar > .guild-info）
  // 与频道主页同款结构/作用域属性 → 样式全部来自官方 CSS；拿不到的字段不渲染
  // 折叠/展开：与公开频道一致（滚动 > 0 → simple 30px；回顶 → full 100px）
  function gatedHeadSetCollapsed(collapsed) {
    var cont = document.getElementById('txpd-guild-head');
    if (!cont || !cont._full || !cont._simple) return;
    var box = document.querySelector('.txpd-op-btns');
    if (collapsed) {
      cont.className = 'title-bar-container simple';
      cont._full.style.display = 'none';
      cont._simple.style.display = 'flex';
      var op = cont._simple.querySelector('.guild-operation');
      if (box && op && box.parentNode !== op) op.appendChild(box);
    } else {
      cont.className = 'title-bar-container full default-bg-color';
      cont._simple.style.display = 'none';
      cont._full.style.display = '';
      var op2 = cont._full.querySelector('.guild-info__operation');
      if (box && op2 && box.parentNode !== op2) op2.appendChild(box);
    }
  }
  function gatedHeadEl(info) {
    var cont = el('div', { 'class': 'title-bar-container full default-bg-color' });
    cont.setAttribute('data-v-5aaa2b70', '');
    // 折叠态（官方 .simple 结构，先隐藏；折叠时把操作按钮挪进 .guild-operation）
    var simple = el('header', { 'class': 'guild-web-main-title-bar guild-web-main-title-bar-simple' });
    simple.setAttribute('data-v-5aaa2b70', '');
    simple.style.display = 'none';
    var sInfo = el('div', { 'class': 'guild-info' });
    sInfo.setAttribute('data-v-5aaa2b70', '');
    if (info.icon) {
      var sIcon = el('div', { 'class': 'guild-info__icon', style: 'background-image:url(' + info.icon + ');' });
      sIcon.setAttribute('data-v-5aaa2b70', '');
      sInfo.appendChild(sIcon);
    }
    var sName = el('h1', { 'class': 'guild-info__basic__name top_title_name' }, info.name || '');
    sName.setAttribute('data-v-5aaa2b70', '');
    sInfo.appendChild(sName);
    simple.appendChild(sInfo);
    var sOp = el('div', { 'class': 'guild-operation' });
    sOp.setAttribute('data-v-5aaa2b70', '');
    simple.appendChild(sOp);
    cont.appendChild(simple);
    cont._simple = simple;
    var head = el('header', { 'class': 'guild-web-main-title-bar guild-web-main-title-bar-full' });
    head.setAttribute('data-v-5aaa2b70', '');
    var infoEl = el('div', { 'class': 'guild-info' });
    infoEl.setAttribute('data-v-5aaa2b70', '');
    if (info.icon) {
      var ic = el('div', { 'class': 'guild-info__icon', style: 'background-image:url(' + info.icon + ');' });
      ic.setAttribute('data-v-5aaa2b70', '');
      infoEl.appendChild(ic);
    }
    var basic = el('div', { 'class': 'guild-info__basic' });
    basic.setAttribute('data-v-5aaa2b70', '');
    var top = el('div', { 'class': 'guild-info__basic__top top_title' });
    top.setAttribute('data-v-5aaa2b70', '');
    top.appendChild(el('h1', { 'class': 'guild-info__basic__name top_title_name black' }, info.name || ''));
    basic.appendChild(top);
    if (info.count) {
      var h4 = el('h4', { 'class': 'guild-info__basic__statistics black' });
      h4.setAttribute('data-v-5aaa2b70', '');
      h4.appendChild(svgIcon('assets/common.svg#user', 12));
      h4.appendChild(el('span', null, String(info.count)));
      h4.appendChild(el('span', { style: 'font-weight:400' }, '成员'));
      basic.appendChild(h4);
    }
    infoEl.appendChild(basic);
    var op = el('div', { 'class': 'guild-info__operation' });
    op.setAttribute('data-v-5aaa2b70', '');
    infoEl.appendChild(op);
    head.appendChild(infoEl);
    cont.appendChild(head);
    cont._full = head;
    return cont;
  }
  var _gatedInfoAsked = {};
  function gatedHeadEnsure(gate, gid, num) {
    var host = gate.closest('.game-guild-main') || gate.parentNode;
    if (!host) return;
    var info = { icon: '', name: '', count: '' };
    // 先从官方提示卡里取（这是该频道真实数据，随后这张卡会被隐藏）
    var faceEl = gate.querySelector('.game-guild-main__not-permit__face');
    if (faceEl) {
      var mm = /url\(["']?([^"')]+)/.exec(faceEl.style.backgroundImage || '');
      if (mm) info.icon = mm[1];
    }
    var nameEl = gate.querySelector('.game-guild-main__not-permit__name');
    if (nameEl) info.name = (nameEl.textContent || '').replace(/频道$/, '').trim();
    var cntEl = gate.querySelector('.game-guild-main__not-permit__tag_count .count-text') || gate.querySelector('.count-text');
    if (cntEl) info.count = (cntEl.textContent || '').trim();
    var cur = currentGuild();
    if (!info.name && cur.g && cur.g.name) info.name = cur.g.name;
    if (!info.name) info.name = num || '';
    if (!info.count && cur.g && cur.g.member_count) info.count = String(cur.g.member_count);
    if (!info.icon) info.icon = _dyn.icons[gid] || dynIconCache()[gid] || '';
    var exist = document.getElementById('txpd-guild-head');
    if (!exist) {
      var node = gatedHeadEl(info);
      node.id = 'txpd-guild-head';
      host.insertBefore(node, host.firstChild);
      exist = node;
    }
    // 仍缺图标/成员数 → 用 CLI 频道信息补齐（每个频道只问一次）
    if ((!info.icon || !info.count) && !_gatedInfoAsked[gid]) {
      _gatedInfoAsked[gid] = 1;
      api('/cli', { method: 'POST', body: { action: 'guild-info', params: { guild_id: gid } } }).then(function (r) {
        var d = (r.data && r.data.data) || {};
        var h = document.getElementById('txpd-guild-head');
        if (!h) return;
        if (d.avatar_url) {
          _dyn.icons[gid] = d.avatar_url;
          var store = dynIconCache();
          store[gid] = d.avatar_url;
          dynIconSave(store);
          var ic = h.querySelector('.guild-info__icon');
          if (!ic) {
            ic = el('div', { 'class': 'guild-info__icon' });
            ic.setAttribute('data-v-5aaa2b70', '');
            var basicEl = h.querySelector('.guild-info__basic');
            if (basicEl && basicEl.parentNode) basicEl.parentNode.insertBefore(ic, basicEl);
          }
          if (ic) ic.style.backgroundImage = 'url(' + d.avatar_url + ')';
        }
        if (d.member_count) {
          var basic2 = h.querySelector('.guild-info__basic');
          if (basic2 && !basic2.querySelector('.guild-info__basic__statistics')) {
            var h4b = el('h4', { 'class': 'guild-info__basic__statistics black' });
            h4b.setAttribute('data-v-5aaa2b70', '');
            h4b.appendChild(svgIcon('assets/common.svg#user', 12));
            h4b.appendChild(el('span', null, String(d.member_count)));
            h4b.appendChild(el('span', { style: 'font-weight:400' }, '成员'));
            var metaEl = basic2.querySelector('.txpd-guild-meta');
            if (metaEl) basic2.insertBefore(h4b, metaEl); else basic2.appendChild(h4b);
          }
        }
      }).catch(function () { });
    }
  }
  // 入口：检测到官方「未对访客开放」卡片就地补内容
  // 版块页签：拿到频道 id 后渲染一次（独立于内容渲染，避免 data-key 早退跳过）
  function gatedTabsEnsure() {
    var panel = document.getElementById('txpd-cli-panel');
    var body = document.getElementById('txpd-cli-body');
    if (!panel || !panel._tabs || !body) return;
    var gid = body.getAttribute('data-guild') || '';
    if (gid && _gatedTabsKey !== gid) {
      _gatedTabsKey = gid;
      gatedBuildTabBar(panel._tabs, gid);
    }
  }
  function ensureGatedFallback() {
    var gate = gatedGateEl();
    if (!gate) {
      // 离开受限频道（或官方正常渲染）→ 移除兜底面板，避免残留
      var stale = document.getElementById('txpd-cli-panel');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      return;
    }
    var num = currentGuildNumber();
    if (!num) return;
    var m = /\/post\/([^\/?#]+)/.exec(window.location.pathname);
    var key = (m ? 'd:' + m[1] : 'l:') + num;
    var body = document.getElementById('txpd-cli-body');
    if (body && body.getAttribute('data-key') === key && body.parentNode) { gatedTabsEnsure(); return; }
    // 访客态不显示官方提示卡（用户要求），改用官方频道头卡片 + 内容
    gate.style.display = 'none';
    resolveGuildIdByNumber(num, function (gid) {
      if (!gid) return;
      gatedHeadEnsure(gate, gid, num);
      var box = gatedPanelBody(!m, gid);   // 主页用完整骨架（页签立即渲染）；帖子页只放详情
      box.setAttribute('data-key', key);
      if (m) renderCliFeedDetail(box, decodeURIComponent(m[1]), gid, '');
      else renderCliFeedList(box, gid);
    });
  }

  // ---------- 动态页（复刻官方 /index 布局，数据走 CLI 聚合） ----------
  var _dyn = { tab: 'hot', feeds: [], seen: {}, gidx: 0, loading: false, done: false, started: false, icons: {} };
  function dynIconKey() { return 'txpd_guild_icons_v1_' + (TXPD_USER || 'default'); }
  function dynIconCache() {
    try { return JSON.parse(window.localStorage.getItem(dynIconKey()) || '{}') || {}; } catch (e) { return {}; }
  }
  function dynIconSave(m) {
    try { window.localStorage.setItem(dynIconKey(), JSON.stringify(m)); } catch (e) { /* 忽略 */ }
  }
  // 官方动态条目的时间格式（刚刚 / N分钟前 / N小时前 / 昨天 / M-D）
  function dynRelTime(raw) {
    var t = Number(raw || 0);
    if (!t) return '';
    var diff = Math.floor(Date.now() / 1000) - t;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 172800) return '昨天';
    var d = new Date(t * 1000);
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p2(d.getDate());
  }
  function dynSet(elm, cls) { elm.setAttribute('data-v-b1adbc97', ''); if (cls) elm.className = cls; return elm; }
  function dynItemEl(f) {
    var a = el('a', { 'class': 'feed-list-item', href: PANEL_BASE + 'g/' + encodeURIComponent(f.guild_number || '') + '/post/' + encodeURIComponent(f.feed_id) });
    dynSet(a, 'feed-list-item');
    a.innerHTML = ''
      + '<div class="header-area" data-v-b1adbc97=""><div class="guild-icon" data-v-b1adbc97=""><img class="guild-icon-image" data-v-b1adbc97="" alt="" referrerpolicy="no-referrer"></div>'
      + '<div class="guild-name hover-underline" data-v-b1adbc97=""></div><div class="create-time" data-v-b1adbc97=""></div></div>'
      + '<div class="title-area" data-v-b1adbc97=""><div class="feed-title" data-v-b1adbc97=""></div></div>'
      + '<div class="main-area" data-v-b1adbc97=""><div class="rich-text" data-v-b1adbc97=""><span class="text" data-v-b1adbc97=""></span></div></div>'
      + '<div class="image-area" data-v-b1adbc97=""></div>'
      + '<div class="operation-area" data-v-b1adbc97="">'
      + '<div class="operation-item" data-v-b1adbc97="">' + TXPD_SVG.like22 + '<div class="cnt" data-v-b1adbc97=""></div></div>'
      + '<div class="operation-item" data-v-b1adbc97="">' + TXPD_SVG.cmt22 + '<div class="cnt" data-v-b1adbc97=""></div></div>'
      + '<div class="operation-item" data-v-b1adbc97="">' + TXPD_SVG.share22 + '<div class="cnt" data-v-b1adbc97=""></div></div>'
      + '</div>';
    var gname = f.guild_display || f.guild_name || f.guild_number || '';
    a.querySelector('.guild-name').textContent = gname;
    a.querySelector('.create-time').textContent = dynRelTime(f.create_time_raw);
    var icon = a.querySelector('.guild-icon-image');
    icon.setAttribute('data-gid', f.guild_id || '');
    if (_dyn.icons[f.guild_id]) icon.setAttribute('src', _dyn.icons[f.guild_id]);
    var title = f.title || '';
    var snippet = f.content_snippet || '';
    if (title) a.querySelector('.feed-title').textContent = title;
    else a.querySelector('.title-area').style.display = 'none';
    if (snippet && snippet !== title) a.querySelector('.rich-text .text').textContent = snippet;
    else if (!title) a.querySelector('.rich-text .text').textContent = snippet;
    else a.querySelector('.main-area').style.display = 'none';
    // 图片：官方 .image-area（单图 single-image，多图 .image-item 网格 + 数量角标）
    var imgs = cliImageUrls(f.images);
    var area = a.querySelector('.image-area');
    if (imgs.length === 1) {
      var it1 = el('div', { 'class': 'image-item single-image landscape' });
      dynSet(it1, 'image-item single-image landscape');
      var in1 = el('div', { 'class': 'image-item-inner' }); dynSet(in1, 'image-item-inner');
      var im1 = el('img', { src: imgs[0], referrerpolicy: 'no-referrer' }); dynSet(im1, '');
      im1.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openLightbox(imgs[0]); });
      in1.appendChild(im1); it1.appendChild(in1); area.appendChild(it1);
    } else if (imgs.length > 1) {
      var shown = Math.min(imgs.length, 3);
      for (var i = 0; i < shown; i++) {
        var it = el('div', { 'class': 'image-item' + (shown === 2 ? ' stretch' : '') });
        dynSet(it, 'image-item' + (shown === 2 ? ' stretch' : ''));
        var inn = el('div', { 'class': 'image-item-inner' }); dynSet(inn, 'image-item-inner');
        var im = el('img', { src: imgs[i], referrerpolicy: 'no-referrer', style: 'width:100%;height:100%;object-fit:cover;' }); dynSet(im, '');
        (function (u) { im.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openLightbox(u); }); })(imgs[i]);
        inn.appendChild(im);
        if (i === shown - 1 && imgs.length > shown) {
          inn.appendChild(el('div', { 'class': 'image-num', 'data-v-b1adbc97': '' }, imgs.length + '图'));
        }
        it.appendChild(inn); area.appendChild(it);
      }
    } else {
      area.style.display = 'none';
    }
    // 操作区：赞（CLI 切换 + 持久化）/ 评论数 / 分享（复制链接）
    var ops = a.querySelectorAll('.operation-item');
    var likeEl = ops[0], cmtEl = ops[1], shareEl = ops[2];
    // 标记：动态条目的操作项由元素级处理器接管（避免被帖子链接的浮层接管吞掉）
    likeEl.setAttribute('data-txpd-dyn-act', 'like');
    cmtEl.setAttribute('data-txpd-dyn-act', 'comment');
    shareEl.setAttribute('data-txpd-dyn-act', 'share');
    var liked0 = !!likedSet()[f.feed_id];
    if (liked0) likeEl.classList.add('txpd-dyn-liked');
    likeEl.querySelector('.cnt').textContent = String(f.prefer_count || 0);
    cmtEl.querySelector('.cnt').textContent = String(f.comment_count || 0);
    shareEl.querySelector('.cnt').textContent = '';
    likeEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var liked = !!likedSet()[f.feed_id];
      toast(liked ? '取消点赞中…' : '点赞中…');
      api('/cli', { method: 'POST', body: { action: 'like-feed', params: { feed_id: f.feed_id, guild_id: f.guild_id || '', channel_id: f.channel_id || '', action: liked ? '3' : '1' } } }).then(function (r) {
        if (!r.success) throw new Error(r.message || '操作失败');
        var s2 = likedSet();
        if (liked) delete s2[f.feed_id]; else s2[f.feed_id] = 1;
        saveLikedSet(s2);
        f.prefer_count = Math.max(0, Number(f.prefer_count || 0) + (liked ? -1 : 1));
        likeEl.querySelector('.cnt').textContent = String(f.prefer_count);
        likeEl.classList.toggle('txpd-dyn-liked', !liked);
        toast(liked ? '已取消点赞' : '✓ 已点赞');
      }).catch(function (err) { toast('操作失败：' + String((err && err.message) || err).slice(0, 50)); });
    });
    shareEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var u = 'https://pd.qq.com/g/' + (f.guild_number || '') + '/post/' + f.feed_id;
      try { navigator.clipboard.writeText(u); toast('✓ 链接已复制'); } catch (e2) { toast('复制失败'); }
    });
    return a;
  }
  function dynSorted() {
    var arr = _dyn.feeds.slice();
    if (_dyn.tab === 'hot') {
      arr.sort(function (a, b) { return (Number(b.prefer_count || 0) + Number(b.comment_count || 0) * 2) - (Number(a.prefer_count || 0) + Number(a.comment_count || 0) * 2); });
    } else {
      arr.sort(function (a, b) { return Number(b.create_time_raw || 0) - Number(a.create_time_raw || 0); });
    }
    return arr;
  }
  function dynRender() {
    var content = document.querySelector('.txpd-dynamic .feed-list-content');
    if (!content) return;
    content.innerHTML = '';
    var list = dynSorted();
    if (!list.length) {
      var empty = el('div', { 'class': 'feed-list-content-empty', 'data-v-0c4f7dca': '' });
      empty.appendChild(el('div', { 'class': 'feed-list-content-empty-tip', 'data-v-0c4f7dca': '' }, _dyn.loading ? '正在加载动态…' : '暂无新动态'));
      if (!_dyn.loading) {
        var btn = el('div', { 'class': 'feed-list-content-empty-button', 'data-v-0c4f7dca': '' }, '去看看');
        btn.addEventListener('click', function () { spaNavigate('explore'); });
        empty.appendChild(btn);
      }
      content.appendChild(empty);
      return;
    }
    list.forEach(function (f) { content.appendChild(dynItemEl(f)); });
    if (_dyn.loading) content.appendChild(el('div', { 'class': 'txpd-dyn-more' }, '加载中…'));
    else if (_dyn.done) content.appendChild(el('div', { 'class': 'txpd-dyn-more' }, '没有更多了'));
  }
  function dynLoadMore() {
    if (_dyn.loading || _dyn.done) return;
    var guilds = (_guildsCache || []).filter(function (g) { return g && g.guild_id && g.guild_number; });
    if (!guilds.length) {
      loadJoinedGuilds().then(function () {
        if ((_guildsCache || []).length) dynLoadMore();
        else { _dyn.done = true; dynRender(); }
      });
      return;
    }
    if (_dyn.gidx >= guilds.length) { _dyn.done = true; dynRender(); return; }
    var batch = guilds.slice(_dyn.gidx, _dyn.gidx + 6);
    _dyn.gidx += batch.length;
    _dyn.loading = true;
    dynRender();
    Promise.all(batch.map(function (g) {
      return api('/cli', { method: 'POST', body: { action: 'feeds', params: { guild_id: g.guild_id, count: 10 } } }).then(function (r) {
        var feeds = (r.data && r.data.data && r.data.data.feeds) || [];
        feeds.forEach(function (f) {
          if (!f || !f.feed_id || _dyn.seen[f.feed_id]) return;
          _dyn.seen[f.feed_id] = 1;
          f.guild_id = g.guild_id;
          f.guild_number = g.guild_number;
          f.guild_display = g.name || f.guild_name || g.guild_number;
          _dyn.feeds.push(f);
        });
      }).catch(function () { /* 单频道失败不影响整体 */ });
    })).then(function () {
      _dyn.loading = false;
      _dyn.icons = dynIconCache();
      batch.forEach(function (g) {
        if (_dyn.icons[g.guild_id]) return;
        api('/cli', { method: 'POST', body: { action: 'guild-info', params: { guild_id: g.guild_id } } }).then(function (r) {
          var d = (r.data && r.data.data) || {};
          if (!d.avatar_url) return;
          _dyn.icons[g.guild_id] = d.avatar_url;
          var store = dynIconCache();
          store[g.guild_id] = d.avatar_url;
          dynIconSave(store);
          var im = document.querySelector('.txpd-dynamic img.guild-icon-image[data-gid="' + g.guild_id + '"]');
          if (im) im.setAttribute('src', d.avatar_url);
        }).catch(function () { });
      });
      dynRender();
    });
  }
  function buildDynamicShell() {
    var page = el('div', { 'class': 'app-page page-index txpd-dynamic' });
    page.setAttribute('data-v-73f9d585', '');
    var cont = el('div', { 'class': 'page-container', 'data-v-73f9d585': '' });
    var list2 = el('div', { 'class': 'feed-list', 'data-v-0c4f7dca': '' });
    var tabs = el('div', { 'class': 'feed-list-tabs', 'data-v-0c4f7dca': '' });
    var mkTab = function (key, label) {
      var d = el('div', { 'class': 'feed-list-tabs-item pointer' + (_dyn.tab === key ? ' active' : ''), 'data-v-0c4f7dca': '' }, label);
      d.addEventListener('click', function () {
        if (_dyn.tab === key) return;
        _dyn.tab = key;
        Array.prototype.forEach.call(tabs.children, function (c) { c.classList.remove('active'); });
        d.classList.add('active');
        dynRender();
      });
      return d;
    };
    tabs.appendChild(mkTab('hot', '热门'));
    tabs.appendChild(mkTab('latest', '最新'));
    var content = el('div', { 'class': 'feed-list-content', 'data-v-0c4f7dca': '' });
    content.addEventListener('scroll', function () {
      if (content.scrollTop + content.clientHeight >= content.scrollHeight - 240) dynLoadMore();
    });
    list2.appendChild(tabs);
    list2.appendChild(content);
    cont.appendChild(list2);
    page.appendChild(cont);
    return page;
  }
  function dynReset() {
    _dyn.tab = 'hot';
    _dyn.feeds = [];
    _dyn.seen = {};
    _dyn.gidx = 0;
    _dyn.loading = false;
    _dyn.done = false;
    _dyn.started = false;
    _dyn.icons = {};
    _dyn.user = TXPD_USER || 'default';
  }
  function ensureDynamicPage() {
    // 账号切换后缓存失效：重置（图标缓存按账号分键，也会随之切换）
    if (_dyn.user !== (TXPD_USER || 'default')) dynReset();
    var tail = window.location.pathname.slice(PANEL_BASE.length);
    var isIndex = tail === 'index' || tail.indexOf('index') === 0;
    var page = document.querySelector('.txpd-dynamic');
    var explore = document.getElementById('explorePage');
    if (!isIndex) {
      if (page && page.parentNode) page.parentNode.removeChild(page);
      if (explore && explore.style.display === 'none') explore.style.display = '';
      return;
    }
    if (explore) explore.style.display = 'none';
    if (!page) {
      var host = (explore && explore.parentNode) || document.querySelector('main') || document.querySelector('.app-main');
      if (!host) return;
      page = buildDynamicShell();
      host.appendChild(page);
      // 回到动态页：先用缓存渲染（秒开），首次再拉数据
      _dyn.icons = dynIconCache();
      dynRender();
    }
    if (!_dyn.started) {
      _dyn.started = true;
      dynLoadMore();
    }
  }

  // ---------- 帖子详情浮层：点卡片就地打开（不再整页跳转） ----------
  function closeEmbedOverlay() {
    var ov = document.getElementById('txpd-embed-overlay');
    if (ov) ov.style.display = 'none';
  }
  function ensureOverlayShell() {
    var ov = document.getElementById('txpd-embed-overlay');
    if (ov) return ov;
    ov = el('div', { id: 'txpd-embed-overlay' });
    var card = el('div', { id: 'txpd-embed-card' });
    var bar = el('div', { id: 'txpd-embed-bar' });
    var tEl = el('span', { id: 'txpd-embed-title' });
    var close = el('button', { id: 'txpd-embed-close', type: 'button', title: '关闭' }, '×');
    var frame = el('iframe', { id: 'txpd-embed-frame', title: '帖子详情' });
    frame.setAttribute('allow', 'clipboard-write');
    var dom = el('div', { id: 'txpd-embed-dom' });
    bar.appendChild(tEl);
    bar.appendChild(close);
    card.appendChild(bar);
    card.appendChild(dom);
    card.appendChild(frame);
    ov.appendChild(card);
    document.body.appendChild(ov);
    close.addEventListener('click', closeEmbedOverlay);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeEmbedOverlay(); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov.style.display === 'flex') closeEmbedOverlay();
    }, true);
    ov._frame = frame; ov._title = tEl; ov._dom = dom;
    return ov;
  }
  function openEmbedOverlay(url, title) {
    var ov = ensureOverlayShell();
    ov._dom.className = '';
    ov._dom.style.display = 'none';
    ov._dom.innerHTML = '';
    ov._frame.style.display = 'block';
    ov._title.textContent = title || '帖子详情';
    ov.style.display = 'flex';
    if (ov._frame.getAttribute('src') !== url) ov._frame.setAttribute('src', url);
    return true;
  }
  // 访客限制频道：官方详情页同样被挡 → 用 CLI 数据在本插件浮层里渲染
  function openCliDetailOverlay(feedId, guildId, title) {
    var ov = ensureOverlayShell();
    ov._frame.style.display = 'none';
    ov._dom.className = 'txpd-dom-detail';
    ov._dom.style.display = 'flex';
    ov._dom.innerHTML = '';
    ov._title.textContent = title || '帖子详情';
    ov.style.display = 'flex';
    renderCliFeedDetail(ov._dom, feedId, guildId, '');
    return true;
  }
  function openPostOverlay(href) {
    var m = /\/g\/([^\/?#]+)\/post\/([^\/?#]+)/.exec(String(href || ''));
    if (!m) return false;
    var subc = (/[?&]subc=([^&]+)/.exec(String(href || '')) || [])[1] || '';
    var url = PANEL_BASE + 'g/' + encodeURIComponent(m[1]) + '/post/' + encodeURIComponent(m[2])
      + '?txpd_embed=1' + (subc ? '&subc=' + subc : '');
    return openEmbedOverlay(url, '帖子详情');
  }

  // ---------- 评论/回复：内联到底部输入条（官方样式），不再弹居中弹窗 ----------
  // opt.ctx 可显式给上下文（CLI 兜底详情不在 /post 路由上）；
  // opt.commentAuthorId / opt.commentCreateTime 已知时可跳过评论列表查询
  function submitComment(mode, commentId, content, opt) {
    var ctx = (opt && opt.ctx) || getFeedContext();
    if (!ctx.feedId) return Promise.reject(new Error('无法识别当前帖子'));
    var prep;
    if (ctx.feedCreateTime) {
      prep = Promise.resolve(ctx);
    } else {
      prep = api('/cli', { method: 'POST', body: { action: 'feed-detail', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId } } }).then(function (r1) {
        var feed = (r1.data && r1.data.data && r1.data.data.feed) || {};
        if (!r1.success || !(feed.create_time_raw || feed.create_time)) throw new Error(r1.message || '获取帖子信息失败');
        ctx.guildId = feed.guild_id || ctx.guildId;
        ctx.channelId = feed.channel_id || ctx.channelId;
        ctx.feedAuthorId = feed.author_id || '';
        ctx.feedCreateTime = String(feed.create_time_raw || feed.create_time);
        return ctx;
      });
    }
    return prep.then(function () {
      if (mode !== 'reply') {
        var cparams = { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId, feed_create_time: ctx.feedCreateTime, content: content, comment_type: '1' };
        if (opt && opt.imagePath) cparams.image_path = opt.imagePath;
        return api('/cli', { method: 'POST', body: { action: 'do-comment', params: cparams } });
      }
      if (opt && opt.commentAuthorId) {
        return api('/cli', { method: 'POST', body: { action: 'do-reply', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId, feed_create_time: ctx.feedCreateTime, comment_id: commentId, comment_author_id: opt.commentAuthorId, comment_create_time: opt.commentCreateTime || '', content: content, reply_type: '1' } } });
      }
      return api('/cli', { method: 'POST', body: { action: 'comments', params: { feed_id: ctx.feedId } } }).then(function (rc) {
        var comments = (rc.data && rc.data.data && rc.data.data.comments) || [];
        var c = null;
        for (var i = 0; i < comments.length; i++) {
          if (String(comments[i].comment_id) === String(commentId) || 'c_' + String(comments[i].comment_id) === String(commentId)) { c = comments[i]; break; }
        }
        if (!rc.success || !c) throw new Error('未找到该评论，请刷新后重试');
        return api('/cli', { method: 'POST', body: { action: 'do-reply', params: { feed_id: ctx.feedId, guild_id: ctx.guildId, channel_id: ctx.channelId, feed_create_time: ctx.feedCreateTime, comment_id: commentId, comment_author_id: c.author_id, comment_create_time: String(c.create_time_raw || c.create_time), content: content, reply_type: '1' } } });
      });
    }).then(function (r) {
      if (r && r.success === false) throw new Error(r.message || '操作失败');
      return r;
    });
  }

  // 官方底部输入栏占位是「登录后评论」（匿名态文案），这里改成官方登录态的占位
  function syncCommentPlaceholder() {
    var bar = document.querySelector('.bottom-input');
    if (!bar || bar.getAttribute('data-txpd-editor') === '1') return;
    var txt = bar.querySelector('.bottom-input__text');
    if (txt && txt.textContent !== '说点什么…') txt.textContent = '说点什么…';
  }

  function openInlineComment(mode, commentId, commentEl, hostEl) {
    var bar = (hostEl && hostEl.classList && hostEl.classList.contains('bottom-input')) ? hostEl : document.querySelector('.bottom-input');
    if (!bar) { openCommentFlow(mode, commentId); return; }  // 兜底：没有底部输入条的页面仍走弹窗
    var nick = '';
    if (commentEl) {
      var nEl = commentEl.querySelector('.comment-list-item__info__title-name') || commentEl.querySelector('.nick');
      nick = nEl ? (nEl.textContent || '').trim() : '';
    }
    var ta, send, cancel;
    if (bar.getAttribute('data-txpd-editor') === '1') {
      ta = bar.querySelector('.txpd-rich');
      send = bar.querySelector('.txpd-inline-send');
      cancel = bar.querySelector('.txpd-inline-cancel');
    } else {
      bar.setAttribute('data-txpd-editor', '1');
      bar.innerHTML = '';
      ta = makeRichEditor('说点什么…');   // 富文本：表情显示为图
      bar.appendChild(ta);
      cancel = el('button', { 'class': 'txpd-inline-cancel', type: 'button', title: '取消回复' }, '×');
      bar.appendChild(cancel);
      var imgBtn = el('button', { 'class': 'txpd-inline-emoji', type: 'button', title: '图片' });
      imgBtn.appendChild(svgIcon('assets/common.svg#image', 18));
      imgBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        attachCommentImage(ta);
      });
      bar.appendChild(imgBtn);
      var emoji = el('button', { 'class': 'txpd-inline-emoji', type: 'button', title: '表情' });
      emoji.appendChild(svgIcon('assets/common.svg#emoji', 18));
      emoji.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openEmojiPicker(emoji, function (item) { richInsertEmoji(ta, item); });
      });
      bar.appendChild(emoji);
      send = el('button', { 'class': 'txpd-inline-send', type: 'button' }, '发送');
      send.disabled = true;
      bar.appendChild(send);
      var grow = function () { /* contenteditable 自适应高度，无需手动撑高 */ };
      var cancelReply = function () {
        bar.setAttribute('data-txpd-mode', 'comment');
        bar.setAttribute('data-txpd-cid', '');
        cancel.style.display = 'none';
        ta.setAttribute('data-ph', '说点什么…');
      };
      ta.addEventListener('input', function () { richNormalize(ta); send.disabled = !richText(ta); });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!send.disabled) send.click(); }
        else if (e.key === 'Escape') { cancelReply(); }
      });
      cancel.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); cancelReply(); });
      send.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var content = richValue(ta);       // 序列化：表情芯片 → 节点语法
        if (!richText(ta)) return;
        var curMode = bar.getAttribute('data-txpd-mode') || 'comment';
        var curCid = bar.getAttribute('data-txpd-cid') || '';
        send.disabled = true;
        send.textContent = '发送中…';
        submitComment(curMode, curCid, content, { imagePath: ta._imgPath || '' }).then(function () {
          ta._imgPath = '';
          var chipOld = ta.querySelector('[data-txpd-imgchip]');
          if (chipOld && chipOld.parentNode) chipOld.parentNode.removeChild(chipOld);
          richClear(ta);
          send.textContent = '发送';
          send.disabled = true;
          grow();
          cancelReply();
          toast(curMode === 'reply' ? '✓ 回复已发表（CLI 账号身份）' : '✓ 评论已发表（CLI 账号身份）');
        }).catch(function (err) {
          send.textContent = '发送';
          send.disabled = !richText(ta);
          toast('发送失败：' + String((err && err.message) || err).slice(0, 60));
        });
      });
    }
    bar.setAttribute('data-txpd-mode', mode || 'comment');
    bar.setAttribute('data-txpd-cid', commentId || '');
    if (cancel) cancel.style.display = (mode === 'reply') ? 'inline-flex' : 'none';
    ta.setAttribute('data-ph', mode === 'reply' ? ('回复 ' + (nick || '') + '…') : '说点什么…');
    try { bar.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e2) { }
    setTimeout(function () { try { ta.focus(); } catch (e3) { } }, 30);
  }

  // ---------- 登录入口：接管页面原生「登录」按钮（用户要求删除悬浮按钮） ----------
  // - 未登录（插件无已登录账号）：点击 → 插件扫码登录弹窗
  // - 有已登录账号：按钮文字变「切换账号」，点击 → 账号列表弹窗
  // - 加入频道等操作 → 插件 CLI；qq 域跳转一律拦截
  function applyCachedAcctState() {
    try {
      var raw = window.localStorage.getItem(acctCacheKey());
      if (raw) {
        var box = JSON.parse(raw);
        if (box && Date.now() - box.ts < 10800000) {
          if (box.any) document.body.classList.add('txpd-logged-in');
          else document.body.classList.remove('txpd-logged-in');
          var entry = document.getElementById('txpd-acct-entry');
          if (entry) entry.textContent = box.any ? '切换账号' : '扫码登录';
        }
      }
    } catch (e) { /* 忽略 */ }
  }
  var _uiSyncQueued = false;
  function queueUiSync() {
    if (_uiSyncQueued) return;
    _uiSyncQueued = true;
    setTimeout(function () {
      _uiSyncQueued = false;
      // body 还没解析出来（head 里的阻塞样式表 / 大段内联脚本会拖很久）：
      // 这一批 ensure* 都要操作 body，直接跑会 null.classList 抛错并中断整批，
      // 所以和 mount() 一样重排一次，等 body 就绪再同步。
      if (!document.body) {
        queueUiSync();
        return;
      }
      ensureTopbarButtons();
      ensureNavEntries();
      syncPublishArea();
      ensureMobileBackButton();
      ensureNarrowDrawer();
      syncLikedMarks();
      ensureGuildMeta();
      syncCommentPlaceholder();
      ensureGatedFallback();
      ensureDynamicPage();
      ensurePageView();       // 放在动态页之后：整页视图要能盖住动态页
      ensureLoginNotice();    // 缺登录态的页面显示「无法查看」提示
    }, 120);
  }
  function mount() {
    if (!document.body) { setTimeout(mount, 100); return; }
    applyCachedAcctState();
    ensureJoinedSection();
    queueUiSync();
    // 页面提示需要 CLI 登录态；顺带在没有任何已登录账号时打开插件管理引导登录
    getAccountsState().catch(function () { /* 忽略 */ });
    setTimeout(maybeAutoOpenManage, 1200);
    // 挂 window 捕获层：应用的全局守卫在 window 捕获里 stopPropagation 拦截点赞/评论点击
    // （document 层的监听收不到事件），同层后注册的监听仍可运行
    window.addEventListener('click', function (e) {
      var t = e.target, btn = null, anchor = null;
      while (t && t !== document.body && t !== document.documentElement) {
        if (!btn && t.tagName === 'BUTTON') btn = t;
        if (!anchor && t.tagName === 'A' && t.getAttribute && t.getAttribute('href')) anchor = t;
        t = t.parentElement;
      }
      // 动态条目内的操作项（赞/分享）由元素级处理器接管：放行，不消费事件
      if (e.target && e.target.closest && e.target.closest('[data-txpd-dyn-act]')) return;
      // 频道卡 operation 行的插件按钮（配置/定时/成员/加入）
      var opBtn = e.target && e.target.closest ? e.target.closest('[data-txpd-op]') : null;
      if (opBtn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        var opKind = opBtn.getAttribute('data-txpd-op');
        if (opKind === 'config') openGuildConfig(opBtn);
        else if (opKind === 'schedule') openPage('schedule');
        else if (opKind === 'members') openMemberList(opBtn);
        else if (opKind === 'join') openJoinFlow(currentGuildNumber());
        return;
      }
      var btxt = btn && btn.textContent ? btn.textContent.trim() : '';
      // 登录 / 切换账号
      if (btxt === '登录' || btxt === '切换账号') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        getAccountsState().then(function (any) {
          if (any) openAccountList(); else openQrStage();
        }).catch(function () { openQrStage(); });
        return;
      }
      // 加入频道入口：探索卡片的 button、频道视图的 join-guild-button DIV 等
      // （官方按钮不一定是 button 标签，按可见文本匹配）
      var joinEl = null, jt = e.target, joinText = "";
      for (var hop = 0; jt && jt !== document.body && hop < 6; hop++) {
        var jtxt = (jt.textContent || "").trim();
        if (jtxt === "加入" || jtxt === "加入频道") { joinEl = jt; joinText = jtxt; break; }
        if (jt.tagName === "BUTTON" || jt.tagName === "A") break;
        jt = jt.parentElement;
      }
      if (joinEl && joinEl.offsetParent !== null) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        var hrefSrc = (anchor && anchor.getAttribute("href")) || (joinEl.closest && joinEl.closest("a") ? joinEl.closest("a").getAttribute("href") : "");
        var num = extractGuildNumber(hrefSrc || "") || currentGuildNumber();
        if (num) openJoinFlow(num);
        else toast("未识别到频道号，无法发起加入");
        return;
      }
      // 评论/回复（帖子详情页）与点赞一律接管到 CLI：网页登录只用于显示内容，
      // 操作必须由插件账号完成（否则网页登录的账号会被用来发评论）
      {
        var leaf = e.target;
        var lt = leaf && leaf.textContent ? leaf.textContent.trim() : '';
        var cItem = leaf && leaf.closest ? leaf.closest('.comment-list-item') : null;
        var cBar = leaf && leaf.closest ? leaf.closest('.comment-bar') : null;
        if (lt === '回复' && cItem && cItem.getAttribute('data-txpd-cli-comment') === '1') return;
        if (lt === '回复' && cItem) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          openInlineComment('reply', cItem.id || '', cItem, null);
          return;
        }
        var bottomInput = leaf.closest ? leaf.closest('.bottom-input') : null;
        // 内联编辑态：输入框/表情/发送/取消各自的事件自己处理，不再重复接管（否则点击会被吞）
        if (bottomInput && bottomInput.getAttribute('data-txpd-editor') === '1') return;
        if (bottomInput || (lt.indexOf('评论') === 0 && (cBar || (leaf.closest && leaf.closest('.comment-container'))))) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          openInlineComment('comment', '', null, bottomInput);
          return;
        }
        // 评论条输入框聚焦 → 同样接管
        if (cBar && leaf.tagName === 'INPUT') {
          e.preventDefault();
          leaf.blur();
          openInlineComment('comment', '', null, null);
          return;
        }
        // 评论/帖子作者名字 → CLI 私聊（不弹官方登录）
        var nickEl = leaf.closest ? leaf.closest('.nick') : null;
        var feedUserInfo = leaf.closest ? leaf.closest('.feed-item-userinfo') : null;
        if (nickEl || (feedUserInfo && leaf.closest('.publish-editor-container') === null)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          var nick = ((nickEl || leaf).textContent || '').trim();
          var cOwner = nickEl ? nickEl.closest('.comment-list-item') : null;
          var cid = cOwner && cOwner.id ? cOwner.id.replace(/^c_/, '') : '';
          // 频道视图卡片：从卡片帖子链接解析 feed_id
          var cardLink = leaf.closest ? leaf.closest('a[href*="/post/"]') : null;
          var fid = cardLink ? (/#?\/?g\/[^\/]+\/post\/([^\/?#]+)/.exec(cardLink.getAttribute('href') || '') || [])[1] : '';
          openDmByNick(nick, cid, fid ? decodeURIComponent(fid) : '');
          return;
        }
      }
      // 评论点赞（帖子详情评论区）→ CLI do-like（3=赞/4=取消）
      if (leaf && leaf.closest) {
        var cLikeEl = leaf.closest('.comment-list-item__like, .comment-list-item__like-count');
        if (!cLikeEl) {
          var cOpRow = leaf.closest('.comment-list-item__info__operation');
          if (cOpRow && cOpRow.children.length) {
            var cFirst = cOpRow.children[0];
            if (cFirst === leaf || (cFirst.contains && cFirst.contains(leaf))) cLikeEl = cFirst;
          }
        }
        if (cLikeEl) {
          var cOwnerEl = cLikeEl.closest('.comment-list-item');
          if (cOwnerEl && cOwnerEl.getAttribute('data-txpd-cli-comment') === '1') return;
          if (cOwnerEl) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            var cCountEl = cOwnerEl.querySelector('.comment-list-item__like-count') || cLikeEl;
            commentLikeFlow(cCountEl, cOwnerEl);
            return;
          }
        }
      }
      // 点赞（帖子卡片操作区第一项）→ CLI like-feed
      {
        var opItem = leaf.closest ? leaf.closest('[class*="operation__item"]') : null;
        if (opItem) {
          var row = opItem.parentElement;
          var rowItems = row ? Array.from(row.querySelectorAll('[class*="operation__item"]')) : [];
          var opIdx = rowItems.indexOf(opItem);
          var opText = (opItem.textContent || "").trim();
          // 点赞项两种变体：数字（点赞数）或文字「点赞/赞」
          if (opIdx === 0 && (/^\d*$/.test(opText) || opText === "点赞" || opText === "赞")) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            (function () {
              var cOwner = opItem.closest ? opItem.closest('.comment-list-item') : null;
              if (cOwner) { commentLikeFlow(opItem, cOwner); return; }
              var card = opItem;
              var fid = "";
              for (var depth = 0; card && depth < 8; depth++) {
                var pa = card.querySelector ? card.querySelector('a[href*="/post/"]') : null;
                if (pa) { var pm = /\/post\/([^\/?#]+)/.exec(pa.getAttribute("href")); if (pm) { fid = decodeURIComponent(pm[1]); break; } }
                card = card.parentElement;
              }
              if (!fid) { toast("未识别到帖子，无法点赞"); return; }
              var lset = likedSet();
              var liked = !!lset[fid];
              toast(liked ? "取消点赞中…" : "点赞中…");
              loadJoinedGuilds().then(function (guilds) {
                var gnum = currentGuildNumber(), gid = "";
                for (var gi = 0; gi < guilds.length; gi++) {
                  if (guilds[gi].guild_number === gnum) { gid = guilds[gi].guild_id; break; }
                }
                return api("/cli", { method: "POST", body: { action: "like-feed", params: { feed_id: fid, guild_id: gid, action: liked ? "3" : "1" } } });
              }).then(function (r) {
                if (!r.success) { toast((liked ? "取消失败：" : "点赞失败：") + (r.message || "").slice(0, 60)); return; }
                var lset2 = likedSet();
                if (liked) delete lset2[fid]; else lset2[fid] = 1;
                saveLikedSet(lset2);
                applyLikeVisual(opItem, !liked);
                toast(liked ? "已取消点赞" : "✓ 已点赞");
              }).catch(function () { toast("操作失败：网络错误"); });
            })();
            return;
          }
        }
      }
      // 帖子卡片/详情链接 → 就地浮层打开详情，不再整页跳转（嵌入模式内部保持原生跳转）
      // 受限频道的卡片（data-txpd-cli-detail）走插件 CLI 详情浮层（官方详情页同样被挡）
      if (!TXPD_EMBED) {
        var postA = e.target && e.target.closest ? e.target.closest('a[href*="/post/"]') : null;
        if (postA && !(postA.closest && postA.closest('#txpd-pop'))) {
          var opened = postA.getAttribute('data-txpd-cli-detail') === '1'
            ? openCliDetailOverlay(postA.getAttribute('data-feed'), postA.getAttribute('data-guild'), '帖子详情')
            : openPostOverlay(postA.getAttribute('href') || '');
          if (opened) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            return;
          }
        }
      }
      // 漏网的 qq 域链接跳转（pd.qq.com 的已在 DOM 层改写为相对路径）→ 提示拦截
      if (anchor) {
        var href = anchor.getAttribute('href') || '';
        if (isQqUrl(href)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          toast('已拦截 qq 域跳转：' + href.slice(0, 60));
        }
      }
    }, true);
    // 首屏 SSR 内容里的 pd.qq.com 锚点一次性改写 + 全量图片补 no-referrer
    var oldAnchors = document.querySelectorAll('a[href]');
    for (var ai = 0; ai < oldAnchors.length; ai++) normalizeQqAnchor(oldAnchors[ai]);
    enforceImgPolicy(document);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
