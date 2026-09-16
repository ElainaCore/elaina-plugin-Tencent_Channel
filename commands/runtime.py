import ctypes
import functools
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import asyncio
import shutil
from core.plugin.decorators import handler

BASE_DIR = Path(__file__).resolve().parent.parent
# 运行期数据统一收在插件目录的 data/ 下：账号槽位与登录态、网页 Cookie、计划任务与历史、
# 发帖上传的图片、npm 本地安装的 CLI 等都在这里；插件根目录只留代码与随包二进制。
DATA_DIR = BASE_DIR / "data"
IS_WINDOWS = sys.platform.startswith("win")
LOCAL_NPM_DIR = DATA_DIR / ".cli" / "node_modules"
LOCAL_CLI_BINS = (
    LOCAL_NPM_DIR / ".bin" / "tencent-channel-cli",
    LOCAL_NPM_DIR / "tencent-channel-cli-linux-x64" / "bin" / "tencent-channel-cli",
    LOCAL_NPM_DIR / "tencent-channel-cli-linux-arm64" / "bin" / "tencent-channel-cli",
    LOCAL_NPM_DIR / "tencent-channel-cli" / "bin" / "tencent-channel-cli",
)


def _cli_env(user: Optional[str] = None) -> Dict[str, str]:
    """CLI 子进程环境。多账号模式下每个账号槽位用独立的 HOME/USERPROFILE
    （data/users/槽位名）隔离 ~/.qqcli 登录态；未创建任何槽位时保持原有行为：
    Windows 用系统环境，Linux/macOS 在 HOME 缺失或不可写时回退到 data/.home。"""
    env = dict(os.environ)
    if not IS_WINDOWS:
        # 禁用系统钥匙串（secret service）：钥匙串是全局存储，不随 HOME 隔离，
        # 会导致多个账号槽位共用同一个 token；禁用后 CLI 自动回退到
        # 按 HOME 落盘（~/.qqcli/.env），每个槽位的 token 各自隔离。
        env["DBUS_SESSION_BUS_ADDRESS"] = (
            "unix:path=/nonexistent-qqcli-keyring-disabled"
        )
    name = _safe_user_name(user) or get_current_user()
    if name:
        home = _user_home(name)
        try:
            home.mkdir(parents=True, exist_ok=True)
        except Exception:
            return env
        env["HOME"] = str(home)
        env["USERPROFILE"] = str(home)
        return env
    if IS_WINDOWS:
        return env
    home = env.get("HOME", "")
    if not home or not os.path.isdir(home) or not os.access(home, os.W_OK):
        fallback = DATA_DIR / ".home"
        try:
            fallback.mkdir(exist_ok=True)
        except Exception:
            return env
        env["HOME"] = str(fallback)
    return env


def _ensure_executable(path: Path) -> None:
    try:
        if not os.access(path, os.X_OK):
            path.chmod(path.stat().st_mode | 0o755)
    except Exception:
        pass


def _resolve_cli() -> Optional[str]:
    """CLI 查找顺序：插件目录内置二进制（Windows: exe/cmd；Linux/macOS: linux-x64 等）
    → data/.cli 本地 npm 安装 → PATH（npm install -g tencent-channel-cli）。"""
    if IS_WINDOWS:
        local_names = (
            "tencent-channel-cli.exe",
            "tencent-channel-cli.cmd",
            "tencent-channel-cli",
        )
        path_names = ("tencent-channel-cli", "tencent-channel-cli.cmd")
    else:
        local_names = (
            "tencent-channel-cli-linux-x64",
            "tencent-channel-cli-linux-arm64",
            "tencent-channel-cli-macos-x64",
            "tencent-channel-cli-macos-arm64",
            "tencent-channel-cli",
        )
        path_names = ("tencent-channel-cli",)
    for name in local_names:
        p = BASE_DIR / name
        if p.is_file():
            if not IS_WINDOWS:
                _ensure_executable(p)
            return str(p)
    if not IS_WINDOWS:
        for p in LOCAL_CLI_BINS:
            if p.is_file():
                _ensure_executable(p)
                return str(p)
    for name in path_names:
        found = shutil.which(name)
        if found and not found.lower().endswith(".ps1"):
            return found
    return None


PLUGIN_SETTINGS = DATA_DIR / "plugin_settings.json"
TOKEN_STORE = DATA_DIR / "token_store.json"
KEYCHAIN_GLOBAL = IS_WINDOWS or sys.platform == "darwin"
KEYCHAIN_OWNER_FILE = DATA_DIR / "keychain_owner.json"
_KEYCHAIN_LOCK = threading.Lock()
ADMINS_FILE = DATA_DIR / "admins.txt"
# 插件不内置默认管理员：data/admins.txt 没有内容（或文件不存在）即视为未配置，指令会提示去填自己的 ID。
USERS_DIR = DATA_DIR / "users"
USERS_FILE = DATA_DIR / "users.json"
UPLOADS_DIR = DATA_DIR / "uploads"              # 发帖插图落盘目录
JOINED_GUILDS_FILE = DATA_DIR / "_joined_guilds.json"
COOKIE_FILE = DATA_DIR / "pd-cookie.txt"        # pd.qq.com 网页 Cookie（可选，放进来自动带登录态）


