#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Web 管理面板：pd.qq.com 官网同款界面（本地镜像）+ 完整管理 API。

页面：
- web/panel/index.html —— pd.qq.com/explore 官方页面原样镜像，
  以完整 HTML 文档挂在 /api/web-pages/tencent-channel-panel（宿主 iframe 加载）。
- web/panel/manage.html —— 旧版管理界面（历史遗留，可自行挂载）。

管理 API（/api/ext/tencent-channel/*，全部复用后台登录鉴权）：
- POST /cli            65 个 CLI action 白名单
- GET/POST /users      账号槽位列表 / 增删切换
- POST /users/status   单槽位登录状态+昵称
- GET /history         发帖历史
- GET/POST /admins     插件管理员
- GET/POST /notify-settings  通知设置
- GET /schedules + save/toggle/run/delete  定时发帖
- POST /publish        立即发帖
- GET /panel/<file>    pd.qq.com 镜像静态资源
"""

import asyncio
import base64
import os
import random
import re
import time
import base64
import copy
import json
import time as _time
from pathlib import Path
from typing import Any, Dict, List

import httpx
from aiohttp import web

from core.plugin.decorators import on_load, on_unload
from core.plugin.web_pages import register_page, register_route, unregister_page

from ..services import scheduling as feed_scheduler
from ..services.notifications import (
    DM_MERGE_WINDOW_MAX,
    POLL_INTERVAL_MAX,
    POLL_INTERVAL_MIN,
    dm_merge_window,
    dm_notify_enabled,
    notify_enabled,
    notify_poll_interval,
)
from ..commands.shared import (
    COOKIE_FILE,
    _ensure_parent,
    JOINED_GUILDS_FILE,
    UPLOADS_DIR,
    USERS_DIR,
    _extract_json,
    _get_self_user_id,
    _load_admins,
    _load_users,
    _normalize_rate_limit,
    _run_cli,
    _safe_user_name,
    _save_admins,
    _set_setting,
    _set_switch,
    add_user,
    create_auto_user,
    get_current_user,
    list_users,
    remove_user,
    set_user_nickname,
    switch_user,
)

# ==================== pd.qq.com 网关代理 ====================

UPSTREAM = "https://pd.qq.com"
_UPSTREAM_HOST = "pd.qq.com"
_HOP_HEADERS = {
    "host", "content-length", "connection", "keep-alive", "transfer-encoding",
    "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "origin", "referer", "accept-encoding", "cookie", "x-forwarded-for",
}
_PROXY_COOKIES: Dict[str, Dict[str, str]] = {}
_PROXY_COOKIES_TS = 0.0


def _read_user_cookie_file(user: str) -> str:
    """读取指定槽位的 pd.qq.com Cookie（data/users/<槽位>/pd-cookie.txt 或全局 data/pd-cookie.txt）。"""
    base = USERS_DIR / _safe_user_name(user)
    for name in ("pd-cookie.txt", ".qqcli/pd-cookie.txt"):
        f = base / name
        try:
            if f.is_file():
                return f.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    try:
        if COOKIE_FILE.is_file():
            return COOKIE_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    return ""


def _proxy_cookie(user: str) -> str:
    global _PROXY_COOKIES_TS
    now = time.time()
    if now - _PROXY_COOKIES_TS > 5 or user not in _PROXY_COOKIES:
        cookie = _read_user_cookie_file(user)
        if cookie:
            _PROXY_COOKIES[user] = {
                part.split("=", 1)[0].strip(): part.split("=", 1)[1].strip()
                for part in cookie.split(";")
                if "=" in part
            }
        _PROXY_COOKIES_TS = now
    return "; ".join(f"{k}={v}" for k, v in _PROXY_COOKIES.get(user, {}).items())


# ==================== 访客受限频道：官方前端 + 插件账号数据 ====================

_FEED_TPL_PATH = Path(__file__).resolve().parent / "_feed_tpl.json"
_feed_tpl_cache: Dict[str, Any] = {}
_joined_keys_cache: Dict[str, Any] = {"ts": 0.0, "numbers": set(), "ids": {}}
# 合成结果缓存（避免官方前端反复拉取时把 CLI 打爆）：number -> (ts, bytes)
_feeds_synth_cache: Dict[str, Any] = {}
_FEEDS_SYNTH_TTL = 60.0
_cli_lock = asyncio.Semaphore(2)      # CLI 调用限流（每次都要起进程，别并发太多）
_JOINED_FILE = JOINED_GUILDS_FILE


def _load_joined_file() -> None:
    """把已加入频道列表与「受限频道」标记落盘，进程重启后首屏不必等 CLI"""
    try:
        d = json.loads(_JOINED_FILE.read_text(encoding="utf-8"))
        nums = set(str(x) for x in (d.get("numbers") or []))
        if nums:
            _joined_keys_cache.update({"ts": float(d.get("ts") or 0), "numbers": nums, "ids": {str(k): str(v) for k, v in (d.get("ids") or {}).items()}})
        for gnum, ts in (d.get("gated") or {}).items():
            _gated_seen[str(gnum)] = float(ts)
    except Exception:
        pass


def _save_joined_file() -> None:
    try:
        _JOINED_FILE.write_text(json.dumps({
            "ts": _joined_keys_cache["ts"],
            "numbers": sorted(_joined_keys_cache["numbers"]),
            "ids": _joined_keys_cache["ids"],
            "gated": _gated_seen,
        }, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
# 上游 feeds 明确拒绝过的频道号（说明官方认定「未对访客开放」）→ 只对这些频道放开权限位
_gated_seen: Dict[str, float] = {}


def _mark_gated(gnum: str) -> None:
    if gnum and gnum not in _gated_seen:
        _gated_seen[gnum] = _time.time()
        _save_joined_file()


def _is_gated(gnum: str) -> bool:
    ts = _gated_seen.get(gnum)
    return bool(ts) and (_time.time() - ts) < 900

# 6 位访客权限位（bit5 公开内容 / bit4 帖子互动 / bit3 发帖 / bit2 直播 / bit1 语音 / bit0 聊天）
PERMIT_ALL_VISITOR = 63


def _b64_text(v: Any) -> str:
    """官方 JSON 里 bytes 字段是 base64（如 bytes_guild_number）"""
    if not v or not isinstance(v, str):
        return ""
    try:
        return base64.b64decode(v).decode("utf-8", "ignore")
    except Exception:
        return ""


def _load_feed_tpl() -> Dict[str, Any]:
    if not _feed_tpl_cache:
        try:
            _feed_tpl_cache["d"] = json.loads(_FEED_TPL_PATH.read_text(encoding="utf-8"))
        except Exception:
            _feed_tpl_cache["d"] = {}
    return _feed_tpl_cache["d"]


async def _joined_keys(user: str) -> Dict[str, Any]:
    """插件账号已加入的频道（5 分钟缓存）：{numbers: set, ids: {number: guild_id}}"""
    now = _time.time()
    if _joined_keys_cache["numbers"] and now - _joined_keys_cache["ts"] < 300:
        return _joined_keys_cache
    numbers: set = set()
    ids: Dict[str, str] = {}
    try:
        async with _cli_lock:
            res = await _run_cli_json(["manage", "get-my-join-guild-info", "--json"], user)
        data = ((res or {}).get("data") or {}).get("data") or {}
        # 三个列表都算「已加入」：created（我创建的）/ managed（我是管理员·小管家）/ joined（普通成员）
        for g in ((data.get("created_guilds") or []) + (data.get("managed_guilds") or [])
                  + (data.get("joined_guilds") or [])):
            num = str(g.get("guild_number") or "")
            if not num:
                continue
            numbers.add(num)
            ids[num] = str(g.get("guild_id") or "")
    except Exception:
        pass
    if numbers:
        _joined_keys_cache.update({"ts": now, "numbers": numbers, "ids": ids})
        _save_joined_file()
    return _joined_keys_cache


def _feed_from_cli(f: Dict[str, Any], tpl: Dict[str, Any], gnum: str, gid: str) -> Dict[str, Any]:
    """把 CLI 的一条帖子映射成官方 GetGuildFeeds 的 feed 结构（以真实响应为模板改写）"""
    feed = copy.deepcopy(tpl)
    feed["id"] = f.get("feed_id") or ""
    try:
        feed["createTime"] = int(f.get("create_time_raw") or feed.get("createTime") or 0)
    except Exception:
        pass
    feed["commentCount"] = int(f.get("comment_count") or 0)
    prefer = int(f.get("prefer_count") or 0)
    feed["total_prefer"] = {"prefer_count": prefer, "prefer_status": 0, "prefer_count_without_like": prefer}
    feed["total_like"] = {"is_clicked": False, "like_count": prefer}
    # 卡片时间取自 meta.last_modified_time（官方卡片代码 M=Number(feed.meta.last_modified_time)）
    raw = 0
    try:
        raw = int(f.get("create_time_raw") or 0)
    except Exception:
        raw = 0
    meta = feed.get("meta") or {}
    meta["last_modified_time"] = str(raw)
    mc = meta.get("content") or {}
    cnt = mc.get("count") or {}
    cnt["image"] = str(len(f.get("images") or []))
    cnt["text_word"] = str(len((f.get("content_snippet") or "")))
    mc["count"] = cnt
    meta["content"] = mc
    feed["meta"] = meta
    feed["createTimeNs"] = str(raw) + "000000000"
    # 作者（CLI 不返回头像 → 留空，由官方组件用默认占位）
    poster = feed.get("poster") or {}
    poster["nick"] = f.get("author") or ""
    poster["id"] = str(f.get("author_id") or "")
    icon = poster.get("icon") or {}
    icon["iconUrl"] = ""
    icon["bytes_avatar_meta"] = None
    poster["icon"] = icon
    feed["poster"] = poster
    # 正文：官方用 title.contents[].text_content.text
    text = (f.get("content_snippet") or f.get("title") or "").strip()
    title = feed.get("title") or {}
    contents = title.get("contents") or []
    c0 = copy.deepcopy(contents[0]) if contents else {"type": 1}
    c0["text_content"] = {"text": text}
    c0["at_content"] = None
    c0["url_content"] = None
    c0["emoji_content"] = None
    title["contents"] = [c0]
    feed["title"] = title
    # 图片
    imgs = [u for u in (f.get("images") or []) if isinstance(u, str)]
    tpl_img = (tpl.get("images") or [None])[0]
    out_imgs = []
    for i, u in enumerate(imgs[:9]):
        base = copy.deepcopy(tpl_img) if tpl_img else {}
        base["picUrl"] = u
        base["vecImageUrl"] = [{"busiData": None, "height": 0, "width": 0, "url": u, "levelType": 2}]
        base["display_index"] = i
        base["is_gif"] = u.lower().endswith(".gif")
        out_imgs.append(base)
    feed["images"] = out_imgs
    # 频道 / 版块信息
    ci = feed.get("channelInfo") or {}
    ci["guild_name"] = f.get("guild_name") or ""
    ci["guild_number"] = gnum
    sign = ci.get("sign") or {}
    sign["guild_id"] = gid
    sign["channel_id"] = ""
    sign["group_id"] = None
    sign["join_guild_sig"] = None
    ci["sign"] = sign
    ci["icon_url"] = ""
    feed["channelInfo"] = ci
    # 分享卡片里的频道签名也指向本频道
    share = feed.get("share") or {}
    chan_share = share.get("channelShareInfo") or {}
    chan_share["feedID"] = feed["id"]
    chan_share["posterID"] = poster["id"]
    csign = chan_share.get("channelSign") or {}
    csign["guild_id"] = gid
    csign["channel_id"] = ""
    chan_share["channelSign"] = csign
    share["channelShareInfo"] = chan_share
    feed["share"] = share
    return feed


def _build_feeds_payload(feeds: List[Dict[str, Any]], gnum: str, gid: str) -> bytes:
    tpl_doc = _load_feed_tpl()
    tpl_feed = (((tpl_doc.get("data") or {}).get("vecFeed") or [{}])[0])
    env = copy.deepcopy(tpl_doc)
    data = env.setdefault("data", {})
    data["vecFeed"] = [_feed_from_cli(f, tpl_feed, gnum, gid) for f in feeds]
    data["isFinish"] = True          # 先不接官方分页（CLI 侧另有「加载更多」）
    data["feedAttchInfo"] = ""
    data["has_feed"] = bool(feeds)
    data.setdefault("topFeeds", [])
    data.setdefault("channels", [])
    env["error"] = {"code": 0, "message": ""}
    env["retcode"] = 0
    env["message"] = ""
    return json.dumps(env, ensure_ascii=False).encode("utf-8")


_load_joined_file()


async def _try_official_frontend(url: str, body: bytes, content: bytes, user: str):
    """受限频道：改写上游响应，让官方前端正常渲染（返回新的响应体或 None）"""
    try:
        if "HandleProcess" in url and b"cmd0xf57_rsp" in content:
            keys = await _joined_keys(user)
            if not keys["numbers"]:
                return None
            doc = json.loads(content.decode("utf-8"))
            lst = (((doc.get("data") or {}).get("cmd0xf57_rsp") or {}).get("rpt_rsp_guild_info_list") or [])
            changed = False
            for item in lst:
                gi = item.get("msg_guild_info") or {}
                gnum = _b64_text(gi.get("bytes_guild_number"))
                if gnum and gnum in keys["numbers"] and _is_gated(gnum):
                    # 放开访客权限（官方据此渲染完整频道主页而不是提示卡）
                    gi["uint32_vistor_interaction_all_switch"] = PERMIT_ALL_VISITOR
                    gi["uint32_is_visible_for_visitor"] = 1
                    # 插件账号确实是成员 → 让官方按「已加入」渲染
                    ui = item.get("msg_cmd_uin_info") or {}
                    if ui:
                        ui["uint32_is_member"] = 2
                    changed = True
            if changed:
                return json.dumps(doc, ensure_ascii=False).encode("utf-8")
            return None
        if "GetGuildFeeds" in url:
            # 官方自己拿得到内容（公开频道）就不动它
            if b'"retcode":0' in content[:60]:
                return None
            try:
                req = json.loads(body.decode("utf-8")) if body else {}
            except Exception:
                req = {}
            gnum = str(req.get("guild_number") or "")
            keys = await _joined_keys(user)
            if not gnum or gnum not in keys["numbers"]:
                return None
            _mark_gated(gnum)   # 上游拒绝 → 记为受限频道（随后频道信息里的权限位才会被放开）
            hit = _feeds_synth_cache.get(gnum)
            if hit and (_time.time() - hit[0]) < _FEEDS_SYNTH_TTL:
                return hit[1]
            gid = keys["ids"].get(gnum, "")
            async with _cli_lock:
                res = await _run_cli_json(["feed", "get-guild-feeds", "--guild-id", gid, "--count", "20", "--json"], user)
            data = ((res or {}).get("data") or {}).get("data") or {}
            feeds = data.get("feeds") or []
            if not feeds:
                # CLI 临时失败（如上游限流 151）→ 有旧缓存就先用旧的，别让列表空白
                if hit:
                    return hit[1]
                return None
            payload = _build_feeds_payload(feeds, gnum, gid)
            _feeds_synth_cache[gnum] = (_time.time(), payload)
            return payload
    except Exception:
        return None
    return None


def _looks_like_json(body: bytes) -> bool:
    """上游错误页常常是 HTML/空体，前端 JSON.parse 会直接抛错，所以这里先探一下。"""
    head = (body or b"").lstrip()[:1]
    return head in (b"{", b"[")


async def api_pd_proxy(request: web.Request) -> web.Response:
    """把镜像页面的本站 API 请求透传给 pd.qq.com（携带当前槽位的 Cookie）。

    宿主 match_route 前缀路由不会填充 match_info，tail 需从 request.path 截取。
    """
    prefix = "/api/ext/tencent-channel/pd/"
    path = request.path
    tail = path[len(prefix):] if path.startswith(prefix) else ""
    tail = tail.lstrip("/")
    url = f"{UPSTREAM}/{tail}" if tail else UPSTREAM + "/"
    qs = request.rel_url.query_string
    if qs:
        url = f"{url}?{qs}"
    user = request.query.get("txpd_user", "") or get_current_user()
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in _HOP_HEADERS and not k.lower().startswith("x-txpd-")
    }
    cookie = _proxy_cookie(user)
    if cookie:
        headers["Cookie"] = cookie
    headers["Referer"] = "https://pd.qq.com/"
    headers.setdefault("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    body = await request.read()
    # 上游偶发 5xx / 网络抖动：重试一次再放弃（腾讯网关抖一下很常见）
    resp = None
    last_error = ""
    async with httpx.AsyncClient(verify=False, timeout=30, follow_redirects=True) as client:
        for attempt in (1, 2):
            try:
                resp = await client.request(
                    request.method,
                    url,
                    headers=headers,
                    content=body if request.method not in ("GET", "HEAD") else None,
                )
            except httpx.HTTPError as e:
                last_error = str(e)
                resp = None
            if resp is not None and resp.status_code < 500:
                break
            if attempt == 1:
                await asyncio.sleep(0.4)
    if resp is None:
        return web.json_response({"success": False, "retcode": -1, "message": f"上游请求失败: {last_error}"}, status=502)
    # 上游错误页通常不是 JSON；前端拿到会直接 JSON.parse 崩掉（Unexpected end of JSON input）。
    # 网关类错误统一包成 JSON 信封，让页面按正常错误态处理。
    _ct = resp.headers.get("content-type", "")
    if resp.status_code >= 500 and not _ct.lower().startswith("application/json") and not _looks_like_json(resp.content):
        return web.json_response(
            {"retcode": -1, "message": f"上游暂时不可用（HTTP {resp.status_code}）", "success": False},
            status=502,
        )
    out_headers = {
        k: v
        for k, v in resp.headers.items()
        if k.lower() not in ("content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "content-security-policy", "x-frame-options")
    }
    # 访客受限频道：让官方前端照常渲染（放开权限位 + 用插件账号数据合成 feeds 响应）
    _official = await _try_official_frontend(url, body, resp.content, user)
    if _official is not None:
        return web.Response(body=_official, status=200, content_type="application/json")
    ct = resp.headers.get("content-type", "application/octet-stream").split(";")[0]
    out_headers = {k: v for k, v in out_headers.items() if k.lower() != "content-type"}
    return web.Response(
        body=resp.content,
        status=resp.status_code,
        headers=out_headers,
        content_type=ct or None,
    )

PAGE_KEY = "tencent-channel-panel"

_PANEL_DIR = Path(__file__).resolve().parent / "panel"
_ASSETS_DIR = _PANEL_DIR / "assets"

_STATIC_TYPES = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".json": "application/json",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".txt": "text/plain",
    ".map": "application/json",
}


# ==================== CLI 动作白名单 ====================
# 每个动作: base=CLI 子命令, required/optional=参数名→CLI flag, extra=固定附加参数

ACTIONS: Dict[str, Dict[str, Any]] = {
    "guilds": {"base": ["manage", "get-my-join-guild-info"]},
    "guilds": {"base": ["manage", "get-my-join-guild-info"]},
    "guild-info": {"base": ["manage", "get-guild-info"],"required": {"guild_id": "--guild-id"}},
    "guild-share-url": {"base": ["manage", "get-guild-share-url"],"required": {"guild_id": "--guild-id"}},
    "channels": {"base": ["manage", "get-guild-channel-list"],"required": {"guild_id": "--guild-id"}},
    "members": {"base": ["manage", "get-guild-member-list"],"required": {"guild_id": "--guild-id"},"optional": {"next_page_token": "--next-page-token"}},
    "member-search": {"base": ["manage", "guild-member-search"],"required": {"guild_id": "--guild-id", "keyword": "--keyword"},"optional": {"num": "--num", "next_pos": "--next-pos"}},
    "user-info": {"base": ["manage", "get-user-info"],"optional": {"guild_id": "--guild-id", "tiny_id": "--tiny-id"}},
    "join-setting": {"base": ["manage", "get-join-guild-setting"],"required": {"guild_id": "--guild-id"}},
    "join-setting-set": {"base": ["manage", "update-join-guild-setting"],"required": {"guild_id": "--guild-id", "join_type": "--join-type"}},
    "search-guild": {"base": ["manage", "search-guild-content"],"required": {"keyword": "--keyword"},"optional": {"scope": "--scope", "next_page_token": "--next-page-token"}},
    "search-and-join": {"base": ["manage", "search-and-join"],"required": {"keyword": "--keyword"},"optional": {"resume_id": "--resume-id", "pick": "--pick"}},
    "share-info": {"base": ["manage", "get-share-info"],"required": {"url": "--url"}},
    "feeds": {"base": ["feed", "get-guild-feeds"],"required": {"guild_id": "--guild-id"},"optional": {"get_type": "--get-type", "count": "--count", "feed_attach_info": "--feed-attach-info"}},
    "feed-timeline": {"base": ["feed", "get-channel-timeline-feeds"],"required": {"guild_id": "--guild-id", "channel_id": "--channel-id"},"optional": {"count": "--count", "feed_attach_info": "--feed-attach-info"}},
    "feed-detail": {"base": ["feed", "get-feed-detail"],"required": {"feed_id": "--feed-id"},"optional": {"guild_id": "--guild-id", "channel_id": "--channel-id"}},
    "feed-share-url": {"base": ["feed", "get-feed-share-url"],"required": {"feed_id": "--feed-id"},"optional": {"guild_id": "--guild-id", "channel_id": "--channel-id"}},
    "feed-search": {"base": ["feed", "search-guild-feeds"],"required": {"guild_id": "--guild-id"},"optional": {"query": "--query", "keyword": "--keyword", "next_page_cookie": "--next-page-cookie"}},
    "latest-feeds-detail": {"base": ["feed", "latest-feeds-detail"],"optional": {"count": "--count", "resume_id": "--resume-id", "pick": "--pick"}},
    "hot-feeds-detail": {"base": ["feed", "hot-feeds-detail"],"optional": {"count": "--count", "resume_id": "--resume-id", "pick": "--pick"}},
    "publish-feed": {"base": ["feed", "publish-feed"],"optional": {"guild_id": "--guild-id", "channel_id": "--channel-id", "title": "--title", "content": "--content", "markdown_content": "--markdown-content", "content_file": "--content-file", "feed_type": "--feed-type", "image": "--image", "video": "--video", "at_user": "--at-user", "link": "--link", "topic_name": "--topic-name"}},
    "alter-feed": {"base": ["feed", "alter-feed"],"required": {"feed_id": "--feed-id", "guild_id": "--guild-id", "channel_id": "--channel-id", "create_time": "--create-time"},"optional": {"feed_type": "--feed-type", "title": "--title", "content": "--content", "markdown_content": "--markdown-content", "content_file": "--content-file", "image": "--image", "video": "--video", "at_user": "--at-user", "link": "--link", "topic_name": "--topic-name", "clear_images": "--clear-images", "clear_videos": "--clear-videos"}},
    "del-feed": {"base": ["feed", "del-feed"],"required": {"feed_id": "--feed-id", "guild_id": "--guild-id", "channel_id": "--channel-id", "create_time": "--create-time"},"yes": True},
    "top-feed": {"base": ["feed", "top-feed"],"required": {"feed_id": "--feed-id", "user_id": "--user-id", "create_time": "--create-time", "guild_id": "--guild-id"},"optional": {"action": "--action", "top_type": "--top-type"}},
    "set-essence": {"base": ["feed", "set-feed-essence"],"required": {"feed_id": "--feed-id"},"optional": {"action": "--action"}},
    "push-essence": {"base": ["feed", "push-essence-feed"],"required": {"feed_id": "--feed-id"}},
    "move-feed": {"base": ["feed", "move-feed"],"required": {"guild_id": "--guild-id", "channel_id": "--channel-id", "original_channel_id": "--original-channel-id", "feed_id": "--feed-id"}},
    "like-feed": {"base": ["feed", "do-feed-prefer"],"required": {"feed_id": "--feed-id"},"optional": {"action": "--action", "guild_id": "--guild-id", "channel_id": "--channel-id"}},
    "comments": {"base": ["feed", "get-feed-comments"],"required": {"feed_id": "--feed-id"},"optional": {"guild_id": "--guild-id", "channel_id": "--channel-id", "count": "--count", "rank_type": "--rank-type", "reply_list_num": "--reply-list-num", "attach_info": "--attach-info"}},
    "replies": {"base": ["feed", "get-next-page-replies"],"required": {"feed_id": "--feed-id", "comment_id": "--comment-id", "guild_id": "--guild-id", "channel_id": "--channel-id"},"optional": {"count": "--count", "attach_info": "--attach-info"}},
    "do-comment": {"base": ["feed", "do-comment"],"optional": {"feed_id": "--feed-id", "feed_create_time": "--feed-create-time", "comment_type": "--comment-type", "content": "--content", "image_path": "--image-path", "at_user": "--at-user", "link": "--link", "comment_id": "--comment-id", "comment_author_id": "--comment-author-id", "guild_id": "--guild-id", "channel_id": "--channel-id", "ref": "--ref"}},
    "del-comment": {"base": ["feed", "do-comment", "--comment-type", "0"],"required": {"feed_id": "--feed-id", "comment_id": "--comment-id", "comment_author_id": "--comment-author-id", "feed_create_time": "--feed-create-time"},"optional": {"guild_id": "--guild-id", "channel_id": "--channel-id"},"yes": True},
    "do-reply": {"base": ["feed", "do-reply"],"optional": {"feed_id": "--feed-id", "feed_author_id": "--feed-author-id", "feed_create_time": "--feed-create-time", "comment_id": "--comment-id", "comment_author_id": "--comment-author-id", "comment_create_time": "--comment-create-time", "reply_type": "--reply-type", "replier_id": "--replier-id", "content": "--content", "image_path": "--image-path", "at_user": "--at-user", "link": "--link", "target_reply_id": "--target-reply-id", "target_user_id": "--target-user-id", "target_user_nick": "--target-user-nick", "reply_id": "--reply-id", "guild_id": "--guild-id", "channel_id": "--channel-id", "ref": "--ref"},"replier": True},
    "like-comment": {"base": ["feed", "do-like"],"required": {"feed_id": "--feed-id", "comment_id": "--comment-id", "feed_author_id": "--feed-author-id", "feed_create_time": "--feed-create-time", "comment_author_id": "--comment-author-id"},"optional": {"like_type": "--like-type", "guild_id": "--guild-id", "channel_id": "--channel-id", "reply_id": "--reply-id", "reply_author_id": "--reply-author-id", "comment_like_count": "--comment-like-count", "reply_like_count": "--reply-like-count"}},
    "notices": {"base": ["feed", "get-notices"],"optional": {"page_num": "--page-num", "guild_id": "--guild-id", "attach_info": "--attach-info"}},
    "add-admin": {"base": ["manage", "add-admin"],"required": {"guild_id": "--guild-id", "tiny_ids": "--tiny-ids"}},
    "remove-admin": {"base": ["manage", "remove-admin"],"required": {"guild_id": "--guild-id", "tiny_ids": "--tiny-ids"}},
    "mute": {"base": ["manage", "modify-member-shut-up"],"required": {"guild_id": "--guild-id", "tiny_id": "--tiny-id"},"optional": {"time_stamp": "--time-stamp"},"yes": True},
    "kick": {"base": ["manage", "kick-guild-member"],"required": {"guild_id": "--guild-id"},"optional": {"tiny_id": "--tiny-id", "member_tinyids": "--member-tinyids", "blacklist": "--blacklist", "revoke_msgs": "--revoke-msgs"},"yes": True},
    "join-guild": {"base": ["manage", "join-guild"],"required": {"guild_id": "--guild-id"}},
    "leave-guild": {"base": ["manage", "leave-guild"],"required": {"guild_id": "--guild-id"},"yes": True},
    "create-channel": {"base": ["manage", "create-channel"],"required": {"guild_id": "--guild-id", "channel_name": "--channel-name"}},
    "modify-channel": {"base": ["manage", "modify-channel"],"required": {"guild_id": "--guild-id", "channel_id": "--channel-id", "channel_name": "--channel-name"}},
    "delete-channel": {"base": ["manage", "delete-channel"],"required": {"guild_id": "--guild-id", "channel_ids": "--channel-ids"},"yes": True},
    "update-guild-name": {"base": ["manage", "update-guild-info"],"required": {"guild_id": "--guild-id"},"optional": {"guild_name": "--guild-name", "guild_profile": "--guild-profile"}},
    "update-guild-profile": {"base": ["manage", "update-guild-info"],"required": {"guild_id": "--guild-id"},"optional": {"guild_name": "--guild-name", "guild_profile": "--guild-profile"}},
    "set-join-type": {"base": ["manage", "update-join-guild-setting"],"required": {"guild_id": "--guild-id", "join_type": "--join-type"}},
    "create-guild": {"base": ["manage", "create-theme-private-guild"],"required": {"image_path": "--image-path"},"optional": {"theme": "--theme", "guild_name": "--guild-name", "guild_profile": "--guild-profile", "community_type": "--community-type"}},
    "upload-avatar": {"base": ["manage", "upload-guild-avatar"],"required": {"guild_id": "--guild-id", "image_path": "--image-path"}},
    "modify-guild-number": {"base": ["manage", "modify-guild-number"],"required": {"guild_id": "--guild-id", "guild_number": "--guild-number"}},
    "create-role-group": {"base": ["manage", "create-guild-role-group"],"required": {"guild_id": "--guild-id", "name": "--name"}},
    "modify-role-group": {"base": ["manage", "modify-guild-role-group"],"required": {"guild_id": "--guild-id", "role_id": "--role-id", "name": "--name"}},
    "add-role-members": {"base": ["manage", "add-role-members"],"required": {"guild_id": "--guild-id", "role_id": "--role-id", "tiny_ids": "--tiny-ids"}},
    "remove-role-members": {"base": ["manage", "remove-role-members"],"required": {"guild_id": "--guild-id", "role_id": "--role-id", "tiny_ids": "--tiny-ids"}},
    "push-dm": {"base": ["manage", "push-group-dm-msg"],"required": {"text": "--text"},"optional": {"peer_tiny_id": "--peer-tiny-id", "source_guild_id": "--source-guild-id", "ref": "--ref"}},
    "recent-notices": {"base": ["manage", "get-recent-notices"]},
    "check-notices": {"base": ["manage", "check-notices"]},
    "check-new-notices": {"base": ["manage", "check-new-notices"]},
    "deal-notice": {"base": ["manage", "deal-notice"],"required": {"action_id": "--action-id"},"optional": {"notice_id": "--notice-id", "ref": "--ref"}},
    "notices-status": {"base": ["manage", "notices-status"]},
    "notices-on": {"base": ["manage", "notices-on"],"optional": {"session_key": "--session-key", "confirm": "--confirm"}},
    "notices-off": {"base": ["manage", "notices-off"],"optional": {"session_key": "--session-key"}},
    "login-status": {"base": ["login", "status"]},
    "login": {"base": ["login"]},
    "login-force": {"base": ["login"],"yes": True},
    "login-poll": {"base": ["login", "poll-token"]},
    "logout": {"base": ["login", "logout"]},
}


def _build_action_args(action: str, params: Dict[str, Any], user: str = "") -> Any:
    spec = ACTIONS.get(action)
    if not spec:
        return {"error": f"未知操作: {action}"}
    args: List[str] = list(spec["base"])
    defaults = spec.get("defaults") or {}
    for key, flag in (spec.get("required") or {}).items():
        value = str(params.get(key) or defaults.get(key) or "").strip()
        if not value:
            return {"error": f"缺少参数: {key}"}
        args += [flag, value]
    for key, flag in (spec.get("optional") or {}).items():
        value = str(params.get(key) or defaults.get(key) or "").strip()
        if value:
            args += [flag, value]
    if spec.get("replier"):
        replier_id = (
            str(params.get("replier_id") or "").strip()
            or _get_self_user_id(str(params.get("guild_id") or "").strip() or None, user or None)
            or _get_self_user_id(None, user or None)
        )
        if not replier_id:
            return {"error": "无法获取自己的用户ID，请先执行一次「用户资料」"}
        args += ["--replier-id", replier_id]
    if spec.get("yes"):
        args.append("--yes")
    args.append("--json")
    return {"args": args}


async def _run_cli_json(args: List[str], user: str = "") -> Dict[str, Any]:
    ok, output = await asyncio.to_thread(_run_cli, args, None, user or None)
    output = _normalize_rate_limit(output)
    data = _extract_json(output)
    result: Dict[str, Any] = {"success": ok}
    if data is not None:
        result["data"] = data
        payload = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), dict) else data
        if isinstance(payload, dict):
            success = payload.get("success", data.get("success") if isinstance(data, dict) else None)
            code = payload.get(
                "retCode",
                payload.get(
                    "ret_code",
                    payload.get(
                        "retcode",
                        data.get("retCode", data.get("ret_code", data.get("retcode", ""))) if isinstance(data, dict) else "",
                    ),
                ),
            )
            if isinstance(success, bool):
                result["success"] = result["success"] and success
            if str(code).strip() not in ("", "0", "OK", "ok"):
                result["success"] = False
            if not result["success"]:
                msg = str(
                    payload.get("message")
                    or payload.get("msg")
                    or payload.get("error")
                    or (data.get("message") if isinstance(data, dict) else "")
                    or (data.get("msg") if isinstance(data, dict) else "")
                    or ""
                ).strip()
                # 没有明确 message 时，把 CLI 的原始输出尾巴带上（用户要求看原始报错）
                if not msg or msg in ("操作未成功，请查看返回详情",):
                    tail = " ".join((output or "").split())[-400:]
                    msg = (msg + " " if msg else "") + ("原始返回：" + tail if tail else "操作未成功")
                result["message"] = msg
    else:
        result["raw"] = output.strip()[-2000:]
        if not ok:
            result["message"] = output.strip()[-500:] or "命令执行失败"
    return result


async def _json_body(request: web.Request) -> Dict[str, Any]:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ==================== 路由 ====================


@register_route("POST", "/api/ext/tencent-channel/cli")
async def api_cli(request: web.Request):
    body = await _json_body(request)
    action = str(body.get("action") or "").strip()
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    user = str(body.get("user") or "").strip()
    built = _build_action_args(action, params, user)
    if "error" in built:
        return web.json_response({"success": False, "message": built["error"]})
    return web.json_response(await _run_cli_json(built["args"], user))


# ==================== 账号槽位 ====================


@register_route("GET", "/api/ext/tencent-channel/users")
async def api_get_users(request: web.Request):
    return web.json_response({"success": True, "data": _load_users()})


@register_route("POST", "/api/ext/tencent-channel/users")
async def api_post_users(request: web.Request):
    body = await _json_body(request)
    op = str(body.get("op") or "").strip()
    name = _safe_user_name(body.get("name"))
    if op == "add":
        if not name:
            ok, message = create_auto_user()
            return web.json_response({"success": ok, "message": message})
        ok, message = add_user(name)
    elif op == "delete":
        ok, message = remove_user(name)
    elif op == "switch":
        ok, message = switch_user(name)
    elif op == "rename":
        nickname = str(body.get("nickname") or "").strip()
        if name not in _load_users()["users"]:
            return web.json_response({"success": False, "message": f"槽位「{name}」不存在"})
        set_user_nickname(name, nickname)
        ok, message = True, "昵称已保存"
    else:
        return web.json_response({"success": False, "message": f"未知操作: {op}"})
    return web.json_response({"success": ok, "message": message, "data": _load_users()})


@register_route("POST", "/api/ext/tencent-channel/users/status")
async def api_user_status(request: web.Request):
    """查询指定槽位的登录状态与昵称（昵称成功时顺带缓存）。"""
    body = await _json_body(request)
    name = str(body.get("name") or "").strip()
    if not name or name not in _load_users()["users"]:
        return web.json_response({"success": False, "message": f"槽位「{name}」不存在"})
    status = await _run_cli_json(["login", "status", "--json"], name)
    nickname = ""
    info = await _run_cli_json(["manage", "get-user-info", "--json"], name)
    payload = info.get("data") if isinstance(info.get("data"), dict) else {}
    if isinstance(payload.get("data"), dict):
        payload = payload["data"]
    if isinstance(payload, dict):
        nickname = str(payload.get("nickname") or payload.get("nick") or "").strip()
    if nickname:
        set_user_nickname(name, nickname)
    return web.json_response({"success": True, "data": {"name": name, "status": status, "nickname": nickname}})


# ==================== 发帖历史 ====================


@register_route("GET", "/api/ext/tencent-channel/history")
async def api_get_history(request: web.Request):
    return web.json_response({"success": True, "data": {"history": feed_scheduler.load_history()}})


# ==================== 插件管理员 ====================


@register_route("GET", "/api/ext/tencent-channel/admins")
async def api_get_admins(request: web.Request):
    return web.json_response({"success": True, "data": {"admins": _load_admins()}})


@register_route("POST", "/api/ext/tencent-channel/admins")
async def api_save_admins(request: web.Request):
    body = await _json_body(request)
    raw = body.get("admins")
    if isinstance(raw, str):
        admins = [x.strip() for x in raw.replace("，", ",").splitlines() for x in [x]]
        admins = [x for x in ",".join(admins).split(",") if x]
    elif isinstance(raw, list):
        admins = [str(x).strip() for x in raw if str(x).strip()]
    else:
        admins = []
    if not _save_admins(admins):
        return web.json_response({"success": False, "message": "保存失败"})
    return web.json_response({"success": True, "message": f"已保存 {len(admins)} 个管理员", "data": {"admins": _load_admins()}})


# ==================== 通知设置 ====================


def _notify_settings_data() -> Dict[str, Any]:
    return {
        "dm_merge_window": dm_merge_window(),
        "max": DM_MERGE_WINDOW_MAX,
        "comment_notify_enabled": notify_enabled(),
        "dm_notify_enabled": dm_notify_enabled(),
        "notify_poll_interval": notify_poll_interval(),
        "poll_interval_min": POLL_INTERVAL_MIN,
        "poll_interval_max": POLL_INTERVAL_MAX,
    }


@register_route("GET", "/api/ext/tencent-channel/notify-settings")
async def api_get_notify_settings(request: web.Request):
    return web.json_response({"success": True, "data": _notify_settings_data()})


@register_route("POST", "/api/ext/tencent-channel/notify-settings")
async def api_save_notify_settings(request: web.Request):
    body = await _json_body(request)
    if "dm_merge_window" in body:
        try:
            value = int(body.get("dm_merge_window"))
        except (TypeError, ValueError):
            return web.json_response({"success": False, "message": "冷却时间需为整数秒数"})
        if value < 0 or value > DM_MERGE_WINDOW_MAX:
            return web.json_response({"success": False, "message": f"冷却时间需在 0-{DM_MERGE_WINDOW_MAX} 秒之间"})
        _set_setting("dm_merge_window", value)
    if "notify_poll_interval" in body:
        try:
            interval = int(body.get("notify_poll_interval"))
        except (TypeError, ValueError):
            return web.json_response({"success": False, "message": "轮询间隔需为整数秒数"})
        if interval < POLL_INTERVAL_MIN or interval > POLL_INTERVAL_MAX:
            return web.json_response({"success": False, "message": f"轮询间隔需在 {POLL_INTERVAL_MIN}-{POLL_INTERVAL_MAX} 秒之间"})
        _set_setting("notify_poll_interval", interval)
    if "comment_notify_enabled" in body:
        _set_switch("comment_notify_enabled", bool(body.get("comment_notify_enabled")))
    if "dm_notify_enabled" in body:
        _set_switch("dm_notify_enabled", bool(body.get("dm_notify_enabled")))
    return web.json_response({"success": True, "message": "通知设置已保存", "data": _notify_settings_data()})


# ==================== 定时发帖 ====================


@register_route("GET", "/api/ext/tencent-channel/schedules")
async def api_get_schedules(request: web.Request):
    examples = [{"expr": expr, "desc": desc} for expr, desc in feed_scheduler.CRON_EXAMPLES]
    return web.json_response({"success": True, "data": {"schedules": feed_scheduler.load_schedules(), "cron_examples": examples}})


@register_route("POST", "/api/ext/tencent-channel/schedules/save")
async def api_save_schedule(request: web.Request):
    body = await _json_body(request)
    normalized = feed_scheduler.normalize_schedule(body)
    if "error" in normalized:
        return web.json_response({"success": False, "message": normalized["error"]})
    schedules = feed_scheduler.load_schedules()
    index = next((i for i, s in enumerate(schedules) if s.get("id") == normalized["id"]), None)
    if index is not None:
        normalized["last_run"] = schedules[index].get("last_run", "")
        normalized["last_result"] = schedules[index].get("last_result", "")
        schedules[index] = normalized
    else:
        schedules.append(normalized)
    if not feed_scheduler.save_schedules(schedules):
        return web.json_response({"success": False, "message": "保存失败"})
    feed_scheduler.record_history({**normalized, "kind": "schedule"})
    return web.json_response({"success": True, "message": "计划已保存", "data": {"schedule": normalized}})


@register_route("POST", "/api/ext/tencent-channel/schedules/toggle")
async def api_toggle_schedule(request: web.Request):
    body = await _json_body(request)
    schedule_id = str(body.get("id") or "").strip()
    schedules = feed_scheduler.load_schedules()
    for item in schedules:
        if item.get("id") == schedule_id:
            item["enabled"] = not item.get("enabled", True)
            feed_scheduler.save_schedules(schedules)
            state = "启用" if item["enabled"] else "停用"
            return web.json_response({"success": True, "message": f"计划「{item.get('name')}」已{state}", "data": {"enabled": item["enabled"]}})
    return web.json_response({"success": False, "message": "计划不存在"})


@register_route("POST", "/api/ext/tencent-channel/schedules/run")
async def api_run_schedule(request: web.Request):
    body = await _json_body(request)
    schedule_id = str(body.get("id") or "").strip()
    schedule = next((s for s in feed_scheduler.load_schedules() if s.get("id") == schedule_id), None)
    if not schedule:
        return web.json_response({"success": False, "message": "计划不存在"})
    result = await feed_scheduler.run_schedule(schedule)
    return web.json_response({"success": result["ok"], "message": result["message"]})


@register_route("POST", "/api/ext/tencent-channel/schedules/delete")
async def api_delete_schedule(request: web.Request):
    body = await _json_body(request)
    schedule_id = str(body.get("id") or "").strip()
    schedules = feed_scheduler.load_schedules()
    remaining = [s for s in schedules if s.get("id") != schedule_id]
    if len(remaining) == len(schedules):
        return web.json_response({"success": False, "message": "计划不存在"})
    feed_scheduler.save_schedules(remaining)
    return web.json_response({"success": True, "message": "计划已删除"})


@register_route("POST", "/api/ext/tencent-channel/publish")
async def api_publish_feed(request: web.Request):
    """立即发帖（与定时发帖同一套参数：format=text/md/html + images/videos）。"""
    body = await _json_body(request)
    normalized = feed_scheduler.normalize_schedule({**body, "cron": "* * * * *"})
    if "error" in normalized:
        return web.json_response({"success": False, "message": normalized["error"]})
    feed_scheduler.record_history({**normalized, "kind": "publish"})
    result = await asyncio.to_thread(feed_scheduler.run_schedule_sync, normalized)
    return web.json_response({"success": result["ok"], "message": result["message"]})


# ==================== 账号登录 API（供镜像页弹窗使用） ====================

_POLL_TASKS: Dict[str, asyncio.Task] = {}


def _slot_has_token(user: str) -> bool:
    """快速判断槽位是否已登录（.qqcli/.env 里是否有 token，不启子进程）。"""
    f = USERS_DIR / user / ".qqcli" / ".env"
    try:
        return "QQ_AI_CONNECT_TOKEN" in f.read_text(encoding="utf-8")
    except OSError:
        return False


@register_route("GET", "/api/ext/tencent-channel/accounts")
async def api_accounts(request: web.Request):
    """槽位列表 + 登录状态（供左下角弹窗判断「登录/切换账号」）。"""
    data = _load_users()
    accounts = []
    for name in data.get("users", []):
        accounts.append({
            "name": name,
            "nickname": data.get("nicknames", {}).get(name, ""),
            "current": name == data.get("current", ""),
            "logged_in": _slot_has_token(name),
        })
    return web.json_response({"success": True, "data": {"accounts": accounts, "current": data.get("current", "")}})


@register_route("POST", "/api/ext/tencent-channel/accounts/add")
async def api_accounts_add(request: web.Request):
    """添加账号：创建隔离槽位（或复用传入槽位）并返回登录二维码。"""
    body = await _json_body(request)
    reuse = _safe_user_name(body.get("user"))
    if reuse:
        data = _load_users()
        if reuse not in data.get("users", []):
            ok, message = add_user(reuse)
            if not ok:
                return web.json_response({"success": False, "message": message})
        user = reuse
    else:
        name = _safe_user_name(body.get("name"))
        if name:
            ok, message = add_user(name)
            if not ok:
                return web.json_response({"success": False, "message": message})
            user = name
        else:
            ok, user, message = create_auto_user()
            if not ok:
                return web.json_response({"success": False, "message": message})
    ok, output = await asyncio.to_thread(
        _run_cli, ["login", "--json", "--qrcode-path", str(USERS_DIR / user / "login-qrcode.png")], None, user
    )
    data = _extract_json(output)
    payload = (data or {}).get("data") if isinstance(data, dict) else None
    if not isinstance(payload, dict) or not payload.get("qr_code"):
        return web.json_response({"success": False, "message": "获取登录二维码失败：" + (output or "")[-300:]})
    return web.json_response({
        "success": True,
        "data": {
            "user": user,
            "qr_code": payload.get("qr_code"),
            "verification_uri": payload.get("verification_uri", ""),
            "expires_in_s": payload.get("expires_in_s", 599),
        },
    })


@register_route("POST", "/api/ext/tencent-channel/accounts/poll")
async def api_accounts_poll(request: web.Request):
    """轮询扫码结果。CLI poll-token 会阻塞至终态，这里用后台任务承载，HTTP 只查状态。"""
    body = await _json_body(request)
    user = _safe_user_name(body.get("user"))
    if not user:
        return web.json_response({"success": False, "message": "缺少账号槽位"})
    task = _POLL_TASKS.get(user)
    if task is None:

        async def _do_poll():
            ok, output = await asyncio.to_thread(_run_cli, ["login", "poll-token", "--json"], None, user)
            data = _extract_json(output)
            payload = (data or {}).get("data") if isinstance(data, dict) else None
            payload = payload if isinstance(payload, dict) else {}
            err = payload.get("error") if isinstance(payload.get("error"), dict) else {}
            message = str(payload.get("message") or err.get("message") or "")
            return ok, payload, message

        task = asyncio.create_task(_do_poll())
        _POLL_TASKS[user] = task
    if not task.done():
        return web.json_response({"success": True, "data": {"user": user, "status": "waiting"}})
    _POLL_TASKS.pop(user, None)
    try:
        ok, payload, message = task.result()
    except Exception as e:
        ok, payload, message = False, {}, f"轮询异常: {e}"
    if ok and payload.get("token") or (ok and not message):
        status = "ok"
    elif any(k in message for k in ("过期", "expire", "expired")):
        status = "expired"
    elif any(k in message for k in ("拒绝", "denied", "取消")):
        status = "denied"
    else:
        status = "failed"
    return web.json_response({
        "success": status == "ok",
        "data": {"user": user, "status": status, "message": message[:300]},
    })


@register_route("GET", "/api/ext/tencent-channel/panel-cookie")
async def api_panel_cookie(request: web.Request):
    """当前槽位的 pd.qq.com Cookie 键值对（供注入脚本做虚拟会话 Cookie）。

    页面 JS 通过 document.cookie 判断登录态（p_skey/p_uin），而镜像页跑在宿主域名下
    天然没有 pd.qq.com 的浏览器 Cookie；真实鉴权仍由代理在服务端注入 Cookie 完成。
    """
    user = get_current_user()
    cookie = _read_user_cookie_file(user)
    pairs = {}
    for part in cookie.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            k = k.strip()
            if k:
                pairs[k] = v.strip()
    # session_valid=True 表示 Cookie 文件里有真实网页会话（p_skey）：
    # 注入脚本据此决定是否给页面补虚拟登录态并接管评论等操作
    return web.json_response({
        "success": True,
        "data": {"user": user, "cookies": pairs, "session_valid": "p_skey" in pairs},
    })


@register_route("POST", "/api/ext/tencent-channel/accounts/switch")
async def api_accounts_switch(request: web.Request):
    body = await _json_body(request)
    ok, message = switch_user(body.get("name"))
    return web.json_response({"success": ok, "message": message})


@register_route("POST", "/api/ext/tencent-channel/accounts/delete")
async def api_accounts_delete(request: web.Request):
    body = await _json_body(request)
    ok, message = remove_user(body.get("name"))
    return web.json_response({"success": ok, "message": message})


# ==================== pd.qq.com 镜像静态资源 ====================
# 宿主路由表只支持精确路径匹配（不支持 {name} 动态段），
# 因此在插件加载时把 assets/ 内每个文件注册成精确路由（两种路径形态都注册）。


def _make_static_handler(filename: str):
    async def _handler(request: web.Request) -> web.Response:
        return await _serve_panel_file(filename)

    return _handler


async def _serve_panel_file(name: str) -> web.Response:
    """提供 pd.qq.com 镜像静态资源（仅 assets 目录内已注册文件，防目录穿越）。"""
    file = _ASSETS_DIR / Path(name).name
    if not file.is_file() or file.name.startswith("_"):
        return web.Response(status=404, text="not found")
    mime = _STATIC_TYPES.get(file.suffix.lower(), "application/octet-stream")
    try:
        body = await asyncio.to_thread(file.read_bytes)
    except OSError:
        return web.Response(status=404, text="not found")
    return web.Response(body=body, content_type=mime)


@register_route("POST", "/api/ext/tencent-channel/upload-image")
async def api_upload_image(request: web.Request):
    """发帖插图：base64 图片落盘到 uploads/，返回本地路径供 publish-feed --image 使用。"""
    body = await _json_body(request)
    raw = str(body.get("data") or "")
    name = os.path.basename(str(body.get("name") or "img.png")) or "img.png"
    if "," in raw[:80]:
        raw = raw.split(",", 1)[1]
    if not raw:
        return web.json_response({"success": False, "message": "缺少图片数据"})
    try:
        blob = base64.b64decode(raw)
    except Exception:
        return web.json_response({"success": False, "message": "图片数据无效"})
    if len(blob) > 12 * 1024 * 1024:
        return web.json_response({"success": False, "message": "图片超过 12MB 限制"})
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
    updir = UPLOADS_DIR
    try:
        updir.mkdir(parents=True, exist_ok=True)
        out = updir / ("txpd_%d_%s" % (int(time.time() * 1000), safe))
        out.write_bytes(blob)
    except OSError as e:
        return web.json_response({"success": False, "message": "写入失败: %s" % e})
    return web.json_response({"success": True, "data": {"path": str(out)}})


async def _serve_blocked(request: web.Request) -> web.Response:
    """被注入脚本封锁的 qq 域请求统一落到这里。

    返回 200 + 最小 JSON，而不是 204 空响应：调用方常用 res.json() 解析，
    空响应会抛 "Unexpected end of JSON input"（控制台噪音）；请求本身不会触达 qq.com。
    """
    return web.json_response({"retcode": 0, "data": {}, "message": ""})


async def _serve_panel_index(request: web.Request) -> web.Response:
    """SPA 导航兜底：baseURL 下的无后缀路径（如 /panel/explore）返回 index.html。

    注意：/panel/* 前缀路由优先级低于已注册的精确路由（宿主 longest-prefix 在精确未命中时才生效），
    所以静态资源（.js/.css 等）仍走精确路由；带后缀的未知文件拒绝兜底，防止把 404 误变成页面。
    """
    tail = request.path[len("/api/ext/tencent-channel/panel/"):] if request.path.startswith("/api/ext/tencent-channel/panel/") else ""
    tail = tail.rstrip("/")
    # 含后缀（.xxx）的请求一律不兑底——未知静态文件必须 404，且防穿越（..%2f 解码后含 ..）
    last_seg = tail.rsplit("/", 1)[-1]
    if ".." in tail or ("." in last_seg):
        return web.Response(status=404, text="not found")
    file = _PANEL_DIR / "index.html"
    if not file.is_file():
        return web.Response(status=404, text="not found")
    try:
        body = await asyncio.to_thread(file.read_bytes)
    except OSError:
        return web.Response(status=404, text="not found")
    # 深层路由（/g/<频道号>/post/<帖子>、/g/<频道号> 等）整页加载时剥离 explore 的 SSR 数据载荷：
    # Nuxt 水合发现 payload 路径(/explore) 与当前路由不一致会 router.replace 回探索页，
    # 导致帖子详情/频道视图永远落回探索页。剥离后该路由按纯客户端渲染（数据照常走代理）。
    if tail and tail != "explore":
        marker = b'<script type="application/json" data-nuxt-data="nuxt-app"'
        start = body.find(marker)
        if start != -1:
            end = body.find(b"</script>", start)
            if end != -1:
                body = body[:start] + body[end + len(b"</script>"):]
    return web.Response(body=body, content_type="text/html", charset="utf-8")


# ==================== 网页登录（扫码；只影响页面显示，不参与点赞/评论等操作） ====================
# 官方登录入口：xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=1600001587&daid=823（镜像页里抓到的原始参数）。
# 流程全部在服务端完成：取二维码 → 轮询 ptqrlogin → 跟随跳转链收 Cookie → 落盘 data/pd-cookie.txt。
# 只支持一个登录（单份 Cookie 文件），重新登录会覆盖上一个。

_WEB_LOGIN_APPID = "1600001587"
_WEB_LOGIN_DAID = "823"
_WEB_LOGIN_S_URL = "https://pd.qq.com/"
_WEB_LOGIN_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
# 唯一的登录会话（同一时刻只允许一个二维码在等）
_WEB_LOGIN: Dict[str, Any] = {
    "client": None, "qrsig": "", "status": "idle", "message": "", "nick": "",
    "created": 0.0, "last_poll": 0.0, "uin": "",
}
_WEB_LOGIN_TTL = 180.0     # 二维码最长等待时间（秒）
_WEB_LOGIN_POLL_GAP = 1.2  # 服务端轮询最小间隔，避免前端点快了把上游打爆


def _hash33(text: str) -> int:
    """ptqrtoken 算法（官方 ptlogin JS 里的 hash33）。"""
    e = 0
    for ch in text:
        e += (e << 5) + ord(ch)
    return 2147483647 & e


def _web_login_client() -> httpx.Client:
    return httpx.Client(
        headers={"User-Agent": _WEB_LOGIN_UA, "Referer": _WEB_LOGIN_S_URL},
        timeout=20,
        follow_redirects=True,
    )


def _cookie_header_of(client: httpx.Client) -> str:
    parts: List[str] = []
    for c in client.cookies.jar:
        if c.value:
            parts.append(f"{c.name}={c.value}")
    return "; ".join(parts)


def _parse_ptui_cb(text: str) -> List[str]:
    """解析 ptuiCB('code','arg2','url','arg4','msg','nick')。

    各字段的分隔、引号转义、\\uXXXX 转义在不同版本/不同阶段（未扫码、已扫码、登录成功）并不一致，
    所以这里不套固定模板：先取括号内参数串，再逐段抠引号内容，并对 \\uXXXX 做反转义。
    """
    m = re.search(r"ptuiCB\((.*)\)", text or "", re.S)
    if not m:
        return []
    parts: List[str] = []
    for raw in re.findall(r"'((?:\\.|[^'\\])*)'", m.group(1)):
        if "\\u" in raw:
            try:
                raw = raw.encode("utf-8", "surrogatepass").decode("unicode_escape")
            except Exception:
                pass
        parts.append(raw)
    return parts


def _close_web_login() -> None:
    client = _WEB_LOGIN.get("client")
    if client is not None:
        try:
            client.close()
        except Exception:
            pass
    _WEB_LOGIN.update({"client": None, "qrsig": "", "status": "idle", "message": "", "nick": "", "uin": ""})


def _slot_cookie_files() -> List[Path]:
    """各槽位目录下的网页 Cookie 文件（直接扫目录：users.json 里没有的残留槽位也要清）。"""
    out: List[Path] = []
    try:
        for d in USERS_DIR.iterdir():
            f = d / "pd-cookie.txt"
            if f.is_file():
                out.append(f)
    except OSError:
        pass
    return out


def _save_web_cookie(cookie: str) -> None:
    """网页登录态只保留一份：写全局 data/pd-cookie.txt，并清掉槽位里的同名文件（否则会被优先读到）。"""
    _ensure_parent(COOKIE_FILE)
    COOKIE_FILE.write_text(cookie, encoding="utf-8")
    for f in _slot_cookie_files():
        try:
            f.unlink()
        except OSError:
            continue
    _PROXY_COOKIES.clear()


def _drop_web_cookie() -> int:
    """清除网页登录态（全局 + 各槽位），不动 CLI 登录。返回删除的文件数。"""
    removed = 0
    for f in [COOKIE_FILE] + _slot_cookie_files():
        try:
            if f.is_file():
                f.unlink()
                removed += 1
        except OSError:
            continue
    _PROXY_COOKIES.clear()
    return removed


@register_route("POST", "/api/ext/tencent-channel/web-login/start")
async def api_web_login_start(request: web.Request):
    """取一张新的扫码二维码（会作废上一个会话）。"""
    _close_web_login()
    _WEB_LOGIN.update({"status": "waiting", "message": "等待扫码", "created": time.time(), "last_poll": 0.0})
    try:
        client = _web_login_client()
        await asyncio.to_thread(client.get, "https://xui.ptlogin2.qq.com/cgi-bin/xlogin", params={
            "appid": _WEB_LOGIN_APPID, "hide_close_icon": "1", "daid": _WEB_LOGIN_DAID,
            "s_url": _WEB_LOGIN_S_URL, "style": "20", "low_login": "0", "pt_no_auth": "0",
        })
        resp = await asyncio.to_thread(client.get, "https://ssl.ptlogin2.qq.com/ptqrshow", params={
            "appid": _WEB_LOGIN_APPID, "e": "2", "l": "M", "s": "3", "d": "72", "v": "4",
            "t": "%.8f" % (random.random() * 10 ** 17), "daid": _WEB_LOGIN_DAID, "pt_3rd_aid": "0",
        })
        qrsig = client.cookies.get("qrsig") or ""
        if resp.status_code != 200 or not qrsig or not resp.content.startswith(b"\x89PNG"):
            try:
                client.close()
            except Exception:
                pass
            _WEB_LOGIN.update({"status": "failed", "message": f"获取二维码失败（HTTP {resp.status_code}）"})
            return web.json_response({"success": False, "message": _WEB_LOGIN["message"]})
        _WEB_LOGIN.update({"client": client, "qrsig": qrsig, "status": "waiting", "message": "等待扫码"})
        return web.json_response({"success": True, "data": {
            "qrcode": "data:image/png;base64," + base64.b64encode(resp.content).decode("ascii"),
            "expires_in_s": int(_WEB_LOGIN_TTL),
        }})
    except Exception as e:
        _WEB_LOGIN.update({"status": "failed", "message": f"获取二维码失败：{e}"})
        return web.json_response({"success": False, "message": _WEB_LOGIN["message"]})


@register_route("GET", "/api/ext/tencent-channel/web-login/poll")
async def api_web_login_poll(request: web.Request):
    """轮询扫码结果；成功后把 Cookie 落盘并即刻对代理生效。"""
    client = _WEB_LOGIN.get("client")
    state = {"status": _WEB_LOGIN.get("status") or "idle", "message": _WEB_LOGIN.get("message") or "",
             "nick": _WEB_LOGIN.get("nick") or "", "uin": _WEB_LOGIN.get("uin") or ""}
    if client is None or not _WEB_LOGIN.get("qrsig"):
        return web.json_response({"success": True, "data": state})
    if time.time() - float(_WEB_LOGIN.get("created") or 0) > _WEB_LOGIN_TTL:
        _close_web_login()
        state.update({"status": "expired", "message": "二维码已过期，请重新获取"})
        return web.json_response({"success": True, "data": state})
    if state["status"] in ("ok", "expired", "denied", "failed"):
        return web.json_response({"success": True, "data": state})
    if time.time() - float(_WEB_LOGIN.get("last_poll") or 0) < _WEB_LOGIN_POLL_GAP:
        return web.json_response({"success": True, "data": state})
    _WEB_LOGIN["last_poll"] = time.time()
    try:
        resp = await asyncio.to_thread(client.get, "https://ssl.ptlogin2.qq.com/ptqrlogin", params={
            "u1": _WEB_LOGIN_S_URL, "ptqrtoken": str(_hash33(_WEB_LOGIN["qrsig"])), "ptredirect": "0",
            "h": "1", "t": "1", "g": "1", "from_ui": "1", "ptlang": "2052",
            "action": "0-0-%d" % int(time.time() * 1000), "js_ver": "10233", "js_type": "1",
            "login_sig": client.cookies.get("pt_login_sig") or "", "pt_uistyle": "40",
            "aid": _WEB_LOGIN_APPID, "daid": _WEB_LOGIN_DAID, "has_onekey": "1",
        })
        text = resp.text or ""
        parts = _parse_ptui_cb(text)
        if not parts:
            # 不落成终态：二维码还有效，下一轮再试（官方返回格式会随阶段变化，重试能自愈）
            state.update({"status": "waiting", "message": "登录返回异常，正在重试：" + text.strip()[:120]})
            _WEB_LOGIN.update(state)
            return web.json_response({"success": True, "data": state})
        code = parts[0]
        url = parts[2] if len(parts) > 2 else ""
        message = parts[4] if len(parts) > 4 else ""
        nick = parts[5] if len(parts) > 5 else ""
        if code == "0":
            # 跟随 check_sig → pd.qq.com 的跳转链收 Cookie（p_skey 等在这一步落地）
            if url:
                await asyncio.to_thread(client.get, url)
            cookie = _cookie_header_of(client)
            if "p_skey" not in cookie:
                await asyncio.to_thread(client.get, _WEB_LOGIN_S_URL)
                cookie = _cookie_header_of(client)
            if "p_skey" not in cookie:
                state.update({"status": "failed", "message": "登录成功但没拿到网页会话 Cookie（可能被风控拦截）"})
            else:
                _save_web_cookie(cookie)
                uin = ""
                for part in cookie.split(";"):
                    k, _, v = part.strip().partition("=")
                    if k in ("p_uin", "uin") and v:
                        uin = v.lstrip("o0") or v
                        break
                state.update({"status": "ok", "message": "登录成功", "nick": nick.strip(),
                              "uin": uin, "logged_in": True})
        elif code == "65":
            state.update({"status": "expired", "message": message or "二维码已失效，请重新获取"})
            _close_web_login()
        elif code == "66":
            state.update({"status": "waiting", "message": message or "等待扫码"})
        elif code == "67":
            state.update({"status": "scanned", "message": message or "已扫码，请在手机上确认"})
        elif code == "68":
            state.update({"status": "denied", "message": message or "已取消登录"})
        else:
            state.update({"status": "failed", "message": message or ("登录失败（code %s）" % code)})
        _WEB_LOGIN.update(state)
        if state["status"] == "ok":
            _WEB_LOGIN.update({"client": None, "qrsig": ""})
            try:
                client.close()
            except Exception:
                pass
        return web.json_response({"success": True, "data": state})
    except Exception as e:
        state.update({"status": "failed", "message": f"轮询失败：{e}"})
        return web.json_response({"success": True, "data": state})


@register_route("GET", "/api/ext/tencent-channel/web-login/status")
async def api_web_login_status(request: web.Request):
    """当前网页登录态（只认全局那份 Cookie；仅允许登录一个）。"""
    cookie = ""
    try:
        if COOKIE_FILE.is_file():
            cookie = COOKIE_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        cookie = ""
    pairs: Dict[str, str] = {}
    for part in cookie.split(";"):
        k, _, v = part.strip().partition("=")
        if k and v:
            pairs[k] = v
    uin = pairs.get("p_uin") or pairs.get("uin") or ""
    return web.json_response({"success": True, "data": {
        "logged_in": "p_skey" in pairs,
        "uin": uin.lstrip("o0") or uin,
        "nick": _WEB_LOGIN.get("nick") or "",
        "cookie_count": len(pairs),
        "polling": bool(_WEB_LOGIN.get("client") and _WEB_LOGIN.get("status") in ("waiting", "scanned")),
    }})


@register_route("POST", "/api/ext/tencent-channel/web-login/logout")
async def api_web_login_logout(request: web.Request):
    """退出网页登录（只清网页 Cookie，不影响 CLI 扫码登录）。"""
    _close_web_login()
    removed = _drop_web_cookie()
    return web.json_response({"success": True, "message": "已退出网页登录" if removed else "本来就没有网页登录态"})


# ==================== 页面注册 ====================


@on_load
def _register_panel():
    register_page(
        key=PAGE_KEY,
        label="腾讯频道",
        source="plugin",
        source_name=Path(__file__).resolve().parents[1].name,   # 插件目录名（与目录名一致，不写死）
        html_file=str(_PANEL_DIR / "index.html"),
        icon="message-square",
    )
    # 镜像静态资源：每个文件注册精确路由（页面 base href 下为 assets/x 两段形态）
    if _ASSETS_DIR.is_dir():
        for f in sorted(_ASSETS_DIR.iterdir()):
            if not f.is_file() or f.name.startswith("_"):
                continue
            handler = _make_static_handler(f.name)
            register_route("GET", f"/api/ext/tencent-channel/panel/{f.name}", handler)
            register_route("GET", f"/api/ext/tencent-channel/panel/assets/{f.name}", handler)
            # Vite 预加载器按「模块自身目录 + assets/」拼接，产生 assets/assets/x 双层路径，注册别名兜底
            register_route("GET", f"/api/ext/tencent-channel/panel/assets/assets/{f.name}", handler)
    # pd.qq.com 网关代理（前缀路由，透传页面本站 API 请求）
    register_route("*", "/api/ext/tencent-channel/pd/*", api_pd_proxy)
    # SPA 路由兜底：Nuxt baseURL 指向 panel/，vue-router 会把地址 rewrite 为 /panel/<path>，
    # 这些无后缀路径必须返回 index.html，否则刷新/直接访问白屏
    register_route("GET", "/api/ext/tencent-channel/panel/*", _serve_panel_index)

    # 被封锁请求的静默端点：注入脚本把 qq 域请求改写到此处，返回 204 避免控制台 404 噪音
    register_route("GET", "/api/ext/tencent-channel/__blocked", _serve_blocked)
    register_route("POST", "/api/ext/tencent-channel/__blocked", _serve_blocked)


@on_unload
def _unregister_panel():
    try:
        unregister_page(PAGE_KEY)
    except Exception:
        pass

# assets: person.CEcRjeK_.svg 已补抓（新增资源需重载插件以注册路由）
