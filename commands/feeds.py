"""帖子与评论命令。"""

from .shared import *  # noqa: F401,F403


async def handle_feed_list(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    if len(parts) >= 3 and re.fullmatch(r"f[0-9a-f]+", parts[2]):
        payload = _load_token_payload(parts[2], kind="feed_page")
        if not payload:
            await event.reply("帖子翻页令牌无效或已过期，请重新打开帖子列表后再试")
            return
        await _reply_cli(
            event,
            [
                "feed",
                "get-guild-feeds",
                "--guild-id",
                payload["guild_id"],
                "--get-type",
                str(payload.get("get_type") or 2),
                "--feed-attach-info",
                payload["attach_info"],
                "--json",
            ],
            title="频道帖子",
            guild_id=payload["guild_id"],
        )
        return
    args = ["feed", "get-guild-feeds", "--guild-id", guild_id, "--get-type", "2"]
    if len(parts) >= 3:
        args += ["--feed-attach-info", " ".join(parts[2:]).strip()]
    args += ["--json"]
    await _reply_cli(event, args, title="频道帖子", guild_id=guild_id)


async def handle_search_feeds(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    if len(parts) >= 3 and re.fullmatch(r"f[0-9a-f]+", parts[2]):
        payload = _load_token_payload(parts[2], kind="search_feed_page")
        if not payload:
            await event.reply("搜帖翻页令牌无效或已过期，请重新打开搜索结果后再试")
            return
        keyword = str(payload.get("query") or payload.get("keyword") or "").strip()
        if not keyword:
            await event.reply("搜帖翻页参数缺失，请重新执行 频道搜帖 <频道ID> <关键词>")
            return
        await _reply_cli(
            event,
            [
                "feed",
                "search-guild-feeds",
                "--guild-id",
                payload["guild_id"],
                "--keyword",
                keyword,
                "--next-page-cookie",
                payload["next_page_cookie"],
                "--json",
            ],
            title="频道搜帖",
            guild_id=payload["guild_id"],
        )
        return
    keyword = " ".join(parts[2:]).strip()
    if not keyword:
        await event.reply("格式：频道搜帖 <频道ID> <关键词>")
        return
    await _reply_cli(
        event,
        [
            "feed",
            "search-guild-feeds",
            "--guild-id",
            guild_id,
            "--keyword",
            keyword,
            "--json",
        ],
        title="频道搜帖",
        guild_id=guild_id,
    )


async def handle_feed_detail(event, match):
    parts = _parts(event)
    feed_id = parts[1]
    args = ["feed", "get-feed-detail", "--feed-id", feed_id, "--json"]
    guild_id = parts[2] if len(parts) >= 3 else None
    if guild_id:
        args[2:2] = ["--guild-id", guild_id]
    await _reply_cli(event, args, title="帖子详情", guild_id=guild_id)


async def handle_feed_comments(event, match):
    parts = _parts(event)
    if len(parts) < 2:
        await event.reply("格式：帖子评论 <帖子ID> [频道ID] 或 帖子评论 <评论翻页令牌>")
        return
    if re.fullmatch(r"c[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="comment_page")
        if not payload:
            await event.reply("评论翻页令牌无效或已过期，请重新打开评论列表后再试")
            return
        args = ["feed", "get-feed-comments", "--feed-id", payload["feed_id"]]
        if payload.get("guild_id"):
            args += ["--guild-id", payload["guild_id"]]
        if payload.get("channel_id"):
            args += ["--channel-id", payload["channel_id"]]
        args += ["--attach-info", payload["attach_info"], "--json"]
        await _reply_cli(
            event, args, title="帖子评论", guild_id=payload.get("guild_id")
        )
        return
    feed_id = parts[1]
    guild_id = parts[2] if len(parts) >= 3 else None
    args = ["feed", "get-feed-comments", "--feed-id", feed_id]
    if guild_id:
        args += ["--guild-id", guild_id]
    args += ["--json"]
    await _reply_cli(event, args, title="帖子评论", guild_id=guild_id)


async def handle_reply_list(event, match):
    """帖子回复统一入口：回复令牌回复评论 / 翻页令牌看更多回复 / 显式参数查回复列表。"""
    parts = _parts(event)
    if len(parts) >= 2 and re.fullmatch(r"r[0-9a-f]+", parts[1]):
        token = parts[1]
        payload = _load_token_payload(token, kind="reply_page")
        if not payload:
            if _load_token_payload(token, kind="reply_comment"):
                if len(parts) >= 3:
                    await handle_reply_comment(event, match)
                else:
                    await event.reply("格式：帖子回复 <回复令牌> <内容>")
                return
            await event.reply("回复令牌无效或已过期，请重新打开评论列表后再试")
            return
        args = [
            "feed",
            "get-next-page-replies",
            "--feed-id",
            payload["feed_id"],
            "--comment-id",
            payload["comment_id"],
            "--guild-id",
            payload["guild_id"],
            "--channel-id",
            payload["channel_id"],
        ]
        attach_info = payload.get("attach_info")
        if attach_info:
            args += ["--attach-info", attach_info]
        args += ["--json"]
        await _reply_cli(
            event, args, title="评论回复", guild_id=payload.get("guild_id")
        )
        return
    if len(parts) < 5:
        await event.reply(
            "格式：帖子回复 <回复令牌> <内容> 或 帖子回复 <帖子ID> <评论ID> <频道ID> <版块ID> [attach_info]"
        )
        return
    feed_id, comment_id, guild_id, channel_id = parts[1], parts[2], parts[3], parts[4]
    args = [
        "feed",
        "get-next-page-replies",
        "--feed-id",
        feed_id,
        "--comment-id",
        comment_id,
        "--guild-id",
        guild_id,
        "--channel-id",
        channel_id,
    ]
    if len(parts) >= 6:
        args += ["--attach-info", " ".join(parts[5:]).strip()]
    args += ["--json"]
    await _reply_cli(event, args, title="评论回复", guild_id=guild_id)


async def handle_publish_comment(event, match):
    parts = _parts(event)
    if len(parts) < 4:
        await event.reply(
            "格式：帖子评论 <帖子ID> <帖子创建时间> [频道ID] [版块ID] <内容>"
        )
        return
    feed_id = parts[1]
    feed_create_time = parts[2]
    guild_id = None
    channel_id = None
    content_start = 3
    if len(parts) >= 6:
        guild_id = parts[3]
        channel_id = parts[4]
        content_start = 5
    content = " ".join(parts[content_start:]).strip()
    if not content:
        await event.reply(
            "格式：帖子评论 <帖子ID> <帖子创建时间> [频道ID] [版块ID] <内容>"
        )
        return
    args = [
        "feed",
        "do-comment",
        "--feed-id",
        feed_id,
        "--feed-create-time",
        feed_create_time,
        "--content",
        content,
        "--json",
    ]
    if guild_id and channel_id:
        args[2:2] = ["--guild-id", guild_id, "--channel-id", channel_id]
    await _reply_cli(event, args, title="发表评论", guild_id=guild_id)


async def handle_feed_share(event, match):
    parts = _parts(event)
    feed_id = parts[1]
    args = ["feed", "get-feed-share-url", "--feed-id", feed_id, "--json"]
    guild_id = parts[2] if len(parts) >= 3 else None
    if guild_id:
        args[2:2] = ["--guild-id", guild_id]
    await _reply_cli(event, args, title="帖子分享链接", guild_id=guild_id)


async def handle_publish_feed(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    channel_id = parts[2]
    content = " ".join(parts[3:]).strip()
    await _reply_cli(
        event,
        [
            "feed",
            "publish-feed",
            "--guild-id",
            guild_id,
            "--channel-id",
            channel_id,
            "--content",
            content,
            "--json",
        ],
        title="发布帖子",
        guild_id=guild_id,
    )


async def handle_publish_long_feed(event, match):
    m = re.match(r"^频道长帖\s+(\S+)\s+(\S+)\s+(.+?)\s*\|\s*(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道长帖 <频道ID> <版块ID> <标题> | <正文>")
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
            "--content",
            content.strip(),
            "--json",
        ],
        title="发布长帖",
        guild_id=guild_id,
    )


async def handle_feed_like(event, match):
    parts = _parts(event)
    feed_id = parts[1]
    args = ["feed", "do-feed-prefer", "--feed-id", feed_id, "--action", "1", "--json"]
    guild_id = parts[2] if len(parts) >= 4 else None
    channel_id = parts[3] if len(parts) >= 4 else None
    if guild_id and channel_id:
        args[2:2] = ["--guild-id", guild_id, "--channel-id", channel_id]
    await _reply_cli(event, args, title="帖子点赞", guild_id=guild_id)


async def handle_feed_unlike(event, match):
    parts = _parts(event)
    feed_id = parts[1]
    args = ["feed", "do-feed-prefer", "--feed-id", feed_id, "--action", "3", "--json"]
    guild_id = parts[2] if len(parts) >= 4 else None
    channel_id = parts[3] if len(parts) >= 4 else None
    if guild_id and channel_id:
        args[2:2] = ["--guild-id", guild_id, "--channel-id", channel_id]
    await _reply_cli(event, args, title="帖子取消点赞", guild_id=guild_id)


async def handle_reply_comment(event, match):
    parts = _parts(event)
    if len(parts) >= 3 and re.fullmatch(r"r[0-9a-f]+", parts[1]):
        token = parts[1]
        payload = _load_token_payload(token, kind="reply_comment")
        if not payload:
            await event.reply("回复令牌无效或已过期，请重新打开评论列表后再试")
            return
        content = " ".join(parts[2:]).strip()
        if not content:
            await event.reply("格式：帖子评论回复 <回复令牌> <内容>")
            return
        replier_id = (
            payload.get("replier_id")
            or _get_self_user_id(payload.get("guild_id"))
            or _get_self_user_id()
        )
        if not replier_id:
            await event.reply(
                "无法自动获取自己的用户ID，请先执行一次：频道用户资料 或 频道用户资料 <频道ID>"
            )
            return
        args = [
            "feed",
            "do-reply",
            "--feed-id",
            payload["feed_id"],
            "--comment-id",
            payload["comment_id"],
            "--replier-id",
            replier_id,
            "--feed-author-id",
            payload["feed_author_id"],
            "--feed-create-time",
            payload["feed_create_time"],
            "--comment-author-id",
            payload["comment_author_id"],
            "--comment-create-time",
            payload["comment_create_time"],
            "--content",
            content,
            "--json",
        ]
        if payload.get("target_reply_id") and payload.get("target_user_id"):
            args[2:2] = [
                "--target-reply-id",
                payload["target_reply_id"],
                "--target-user-id",
                payload["target_user_id"],
            ]
            if payload.get("target_user_nick"):
                args[2:2] = ["--target-user-nick", payload["target_user_nick"]]
        await _reply_cli(
            event, args, title="回复评论", guild_id=payload.get("guild_id")
        )
        return
    m = re.match(
        r"^帖子评论回复\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$",
        _text(event),
        re.S,
    )
    if not m:
        await event.reply("格式：帖子评论回复 <回复令牌> <内容>")
        return
    (
        feed_id,
        comment_id,
        replier_id,
        feed_author_id,
        feed_create_time,
        comment_author_id,
        comment_create_time,
        content,
    ) = m.groups()
    await _reply_cli(
        event,
        [
            "feed",
            "do-reply",
            "--feed-id",
            feed_id,
            "--comment-id",
            comment_id,
            "--replier-id",
            replier_id,
            "--feed-author-id",
            feed_author_id,
            "--feed-create-time",
            feed_create_time,
            "--comment-author-id",
            comment_author_id,
            "--comment-create-time",
            comment_create_time,
            "--content",
            content.strip(),
            "--json",
        ],
        title="回复评论",
    )


async def handle_delete_comment(event, match):
    parts = _parts(event)
    if len(parts) >= 2 and re.fullmatch(r"d[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="delete_comment")
        if not payload:
            await event.reply("删除评论令牌无效或已过期，请重新打开评论列表后再试")
            return
        args = [
            "feed",
            "do-comment",
            "--comment-type",
            "0",
            "--feed-id",
            payload["feed_id"],
            "--comment-id",
            payload["comment_id"],
            "--comment-author-id",
            payload["comment_author_id"],
            "--feed-create-time",
            payload["feed_create_time"],
            "--yes",
            "--json",
        ]
        if payload.get("guild_id") and payload.get("channel_id"):
            args[2:2] = [
                "--guild-id",
                payload["guild_id"],
                "--channel-id",
                payload["channel_id"],
            ]
        await _reply_cli(
            event, args, title="删除评论", guild_id=payload.get("guild_id")
        )
        return
    if len(parts) < 5:
        await event.reply(
            "格式：删除评论 <删除令牌> 或 删除评论 <帖子ID> <评论ID> <评论作者ID> <帖子创建时间> [频道ID] [版块ID]"
        )
        return
    feed_id, comment_id, comment_author_id, feed_create_time = (
        parts[1],
        parts[2],
        parts[3],
        parts[4],
    )
    args = [
        "feed",
        "do-comment",
        "--comment-type",
        "0",
        "--feed-id",
        feed_id,
        "--comment-id",
        comment_id,
        "--comment-author-id",
        comment_author_id,
        "--feed-create-time",
        feed_create_time,
        "--yes",
        "--json",
    ]
    guild_id = parts[5] if len(parts) >= 7 else None
    channel_id = parts[6] if len(parts) >= 7 else None
    if guild_id and channel_id:
        args[2:2] = ["--guild-id", guild_id, "--channel-id", channel_id]
    await _reply_cli(event, args, title="删除评论", guild_id=guild_id)


async def handle_delete_reply(event, match):
    parts = _parts(event)
    if len(parts) >= 2 and re.fullmatch(r"d[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="delete_reply")
        if not payload:
            await event.reply("删除回复令牌无效或已过期，请重新打开回复列表后再试")
            return
        args = [
            "feed",
            "do-reply",
            "--reply-type",
            "0",
            "--feed-id",
            payload["feed_id"],
            "--comment-id",
            payload["comment_id"],
            "--reply-id",
            payload["reply_id"],
            "--replier-id",
            payload["replier_id"],
            "--feed-author-id",
            payload["feed_author_id"],
            "--feed-create-time",
            payload["feed_create_time"],
            "--comment-author-id",
            payload["comment_author_id"],
            "--comment-create-time",
            payload["comment_create_time"],
            "--yes",
            "--json",
        ]
        if payload.get("guild_id") and payload.get("channel_id"):
            args[2:2] = [
                "--guild-id",
                payload["guild_id"],
                "--channel-id",
                payload["channel_id"],
            ]
        await _reply_cli(
            event, args, title="删除回复", guild_id=payload.get("guild_id")
        )
        return
    if len(parts) < 9:
        await event.reply(
            "格式：删除回复 <帖子ID> <评论ID> <回复ID> <回复作者ID> <帖子作者ID> <帖子创建时间> <评论作者ID> <评论创建时间> [频道ID] [版块ID]"
        )
        return
    feed_id, comment_id, reply_id, replier_id, feed_author_id, feed_create_time = (
        parts[1],
        parts[2],
        parts[3],
        parts[4],
        parts[5],
        parts[6],
    )
    comment_author_id, comment_create_time = parts[7], parts[8]
    args = [
        "feed",
        "do-reply",
        "--reply-type",
        "0",
        "--feed-id",
        feed_id,
        "--comment-id",
        comment_id,
        "--reply-id",
        reply_id,
        "--replier-id",
        replier_id,
        "--feed-author-id",
        feed_author_id,
        "--feed-create-time",
        feed_create_time,
        "--comment-author-id",
        comment_author_id,
        "--comment-create-time",
        comment_create_time,
        "--yes",
        "--json",
    ]
    guild_id = parts[9] if len(parts) >= 11 else None
    channel_id = parts[10] if len(parts) >= 11 else None
    if guild_id and channel_id:
        args[2:2] = ["--guild-id", guild_id, "--channel-id", channel_id]
    await _reply_cli(event, args, title="删除回复", guild_id=guild_id)


async def handle_like_reply(event, match):
    await _handle_reply_like(event, like_type="5", title="回复点赞")


async def handle_unlike_reply(event, match):
    await _handle_reply_like(event, like_type="6", title="回复取消点赞")


async def handle_like_comment(event, match):
    await _handle_comment_like(event, like_type="3", title="评论点赞")


async def handle_unlike_comment(event, match):
    await _handle_comment_like(event, like_type="4", title="评论取消点赞")


async def handle_feed_essence_on(event, match):
    feed_id = _parts(event)[1]
    await _reply_cli(
        event,
        ["feed", "set-feed-essence", "--feed-id", feed_id, "--action", "1", "--json"],
        title="帖子设精华",
    )


async def handle_feed_essence_off(event, match):
    feed_id = _parts(event)[1]
    await _reply_cli(
        event,
        ["feed", "set-feed-essence", "--feed-id", feed_id, "--action", "2", "--json"],
        title="帖子取消精华",
    )


async def handle_feed_push_essence(event, match):
    feed_id = _parts(event)[1]
    await _reply_cli(
        event,
        ["feed", "push-essence-feed", "--feed-id", feed_id, "--json"],
        title="帖子推送精华",
    )


async def handle_delete_feed(event, match):
    parts = _parts(event)
    feed_id, guild_id, channel_id, create_time = parts[1], parts[2], parts[3], parts[4]
    await _reply_cli(
        event,
        [
            "feed",
            "del-feed",
            "--feed-id",
            feed_id,
            "--guild-id",
            guild_id,
            "--channel-id",
            channel_id,
            "--create-time",
            create_time,
            "--yes",
            "--json",
        ],
        title="删除帖子",
        guild_id=guild_id,
    )


async def handle_top_feed(event, match):
    parts = _parts(event)
    feed_id, user_id, create_time, guild_id = parts[1], parts[2], parts[3], parts[4]
    await _reply_cli(
        event,
        [
            "feed",
            "top-feed",
            "--feed-id",
            feed_id,
            "--user-id",
            user_id,
            "--create-time",
            create_time,
            "--guild-id",
            guild_id,
            "--action",
            "1",
            "--top-type",
            "1",
            "--json",
        ],
        title="帖子置顶",
        guild_id=guild_id,
    )


async def handle_untop_feed(event, match):
    parts = _parts(event)
    feed_id, user_id, create_time, guild_id = parts[1], parts[2], parts[3], parts[4]
    await _reply_cli(
        event,
        [
            "feed",
            "top-feed",
            "--feed-id",
            feed_id,
            "--user-id",
            user_id,
            "--create-time",
            create_time,
            "--guild-id",
            guild_id,
            "--action",
            "2",
            "--top-type",
            "1",
            "--json",
        ],
        title="帖子取消置顶",
        guild_id=guild_id,
    )


async def handle_alter_feed(event, match):
    m = re.match(
        r"^帖子修改\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(短帖|长帖|1|2)\s+(.+)$",
        _text(event),
        re.S,
    )
    if not m:
        await event.reply(
            "格式：帖子修改 <帖子ID> <频道ID> <版块ID> <创建时间> <短帖|长帖> <内容>\n长帖可用：帖子修改 帖子ID 频道ID 版块ID 创建时间 长帖 标题 | 正文"
        )
        return
    feed_id, guild_id, channel_id, create_time, feed_type_text, body = m.groups()
    feed_type = "2" if feed_type_text in {"长帖", "2"} else "1"
    args = [
        "feed",
        "alter-feed",
        "--feed-id",
        feed_id,
        "--guild-id",
        guild_id,
        "--channel-id",
        channel_id,
        "--create-time",
        create_time,
        "--feed-type",
        feed_type,
        "--json",
    ]
    if feed_type == "2":
        if "|" not in body:
            await event.reply(
                "长帖修改格式：帖子修改 <帖子ID> <频道ID> <版块ID> <创建时间> 长帖 <标题> | <正文>"
            )
            return
        title, content = [x.strip() for x in body.split("|", 1)]
        if not title or not content:
            await event.reply("长帖标题和正文都不能为空")
            return
        args.extend(["--title", title, "--content", content])
    else:
        content = body.strip()
        if not content:
            await event.reply("短帖内容不能为空")
            return
        args.extend(["--content", content])
    await _reply_cli(event, args, title="修改帖子", guild_id=guild_id)


async def handle_move_feed(event, match):
    parts = _parts(event)
    feed_id, guild_id, original_channel_id, target_channel_id = (
        parts[1],
        parts[2],
        parts[3],
        parts[4],
    )
    await _reply_cli(
        event,
        [
            "feed",
            "move-feed",
            "--guild-id",
            guild_id,
            "--channel-id",
            target_channel_id,
            "--original-channel-id",
            original_channel_id,
            "--feed-id",
            feed_id,
            "--json",
        ],
        title="移动帖子",
        guild_id=guild_id,
    )


__all__ = [name for name in globals() if name.startswith("handle_")]