def _ensure_parent(path: Path) -> None:
    """写文件前确保父目录存在（data/ 首次使用时按需创建）。"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def _safe_user_name(name: Any) -> str:
    """槽位名校验：去除路径分隔符等危险字符，最长 32 字。非法返回空串。"""
    value = str(name or "").strip()
    if not value or value in (".", ".."):
        return ""
    if re.search(r'[\\/:*?"<>|\x00-\x1f]', value):
        return ""
    return value[:32]


def _load_users() -> Dict[str, Any]:
    data = _read_json_file(USERS_FILE, {})
    users = data.get("users") if isinstance(data.get("users"), list) else []
    users = [u for u in (_safe_user_name(x) for x in users) if u]
    current = _safe_user_name(data.get("current"))
    if current not in users:
        current = users[0] if users else ""
    nicknames = data.get("nicknames") if isinstance(data.get("nicknames"), dict) else {}
    return {"current": current, "users": users, "nicknames": nicknames}


def _save_users(data: Dict[str, Any]) -> None:
    _write_json_file(USERS_FILE, data)


def list_users() -> List[str]:
    return _load_users()["users"]


def get_current_user() -> str:
    """当前隔离账号身份；空字符串表示尚未创建登录身份。"""
    return _load_users()["current"]


def _user_home(user: str) -> Path:
    return USERS_DIR / user


def add_user(name: Any) -> Tuple[bool, str]:
    user = _safe_user_name(name)
    if not user:
        return False, '槽位名无效（不能含 \\ / : * ? " < > | 等字符，最长 32 字）'
    data = _load_users()
    if user in data["users"]:
        return False, f"槽位「{user}」已存在"
    try:
        _user_home(user).mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return False, f"创建槽位目录失败：{e}"
    first = not data["users"]
    data["users"].append(user)
    if not data["current"]:
        data["current"] = user
    _save_users(data)
    if first:
        _migrate_legacy_login(user)
    return True, f"已创建账号槽位「{user}」" + (
        "（已设为当前槽位，并尝试迁移原有登录态）" if first else ""
    )


def create_auto_user() -> Tuple[bool, str, str]:
    """创建一个无需用户命名的内部账号身份。

    账号目录仍按身份隔离，名称仅作为内部存储键，不再暴露给 Web 用户。
    """
    for _ in range(8):
        name = f"account-{uuid.uuid4().hex[:10]}"
        ok, message = add_user(name)
        if ok:
            switch_user(name)
            return True, name, message
    return False, "", "无法创建新的账号隔离目录"


def remove_user(name: Any) -> Tuple[bool, str]:
    user = _safe_user_name(name)
    data = _load_users()
    if not user or user not in data["users"]:
        return False, f"槽位「{name}」不存在"
    data["users"].remove(user)
    data["nicknames"].pop(user, None)
    if data["current"] == user:
        data["current"] = data["users"][0] if data["users"] else ""
    _save_users(data)
    if KEYCHAIN_GLOBAL and _read_keychain_owner() == user:
        # 被删槽位的登录态还留在全局钥匙串里，清掉防止其他槽位误用
        with _KEYCHAIN_LOCK:
            _keychain_clear()
            _write_keychain_owner("")
    try:
        shutil.rmtree(_user_home(user), ignore_errors=True)
    except Exception:
        pass
    return True, f"已删除账号槽位「{user}」" + (
        f"，当前槽位：{data['current'] or '无'}" if data["current"] != user else ""
    )


def switch_user(name: Any) -> Tuple[bool, str]:
    user = _safe_user_name(name)
    data = _load_users()
    if not user or user not in data["users"]:
        return False, f"槽位「{name}」不存在，先用「频道添加账号 名称」创建"
    data["current"] = user
    _save_users(data)
    return True, f"已切换到账号槽位「{user}」"


def set_user_nickname(user: str, nickname: str) -> None:
    data = _load_users()
    if user in data["users"] and str(nickname or "").strip():
        data["nicknames"][user] = str(nickname).strip()
        _save_users(data)


def _migrate_legacy_login(user: str) -> None:
    """创建第一个槽位时，把旧版单账号的登录态（~/.qqcli）与 token_store 复制进槽位，
    避免升级后需要重新扫码。失败不影响使用（重新登录即可）。"""
    home = _user_home(user)
    try:
        legacy_homes = []
        if IS_WINDOWS:
            legacy_homes = [
                os.environ.get("USERPROFILE", ""),
                os.environ.get("HOME", ""),
            ]
        else:
            legacy_homes = [os.environ.get("HOME", ""), str(DATA_DIR / ".home")]
        for legacy in legacy_homes:
            src = Path(legacy) / ".qqcli" if legacy else None
            if src and src.is_dir():
                dst = home / ".qqcli"
                if not dst.exists():
                    shutil.copytree(src, dst)
                break
        if TOKEN_STORE.exists():
            dst_store = home / "token_store.json"
            if not dst_store.exists():
                shutil.copyfile(TOKEN_STORE, dst_store)
    except Exception:
        pass


def _load_admins() -> List[str]:
    """读取插件管理员列表（一行一个，# 开头为注释）；没有配置就是空列表，不写任何默认值。"""
    try:
        text = ADMINS_FILE.read_text(encoding="utf-8")
    except OSError:
        return []
    return [x.strip() for x in text.splitlines() if x.strip() and not x.strip().startswith("#")]


