"""命令输出格式化、帮助文本与交互回复辅助。"""

from .runtime import *  # noqa: F401,F403


async def _reply_cli(
    event, args: List[str], title: str, guild_id: Optional[str] = None
):
    final_args = _with_preview(args)
    ok, output = await run_cli_async( final_args)
    await event.reply(
        _render_result(
            title, ok, _normalize_rate_limit(output), final_args, guild_id=guild_id
        )
    )


async def _reply_cli_json_stdin(
    event,
    args: List[str],
    payload: Dict[str, Any],
    title: str,
    guild_id: Optional[str] = None,
):
    final_args = _with_preview(args)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    ok, output = await run_cli_async( final_args, body)
    await event.reply(
        _render_result(
            title, ok, _normalize_rate_limit(output), final_args, guild_id=guild_id
        )
    )


async def _handle_comment_like(event, like_type: str, title: str):
    parts = _parts(event)
    if len(parts) >= 2 and re.fullmatch(r"l[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="comment_like")
        if not payload:
            await event.reply("评论点赞令牌无效或已过期，请重新打开评论列表后再试")
            return
        args = [
            "feed",
            "do-like",
            "--like-type",
            like_type,
            "--feed-id",
            payload["feed_id"],
            "--comment-id",
            payload["comment_id"],
            "--feed-author-id",
            payload["feed_author_id"],
            "--feed-create-time",
            payload["feed_create_time"],
            "--comment-author-id",
            payload["comment_author_id"],
        ]
        if payload.get("guild_id") and payload.get("channel_id"):
            args += [
                "--guild-id",
                payload["guild_id"],
                "--channel-id",
                payload["channel_id"],
            ]
        args += ["--json"]
        await _reply_cli(event, args, title=title, guild_id=payload.get("guild_id"))
        return
    m = re.match(
        r"^(?:评论点赞|评论取消点赞)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+)\s+(\S+))?$",
        _text(event),
        re.S,
    )
    if not m:
        await event.reply(
            "格式：评论点赞 <评论令牌> 或 评论点赞 <帖子ID> <评论ID> <帖子作者ID> <帖子创建时间> <评论作者ID> [频道ID] [版块ID]"
        )
        return
    (
        feed_id,
        comment_id,
        feed_author_id,
        feed_create_time,
        comment_author_id,
        guild_id,
        channel_id,
    ) = m.groups()
    args = [
        "feed",
        "do-like",
        "--like-type",
        like_type,
        "--feed-id",
        feed_id,
        "--comment-id",
        comment_id,
        "--feed-author-id",
        feed_author_id,
        "--feed-create-time",
        feed_create_time,
        "--comment-author-id",
        comment_author_id,
    ]
    if guild_id and channel_id:
        args += ["--guild-id", guild_id, "--channel-id", channel_id]
    args += ["--json"]
    await _reply_cli(event, args, title=title, guild_id=guild_id)


async def _handle_reply_like(event, like_type: str, title: str):
    parts = _parts(event)
    if len(parts) >= 2 and re.fullmatch(r"l[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="reply_like")
        if not payload:
            await event.reply("回复点赞令牌无效或已过期，请重新打开回复列表后再试")
            return
        args = [
            "feed",
            "do-like",
            "--like-type",
            like_type,
            "--feed-id",
            payload["feed_id"],
            "--comment-id",
            payload["comment_id"],
            "--reply-id",
            payload["reply_id"],
            "--feed-author-id",
            payload["feed_author_id"],
            "--feed-create-time",
            payload["feed_create_time"],
            "--comment-author-id",
            payload["comment_author_id"],
            "--reply-author-id",
            payload["reply_author_id"],
        ]
        if payload.get("guild_id") and payload.get("channel_id"):
            args += [
                "--guild-id",
                payload["guild_id"],
                "--channel-id",
                payload["channel_id"],
            ]
        args += ["--json"]
        await _reply_cli(event, args, title=title, guild_id=payload.get("guild_id"))
        return
    m = re.match(
        r"^(?:回复点赞|回复取消点赞)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+)\s+(\S+))?$",
        _text(event),
        re.S,
    )
    if not m:
        await event.reply(
            "格式：回复点赞 <回复令牌> 或 回复点赞 <帖子ID> <评论ID> <回复ID> <帖子作者ID> <帖子创建时间> <评论作者ID> <回复作者ID> [频道ID] [版块ID]"
        )
        return
    (
        feed_id,
        comment_id,
        reply_id,
        feed_author_id,
        feed_create_time,
        comment_author_id,
        reply_author_id,
        guild_id,
        channel_id,
    ) = m.groups()
    args = [
        "feed",
        "do-like",
        "--like-type",
        like_type,
        "--feed-id",
        feed_id,
        "--comment-id",
        comment_id,
        "--reply-id",
        reply_id,
        "--feed-author-id",
        feed_author_id,
        "--feed-create-time",
        feed_create_time,
        "--comment-author-id",
        comment_author_id,
        "--reply-author-id",
        reply_author_id,
    ]
    if guild_id and channel_id:
        args += ["--guild-id", guild_id, "--channel-id", channel_id]
    args += ["--json"]
    await _reply_cli(event, args, title=title, guild_id=guild_id)


def _parse_duration_to_timestamp(text: str) -> Optional[int]:
    raw = str(text or "").strip()
    if not raw:
        return None
    total = 0
    matched = False
    for value, unit in re.findall(r"(\d+)\s*(天|日|小时|时|分钟|分|秒)", raw):
        matched = True
        num = int(value)
        if unit in {"天", "日"}:
            total += num * 86400
        elif unit in {"小时", "时"}:
            total += num * 3600
        elif unit in {"分钟", "分"}:
            total += num * 60
        elif unit == "秒":
            total += num
    if not matched or total <= 0:
        return None
    return int(time.time()) + total


def _render_result(
    title: str, ok: bool, output: str, args: List[str], guild_id: Optional[str] = None
) -> str:
    data = _extract_json(output)
    lines: List[str] = [f"{'✅' if ok else '❌'} {title}"]

    if "--dry-run" in args or "-d" in args:
        lines.append("模式：预演模式（仅验证参数，不实际执行）")

    success = data.get("success") if isinstance(data, dict) else None
    if isinstance(success, bool):
        for key in ("message", "msg", "error", "description"):
            value = data.get(key)
            if value:
                lines.append(f"说明：{value}")
                break
        nested = data.get("data")
        if isinstance(nested, dict):
            status = nested.get("status")
            if status:
                lines.append(f"状态：{status}")
            if nested.get("need_verification"):
                lines.append(
                    "需要验证：该频道加入需要附言或答题，请根据返回内容继续操作"
                )
                if guild_id:
                    lines.append(
                        _quick_cmd(
                            f"频道加入附言 {guild_id} 我想加入这个频道", "加入附言"
                        )
                    )
                    lines.append(
                        _quick_cmd(f"频道加入答题 {guild_id} 答案1|答案2", "加入答题")
                    )
            pending = nested.get("pending")
            if isinstance(pending, dict):
                hint = pending.get("hint")
                if hint:
                    lines.append(f"下一步：{hint}")
                resume = nested.get("resume_command") or pending.get("resume_command")
                if resume:
                    lines.append(_quick_cmd(resume, "继续执行"))
        summary_lines = _render_summary(title, data, guild_id=guild_id) or []
        # 如果 _render_summary 没有针对该 title 的专门处理（只返回了空或极少内容），
        # 用通用兜底渲染展示关键字段，避免用户看到原始 JSON
        has_real_content = any(
            l
            for l in summary_lines
            if l and not l.startswith("|") and not l.startswith("---")
        )
        if not has_real_content:
            summary_lines = _render_fallback_summary(data) or []
        lines.extend(summary_lines)
    else:
        brief = str(output or "").strip()
        if brief:
            lines.append(f"结果：{brief}")

    if _debug_enabled() and str(output or "").strip():
        lines.append("")
        lines.append(_json_block(output))

    return "\n".join([x for x in lines if x is not None])


def _render_summary(
    title: str, data: Dict[str, Any], guild_id: Optional[str] = None
) -> List[str]:
    lines: List[str] = []
    payload = data.get("data") if isinstance(data.get("data"), dict) else data

    if title == "频道列表":
        local_groups = payload.get("_guild_list_groups")
        local_page_index = int(payload.get("_guild_list_page_index", 0) or 0)
        local_expires_at = int(payload.get("_guild_list_expires_at", 0) or 0)

        groups_to_render = []
        if isinstance(local_groups, list) and local_groups:
            groups_to_render = local_groups
        else:
            for key, label in (
                ("created_guilds", "我创建的频道"),
                ("managed_guilds", "我管理的频道"),
                ("joined_guilds", "我加入的频道"),
            ):
                items = payload.get(key)
                if isinstance(items, list) and items:
                    pages = max(
                        1,
                        (len(items) + GUILD_LIST_PAGE_SIZE - 1) // GUILD_LIST_PAGE_SIZE,
                    )
                    groups_to_render.append(
                        {
                            "key": key,
                            "label": label,
                            "items": items,
                            "pages": pages,
                        }
                    )

        has_guild = False
        max_page = 1
        for group in groups_to_render:
            if not isinstance(group, dict):
                continue
            label = group.get("label") or "频道列表"
            items = group.get("items") if isinstance(group.get("items"), list) else []
            pages = int(group.get("pages", 1) or 1)
            max_page = max(max_page, pages)
            if not items:
                continue
            has_guild = True
            start = local_page_index * GUILD_LIST_PAGE_SIZE
            page_items = items[start : start + GUILD_LIST_PAGE_SIZE]
            if not page_items:
                continue
            end = min(start + len(page_items), len(items))
            total_pages = max(
                1, (len(items) + GUILD_LIST_PAGE_SIZE - 1) // GUILD_LIST_PAGE_SIZE
            )
            lines.append(
                f"{label}：{len(items)} 个（第 {start + 1}-{end} 条，第 {local_page_index + 1}/{total_pages} 页）"
            )
            rows = []
            for item in page_items:
                name = item.get("guild_name") or item.get("name") or "未命名频道"
                item_gid = item.get("guild_id") or item.get("guildId")
                member_count = (
                    item.get("member_count") or item.get("memberCount") or "-"
                )
                if item_gid:
                    name_cell = _quick_cmd(
                        f"频道资料 {item_gid}", _truncate_display_text(name, 18)
                    )
                else:
                    name_cell = _truncate_display_text(name, 18)

                member_cmd = (
                    _quick_cmd(f"频道成员 {item_gid}", "成员") if item_gid else "-"
                )
                search_member_cmd = (
                    _quick_cmd(f"频道搜成员 {item_gid} 关键词", "搜成员")
                    if item_gid
                    else "-"
                )
                feed_cmd = (
                    _quick_cmd(f"频道帖子 {item_gid}", "帖子") if item_gid else "-"
                )
                search_feed_cmd = (
                    _quick_cmd(f"频道搜帖 {item_gid} 关键词", "搜帖")
                    if item_gid
                    else "-"
                )
                leave_cmd = (
                    _quick_cmd(f"频道退出 {item_gid}", "退出") if item_gid else "-"
                )

                join_setting_cmd = "-"
                direct_join_cmd = "-"
                audit_join_cmd = "-"
                disable_join_cmd = "-"
                rename_cmd = "-"
                profile_cmd = "-"
                avatar_cmd = "-"
                if item_gid and group.get("key") in {
                    "created_guilds",
                    "managed_guilds",
                }:
                    join_setting_cmd = _quick_cmd(
                        f"频道加入方式 {item_gid}", "加入方式"
                    )
                    direct_join_cmd = _quick_cmd(f"频道设直接加入 {item_gid}", "直加")
                    audit_join_cmd = _quick_cmd(f"频道设审核加入 {item_gid}", "审核")
                    disable_join_cmd = _quick_cmd(f"频道设禁止加入 {item_gid}", "禁止")
                    rename_cmd = _quick_cmd(f"频道改名 {item_gid} 新名称", "改名")
                    profile_cmd = _quick_cmd(f"频道改简介 {item_gid} 新简介", "改简介")
                    avatar_cmd = _quick_cmd(f"频道改头像 {item_gid} 图片路径", "改头像")

                rows.append(
                    [
                        name_cell,
                        member_count,
                        member_cmd,
                        search_member_cmd,
                        feed_cmd,
                        search_feed_cmd,
                        leave_cmd,
                        join_setting_cmd,
                        direct_join_cmd,
                        audit_join_cmd,
                        disable_join_cmd,
                        rename_cmd,
                        profile_cmd,
                        avatar_cmd,
                    ]
                )
            lines.extend(
                _table(
                    [
                        "频道",
                        "人数",
                        "成员",
                        "搜成员",
                        "帖子",
                        "搜帖",
                        "退出",
                        "加入方式",
                        "直加",
                        "审核",
                        "禁止",
                        "改名",
                        "改简介",
                        "改头像",
                    ],
                    rows,
                )
            )

        if has_guild and not local_groups:
            local_expires_at = int(time.time()) + 7200

        if has_guild:
            if groups_to_render:
                prev_token = None
                next_token = None
                if local_page_index > 0:
                    prev_token = _save_token_payload(
                        "guild_list_page",
                        {
                            "all_groups": groups_to_render,
                            "page_index": local_page_index - 1,
                            "expires_at": local_expires_at,
                        },
                    )
                if local_page_index + 1 < max_page:
                    next_token = _save_token_payload(
                        "guild_list_page",
                        {
                            "all_groups": groups_to_render,
                            "page_index": local_page_index + 1,
                            "expires_at": local_expires_at,
                        },
                    )
                pager_ops = []
                if prev_token:
                    pager_ops.append(_quick_cmd(f"频道列表 {prev_token}", "上一页"))
                if next_token:
                    pager_ops.append(_quick_cmd(f"频道列表 {next_token}", "下一页"))
                if pager_ops:
                    lines.append("分页：" + " / ".join(pager_ops))
            lines.append(
                "快捷操作："
                + " / ".join(
                    [
                        _quick_cmd("频道帮助"),
                        _quick_cmd("频道自检"),
                        _quick_cmd("频道创建 头像路径 公开 频道名 | 简介", "创建频道"),
                        _quick_cmd("频道清理缓存", "清理缓存"),
                    ]
                )
            )
        return lines

    if title == "用户资料":
        uid = (
            payload.get("tinyid")
            or payload.get("tiny_id")
            or payload.get("tinyId")
            or payload.get("user_id")
            or payload.get("userId")
            or payload.get("id")
            or payload.get("uid")
            or payload.get("open_id")
            or payload.get("openId")
        )
        if uid:
            store = _load_token_store()
            cache = (
                store.get("__self_user__")
                if isinstance(store.get("__self_user__"), dict)
                else {}
            )
            cache_key = str(
                payload.get("guild_id")
                or payload.get("guildId")
                or guild_id
                or "__global__"
            )
            cache[cache_key] = str(uid)
            store["__self_user__"] = cache
            _save_token_store(store)
        nick = str(payload.get("nickname") or payload.get("nick") or "").strip()
        current = get_current_user()
        if nick and current:
            set_user_nickname(current, nick)
        profile_items = [
            ("nickname", "昵称"),
            ("nick", "昵称"),
            ("tinyid", "用户ID"),
            ("tiny_id", "用户ID"),
            ("tinyId", "用户ID"),
            ("user_id", "用户ID"),
            ("userId", "用户ID"),
            ("id", "ID"),
            ("uid", "ID"),
            ("open_id", "OpenID"),
            ("openId", "OpenID"),
            ("gender", "性别"),
            ("country", "国家"),
            ("province", "省份/地区"),
            ("city", "城市"),
            ("joinTime_human", "加入时间"),
            ("join_time_human", "加入时间"),
            ("joinTime", "加入时间"),
            ("join_time", "加入时间"),
            ("role", "角色"),
            ("role_name", "角色"),
            ("isGuildAuthor", "是否创作者"),
            ("is_guild_author", "是否创作者"),
        ]
        rows: List[List[Any]] = []
        seen_labels = set()
        for key, label in profile_items:
            value = payload.get(key)
            if value not in (None, "", []):
                if label in seen_labels:
                    continue
                rows.append([label, str(value)])
                seen_labels.add(label)
        if rows:
            lines.extend(_table(["属性", "值"], rows))
        gid = payload.get("guild_id") or payload.get("guildId") or guild_id
        uid = (
            payload.get("tinyid")
            or payload.get("tiny_id")
            or payload.get("tinyId")
            or payload.get("user_id")
            or payload.get("userId")
            or payload.get("id")
            or payload.get("uid")
        )
        is_owner, is_admin = _can_manage_members(gid)
        if gid and uid:
            ops = [_quick_cmd(f"频道私信 {gid} {uid} 你好", "发送私信")]
            if is_owner:
                ops.append(_quick_cmd(f"频道设置管理员 {gid} {uid}", "设管理员"))
                ops.append(_quick_cmd(f"频道取消管理员 {gid} {uid}", "取消管理员"))
            if is_admin:
                ops.append(_quick_cmd(f"频道禁言 {gid} {uid} 1小时", "禁言"))
                ops.append(_quick_cmd(f"频道解除禁言 {gid} {uid}", "解禁"))
                ops.append(_quick_cmd(f"频道踢出 {gid} {uid}", "踢出"))
            lines.append("")
            lines.append(f"操作：{' / '.join(ops)}")
        return lines

    if title == "解析分享链接":
        gid = payload.get("guild_id") or payload.get("guildId")
        name = payload.get("guild_name") or payload.get("name") or "未知频道"
        rows = [["频道名", name]]
        if gid:
            rows.append(["频道ID", gid])
            lines.extend(_table(["属性", "值"], rows))
            ops = [
                _quick_cmd(f"频道资料 {gid}", "查看资料"),
                _quick_cmd(f"频道成员 {gid}", "成员"),
                _quick_cmd(f"频道帖子 {gid}", "帖子"),
            ]
            lines.append(f"操作：{' / '.join(ops)}")
        else:
            lines.extend(_table(["属性", "值"], rows))
        return lines

    if title in {"频道资料", "加入方式"}:
        # 加入方式的 joinType 在 setting 嵌套内，先提取
        setting = payload.get("setting")
        if isinstance(setting, dict):
            join_type = setting.get("joinType") or setting.get("join_type")
            if join_type and title == "加入方式":
                join_type_map = {
                    "JOIN_GUILD_TYPE_DIRECT": "直接加入",
                    "JOINGUILDTYPEDIRECT": "直接加入",
                    "JOIN_GUILD_TYPE_ADMIN_AUDIT": "管理员审核",
                    "JOINGUILDTYPEADMINAUDIT": "管理员审核",
                    "JOIN_GUILD_TYPE_DISABLE": "禁止加入",
                    "JOINGUILDTYPEDISABLE": "禁止加入",
                    "JOIN_GUILD_TYPE_QUESTION_WITH_ADMIN_AUDIT": "提问审核",
                    "JOINGUILDTYPEQUESTIONWITHADMINAUDIT": "提问审核",
                    "JOIN_GUILD_TYPE_MULTI_ANSWER_WITH_ADMIN_AUDIT": "多题验证",
                    "JOINGUILDTYPEMULTIANSWERWITHADMINAUDIT": "多题验证",
                    "JOIN_GUILD_TYPE_QUIZ": "测试题",
                    "JOINGUILDTYPEQUIZ": "测试题",
                }
                join_type_text = str(join_type).replace("_", "").upper()
                pretty_join_type = join_type_map.get(
                    str(join_type), join_type_map.get(join_type_text, str(join_type))
                )
                lines.append(f"加入方式：{pretty_join_type}")
        pair_items: List[Tuple[str, str]] = []
        for key, label in (
            ("guild_name", "频道名"),
            ("name", "频道名"),
            ("guild_number", "频道号"),
            ("guild_profile", "简介"),
            ("profile", "简介"),
            ("member_count", "成员数"),
            ("url", "链接"),
            ("share_url", "分享链接"),
            ("nick", "昵称"),
            ("nickname", "昵称"),
            ("tinyid", "用户ID"),
            ("tiny_id", "用户ID"),
            ("tinyId", "用户ID"),
            ("isGuildAuthor", "是否频道创作者"),
            ("is_guild_author", "是否频道创作者"),
        ):
            value = payload.get(key)
            if value not in (None, "", []):
                pair_items.append((label, str(value)))
        if pair_items:
            rows = [[label, value] for label, value in pair_items]
            lines.extend(_table(["属性", "值"], rows))
        if title == "频道资料":
            current_gid = payload.get("guild_id") or payload.get("guildId") or guild_id
            is_owner, is_admin = _can_manage_members(current_gid)
            read_ops = []
            write_ops = []
            if current_gid and is_owner:
                write_ops.extend(
                    [
                        _quick_cmd(f"频道改名 {current_gid} 新名称", "改名"),
                        _quick_cmd(f"频道改简介 {current_gid} 新简介", "改简介"),
                        _quick_cmd(f"频道改头像 {current_gid} 图片路径", "改头像"),
                        _quick_cmd(f"频道加入方式 {current_gid}", "加入方式"),
                    ]
                )
            if current_gid:
                read_ops.extend(
                    [
                        _quick_cmd(f"频道版块 {current_gid}", "版块"),
                        _quick_cmd(f"频道成员 {current_gid}", "成员"),
                        _quick_cmd(f"频道帖子 {current_gid}", "帖子"),
                    ]
                )
            if read_ops or write_ops:
                if read_ops:
                    lines.append("")
                    lines.append(f"查看：{' / '.join(read_ops)}")
                if write_ops:
                    lines.append(f"管理：{' / '.join(write_ops)}")
        if title == "加入方式":
            gid = payload.get("guild_id") or payload.get("guildId") or guild_id
            if gid:
                lines.append(_quick_cmd(f"频道设直接加入 {gid}", "设直接加入"))
                lines.append(_quick_cmd(f"频道设审核加入 {gid}", "设审核加入"))
                lines.append(_quick_cmd(f"频道设禁止加入 {gid}", "设禁止加入"))
                lines.append(
                    _quick_cmd(
                        f"频道加入提问审核 {gid} 你从哪知道这里?|你的用途是什么?",
                        "提问审核",
                    )
                )
                lines.append(
                    _quick_cmd(
                        f"频道加入多题验证 {gid} 1+1=?=2|你是谁?=管理员", "多题验证"
                    )
                )
                lines.append(
                    _quick_cmd(f"频道加入测试题 {gid} 1+1=? | 1,2,3 | 2", "测试题")
                )
        return lines

    if title == "频道版块":
        items = payload.get("channels") or payload.get("list") or payload.get("items")
        if isinstance(items, list):
            lines.append(f"版块数：{len(items)}")
            gid = (
                payload.get("guild_id")
                or payload.get("guildId")
                or guild_id
                or "频道ID"
            )
            rows: List[List[Any]] = []
            for item in items[:20]:
                name = item.get("channel_name") or item.get("name") or "未命名版块"
                cid = item.get("channel_id") or item.get("channelId")
                ctype = (
                    item.get("channel_type")
                    or item.get("channelType")
                    or item.get("type")
                    or "-"
                )
                ops = []
                if cid:
                    ops.extend(
                        [
                            _quick_cmd(f"频道修改版块 {gid} {cid} 新版块名", "修改"),
                            _quick_cmd(f"频道删除版块 {gid} {cid}", "删除"),
                            _quick_cmd(f"频道发帖 {gid} {cid} 内容", "发帖"),
                            _quick_cmd(f"频道长帖 {gid} {cid} 标题 | 正文", "长帖"),
                        ]
                    )
                display_name = _truncate_display_text(name, 18)
                cid_short = _shrink_token(cid) if cid else "-"
                rows.append(
                    [display_name, cid_short, ctype, " ".join(ops) if ops else "-"]
                )
            if rows:
                lines.extend(_table(["版块名称", "ID", "类型", "操作"], rows))
        return lines

    if title in {"频道成员", "频道搜成员"}:
        gid = (
            payload.get("guild_id")
            or payload.get("guildId")
            or guild_id
            or payload.get("_local_guild_id")
        )
        next_page_token = (
            payload.get("next_page_token")
            or payload.get("nextPageToken")
            or payload.get("nextpagetoken")
        )
        match_count = payload.get("match_count") if title == "频道搜成员" else None
        has_more = payload.get("has_more") if title == "频道搜成员" else None

        # ── 本地翻页路径：handle_member_list 切片后注入的 _local_page_items ──
        local_page_items = payload.get("_local_page_items")
        local_page_index = payload.get("_local_page_index", 0)
        local_total = payload.get("_local_total", 0)
        local_next_token = payload.get("_local_next_token")
        local_prev_cmd = payload.get("_local_prev_cmd", f"频道成员 {gid}")
        if isinstance(local_page_items, list) and local_page_items:
            is_owner, is_admin = _can_manage_members(gid)
            page_start = local_page_index * MEMBER_PAGE_SIZE + 1
            page_end = min(page_start + MEMBER_PAGE_SIZE - 1, local_total)
            lines.append(f"成员数：{local_total}（第 {page_start}-{page_end} 条）")
            rows = []
            for item in local_page_items:
                tiny_id = (
                    item.get("tinyid") or item.get("tiny_id") or item.get("tinyId")
                )
                name = _member_chip(gid, tiny_id, _member_name(item))
                member_role = str(item.get("role") or "").strip()
                ops = []
                if gid and tiny_id and is_admin:
                    ops.append(_quick_cmd(f"频道禁言 {gid} {tiny_id} 1小时", "禁言"))
                    ops.append(_quick_cmd(f"频道踢出 {gid} {tiny_id}", "踢出"))
                    if is_owner:
                        if "管理员" in member_role:
                            ops.append(
                                _quick_cmd(
                                    f"频道取消管理员 {gid} {tiny_id}", "取消管理"
                                )
                            )
                        elif "频道主" not in member_role:
                            ops.append(
                                _quick_cmd(f"频道设置管理员 {gid} {tiny_id}", "设管理")
                            )
                rows.append([name, " ".join(ops)])
            lines.extend(_table(["成员", "操作"], rows))
            # 本地下一页
            if page_end < local_total and local_next_token:
                lines.append(_quick_cmd(f"频道成员 {gid} {local_next_token}", "下一页"))
            lines.append(_quick_cmd(local_prev_cmd, "回到首页"))
            if gid:
                lines.append(
                    "快捷搜索："
                    + " / ".join(
                        [
                            _quick_cmd(f"频道搜成员 {gid} 关键词", "搜成员"),
                            _quick_cmd(f"频道搜帖 {gid} 关键词", "搜帖"),
                        ]
                    )
                )
            lines.append("")
            return lines

        # ── 正常渲染路径（首次 API 返回或搜索结果） ──
        is_owner, is_admin = _can_manage_members(gid)
        grouped = [
            ("owners", "频道主"),
            ("admins", "管理员"),
            ("robots", "机器人"),
            ("ai_members", "机器人"),
            ("members", "普通成员"),
        ]
        rendered = False
        all_members: List[Dict[str, Any]] = []
        for key, label in grouped:
            items = payload.get(key)
            if not isinstance(items, list) or not items:
                continue
            rendered = True
            lines.append(f"{label}：{len(items)} 人")
            all_members.extend(items)  # 收集用于本地翻页
            rows = []
            for item in items[:MEMBER_PAGE_SIZE]:
                tiny_id = (
                    item.get("tinyid") or item.get("tiny_id") or item.get("tinyId")
                )
                name = _member_chip(gid, tiny_id, _member_name(item))
                member_role = str(item.get("role") or "").strip()
                ops = []
                if gid and tiny_id and is_admin:
                    ops.append(_quick_cmd(f"频道禁言 {gid} {tiny_id} 1小时", "禁言"))
                    ops.append(_quick_cmd(f"频道踢出 {gid} {tiny_id}", "踢出"))
                    if is_owner:
                        if "管理员" in member_role:
                            ops.append(
                                _quick_cmd(
                                    f"频道取消管理员 {gid} {tiny_id}", "取消管理"
                                )
                            )
                        elif "频道主" not in member_role:
                            ops.append(
                                _quick_cmd(f"频道设置管理员 {gid} {tiny_id}", "设管理")
                            )
                rows.append([name, " ".join(ops)])
            lines.extend(_table(["成员", "操作"], rows))
        if rendered:
            if title == "频道搜成员" and match_count not in (None, ""):
                lines.insert(0, f"匹配数：{match_count}")
            if title == "频道搜成员" and has_more:
                lines.append("提示：搜索结果较多，请换更具体的关键词")
            # 本地翻页：缓存全部成员数据，生成本地翻页令牌（仅当总人数超过一页时）
            total_local = len(all_members)
            if gid and total_local > MEMBER_PAGE_SIZE:
                cache_payload = {
                    "guild_id": gid,
                    "all_members": all_members,
                    "page_index": 0,
                    "raw_payload": dict(payload),
                    "prev_cmd": f"频道成员 {gid}",
                }
                # 同时保留 API 翻页能力（本地数据不够时备用）
                if next_page_token:
                    cache_payload["next_page_token"] = next_page_token
                local_token = _save_token_payload("member_page", cache_payload)
                lines.append(
                    _quick_cmd(f"频道成员 {gid} {local_token}", "下一页（本地）")
                )
            elif gid and next_page_token:
                # 不够一页但有 API 翻页令牌，走 API 翻页
                page_token = _save_token_payload(
                    "member_page",
                    {
                        "guild_id": gid,
                        "next_page_token": next_page_token,
                        "prev_cmd": f"频道成员 {gid}",
                    },
                )
                lines.append(_quick_cmd(f"频道成员 {gid} {page_token}", "下一页"))
            if gid:
                lines.append(_quick_cmd(f"频道成员 {gid}", "重新搜索"))
                lines.append(
                    "快捷搜索："
                    + " / ".join(
                        [
                            _quick_cmd(f"频道搜成员 {gid} 关键词", "搜成员"),
                            _quick_cmd(f"频道搜帖 {gid} 关键词", "搜帖"),
                        ]
                    )
                )
                lines.append("")
            return lines

        items = payload.get("members") or payload.get("items") or payload.get("list")
        if isinstance(items, list):
            all_members_ungrouped = list(items)
            lines.append(
                f"{'匹配数' if title == '频道搜成员' else '成员数'}：{match_count if title == '频道搜成员' and match_count not in (None, '') else len(items)}"
            )
            rows = []
            for item in items[:MEMBER_PAGE_SIZE]:
                tiny_id = (
                    item.get("tinyid") or item.get("tiny_id") or item.get("tinyId")
                )
                name = _member_chip(gid, tiny_id, _member_name(item))
                member_role = str(item.get("role") or "").strip()
                ops = []
                if gid and tiny_id and is_admin:
                    ops.append(_quick_cmd(f"频道禁言 {gid} {tiny_id} 1小时", "禁言"))
                    ops.append(_quick_cmd(f"频道踢出 {gid} {tiny_id}", "踢出"))
                    if is_owner:
                        if "管理员" in member_role:
                            ops.append(
                                _quick_cmd(
                                    f"频道取消管理员 {gid} {tiny_id}", "取消管理"
                                )
                            )
                        elif "频道主" not in member_role:
                            ops.append(
                                _quick_cmd(f"频道设置管理员 {gid} {tiny_id}", "设管理")
                            )
                rows.append([name, " ".join(ops)])
            lines.extend(_table(["成员", "操作"], rows))
            # 未分组列表的本地翻页
            total_ungrouped = len(all_members_ungrouped)
            if gid and total_ungrouped > MEMBER_PAGE_SIZE:
                cache_payload = {
                    "guild_id": gid,
                    "all_members": all_members_ungrouped,
                    "page_index": 0,
                    "raw_payload": dict(payload),
                    "prev_cmd": f"频道成员 {gid}",
                }
                if next_page_token:
                    cache_payload["next_page_token"] = next_page_token
                local_token = _save_token_payload("member_page", cache_payload)
                lines.append(
                    _quick_cmd(f"频道成员 {gid} {local_token}", "下一页（本地）")
                )
        if title == "频道搜成员" and has_more:
            lines.append("提示：搜索结果较多，请换更具体的关键词")
        if (
            gid
            and next_page_token
            and len(
                all_members
                if rendered
                else (all_members_ungrouped if isinstance(items, list) else [])
            )
            <= MEMBER_PAGE_SIZE
        ):
            page_token = _save_token_payload(
                "member_page",
                {
                    "guild_id": gid,
                    "next_page_token": next_page_token,
                    "prev_cmd": f"频道成员 {gid}",
                },
            )
            lines.append(_quick_cmd(f"频道成员 {gid} {page_token}", "下一页"))
            lines.append(_quick_cmd(f"频道成员 {gid}", "重新搜索"))
            lines.append(
                "快捷搜索："
                + " / ".join(
                    [
                        _quick_cmd(f"频道搜成员 {gid} 关键词", "搜成员"),
                        _quick_cmd(f"频道搜帖 {gid} 关键词", "搜帖"),
                    ]
                )
            )
            lines.append("")
        return lines

    if title in {"频道帖子", "频道搜帖", "全局搜帖"}:
        items = (
            payload.get("feeds")
            or payload.get("guild_feeds")
            or payload.get("items")
            or payload.get("list")
        )
        if isinstance(items, list):
            if title == "频道搜帖":
                total = payload.get("total") or payload.get("match_count") or len(items)
                has_more = payload.get("has_more") or payload.get("hasMore")
                lines.append(f"匹配数：{total}")
                if isinstance(has_more, bool):
                    lines.append(f"还有更多：{'是' if has_more else '否'}")
            else:
                lines.append(f"帖子数：{len(items)}")
            rows = []
            for item in items[:10]:
                feed_id = item.get("feed_id") or item.get("feedId")
                item_gid = (
                    item.get("guild_id") or item.get("guildId") or item.get("guildid")
                )
                create_time = (
                    item.get("create_time_raw")
                    or item.get("create_time")
                    or item.get("createTime")
                )
                name = (
                    item.get("title")
                    or item.get("content")
                    or item.get("text")
                    or "无标题帖子"
                )
                if title == "频道搜帖":
                    author = (
                        item.get("author_nick")
                        or item.get("nickname")
                        or item.get("nick")
                        or item.get("author")
                        or "-"
                    )
                    rows.append(
                        [
                            _truncate_display_text(name, 24),
                            _truncate_display_text(author, 12),
                            " / ".join(
                                [
                                    _quick_cmd(
                                        f"帖子详情 {feed_id}"
                                        + (f" {item_gid}" if item_gid else ""),
                                        "详情",
                                    )
                                    if feed_id
                                    else "",
                                    _quick_cmd(f"帖子评论 {feed_id}", "评论")
                                    if feed_id
                                    else "",
                                    _quick_cmd(
                                        f"帖子评论 {feed_id} {create_time} 内容", "回复"
                                    )
                                    if feed_id and create_time
                                    else "",
                                ]
                            ).strip(" /"),
                        ]
                    )
                else:
                    ops = []
                    if feed_id:
                        ops.append(
                            _quick_cmd(
                                f"帖子详情 {feed_id}"
                                + (f" {item_gid}" if item_gid else ""),
                                "详情",
                            )
                        )
                        ops.append(_quick_cmd(f"帖子评论 {feed_id}", "评论"))
                    if feed_id and create_time:
                        ops.append(
                            _quick_cmd(f"帖子评论 {feed_id} {create_time} 内容", "回复")
                        )
                    rows.append([_truncate_display_text(name, 24), " / ".join(ops)])
            if title == "频道搜帖":
                lines.extend(_table(["帖子", "作者", "操作"], rows))
            else:
                lines.extend(_table(["帖子", "操作"], rows))
        if title == "频道帖子":
            attach_info = (
                payload.get("attach_info")
                or payload.get("feed_attach_info")
                or payload.get("feedAttachInfo")
            )
            gid = payload.get("guild_id") or payload.get("guildId") or guild_id
            get_type = payload.get("get_type") or payload.get("getType") or 2
            if gid and attach_info:
                page_token = _save_token_payload(
                    "feed_page",
                    {
                        "guild_id": gid,
                        "attach_info": attach_info,
                        "get_type": get_type,
                        "prev_cmd": f"频道帖子 {gid}",
                    },
                )
                lines.append(_quick_cmd(f"频道帖子 {gid} {page_token}", "下一页"))
                lines.append(_quick_cmd(f"频道帖子 {gid}", "重新搜索"))
        if title == "频道搜帖":
            next_page_cookie = (
                payload.get("next_page_cookie")
                or payload.get("nextPageCookie")
                or payload.get("nextpagecookie")
            )
            gid = payload.get("guild_id") or payload.get("guildId") or guild_id
            query = str(payload.get("query") or payload.get("keyword") or "").strip()
            if gid and next_page_cookie and query:
                page_token = _save_token_payload(
                    "search_feed_page",
                    {
                        "guild_id": gid,
                        "query": query,
                        "next_page_cookie": next_page_cookie,
                        "prev_cmd": f"频道搜帖 {gid} {query}",
                    },
                )
                lines.append(_quick_cmd(f"频道搜帖 {gid} {page_token}", "下一页"))
                lines.append(_quick_cmd(f"频道搜帖 {gid} {query}", "重新搜索"))
        return lines

    if title == "帖子详情":
        # CLI 返回 {data: {feed: {...}}}，需要解包 feed 层
        feed_wrapper = payload.get("feed")
        if isinstance(feed_wrapper, dict):
            payload = feed_wrapper
        detail_items = [
            ("title", "标题"),
            ("content", "内容"),
            ("content_richtext", "富文本内容"),
            ("content_snippet", "内容摘要"),
            ("share_url", "帖子链接"),
            ("create_time", "时间"),
            ("author", "作者"),
            ("author_id", "作者ID"),
            ("channel_name", "版块"),
            ("channel_id", "版块ID"),
            ("guild_name", "频道"),
            ("guild_id", "频道ID"),
            ("feed_type", "帖子类型"),
            ("prefer_count", "点赞数"),
            ("comment_count", "评论数"),
        ]
        seen = set()
        has_detail = False
        rows: List[List[Any]] = []
        for key, label in detail_items:
            value = payload.get(key)
            if value in (None, "", []):
                continue
            if label in seen and label == "内容":
                continue
            display_value = str(value)
            # 内容字段截断到 300 字符避免刷屏
            if len(display_value) > 300:
                display_value = display_value[:300] + "..."
            rows.append([label, display_value])
            seen.add(label)
            has_detail = True
        if rows:
            lines.extend(_table(["属性", "值"], rows))
        # fallback：如果标准字段都没命中，遍历所有字段展示
        if not has_detail:
            for key, value in payload.items():
                if key in (
                    "feed_id",
                    "feedId",
                    "guild_id",
                    "guildId",
                    "channel_id",
                    "channelId",
                    "author_id",
                    "authorId",
                    "create_time_raw",
                ):
                    continue
                if value is None or value == "" or value == []:
                    continue
                display_value = str(value)
                if len(display_value) > 300:
                    display_value = display_value[:300] + "..."
                lines.append(f"{key}：{display_value}")
        feed_id = payload.get("feed_id") or payload.get("feedId")
        gid = payload.get("guild_id") or payload.get("guildId") or guild_id
        cid = payload.get("channel_id") or payload.get("channelId")
        create_time = (
            payload.get("create_time_raw")
            or payload.get("create_time")
            or payload.get("createTime")
        )
        author_id = payload.get("author_id") or payload.get("authorId")
        if feed_id:
            lines.append(
                _quick_cmd(
                    f"帖子评论 {feed_id}" + (f" {gid}" if gid else ""), "评论列表"
                )
            )
            if create_time:
                lines.append(
                    _quick_cmd(f"帖子评论 {feed_id} {create_time} 内容", "发表评论")
                )
            lines.append(_quick_cmd(f"帖子点赞 {feed_id}", "点赞"))
            lines.append(_quick_cmd(f"帖子取消点赞 {feed_id}", "取消点赞"))
        if feed_id and gid:
            lines.append(_quick_cmd(f"帖子分享链接 {feed_id} {gid}", "帖子链接"))
        if feed_id and gid and cid and create_time:
            lines.append(
                _quick_cmd(f"帖子删除 {feed_id} {gid} {cid} {create_time}", "删除帖子")
            )
        if feed_id and author_id and create_time and gid:
            lines.append(
                _quick_cmd(
                    f"帖子置顶 {feed_id} {author_id} {create_time} {gid}", "置顶"
                )
            )
            lines.append(
                _quick_cmd(
                    f"帖子取消置顶 {feed_id} {author_id} {create_time} {gid}",
                    "取消置顶",
                )
            )
        return lines

    if title in {"帖子点赞", "帖子取消点赞"}:
        prefer_count = payload.get("preferCount") or payload.get("prefer_count")
        if prefer_count is not None:
            action_text = "已点赞" if title == "帖子点赞" else "已取消点赞"
            lines.extend(
                _table(
                    ["项目", "值"],
                    [["结果", action_text], ["当前点赞数", str(prefer_count)]],
                )
            )
            return lines

    if title == "帖子评论":
        items = payload.get("comments") or payload.get("items") or payload.get("list")
        feed_id = payload.get("feed_id") or payload.get("feedId")
        guild_id = payload.get("guild_id") or payload.get("guildId")
        feed_create_time = (
            payload.get("create_time_raw")
            or payload.get("feed_create_time")
            or payload.get("create_time")
            or payload.get("createTime")
        )
        feed_author_id_global = (
            payload.get("feed_author_id")
            or payload.get("author_id")
            or payload.get("authorId")
            or payload.get("feedAuthorId")
        )
        # 帖子级字段缺失时补查一次帖子详情，保证每条评论都能生成「回复」按钮
        if feed_id and (not feed_create_time or not feed_author_id_global):
            detail_args = [
                "feed",
                "get-feed-detail",
                "--feed-id",
                str(feed_id),
                "--json",
            ]
            if guild_id:
                detail_args[2:2] = ["--guild-id", str(guild_id)]
            ok_detail, output_detail = _run_cli(detail_args)
            if ok_detail:
                detail_data = _extract_json(output_detail)
                detail_payload = (
                    detail_data.get("data")
                    if isinstance(detail_data, dict)
                    and isinstance(detail_data.get("data"), dict)
                    else {}
                )
                feed_obj = (
                    detail_payload.get("feed")
                    if isinstance(detail_payload.get("feed"), dict)
                    else detail_payload
                )
                if isinstance(feed_obj, dict):
                    feed_create_time = (
                        feed_create_time
                        or feed_obj.get("create_time_raw")
                        or feed_obj.get("feed_create_time")
                        or feed_obj.get("create_time")
                        or feed_obj.get("createTime")
                    )
                    feed_author_id_global = (
                        feed_author_id_global
                        or feed_obj.get("author_id")
                        or feed_obj.get("authorId")
                        or feed_obj.get("feed_author_id")
                    )
        if feed_id and feed_create_time:
            lines.append(
                _quick_cmd(f"帖子评论 {feed_id} {feed_create_time} 内容", "发表评论")
            )
        if isinstance(items, list):
            lines.append(f"评论数：{len(items)}")
            if not items:
                lines.append("暂无评论")
            rows = []
            for item in items[:15]:
                cid = item.get("comment_id") or item.get("commentId")
                nick = (
                    item.get("author_nick")
                    or item.get("nick")
                    or item.get("nickname")
                    or "未知用户"
                )
                content = item.get("content")
                if isinstance(content, dict):
                    display_content = str(content.get("text") or "").strip()
                else:
                    display_content = str(content or "").strip()
                rich_text = (
                    item.get("content_richtext")
                    or item.get("contentRichtext")
                    or item.get("rich_text")
                )
                if (not display_content) and isinstance(rich_text, dict):
                    display_content = str(rich_text.get("text") or "").strip()
                display_content = display_content or "-"
                if len(display_content) > 60:
                    display_content = display_content[:60] + "..."
                feed_id = (
                    payload.get("feed_id")
                    or payload.get("feedId")
                    or item.get("feed_id")
                    or item.get("feedId")
                )
                feed_author_id = feed_author_id_global or item.get("feed_author_id")
                item_feed_create_time = feed_create_time or item.get("feed_create_time")
                comment_author_id = (
                    item.get("author_id")
                    or item.get("comment_author_id")
                    or item.get("authorId")
                )
                comment_create_time = (
                    item.get("comment_create_time")
                    or item.get("create_time_raw")
                    or item.get("create_time")
                    or item.get("createTime")
                )
                guild_id = (
                    item.get("guild_id")
                    or item.get("guildId")
                    or payload.get("guild_id")
                    or payload.get("guildId")
                )
                channel_id = (
                    item.get("channel_id")
                    or item.get("channelId")
                    or payload.get("channel_id")
                    or payload.get("channelId")
                )
                attach_info = item.get("attach_info") or item.get("attachInfo")
                ops = []
                if (
                    feed_id
                    and cid
                    and feed_author_id
                    and item_feed_create_time
                    and comment_author_id
                ):
                    like_token = _save_token_payload(
                        "comment_like",
                        {
                            "feed_id": feed_id,
                            "comment_id": cid,
                            "feed_author_id": feed_author_id,
                            "feed_create_time": item_feed_create_time,
                            "comment_author_id": comment_author_id,
                            "guild_id": guild_id,
                            "channel_id": channel_id,
                        },
                    )
                    delete_token = _save_token_payload(
                        "delete_comment",
                        {
                            "feed_id": feed_id,
                            "comment_id": cid,
                            "comment_author_id": comment_author_id,
                            "feed_create_time": item_feed_create_time,
                            "guild_id": guild_id,
                            "channel_id": channel_id,
                        },
                    )
                    ops.append(_quick_cmd(f"评论点赞 {like_token}", "点赞"))
                    ops.append(_quick_cmd(f"评论取消点赞 {like_token}", "取消点赞"))
                    ops.append(_quick_cmd(f"删除评论 {delete_token}", "删除"))
                if (
                    feed_id
                    and cid
                    and feed_author_id
                    and item_feed_create_time
                    and comment_author_id
                    and comment_create_time
                ):
                    reply_token = _save_token_payload(
                        "reply_comment",
                        {
                            "feed_id": feed_id,
                            "comment_id": cid,
                            "feed_author_id": feed_author_id,
                            "feed_create_time": item_feed_create_time,
                            "comment_author_id": comment_author_id,
                            "comment_create_time": comment_create_time,
                            "guild_id": guild_id,
                        },
                    )
                    ops.append(_quick_cmd(f"帖子评论回复 {reply_token} ", "回复"))
                if feed_id and cid and guild_id and channel_id:
                    page_token = _save_token_payload(
                        "reply_page",
                        {
                            "feed_id": feed_id,
                            "comment_id": cid,
                            "guild_id": guild_id,
                            "channel_id": channel_id,
                            "attach_info": attach_info,
                        },
                    )
                    ops.append(_quick_cmd(f"帖子回复 {page_token}", "更多回复"))
                rows.append(
                    [_truncate_display_text(nick, 12), display_content, " / ".join(ops)]
                )
            if rows:
                lines.extend(_table(["作者", "内容", "操作"], rows))
        attach_info = (
            payload.get("attach_info")
            or payload.get("next_page_cookie")
            or payload.get("attachinfo")
        )
        if attach_info and feed_id:
            comment_page_token = _save_token_payload(
                "comment_page",
                {
                    "feed_id": feed_id,
                    "attach_info": attach_info,
                    "guild_id": guild_id,
                    "prev_cmd": f"帖子评论 {feed_id}"
                    + (f" {guild_id}" if guild_id else ""),
                },
            )
            lines.append(_quick_cmd(f"帖子评论 {comment_page_token}", "下一页"))
            lines.append(
                _quick_cmd(
                    f"帖子评论 {feed_id}" + (f" {guild_id}" if guild_id else ""),
                    "回到首页",
                )
            )
        return lines

    if title == "评论回复":
        items = payload.get("items") or payload.get("replies") or payload.get("list")
        if isinstance(items, list):
            lines.append(f"回复数：{len(items)}")
            feed_id = payload.get("feed_id") or payload.get("feedId")
            comment_id = payload.get("comment_id") or payload.get("commentId")
            guild_id = payload.get("guild_id") or payload.get("guildId")
            channel_id = payload.get("channel_id") or payload.get("channelId")
            feed_author_id = payload.get("feed_author_id") or payload.get("author_id")
            feed_create_time = payload.get("feed_create_time") or payload.get(
                "create_time_raw"
            )
            comment_author_id = payload.get("comment_author_id")
            comment_create_time = payload.get("comment_create_time")
            for item in items[:20]:
                reply_id = item.get("reply_id") or item.get("replyId")
                reply_author_id = (
                    item.get("author_id")
                    or item.get("reply_author_id")
                    or item.get("authorId")
                )
                nick = (
                    item.get("nick")
                    or item.get("nickname")
                    or item.get("author_nick")
                    or "未知用户"
                )
                content = item.get("content") or ""
                ops = []
                if (
                    feed_id
                    and comment_id
                    and reply_id
                    and feed_author_id
                    and feed_create_time
                    and comment_author_id
                    and reply_author_id
                ):
                    like_token = _save_token_payload(
                        "reply_like",
                        {
                            "feed_id": feed_id,
                            "comment_id": comment_id,
                            "reply_id": reply_id,
                            "feed_author_id": feed_author_id,
                            "feed_create_time": feed_create_time,
                            "comment_author_id": comment_author_id,
                            "reply_author_id": reply_author_id,
                            "guild_id": guild_id,
                            "channel_id": channel_id,
                        },
                    )
                    ops.append(_quick_cmd(f"回复点赞 {like_token}", "回复点赞"))
                    ops.append(_quick_cmd(f"回复取消点赞 {like_token}", "取消点赞"))
                if (
                    feed_id
                    and comment_id
                    and reply_id
                    and reply_author_id
                    and feed_author_id
                    and feed_create_time
                    and comment_author_id
                    and comment_create_time
                ):
                    delete_token = _save_token_payload(
                        "delete_reply",
                        {
                            "feed_id": feed_id,
                            "comment_id": comment_id,
                            "reply_id": reply_id,
                            "replier_id": reply_author_id,
                            "feed_author_id": feed_author_id,
                            "feed_create_time": feed_create_time,
                            "comment_author_id": comment_author_id,
                            "comment_create_time": comment_create_time,
                            "guild_id": guild_id,
                            "channel_id": channel_id,
                        },
                    )
                    ops.append(_quick_cmd(f"删除回复 {delete_token}", "删除回复"))
                if (
                    feed_id
                    and comment_id
                    and feed_author_id
                    and feed_create_time
                    and comment_author_id
                    and comment_create_time
                ):
                    reply_token = _save_token_payload(
                        "reply_comment",
                        {
                            "feed_id": feed_id,
                            "comment_id": comment_id,
                            "feed_author_id": feed_author_id,
                            "feed_create_time": feed_create_time,
                            "comment_author_id": comment_author_id,
                            "comment_create_time": comment_create_time,
                            "guild_id": guild_id,
                            "target_reply_id": reply_id,
                            "target_user_id": reply_author_id,
                            "target_user_nick": nick,
                        },
                    )
                    show_text = f"继续回复 {_shrink_token(reply_id or comment_id)}"
                    ops.append(_quick_cmd(f"帖子评论回复 {reply_token} ", show_text))
                lines.append(
                    f"- {nick}：{content[:80]}"
                    + (f"（回复ID：{reply_id}）" if reply_id else "")
                    + (f" {' '.join(ops)}" if ops else "")
                )
        attach_info = payload.get("attach_info") or payload.get("next_page_cookie")
        feed_id = payload.get("feed_id") or payload.get("feedId")
        comment_id = payload.get("comment_id") or payload.get("commentId")
        guild_id = payload.get("guild_id") or payload.get("guildId")
        channel_id = payload.get("channel_id") or payload.get("channelId")
        if attach_info and feed_id and comment_id and guild_id and channel_id:
            page_token = _save_token_payload(
                "reply_page",
                {
                    "feed_id": feed_id,
                    "comment_id": comment_id,
                    "guild_id": guild_id,
                    "channel_id": channel_id,
                    "attach_info": attach_info,
                    "prev_cmd": f"帖子回复 {feed_id} {comment_id} {guild_id} {channel_id}",
                },
            )
            lines.append(_quick_cmd(f"帖子回复 {page_token}", "下一页"))
            lines.append(
                _quick_cmd(
                    f"帖子回复 {feed_id} {comment_id} {guild_id} {channel_id}",
                    "回到首页",
                )
            )
        return lines

    if title == "互动消息":
        items = payload.get("items") or payload.get("list") or payload.get("notices")
        if isinstance(items, list):
            lines.append(f"消息数：{len(items)}")
            for item in items[:15]:
                content = (
                    item.get("content")
                    or item.get("title")
                    or item.get("desc")
                    or "互动消息"
                )
                feed_id = item.get("feed_id") or item.get("feedId")
                gid = item.get("guild_id") or item.get("guildId")
                ops = []
                if feed_id:
                    ops.append(
                        _quick_cmd(
                            f"帖子详情 {feed_id}" + (f" {gid}" if gid else ""),
                            "帖子详情",
                        )
                    )
                lines.append(
                    f"- {content[:100]}" + (f" {' '.join(ops)}" if ops else "")
                )
        attach_info = payload.get("attach_info") or payload.get("next_page_cookie")
        if attach_info:
            gid = payload.get("guild_id") or payload.get("guildId")
            page_token = _save_token_payload(
                "notice_page",
                {
                    "guild_id": gid,
                    "attach_info": attach_info,
                    "prev_cmd": f"互动消息 {gid}" if gid else "互动消息",
                },
            )
            lines.append(_quick_cmd(f"互动消息 {page_token}", "下一页"))
            lines.append(
                _quick_cmd(f"互动消息" + (f" {gid}" if gid else ""), "回到首页")
            )
        return lines

    if title in {"搜频道", "搜作者"}:
        # 搜频道返回 channels/guilds 列表，搜作者返回 authors 列表
        items = (
            payload.get("items")
            or payload.get("list")
            or payload.get("guilds")
            or payload.get("channels")
        )
        authors = payload.get("authors")
        if isinstance(authors, list):
            lines.append(f"结果数：{len(authors)}")
            rows = []
            for author in authors[:10]:
                author_name = author.get("name") or "未知用户"
                author_id = author.get("author_id") or author.get("id") or ""
                ops = []
                if author_id:
                    ops.append(_quick_cmd(f"频道用户资料 {author_id}", "查看资料"))
                rows.append([_truncate_display_text(author_name, 25), " ".join(ops)])
            lines.extend(_table(["作者", "操作"], rows))
            next_page_token = (
                payload.get("next_page_token")
                or payload.get("nextPageToken")
                or payload.get("nextpagetoken")
            )
            keyword = payload.get("keyword") or ""
            if next_page_token:
                page_token = _save_token_payload(
                    "search_guild_page",
                    {
                        "next_page_token": next_page_token,
                        "scope": "author",
                        "keyword": keyword,
                    },
                )
                lines.append(_quick_cmd(f"频道搜作者 {page_token}", "下一页"))
                lines.append(_quick_cmd(f"频道搜作者 {keyword}", "重新搜索"))
            return lines
        if isinstance(items, list):
            lines.append(f"结果数：{len(items)}")
            rows = []
            for item in items[:10]:
                name = (
                    item.get("guild_name")
                    or item.get("name")
                    or item.get("nick")
                    or "未命名"
                )
                guild_id = item.get("guild_id") or item.get("guildId")
                member_count = (
                    item.get("member_count") or item.get("memberCount") or "-"
                )
                profile = item.get("profile") or item.get("guild_profile") or ""
                share_url = item.get("share_url") or item.get("shareUrl") or ""
                ops = []
                if guild_id:
                    ops.append(_quick_cmd(f"频道资料 {guild_id}", "资料"))
                    ops.append(_quick_cmd(f"频道成员 {guild_id}", "成员"))
                    ops.append(_quick_cmd(f"频道帖子 {guild_id}", "帖子"))
                if share_url:
                    ops.append(_quick_cmd(f"频道解析 {share_url}", "解析链接"))
                rows.append(
                    [
                        _truncate_display_text(name, 20),
                        member_count,
                        _truncate_display_text(profile, 30),
                        " ".join(ops),
                    ]
                )
            lines.extend(_table(["频道", "人数", "简介", "操作"], rows))
            # 翻页
            next_page_token = (
                payload.get("next_page_token")
                or payload.get("nextPageToken")
                or payload.get("nextpagetoken")
            )
            keyword = payload.get("keyword") or ""
            if next_page_token:
                scope = "channel" if title == "搜频道" else "author"
                base_cmd = f"频道{'搜频道' if title == '搜频道' else '搜作者'}"
                page_token = _save_token_payload(
                    "search_guild_page",
                    {
                        "next_page_token": next_page_token,
                        "scope": scope,
                        "keyword": keyword,
                    },
                )
                lines.append(_quick_cmd(f"{base_cmd} {page_token}", "下一页"))
                lines.append(_quick_cmd(f"{base_cmd} {keyword}", "重新搜索"))
        elif not (
            payload.get("has_more")
            or payload.get("isEnd")
            or payload.get("next_page_token")
        ):
            # 没有任何数据且没有翻页标记，说明是空结果
            lines.append("未找到匹配结果")
        return lines

    if title in {"全局搜帖"}:
        items = payload.get("feeds") or payload.get("items") or payload.get("list")
        if isinstance(items, list):
            lines.append(f"帖子数：{len(items)}")
            rows = []
            for item in items[:10]:
                feed_id = item.get("feed_id") or item.get("feedId") or ""
                title_text = item.get("title") or item.get("content") or "无标题帖子"
                guild_id = item.get("guild_id") or item.get("guildId") or ""
                ops = []
                if feed_id:
                    ops.append(
                        _quick_cmd(
                            f"帖子详情 {feed_id}"
                            + (f" {guild_id}" if guild_id else ""),
                            "详情",
                        )
                    )
                    ops.append(_quick_cmd(f"帖子评论 {feed_id}", "评论"))
                rows.append([_truncate_display_text(title_text, 35), " ".join(ops)])
            lines.extend(_table(["帖子", "操作"], rows))
            # 翻页
            next_page_token = (
                payload.get("next_page_token")
                or payload.get("nextPageToken")
                or payload.get("nextpagetoken")
            )
            keyword = payload.get("keyword") or ""
            if next_page_token:
                page_token = _save_token_payload(
                    "search_feed_global_page",
                    {"next_page_token": next_page_token, "keyword": keyword},
                )
                lines.append(_quick_cmd(f"频道全局搜帖 {page_token}", "下一页"))
                lines.append(_quick_cmd(f"频道全局搜帖 {keyword}", "重新搜索"))
        elif not (
            payload.get("has_more")
            or payload.get("isEnd")
            or payload.get("next_page_token")
        ):
            lines.append("未找到匹配帖子")
        return lines

    return lines


def _render_fallback_summary(data: Dict[str, Any]) -> List[str]:
    """将 data 中的关键字段以友好的键值对形式展示，避免输出原始 JSON"""
    lines: List[str] = []
    payload = data.get("data") if isinstance(data.get("data"), dict) else data
    if not isinstance(payload, dict):
        return lines

    # 跳过这些无意义的内部字段
    skip_keys = {
        "success",
        "retCode",
        "ret_code",
        "code",
        "message",
        "msg",
        "error",
        "description",
        "status",
        "need_verification",
        "pending",
        "resume_command",
    }

    # 字段标签映射：把 API 的 snake_case/camelCase 字段名转为中文友好显示
    LABEL_MAP = {
        # 频道相关
        "guild_id": "频道ID",
        "guildId": "频道ID",
        "guild_name": "频道名称",
        "name": "名称",
        "guild_number": "频道号",
        "guild_profile": "简介",
        "profile": "简介",
        "member_count": "成员数",
        "memberCount": "成员数",
        "url": "链接",
        "share_url": "分享链接",
        "shareUrl": "分享链接",
        "avatar": "头像",
        "guild_avatar": "频道头像",
        # 版块相关
        "channel_id": "版块ID",
        "channelId": "版块ID",
        "channel_name": "版块名称",
        "channelName": "版块名称",
        "channel_type": "版块类型",
        "channelType": "版块类型",
        # 帖子/内容相关
        "feed_id": "帖子ID",
        "feedId": "帖子ID",
        "title": "标题",
        "content": "内容",
        "content_richtext": "富文本内容",
        "content_snippet": "内容摘要",
        "create_time": "创建时间",
        "createTime": "创建时间",
        "create_time_raw": "创建时间",
        "share_url": "帖子链接",
        "feed_type": "帖子类型",
        "prefer_count": "点赞数",
        "comment_count": "评论数",
        "author": "作者",
        "author_id": "作者ID",
        "authorId": "作者ID",
        # 用户相关
        "tinyid": "用户ID",
        "tiny_id": "用户ID",
        "tinyId": "用户ID",
        "user_id": "用户ID",
        "userId": "用户ID",
        "nick": "昵称",
        "nickname": "昵称",
        "role": "角色",
        "role_name": "角色名称",
        "gender": "性别",
        "joinTime": "加入时间",
        "join_time": "加入时间",
        "isGuildAuthor": "是否创作者",
        "is_guild_author": "是否创作者",
        # 操作结果相关
        "feed_essence_status": "精华状态",
        "top_status": "置顶状态",
        "shut_up_expire_time": "禁言到期时间",
        "shut_up_expire_time_human": "禁言到期",
        # 分页相关
        "next_page_token": "下一页令牌",
        "nextPageToken": "下一页令牌",
        "has_more": "还有更多",
        "match_count": "匹配数量",
        # 列表容器（只显示数量）
        "channels": None,
        "list": None,
        "items": None,
        "feeds": None,
        "members": None,
        "comments": None,
        "replies": None,
        "owners": None,
        "admins": None,
        "robots": None,
        "ai_members": None,
    }

    pair_items: List[Tuple[str, str]] = []
    list_info: List[str] = []

    for key, value in payload.items():
        if key in skip_keys or value is None or value == "" or value == []:
            continue
        label = LABEL_MAP.get(key)
        # 列表类字段：只显示数量
        if label is None and isinstance(value, list):
            list_label = key.replace("_", " ").replace("ID", "ID")
            list_info.append(f"{list_label}：{len(value)} 条")
            continue
        # 有标签的字段
        if label:
            display_value = str(value)
            if len(display_value) > 200:
                display_value = display_value[:200] + "..."
            pair_items.append((label, display_value))
        elif not isinstance(value, (dict, list)):
            # 无映射的标量字段也展示
            display_value = str(value)
            if len(display_value) > 200:
                display_value = display_value[:200] + "..."
            pair_items.append((key, display_value))

    # 用 Markdown 表格展示键值对
    if pair_items:
        rows = [[label, value] for label, value in pair_items]
        lines.extend(_table(["属性", "值"], rows))
    for info in list_info:
        lines.append(info)
    return lines


def _help_text() -> str:
    lines = [
        "# 腾讯频道帮助",
        "",
        f"当前状态：预演 **{'开' if _preview_enabled() else '关'}** ｜ 调试 **{'开' if _debug_enabled() else '关'}**",
        "",
        "## 核心入口",
        *_table(
            ["命令", "说明"],
            [
                [_quick_cmd("频道帮助"), "查看完整帮助"],
                [_quick_cmd("频道自检"), "检查登录与插件状态"],
                [
                    _quick_cmd("频道配置token 你的token", "频道配置token"),
                    "配置或替换 token",
                ],
                [_quick_cmd("频道列表"), "查看我创建/管理/加入的频道"],
                [
                    _quick_cmd("频道开启预演", "开启预演")
                    + " / "
                    + _quick_cmd("频道关闭预演", "关闭预演"),
                    "切换预演模式",
                ],
                [
                    _quick_cmd("频道开启调试", "开启调试")
                    + " / "
                    + _quick_cmd("频道关闭调试", "关闭调试"),
                    "切换调试模式",
                ],
            ],
        ),
        "## 频道与资料查询",
        *_table(
            ["命令", "说明"],
            [
                [_quick_cmd("频道资料 频道ID", "频道资料"), "查看频道信息"],
                [_quick_cmd("频道版块 频道ID", "频道版块"), "查看版块列表"],
                [_quick_cmd("频道成员 频道ID", "频道成员"), "查看成员列表"],
                [_quick_cmd("频道帖子 频道ID", "频道帖子"), "查看帖子列表"],
                [_quick_cmd("频道用户资料", "我的资料"), "查看自己的资料"],
                [
                    _quick_cmd("频道用户资料 频道ID 用户ID", "用户资料"),
                    "查看指定用户资料",
                ],
                [_quick_cmd("频道加入方式 频道ID", "加入方式"), "查看加入规则"],
            ],
        ),
        "## 搜索",
        *_table(
            ["命令", "说明"],
            [
                [_quick_cmd("频道搜帖 频道ID 关键词", "搜帖"), "在指定频道搜帖子"],
                [_quick_cmd("频道搜成员 频道ID 昵称", "搜成员"), "在指定频道搜成员"],
                [_quick_cmd("频道搜频道 关键词", "搜频道"), "全局搜索频道"],
                [_quick_cmd("频道搜作者 关键词", "搜作者"), "全局搜索作者"],
                [_quick_cmd("频道全局搜帖 关键词", "全局搜帖"), "全局搜索帖子"],
            ],
        ),
        "## 帖子与互动",
        *_table(
            ["命令", "说明"],
            [
                [_quick_cmd("帖子详情 帖子ID", "帖子详情"), "查看帖子详情"],
                [_quick_cmd("帖子评论 帖子ID", "评论列表"), "查看评论列表"],
                [
                    _quick_cmd("帖子回复 r123456", "更多回复"),
                    "查看评论下回复（翻页令牌）",
                ],
                [_quick_cmd("互动消息", "互动消息"), "查看互动通知"],
                [
                    _quick_cmd("帖子评论 帖子ID 帖子创建时间 内容", "发表评论"),
                    "给帖子发表评论",
                ],
                [_quick_cmd("帖子回复 r123456 回复内容", "回复某条"), "回复指定回复"],
                [
                    _quick_cmd("帖子评论回复 r123456 回复内容", "回复评论"),
                    "回复指定评论",
                ],
                [
                    _quick_cmd("帖子点赞 帖子ID", "点赞")
                    + " / "
                    + _quick_cmd("帖子取消点赞 帖子ID", "取消点赞"),
                    "帖子点赞 / 取消点赞",
                ],
                [_quick_cmd("帖子分享链接 帖子ID 频道ID", "帖子链接"), "获取帖子链接"],
                [
                    _quick_cmd("帖子设精华 帖子ID", "设精华")
                    + " / "
                    + _quick_cmd("帖子取消精华 帖子ID", "取消精华"),
                    "设置 / 取消精华",
                ],
                [
                    _quick_cmd("帖子置顶 帖子ID 作者ID 创建时间 版块ID", "置顶")
                    + " / "
                    + _quick_cmd(
                        "帖子取消置顶 帖子ID 作者ID 创建时间 版块ID", "取消置顶"
                    ),
                    "设置 / 取消置顶",
                ],
            ],
        ),
        "## 发帖与版块管理",
        *_table(
            ["命令", "说明"],
            [
                [_quick_cmd("频道发帖 频道ID 版块ID 内容", "发帖"), "发普通帖子"],
                [
                    _quick_cmd("频道长帖 频道ID 版块ID 标题 | 正文", "长帖"),
                    "发长帖，注意保留竖线",
                ],
                [_quick_cmd("频道创建版块 频道ID 版块名", "创建版块"), "创建版块"],
                [
                    _quick_cmd("频道修改版块 频道ID 版块ID 新版块名", "修改版块"),
                    "修改版块名称",
                ],
                [_quick_cmd("频道删除版块 频道ID 版块ID", "删除版块"), "删除版块"],
            ],
        ),
        "## 成员与频道管理",
        *_table(
            ["命令", "说明"],
            [
                [
                    _quick_cmd("频道私信 来源频道ID 用户ID 内容", "发送私信"),
                    "给成员发私信",
                ],
                [
                    _quick_cmd("频道禁言 频道ID 用户ID 1小时", "禁言")
                    + " / "
                    + _quick_cmd("频道解除禁言 频道ID 用户ID", "解禁"),
                    "禁言 / 解除禁言",
                ],
                [_quick_cmd("频道踢出 频道ID 用户ID", "踢出"), "移出成员"],
                [
                    _quick_cmd("频道设置管理员 频道ID 用户ID", "设管理员")
                    + " / "
                    + _quick_cmd("频道取消管理员 频道ID 用户ID", "取消管理员"),
                    "设置 / 取消管理员",
                ],
                [_quick_cmd("频道改名 频道ID 新名称", "改名"), "修改频道名称"],
                [_quick_cmd("频道改简介 频道ID 新简介", "改简介"), "修改频道简介"],
                [_quick_cmd("频道改头像 频道ID 图片路径", "改头像"), "修改频道头像"],
            ],
        ),
        "## 加入与创建频道",
        *_table(
            ["命令", "说明"],
            [
                [
                    _quick_cmd("频道创建 头像路径 公开 频道名 | 简介", "创建频道"),
                    "创建自定义频道",
                ],
                [
                    _quick_cmd("频道建频道 头像路径 主题", "按主题建频道"),
                    "按主题快速建频道",
                ],
                [
                    _quick_cmd("频道加入 频道ID", "加入频道")
                    + " / "
                    + _quick_cmd("频道退出 频道ID", "退出频道"),
                    "加入 / 退出频道",
                ],
                [
                    _quick_cmd("频道加入附言 频道ID 我想加入这个频道", "加入附言"),
                    "附言验证加入",
                ],
                [
                    _quick_cmd("频道加入答题 频道ID 答案1|答案2", "加入答题"),
                    "答题验证加入",
                ],
            ],
        ),
        "## 多账号槽位",
        *_table(
            ["命令", "说明"],
            [
                [_quick_cmd("频道账号列表"), "查看所有账号槽位及当前槽位"],
                [
                    _quick_cmd("频道添加账号 名称", "添加账号")
                    + " / "
                    + _quick_cmd("频道删除账号 名称", "删除账号"),
                    "创建 / 删除账号槽位",
                ],
                [
                    _quick_cmd("频道切换账号 名称", "切换账号"),
                    "切换当前操作的账号（登录/发帖等都作用在当前槽位）",
                ],
                [_quick_cmd("频道账号状态 名称", "账号状态"), "查看指定槽位的登录状态"],
            ],
        ),
        "## 登录与通知（Skill 1.1.5）",
        *_table(
            ["命令", "说明"],
            [
                [
                    _quick_cmd("频道登录") + " / " + _quick_cmd("频道登录确认"),
                    "扫码授权登录到当前槽位（扫码后发确认）",
                ],
                [
                    _quick_cmd("频道登录状态") + " / " + _quick_cmd("频道退出登录"),
                    "查看登录状态 / 退出登录",
                ],
                [_quick_cmd("频道强制登录"), "覆盖本槽位登录态，重新扫码换号"],
                [_quick_cmd("频道版本"), "查看 CLI 版本"],
                [
                    _quick_cmd("频道MD帖 频道ID 版块ID Markdown正文", "MD帖"),
                    "发 Markdown 短帖",
                ],
                [
                    _quick_cmd(
                        "频道MD长帖 频道ID 版块ID 标题 | Markdown正文", "MD长帖"
                    ),
                    "发 Markdown 长帖",
                ],
                [
                    _quick_cmd("频道通知状态")
                    + " / "
                    + _quick_cmd("频道检查通知")
                    + " / "
                    + _quick_cmd("频道最近通知"),
                    "通知状态 / 增量检查 / 最近记录",
                ],
                [
                    _quick_cmd("评论通知 1 内容", "评论通知")
                    + " / "
                    + _quick_cmd("回复通知 1 内容", "回复通知"),
                    "按通知编号评论帖子 / 回复评论",
                ],
                [
                    _quick_cmd("处理通知 1 同意", "同意申请")
                    + " / "
                    + _quick_cmd("处理通知 1 拒绝", "拒绝申请"),
                    "按通知编号处理系统通知",
                ],
                [_quick_cmd("私信通知回复 1 内容", "回复私信"), "按通知编号回复私信"],
            ],
        ),
        "## 清理与说明",
        *_table(
            ["命令", "说明"],
            [
                [_quick_cmd("频道清理缓存", "清理缓存"), "清理 self id 与短令牌缓存"],
                [_quick_cmd("频道清理短令牌", "清理短令牌"), "只清理短令牌缓存"],
            ],
        ),
        "- 说明 1：列表、搜索、评论、回复等场景支持短令牌翻页。",
        "- 说明 2：开启预演后只校验参数，不会真正执行写操作。",
        "- 说明 3：开启调试后会额外附上原始返回内容，方便排查。",
        "- 说明 4：长帖命令请用 `标题 | 正文` 的格式，中间保留竖线。",
        "- 说明 5：本插件仅限管理员使用（data/admins.txt，一行一个，可在 Web 后台「腾讯频道」页面维护）。",
        "- 说明 6：Web 后台「腾讯频道」页面支持界面化管理频道 / 帖子 / 评论，以及定时发帖（5 段 Cron）。",
    ]
    return "\n".join(lines)


__all__ = [name for name in globals() if not name.startswith("__")]
