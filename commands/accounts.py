"""账号与登录命令。"""

from .shared import *  # noqa: F401,F403


async def handle_user_list(event, match):
    data = _load_users()
    if not data["users"]:
        await event.reply(
            "还没有任何账号槽位，发送「频道添加账号 名称」创建（如：频道添加账号 小号1）"
        )
        return
    lines = ["👥 账号槽位列表（★ 为当前槽位）"]
    for user in data["users"]:
        mark = "★ " if user == data["current"] else "  "
        nick = data["nicknames"].get(user, "")
        lines.append(f"{mark}{user}" + (f"（{nick}）" if nick else ""))
    lines.append("切换：频道切换账号 名称｜查看状态：频道账号状态 名称")
    await event.reply("\n".join(lines))


async def handle_user_add(event, match):
    name = _text(event).split(None, 1)[1].strip()
    ok, msg = add_user(name)
    if ok:
        msg += "\n登录：频道切换账号 名称 → 频道登录 → 扫码 → 频道登录确认"
    await event.reply(msg)


async def handle_user_remove(event, match):
    name = _text(event).split(None, 1)[1].strip()
    ok, msg = remove_user(name)
    await event.reply(msg)


async def handle_user_switch(event, match):
    name = _text(event).split(None, 1)[1].strip()
    ok, msg = switch_user(name)
    await event.reply(msg)


async def handle_user_status(event, match):
    parts = _text(event).split(None, 1)
    name = parts[1].strip() if len(parts) > 1 else get_current_user()
    if not name:
        await event.reply("还没有任何账号槽位，发送「频道添加账号 名称」创建")
        return
    if name not in list_users():
        await event.reply(f"槽位「{name}」不存在，发送「频道账号列表」查看")
        return
    ok, output = await run_cli_async( ["login", "status", "--json"], None, name
    )
    await event.reply(
        _render_result(
            f"账号状态｜{name}",
            ok,
            _normalize_rate_limit(output),
            ["login", "status", "--json"],
        )
    )


async def handle_login(event, match):
    """扫码授权登录：返回授权链接和二维码路径，扫码后发「频道登录确认」领取 token。"""
    await _do_login(event, force=False)


async def handle_login_force(event, match):
    """强制重新扫码登录（覆盖当前槽位已有的登录态）。"""
    await _do_login(event, force=True)


async def handle_login_poll(event, match):
    _invalidate_self_user_cache()
    await _reply_cli(event, ["login", "poll-token", "--json"], title="频道登录确认")


async def handle_login_status(event, match):
    await _reply_cli(event, ["login", "status", "--json"], title="频道登录状态")


async def handle_login_logout(event, match):
    _invalidate_self_user_cache()
    await _reply_cli(event, ["login", "logout", "--json"], title="频道退出登录")


async def handle_cli_version(event, match):
    await _reply_cli(event, ["version"], title="CLI 版本")


async def handle_publish_md_feed(event, match):
    """Markdown 短帖：正文按 Markdown 渲染（--markdown-content）。"""
    parts = _text(event).split(None, 3)
    guild_id, channel_id, content = parts[1], parts[2], parts[3].strip()
    await _reply_cli(
        event,
        [
            "feed",
            "publish-feed",
            "--guild-id",
            guild_id,
            "--channel-id",
            channel_id,
            "--markdown-content",
            content,
            "--json",
        ],
        title="发布Markdown帖",
        guild_id=guild_id,
    )


async def handle_publish_md_long_feed(event, match):
    m = re.match(
        r"^频道MD长帖\s+(\S+)\s+(\S+)\s+(.+?)\s*\|\s*(.+)$", _text(event), re.S
    )
    if not m:
        await event.reply("格式：频道MD长帖 <频道ID> <版块ID> <标题> | <Markdown正文>")
        return
    guild_id, channel_id, title, content = m.groups()
    await _reply_cli(
        event,
        [
            "feed",
            "publish-feed",
            "--guild-id",
            guild_id,
            "--channel-id",
            channel_id,
            "--title",
            title.strip(),
            "--markdown-content",
            content.strip(),
            "--json",
        ],
        title="发布Markdown长帖",
        guild_id=guild_id,
    )


async def handle_notices_status(event, match):
    await _reply_cli(event, ["manage", "notices-status", "--json"], title="通知状态")


async def handle_check_notices(event, match):
    await _reply_cli(event, ["manage", "check-notices", "--json"], title="检查通知")


async def handle_recent_notices(event, match):
    await _reply_cli(
        event, ["manage", "get-recent-notices", "--json"], title="最近通知"
    )


async def handle_comment_by_ref(event, match):
    """按通知编号评论帖子本身（do-comment --ref）。"""
    parts = _text(event).split(None, 2)
    ref, content = parts[1], parts[2].strip()
    await _reply_cli(
        event,
        ["feed", "do-comment", "--ref", ref, "--content", content, "--json"],
        title="评论通知帖子",
    )


async def handle_reply_by_ref(event, match):
    """按通知编号回复对方的评论（do-reply --ref）。"""
    parts = _text(event).split(None, 2)
    ref, content = parts[1], parts[2].strip()
    await _reply_cli(
        event,
        ["feed", "do-reply", "--ref", ref, "--content", content, "--json"],
        title="回复通知评论",
    )


async def handle_deal_notice(event, match):
    parts = _parts(event)
    ref, action = parts[1], parts[2]
    action_id = "agree" if action == "同意" else "refuse"
    await _reply_cli(
        event,
        ["manage", "deal-notice", "--ref", ref, "--action-id", action_id, "--json"],
        title=f"处理通知（{action}）",
    )


async def handle_dm_reply_by_ref(event, match):
    parts = _text(event).split(None, 2)
    ref, content = parts[1], parts[2].strip()
    await _reply_cli(
        event,
        ["manage", "push-group-dm-msg", "--ref", ref, "--text", content, "--json"],
        title="回复私信通知",
    )


__all__ = [name for name in globals() if name.startswith("handle_")]