def _save_admins(admins: List[str]) -> bool:
    """保存管理员列表；允许保存为空（等于清空，指令会提示去配置）。"""
    cleaned: List[str] = []
    for item in admins:
        value = str(item or "").strip()
        if value and value not in cleaned:
            cleaned.append(value)
    _ensure_parent(ADMINS_FILE)
    try:
        ADMINS_FILE.write_text(("\n".join(cleaned) + "\n") if cleaned else "", encoding="utf-8")
        return True
    except Exception:
        return False


def _admins_configured() -> bool:
    """data/admins.txt 是否已填入自己的管理员（空文件 / 只剩注释视为未配置）。"""
    return bool(_load_admins())


def _is_plugin_admin(user_id: Any) -> bool:
    uid = str(user_id or "").strip()
    if not uid:
        return False
    return uid.upper() in {a.upper() for a in _load_admins()}


def admin_handler(pattern: str, **kwargs):
    """同 @handler，但仅允许 data/admins.txt 中的插件管理员触发。"""
    kwargs.pop("owner_only", None)

    def decorator(func):
        @functools.wraps(func)
        async def wrapped(event, match):
            uid = str(getattr(event, "user_id", "") or "").strip()
            if not _is_plugin_admin(uid):
                if not _admins_configured():
                    try:
                        await event.reply(
                            "⚠️ 尚未配置插件管理员，请先在 data/admins.txt 或 Web 面板「插件管理员」页填入管理员ID。\n"
                            f"你的ID：{uid or '未知'}"
                        )
                    except Exception:
                        pass
                return
            return await func(event, match)

        return handler(pattern, **kwargs)(wrapped)

    return decorator


ENCODE_CMD_INPUT = False
MEMBER_PAGE_SIZE = 24
FEED_PAGE_SIZE = 10
GUILD_LIST_PAGE_SIZE = 10
WRITE_ACTIONS = {
    "manage": {
        "join-guild",
        "upload-guild-avatar",
        "update-guild-info",
        "create-theme-private-guild",
        "create-channel",
        "delete-channel",
        "modify-channel",
        "update-join-guild-setting",
        "push-group-dm-msg",
        "leave-guild",
        "modify-member-shut-up",
        "kick-guild-member",
        "add-admin",
        "remove-admin",
        "search-and-join",
        "deal-notice",
    },
    "feed": {
        "publish-feed",
        "alter-feed",
        "del-feed",
        "do-feed-prefer",
        "set-feed-essence",
        "push-essence-feed",
        "top-feed",
        "do-comment",
        "do-reply",
        "do-like",
        "move-feed",
        "quick-publish",
        "search-and-comment",
        "delete-and-mute",
    },
}


async def _do_login(event, force: bool) -> None:
    current = get_current_user()
    if not current:
        await event.reply(
            "⚠️ 还没有创建账号槽位。\n"
            "请先发送「频道添加账号 名称」创建一个槽位（如：频道添加账号 小号1），\n"
            "再发「频道登录」。每个槽位登录一个频道号，互不影响。"
        )
        return
    args = ["login", "--json"] + (["--yes"] if force else [])
    ok, output = await asyncio.to_thread(_run_cli, args)
    data = _extract_json(_normalize_rate_limit(output))
    payload = (
        data.get("data")
        if isinstance(data, dict) and isinstance(data.get("data"), dict)
        else (data if isinstance(data, dict) else {})
    )
    uri = str(payload.get("verification_uri") or "").strip()
    qr = str(payload.get("qrcode_path") or "").strip()
    expires = payload.get("expires_in_s")
    if ok and uri:
        lines = [
            f"🔑 频道扫码登录（当前槽位：{current}）",
            "如需登录其他号，先发「频道添加账号 名称」和「频道切换账号 名称」",
            f"👉 [点击此处打开授权页面]({uri})",
        ]
        if expires:
            lines.append(f"有效期：{expires} 秒")
        lines.append("扫码或打开链接授权后，发送「频道登录确认」完成登录")
        await event.reply("\n".join(lines), msg_type=2)
        qr_sent = False
        if qr:
            try:
                qr_bytes = Path(qr).read_bytes()
                qr_sent = bool(await event.reply_image(qr_bytes, "📱 扫描二维码授权"))
            except Exception:
                qr_sent = False
        if qr and not qr_sent:
            await event.reply(
                f"二维码图片发送失败，可打开上方授权链接完成授权（二维码文件：{qr}）"
            )
        return
    if not ok and "当前已登录" in str(output or ""):
        await event.reply(
            f"槽位「{current}」已有登录态。\n"
            "发「频道登录状态」查看当前登录信息；\n"
            "如要换号重新扫码，发「频道强制登录」（会覆盖本槽位登录态）"
        )
        return
    await event.reply(
        _render_result("频道登录", ok, _normalize_rate_limit(output), args)
    )


def _text(event) -> str:
    return str(getattr(event, "content", "") or "").strip()


def _parts(event) -> List[str]:
    return _text(event).split()


def _read_json_file(path: Path, default: Dict[str, Any]) -> Dict[str, Any]:
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else default
    except Exception:
        pass
    return dict(default)


