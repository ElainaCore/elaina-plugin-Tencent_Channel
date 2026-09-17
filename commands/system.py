"""系统与诊断命令。"""

from .shared import *  # noqa: F401,F403


async def handle_help(event, match):
    await event.reply(_help_text())


async def handle_clear_cache(event, match):
    store = _load_token_store()
    token_fp = str(store.get("__token_fp__") or "").strip()
    _save_token_store({"__token_fp__": token_fp} if token_fp else {})
    await event.reply("已清理频道缓存（self id 与短令牌）")


async def handle_clear_short_tokens(event, match):
    store = _load_token_store()
    keep = {k: v for k, v in store.items() if str(k).startswith("__")}
    _save_token_store(keep)
    await event.reply("已清理短令牌缓存")


async def handle_preview_on(event, match):
    _set_switch("preview_enabled", True)
    await event.reply(
        "✅ 已开启预演模式，有风险的写操作会自动追加 --dry-run，仅验证参数，不会实际执行。"
    )


async def handle_preview_off(event, match):
    _set_switch("preview_enabled", False)
    await event.reply("✅ 已关闭预演模式。")


async def handle_debug_on(event, match):
    _set_switch("debug_enabled", True)
    await event.reply("✅ 已开启调试模式，后续会在消息末尾追加返回 JSON 大代码块。")


async def handle_debug_off(event, match):
    _set_switch("debug_enabled", False)
    await event.reply("✅ 已关闭调试模式，后续仅显示文本结果。")


async def handle_token_setup(event, match):
    parts = _text(event).split(None, 1)
    if len(parts) < 2 or not parts[1].strip():
        await event.reply("格式：频道配置token <token>")
        return
    token = parts[1].strip()
    _invalidate_self_user_cache(_fingerprint_token(token))
    ok, output = await run_cli_async( ["token", "setup", token])
    if not ok and _is_unknown_command(output):
        await event.reply(
            "当前版本 CLI 不支持手动配置 token，请使用「频道登录」扫码授权登录"
        )
        return
    await event.reply(
        _render_result(
            "配置 token", ok, _normalize_rate_limit(output), ["token", "setup", token]
        )
    )


async def handle_self_check(event, match):
    settings = _read_plugin_settings()
    store = _load_token_store()
    token_fp = str(store.get("__token_fp__") or "").strip()
    self_cache = (
        store.get("__self_user__")
        if isinstance(store.get("__self_user__"), dict)
        else {}
    )
    short_token_count = len(
        [
            k
            for k, v in store.items()
            if not str(k).startswith("__") and isinstance(v, dict)
        ]
    )

    ok, output = await asyncio.to_thread(
        _run_cli_compat, ["login", "status", "--json"], ["token", "verify"]
    )
    normalized_output = _normalize_rate_limit(output)
    data = _extract_json(normalized_output)
    verify_ok = bool(ok)
    verify_message = ""
    token_source = ""
    valid_flag = ""

    if isinstance(data, dict):
        success = data.get("success")
        if isinstance(success, bool):
            verify_ok = success
        payload = data.get("data") if isinstance(data.get("data"), dict) else {}
        for key in ("message", "msg", "error", "description"):
            value = payload.get(key) if isinstance(payload, dict) else None
            if value:
                verify_message = str(value)
                break
        if not verify_message:
            error = data.get("error")
            if isinstance(error, dict) and error.get("message"):
                verify_message = str(error["message"])
        if not verify_message:
            for key in ("message", "msg", "error", "description"):
                value = data.get(key)
                if value:
                    verify_message = str(value)
                    break
        token_source = (
            str(payload.get("tokenSource") or payload.get("token_source") or "").strip()
            if isinstance(payload, dict)
            else ""
        )
        valid_value = payload.get("valid") if isinstance(payload, dict) else None
        if isinstance(valid_value, bool):
            valid_flag = "有效" if valid_value else "无效"
    elif str(normalized_output or "").strip():
        verify_message = str(normalized_output).strip()

    rows = [
        ["登录校验", "正常" if verify_ok else "失败"],
        ["预演模式", "开启" if bool(settings.get("preview_enabled", True)) else "关闭"],
        ["调试模式", "开启" if bool(settings.get("debug_enabled", False)) else "关闭"],
        ["token 指纹", "已记录" if token_fp else "未记录"],
        ["self id 缓存", f"{len(self_cache)} 项"],
        ["短令牌缓存", f"{short_token_count} 项"],
    ]
    if token_source:
        rows.append(["token 来源", token_source])
    if valid_flag:
        rows.append(["token 有效性", valid_flag])

    lines = [
        f"{'✅' if verify_ok else '❌'} 频道自检",
        *_table(["项目", "状态"], rows),
    ]
    if verify_message:
        lines.extend(
            [
                "登录说明",
                f"- {verify_message}",
            ]
        )
    lines.extend(
        [
            "",
            "快捷操作："
            + " ".join(
                [
                    _quick_cmd("频道列表"),
                    _quick_cmd("频道帮助"),
                    _quick_cmd("频道清理缓存", "清理缓存"),
                    _quick_cmd("频道清理短令牌", "清理短令牌"),
                ]
            ),
        ]
    )
    if _debug_enabled() and str(normalized_output or "").strip():
        lines.append("")
        lines.append(_json_block(normalized_output))
    await event.reply("\n".join([x for x in lines if x is not None]))


__all__ = [name for name in globals() if name.startswith("handle_")]