def _read_plugin_settings() -> Dict[str, Any]:
    data = _read_json_file(PLUGIN_SETTINGS, {})
    if data:
        return data
    legacy_preview = _read_json_file(DATA_DIR / "preview_settings.json", {})
    legacy_debug = _read_json_file(DATA_DIR / "debug_settings.json", {})
    merged = {
        "preview_enabled": bool(legacy_preview.get("__global__", True)),
        "debug_enabled": bool(legacy_debug.get("__global__", False)),
    }
    _write_json_file(PLUGIN_SETTINGS, merged)
    return merged


def _write_json_file(path: Path, data: Dict[str, Any]) -> None:
    _ensure_parent(path)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _token_store_path(user: Optional[str] = None) -> Path:
    name = _safe_user_name(user) or get_current_user()
    if name:
        home = _user_home(name)
        try:
            home.mkdir(parents=True, exist_ok=True)
        except Exception:
            return TOKEN_STORE
        return home / "token_store.json"
    return TOKEN_STORE


def _load_token_store(user: Optional[str] = None) -> Dict[str, Any]:
    return _read_json_file(_token_store_path(user), {})


def _save_token_store(data: Dict[str, Any], user: Optional[str] = None) -> None:
    _write_json_file(_token_store_path(user), data)


def _fingerprint_token(token: str) -> str:
    raw = str(token or "").strip()
    if not raw:
        return ""
    return f"{len(raw)}:{raw[:8]}:{raw[-8:]}"


def _invalidate_self_user_cache(
    token_fingerprint: Optional[str] = None, user: Optional[str] = None
) -> None:
    store = _load_token_store(user)
    store.pop("__self_user__", None)
    store.pop("__guild_roles__", None)
    if token_fingerprint is not None:
        store["__token_fp__"] = str(token_fingerprint or "")
    _save_token_store(store, user)


def _refresh_guild_roles(payload: Optional[Dict[str, Any]]) -> None:
    if not isinstance(payload, dict):
        return
    role_cache: Dict[str, Any] = {}
    now = int(time.time())
    for key in ("created_guilds", "managed_guilds", "joined_guilds"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            gid = str(item.get("guild_id") or item.get("guildId") or "").strip()
            if not gid:
                continue
            role = str(
                item.get("role") or item.get("my_role") or item.get("myRole") or ""
            ).strip()
            role_cache[gid] = {"role": role, "expires_at": now + 7200}
    if role_cache:
        store = _load_token_store()
        store["__guild_roles__"] = role_cache
        _save_token_store(store)


def _sync_self_user_cache_with_token(user: Optional[str] = None) -> None:
    if "manage token show" in _UNSUPPORTED_CLI_CMDS:
        return
    ok, output = _run_cli(["manage", "token", "show", "--json"], user=user)
    if not ok:
        if _is_unknown_command(output):
            _UNSUPPORTED_CLI_CMDS.add("manage token show")
        return
    data = _extract_json(output)
    payload = (
        data.get("data")
        if isinstance(data, dict) and isinstance(data.get("data"), dict)
        else {}
    )
    token_value = str(
        payload.get("token") or payload.get("access_token") or payload.get("raw") or ""
    ).strip()
    if not token_value:
        return
    current_fp = _fingerprint_token(token_value)
    store = _load_token_store(user)
    cached_fp = str(store.get("__token_fp__") or "").strip()
    if cached_fp != current_fp:
        _invalidate_self_user_cache(current_fp, user)


def _get_self_user_id(
    guild_id: Optional[str] = None, user: Optional[str] = None
) -> Optional[str]:
    _sync_self_user_cache_with_token(user)
    store = _load_token_store(user)
    cache = (
        store.get("__self_user__")
        if isinstance(store.get("__self_user__"), dict)
        else {}
    )
    cache_key = str(guild_id or "__global__")
    cached_id = str(cache.get(cache_key) or cache.get("__global__") or "").strip()
    if cached_id:
        return cached_id

    args = ["manage", "get-user-info", "--json"]
    if guild_id:
        args[2:2] = ["--guild-id", guild_id]
    ok, output = _run_cli(args, user=user)
    nickname = ""
    if ok:
        data = _extract_json(output)
        payload = (
            data.get("data")
            if isinstance(data, dict) and isinstance(data.get("data"), dict)
            else {}
        )
        user_id = str(
            payload.get("tinyid")
            or payload.get("tiny_id")
            or payload.get("tinyId")
            or payload.get("user_id")
            or payload.get("userId")
            or ""
        ).strip()
        nickname = str(payload.get("nickname") or payload.get("nick") or "").strip()
        if user_id:
            cache[cache_key] = user_id
            cache["__global__"] = user_id
            store["__self_user__"] = cache
            _save_token_store(store, user)
            return user_id
    if not nickname:
        return None

    ok_list, output_list = _run_cli(
        ["manage", "get-my-join-guild-info", "--json"], user=user
    )
    if not ok_list:
        return None
    list_data = _extract_json(output_list)
    list_payload = (
        list_data.get("data")
        if isinstance(list_data, dict) and isinstance(list_data.get("data"), dict)
        else {}
    )

    def _collect(key: str) -> List[Dict[str, Any]]:
        items = list_payload.get(key)
        return (
            [x for x in items if isinstance(x, dict)] if isinstance(items, list) else []
        )

    created = _collect("created_guilds")
    joined = _collect("joined_guilds")
    managed = _collect("managed_guilds")

    ordered: List[Dict[str, Any]] = []
    seen = set()

    def _push(items: List[Dict[str, Any]]):
        for item in items:
            gid = str(item.get("guild_id") or item.get("guildId") or "").strip()
            if not gid or gid in seen:
                continue
            seen.add(gid)
            ordered.append(item)

    _push(created)
    _push(
        sorted(
            [x for x in joined if int(x.get("member_count") or 10**9) < 30],
            key=lambda x: int(x.get("member_count") or 10**9),
        )
    )
    _push(managed)
    remaining = created + joined + managed
    _push(sorted(remaining, key=lambda x: int(x.get("member_count") or 10**9)))

    matches: Dict[str, int] = {}
    for item in ordered:
        gid = str(item.get("guild_id") or item.get("guildId") or "").strip()
        if not gid:
            continue
        ok_search, output_search = _run_cli(
            [
                "manage",
                "guild-member-search",
                "--guild-id",
                gid,
                "--keyword",
                nickname,
                "--json",
            ],
            user=user,
        )
        if not ok_search:
            continue
        search_data = _extract_json(output_search)
        search_payload = (
            search_data.get("data")
            if isinstance(search_data, dict)
            and isinstance(search_data.get("data"), dict)
            else {}
        )
        members = search_payload.get("members")
        if not isinstance(members, list):
            continue
        exact = []
        for member in members:
            if not isinstance(member, dict):
                continue
            member_nick = str(
                member.get("nickname") or member.get("nick") or ""
            ).strip()
            tiny_id = str(
                member.get("tinyid")
                or member.get("tiny_id")
                or member.get("tinyId")
                or ""
            ).strip()
            if member_nick == nickname and tiny_id:
                exact.append(tiny_id)
        if len(exact) == 1:
            tiny_id = exact[0]
            cache[cache_key] = tiny_id
            cache[gid] = tiny_id
            cache["__global__"] = tiny_id
            store["__self_user__"] = cache
            _save_token_store(store, user)
            return tiny_id
        for tiny_id in set(exact):
            matches[tiny_id] = matches.get(tiny_id, 0) + 1
            if matches[tiny_id] >= 2:
                cache[cache_key] = tiny_id
                cache[gid] = tiny_id
                cache["__global__"] = tiny_id
                store["__self_user__"] = cache
                _save_token_store(store, user)
                return tiny_id
    return None


def _get_guild_role(guild_id: Optional[str]) -> str:
    gid = str(guild_id or "").strip()
    if not gid:
        return ""
    store = _load_token_store()
    role_cache = (
        store.get("__guild_roles__")
        if isinstance(store.get("__guild_roles__"), dict)
        else {}
    )
    cached = role_cache.get(gid)
    if isinstance(cached, dict):
        expires_at = int(cached.get("expires_at") or 0)
        role = str(cached.get("role") or "").strip()
        if role and expires_at > int(time.time()):
            return role
    elif isinstance(cached, str) and cached.strip():
        return cached.strip()
    ok, output = _run_cli(["manage", "get-my-join-guild-info", "--json"])
    if not ok:
        return ""
    data = _extract_json(output)
    payload = (
        data.get("data")
        if isinstance(data, dict) and isinstance(data.get("data"), dict)
        else {}
    )
    _refresh_guild_roles(payload)
    store = _load_token_store()
    role_cache = (
        store.get("__guild_roles__")
        if isinstance(store.get("__guild_roles__"), dict)
        else {}
    )
    cached = role_cache.get(gid)
    if isinstance(cached, dict):
        return str(cached.get("role") or "").strip()
    return ""


def _can_manage_members(guild_id: Optional[str]) -> Tuple[bool, bool]:
    role = _get_guild_role(guild_id)
    is_owner = any(x in role for x in ("频道主", "owner", "OWN"))
    is_admin = is_owner or any(x in role for x in ("管理员", "admin", "ADMIN"))
    return is_owner, is_admin


def _save_token_payload(kind: str, payload: Dict[str, Any]) -> str:
    data = _load_token_store()
    token = f"{kind[0]}{int(time.time() * 1000)}{uuid.uuid4().hex[:4]}"
    data[token] = {"kind": kind, "payload": payload}
    # 分别保留系统 key（__前缀）和用户 token，避免裁剪时误删系统缓存
    system_items = {k: v for k, v in data.items() if str(k).startswith("__")}
    user_items = [(k, v) for k, v in data.items() if not str(k).startswith("__")]
    kept = dict(user_items[-200:])
    kept.update(system_items)
    _save_token_store(kept)
    return token


def _load_token_payload(
    token: str, kind: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    data = _load_token_store()
    item = data.get(str(token or "").strip())
    if not isinstance(item, dict):
        return None
    if kind and item.get("kind") != kind:
        return None
    payload = item.get("payload")
    return payload if isinstance(payload, dict) else None


def _set_switch(key: str, enabled: bool) -> None:
    data = _read_plugin_settings()
    data[key] = bool(enabled)
    _write_json_file(PLUGIN_SETTINGS, data)


def _get_switch(key: str, default: bool) -> bool:
    data = _read_plugin_settings()
    return bool(data.get(key, default))


def _get_setting(key: str, default: Any = None) -> Any:
    return _read_plugin_settings().get(key, default)


def _set_setting(key: str, value: Any) -> None:
    data = _read_plugin_settings()
    data[key] = value
    _write_json_file(PLUGIN_SETTINGS, data)


def _preview_enabled() -> bool:
    return _get_switch("preview_enabled", True)


def _debug_enabled() -> bool:
    return _get_switch("debug_enabled", False)


def _xml_escape(text: str) -> str:
    return (
        str(text or "")
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _quote_cmd(text: str) -> str:
    raw = str(text or "")
    if not ENCODE_CMD_INPUT:
        return raw
    return urllib.parse.quote(raw, safe="")


def _shrink_token(value: Optional[str], keep: int = 6) -> str:
    raw = str(value or "").strip()
    if len(raw) <= keep * 2 + 1:
        return raw
    return f"{raw[:keep]}~{raw[-keep:]}"


def _md_cell(text: Any) -> str:
    return str(text or "").replace("|", "¦").replace("\n", " ").strip()


def _table(headers: List[str], rows: List[List[Any]]) -> List[str]:
    if not rows:
        return []
    head = "| " + " | ".join(_md_cell(x) for x in headers) + " |"
    sep = "| " + " | ".join(["---"] * len(headers)) + " |"
    body = ["| " + " | ".join(_md_cell(x) for x in row) + " |" for row in rows]
    # 前后各两个空行，防止平台渲染粘连
    return ["", "", head, sep, *body, "", ""]


def _fit_cmd_text(text: str, max_len: int = 100) -> str:
    raw = str(text or "").strip()
    if len(raw) <= max_len:
        return raw
    return raw[: max_len - 3].rstrip() + "..."


def _truncate_display_text(text: str, max_width: int = 12) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    total = 0
    out = []
    for ch in raw:
        w = 1 if ord(ch) < 128 else 2
        if total + w > max_width:
            return "".join(out).rstrip() + "..."
        out.append(ch)
        total += w
    return "".join(out)


def _member_name(item: Dict[str, Any]) -> str:
    if not isinstance(item, dict):
        return "未知成员"
    for key in (
        "昵称",
        "nick",
        "nickname",
        "name",
        "member_name",
        "memberName",
        "display_name",
        "displayName",
        "user_name",
        "userName",
        "uin_name",
        "uinName",
    ):
        value = item.get(key)
        if value not in (None, ""):
            return str(value)
    for key in ("user", "member", "profile"):
        nested = item.get(key)
        if isinstance(nested, dict):
            for sub_key in (
                "昵称",
                "nick",
                "nickname",
                "name",
                "display_name",
                "displayName",
                "user_name",
                "userName",
            ):
                value = nested.get(sub_key)
                if value not in (None, ""):
                    return str(value)
    return "未知成员"


def _member_chip(
    guild_id: Optional[str], tiny_id: Optional[str], nickname: Optional[str]
) -> str:
    gid = str(guild_id or "").strip()
    tid = str(tiny_id or "").strip()
    name = _truncate_display_text(nickname or "未知成员", 12) or "未知成员"
    if not gid or not tid:
        return name
    return _quick_cmd(f"频道用户资料 {gid} {tid}", name)


def _pair_lines(parts: List[str], sep: str = "  |  ") -> List[str]:
    rows: List[str] = []
    current: List[str] = []
    for part in parts:
        if not part:
            continue
        current.append(part)
        if len(current) == 2:
            rows.append(sep.join(current))
            current = []
    if current:
        rows.append(sep.join(current))
    return rows


def _quick_cmd(
    text: str, show: Optional[str] = None, reference: Optional[bool] = None
) -> str:
    raw = _fit_cmd_text(_quote_cmd(text), 100)
    if not raw:
        return ""
    attrs = [f'text="{_xml_escape(raw)}"']
    show_text = str(show or "").strip()
    if show_text:
        attrs.append(f'show="{_xml_escape(show_text[:100])}"')
    if isinstance(reference, bool):
        attrs.append(f'reference="{"true" if reference else "false"}"')
    return f"<qqbot-cmd-input {' '.join(attrs)} />"


_UNSUPPORTED_CLI_CMDS: set = set()


def _is_unknown_command(output: str) -> bool:
    return "unknown command" in str(output or "").lower()


def _run_cli_compat(
    primary: List[str], fallback: List[str], user: Optional[str] = None
) -> Tuple[bool, str]:
    """兼容不同版本 CLI：primary 报 unknown command 时改用旧命令 fallback。"""
    ok, output = _run_cli(primary, user=user)
    if not ok and _is_unknown_command(output):
        return _run_cli(fallback, user=user)
    return ok, output


def _read_keychain_owner() -> str:
    data = _read_json_file(KEYCHAIN_OWNER_FILE, {})
    return str(data.get("owner") or "").strip()


def _write_keychain_owner(owner: str) -> None:
    _write_json_file(KEYCHAIN_OWNER_FILE, {"owner": str(owner or "")})


ENV_TOKEN_KEY = "QQ_AI_CONNECT_TOKEN"
ENV_DEVICE_KEY = "QQ_AI_CONNECT_DEVICE_ID"
_KEYCHAIN_HINTS = ("qqcli", "qq-cli", "qq_ai_connect", "tencent-channel")


def _slot_env_file(user: str) -> Path:
    return _user_home(user) / ".qqcli" / ".env"


def _read_env_file(path: Path) -> Dict[str, str]:
    entries: Dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            entries[key.strip()] = value.strip().strip('"').strip("'")
    except Exception:
        pass
    return entries


def _write_slot_env(user: str, updates: Dict[str, str]) -> None:
    """合并写入槽位自己的 .qqcli/.env（值为空表示删除该键）。"""
    path = _slot_env_file(user)
    entries = _read_env_file(path)
    for key, value in updates.items():
        if value:
            entries[key] = value
        else:
            entries.pop(key, None)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "".join(f"{k}={v}\n" for k, v in entries.items()), encoding="utf-8"
        )
        if not IS_WINDOWS:
            path.chmod(0o600)
    except Exception:
        pass


def _get_slot_token(user: str) -> str:
    return _read_env_file(_slot_env_file(user)).get(ENV_TOKEN_KEY, "")


def _wincred_list() -> List[Tuple[str, int, str]]:
    """枚举 Windows 凭据管理器里 CLI 相关的凭据：(target, type, secret)。"""
    if not IS_WINDOWS:
        return []
    try:
        from ctypes import wintypes

        class _CREDENTIAL(ctypes.Structure):
            _fields_ = [
                ("Flags", wintypes.DWORD),
                ("Type", wintypes.DWORD),
                ("TargetName", wintypes.LPWSTR),
                ("Comment", wintypes.LPWSTR),
                ("LastWritten", wintypes.FILETIME),
                ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
                ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD),
                ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wintypes.LPWSTR),
                ("UserName", wintypes.LPWSTR),
            ]

        advapi = ctypes.windll.advapi32
        count = wintypes.DWORD()
        pcreds = ctypes.POINTER(ctypes.POINTER(_CREDENTIAL))()
        if not advapi.CredEnumerateW(
            None, 0, ctypes.byref(count), ctypes.byref(pcreds)
        ):
            return []
        results: List[Tuple[str, int, str]] = []
        try:
            for i in range(count.value):
                cred = pcreds[i].contents
                target = str(cred.TargetName or "")
                if not any(h in target.lower() for h in _KEYCHAIN_HINTS):
                    continue
                secret = ""
                if cred.CredentialBlobSize:
                    raw = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
                    secret = raw.decode("utf-8", "ignore").strip("\x00").strip()
                results.append((target, int(cred.Type), secret))
        finally:
            advapi.CredFree(pcreds)
        return results
    except Exception:
        return []


def _wincred_delete(target: str, cred_type: int) -> None:
    try:
        ctypes.windll.advapi32.CredDeleteW(target, cred_type, 0)
    except Exception:
        pass


_MAC_SERVICES = ("qqcli", "qq-cli", "tencent-channel-cli")
_MAC_ACCOUNTS = ("token", "device_id")


def _mac_keychain_read() -> Dict[str, str]:
    creds: Dict[str, str] = {}
    for service in _MAC_SERVICES:
        for account in _MAC_ACCOUNTS:
            try:
                proc = subprocess.run(
                    [
                        "security",
                        "find-generic-password",
                        "-s",
                        service,
                        "-a",
                        account,
                        "-w",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if proc.returncode == 0 and proc.stdout.strip():
                    creds[account] = proc.stdout.strip()
            except Exception:
                pass
    return creds


def _mac_keychain_clear() -> None:
    for service in _MAC_SERVICES:
        for account in _MAC_ACCOUNTS:
            try:
                subprocess.run(
                    [
                        "security",
                        "delete-generic-password",
                        "-s",
                        service,
                        "-a",
                        account,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            except Exception:
                pass


def _keychain_read() -> Dict[str, str]:
    """读取全局钥匙串里的 token/device_id（键：token、device_id）。"""
    if IS_WINDOWS:
        creds: Dict[str, str] = {}
        for target, _cred_type, secret in _wincred_list():
            if not secret:
                continue
            if "device" in target.lower():
                creds.setdefault("device_id", secret)
            else:
                creds.setdefault("token", secret)
        return creds
    if sys.platform == "darwin":
        return _mac_keychain_read()
    return {}


def _keychain_clear() -> None:
    """清空全局钥匙串里的 CLI 凭据，避免它盖过各槽位自己的 .env。"""
    if IS_WINDOWS:
        for target, cred_type, _secret in _wincred_list():
            _wincred_delete(target, cred_type)
    elif sys.platform == "darwin":
        _mac_keychain_clear()


def _migrate_keychain_to_slot(slot: str) -> None:
    """CLI 找凭证的顺序是「钥匙串 → HOME/.qqcli/.env」，而钥匙串是全局唯一
    的，会盖住所有槽位。发现钥匙串里有 token 时，把它落到归属槽位（旧版
    owner 标记指向的槽位，否则当前槽位）自己的 .env 后清空钥匙串，此后每个
    槽位只用自己目录里的 .env。"""
    creds = _keychain_read()
    token = creds.get("token", "")
    if not token:
        return
    owner = _read_keychain_owner() or slot
    updates = {ENV_TOKEN_KEY: token}
    if creds.get("device_id"):
        updates[ENV_DEVICE_KEY] = creds["device_id"]
    if not _get_slot_token(owner):
        _write_slot_env(owner, updates)
    _keychain_clear()
    _write_keychain_owner("")


def _extract_login_creds(output: str) -> Dict[str, str]:
    data = _extract_json(output)
    payload = (
        data.get("data")
        if isinstance(data, dict) and isinstance(data.get("data"), dict)
        else {}
    )
    creds: Dict[str, str] = {}
    if isinstance(payload, dict):
        token = str(payload.get("token") or payload.get("access_token") or "").strip()
        device_id = str(
            payload.get("device_id") or payload.get("deviceId") or ""
        ).strip()
        if token:
            creds["token"] = token
        if device_id:
            creds["device_id"] = device_id
    return creds


def _login_post_hook(args: List[str], ok: bool, output: str, slot: str) -> None:
    """登录/配置/退出后把凭证落到槽位自己的 .env 并保持全局钥匙串为空。"""
    if not ok or not slot:
        return
    head = tuple(args[:2])
    if head == ("login", "poll-token"):
        creds = _extract_login_creds(output) or _keychain_read()
        if creds.get("token"):
            updates = {ENV_TOKEN_KEY: creds["token"]}
            if creds.get("device_id"):
                updates[ENV_DEVICE_KEY] = creds["device_id"]
            _write_slot_env(slot, updates)
        _keychain_clear()
    elif head in (("token", "setup"), ("login", "token")) and len(args) >= 3:
        _write_slot_env(slot, {ENV_TOKEN_KEY: str(args[2])})
        _keychain_clear()
    elif head == ("login", "logout"):
        _write_slot_env(slot, {ENV_TOKEN_KEY: "", ENV_DEVICE_KEY: ""})


def _run_cli(
    args: List[str], stdin_text: Optional[str] = None, user: Optional[str] = None
) -> Tuple[bool, str]:
    ok, output, _ = _run_cli_full(args, stdin_text, user)
    return ok, output


def _run_cli_full(
    args: List[str], stdin_text: Optional[str] = None, user: Optional[str] = None
) -> Tuple[bool, str, str]:
    """同 _run_cli，但额外返回 stderr（部分命令的原始报文只在日志里）。"""
    slot = _safe_user_name(user) or get_current_user()
    if KEYCHAIN_GLOBAL and slot:
        with _KEYCHAIN_LOCK:
            _migrate_keychain_to_slot(slot)
            ok, output, stderr = _run_cli_raw(args, stdin_text, slot)
            _login_post_hook(args, ok, output, slot)
            return ok, output, stderr
    return _run_cli_raw(args, stdin_text, user)


def _run_cli_raw(
    args: List[str], stdin_text: Optional[str] = None, user: Optional[str] = None
) -> Tuple[bool, str, str]:
    cli = _resolve_cli()
    if not cli:
        return (
            False,
            (
                "未找到 tencent-channel-cli，请将 CLI 放入插件目录"
                + ("" if IS_WINDOWS else "（如 tencent-channel-cli-linux-x64 二进制）")
                + "或安装 Node.js/npm 后执行 npm install -g tencent-channel-cli"
            ),
            "",
        )
    try:
        # ``subprocess`` cannot execute a Windows ``.cmd`` shim directly when
        # shell=False (the safe default).  Invoke it through COMSPEC while
        # retaining argument boundaries; native ``.exe``/POSIX binaries keep
        # the direct path for portability.
        command: List[str]
        if IS_WINDOWS and str(cli).lower().endswith((".cmd", ".bat")):
            command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", cli, *args]
        else:
            command = [cli, *args]
        proc = subprocess.run(
            command,
            input=stdin_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(BASE_DIR),
            env=_cli_env(user),
            timeout=90,
        )
    except subprocess.TimeoutExpired:
        return False, "命令执行超时", ""
    except Exception as e:
        return False, f"命令执行失败：{e}", ""
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    if proc.returncode != 0:
        return (
            False,
            stderr or stdout or f"命令执行失败，退出码 {proc.returncode}",
            stderr,
        )
    return True, stdout or stderr or "", stderr


def _with_preview(args: List[str]) -> List[str]:
    if len(args) < 2:
        return args
    domain, action = args[0], args[1]
    if (
        domain in WRITE_ACTIONS
        and action in WRITE_ACTIONS[domain]
        and _preview_enabled()
    ):
        if "--dry-run" not in args and "-d" not in args:
            return [*args, "--dry-run"]
    return args


def _extract_json(text: str) -> Optional[Any]:
    body = str(text or "").strip()
    if not body:
        return None
    try:
        return json.loads(body)
    except Exception:
        pass
    m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", body)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def _json_block(output: str) -> str:
    body = str(output or "").strip()
    if not body:
        return ""
    return f"\n```json 返回JSON\n{body}\n```\n"


def _ret_code(data: Any) -> Optional[str]:
    if isinstance(data, dict):
        for key in ("retCode", "ret_code", "code"):
            value = data.get(key)
            if value is not None:
                return str(value)
    return None


def _normalize_rate_limit(output: str) -> str:
    data = _extract_json(output)
    text = str(output or "")
    code = _ret_code(data)
    if code == "153" or "接口调用已超过申请的频率上限" in text:
        return "接口触发频率限制，请稍后再试"
    return output


__all__ = [name for name in globals() if not name.startswith("__")]

__all__ = [name for name in globals() if not name.startswith("__")]
