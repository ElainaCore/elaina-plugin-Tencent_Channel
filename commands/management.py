"""频道与成员管理命令。"""

from .shared import *  # noqa: F401,F403


async def handle_guild_list(event, match):
    parts = _parts(event)
    token = parts[1] if len(parts) >= 2 else None
    if token and re.fullmatch(r"g[0-9a-f]+", token):
        payload = _load_token_payload(token, kind="guild_list_page")
        if not payload:
            await event.reply("频道列表翻页令牌无效或已过期，请重新打开频道列表后再试")
            return
        expires_at = int(payload.get("expires_at") or 0)
        if expires_at and expires_at <= int(time.time()):
            ok, output = await run_cli_async( ["manage", "get-my-join-guild-info", "--json"]
            )
            if ok:
                data = _extract_json(output)
                payload = (
                    data.get("data")
                    if isinstance(data, dict) and isinstance(data.get("data"), dict)
                    else {}
                )
                _refresh_guild_roles(payload)
            await event.reply(
                _render_result(
                    "频道列表",
                    ok,
                    output,
                    ["manage", "get-my-join-guild-info", "--json"],
                )
            )
            return
        page_idx = int(payload.get("page_index", 0))
        all_groups = payload.get("all_groups")
        if not isinstance(all_groups, list) or not all_groups:
            await event.reply("频道列表翻页数据已失效，请重新打开频道列表后再试")
            return
        ok_output = json.dumps(
            {
                "success": True,
                "data": {
                    "_guild_list_groups": all_groups,
                    "_guild_list_page_index": page_idx,
                    "_guild_list_expires_at": expires_at,
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        await event.reply(
            _render_result("频道列表", True, ok_output, [], guild_id=None)
        )
        return
    ok, output = await run_cli_async( ["manage", "get-my-join-guild-info", "--json"]
    )
    if ok:
        data = _extract_json(output)
        payload = (
            data.get("data")
            if isinstance(data, dict) and isinstance(data.get("data"), dict)
            else {}
        )
        _refresh_guild_roles(payload)
    await event.reply(
        _render_result(
            "频道列表", ok, output, ["manage", "get-my-join-guild-info", "--json"]
        )
    )


async def handle_guild_info(event, match):
    guild_id = _parts(event)[1]
    # 同时获取频道资料和分享链接
    ok_info, output_info = await run_cli_async(
        _with_preview(["manage", "get-guild-info", "--guild-id", guild_id, "--json"]),
    )
    ok_share, output_share = await run_cli_async(
        _with_preview(
            ["manage", "get-guild-share-url", "--guild-id", guild_id, "--json"]
        ),
    )
    # 合并分享链接到资料数据中
    if ok_info:
        data = _extract_json(output_info)
        if isinstance(data, dict):
            inner = data.get("data")
            if isinstance(inner, dict) and ok_share:
                share_data = _extract_json(output_share)
                if isinstance(share_data, dict):
                    share_inner = share_data.get("data")
                    if isinstance(share_inner, dict):
                        share_url = share_inner.get("url") or share_inner.get(
                            "share_url"
                        )
                        if share_url:
                            inner["share_url"] = share_url
                output_info = json.dumps(
                    data, ensure_ascii=False, separators=(",", ":")
                )
    await event.reply(
        _render_result(
            "频道资料",
            ok_info,
            _normalize_rate_limit(output_info),
            ["manage", "get-guild-info", "--guild-id", guild_id, "--json"],
            guild_id=guild_id,
        )
    )


async def handle_share_parse(event, match):
    text = _text(event)
    # 尝试从消息中提取 URL（支持 pd.qq.com 链接）
    url_match = re.search(r"https?://pd\.qq\.com/\S+", text)
    if url_match:
        url = url_match.group(0)
    else:
        # 回退到原来的方式：取命令后的参数
        parts = text.split(None, 1)
        if len(parts) < 2:
            await event.reply("格式：频道解析 <URL> 或发送包含腾讯频道链接的消息")
            return
        url = parts[1].strip()
    await _reply_cli(
        event,
        ["manage", "get-share-info", "--url", url, "--json"],
        title="解析分享链接",
    )


async def handle_channel_list(event, match):
    guild_id = _parts(event)[1]
    await _reply_cli(
        event,
        ["manage", "get-guild-channel-list", "--guild-id", guild_id, "--json"],
        title="频道版块",
        guild_id=guild_id,
    )


async def handle_create_channel(event, match):
    m = re.match(r"^频道创建版块\s+(\S+)\s+(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道创建版块 <频道ID> <版块名称>")
        return
    guild_id, channel_name = m.groups()
    await _reply_cli(
        event,
        [
            "manage",
            "create-channel",
            "--guild-id",
            guild_id,
            "--channel-name",
            channel_name.strip(),
            "--json",
        ],
        title="创建版块",
        guild_id=guild_id,
    )


async def handle_modify_channel(event, match):
    m = re.match(r"^频道修改版块\s+(\S+)\s+(\S+)\s+(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道修改版块 <频道ID> <版块ID> <新名称>")
        return
    guild_id, channel_id, channel_name = m.groups()
    await _reply_cli(
        event,
        [
            "manage",
            "modify-channel",
            "--guild-id",
            guild_id,
            "--channel-id",
            channel_id,
            "--channel-name",
            channel_name.strip(),
            "--json",
        ],
        title="修改版块",
        guild_id=guild_id,
    )


async def handle_delete_channel(event, match):
    parts = _parts(event)
    if len(parts) < 3:
        await event.reply("格式：频道删除版块 <频道ID> <版块ID>")
        return
    guild_id, channel_id = parts[1], parts[2]
    await _reply_cli(
        event,
        [
            "manage",
            "delete-channel",
            "--guild-id",
            guild_id,
            "--channel-ids",
            channel_id,
            "--json",
        ],
        title="删除版块",
        guild_id=guild_id,
    )


async def handle_create_theme_guild(event, match):
    parts = _parts(event)
    if len(parts) < 3:
        await event.reply("格式：频道建频道 <头像路径> <主题>")
        return
    image_path = parts[1]
    theme = " ".join(parts[2:]).strip()
    await _reply_cli(
        event,
        [
            "manage",
            "create-theme-private-guild",
            "--image-path",
            image_path,
            "--theme",
            theme,
            "--json",
        ],
        title="按主题创建频道",
    )


async def handle_create_custom_guild(event, match):
    m = re.match(
        r"^频道创建\s+(.+?)\s+(公开|私密|public|private)\s+(.+?)\s*\|\s*(.+)$",
        _text(event),
        re.S,
    )
    if not m:
        await event.reply("格式：频道创建 <头像路径> <公开|私密> <频道名> | <简介>")
        return
    image_path, community_type, guild_name, guild_profile = m.groups()
    ctype = "private" if community_type in {"私密", "private"} else "public"
    await _reply_cli(
        event,
        [
            "manage",
            "create-theme-private-guild",
            "--image-path",
            image_path.strip(),
            "--community-type",
            ctype,
            "--guild-name",
            guild_name.strip(),
            "--guild-profile",
            guild_profile.strip(),
            "--json",
        ],
        title="创建频道",
    )


async def handle_update_guild_name(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    name = " ".join(parts[2:]).strip()
    await _reply_cli(
        event,
        [
            "manage",
            "update-guild-info",
            "--guild-id",
            guild_id,
            "--guild-name",
            name,
            "--json",
        ],
        title="频道改名",
        guild_id=guild_id,
    )


async def handle_update_guild_profile(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    profile = " ".join(parts[2:]).strip()
    await _reply_cli(
        event,
        [
            "manage",
            "update-guild-info",
            "--guild-id",
            guild_id,
            "--guild-profile",
            profile,
            "--json",
        ],
        title="频道改简介",
        guild_id=guild_id,
    )


async def handle_upload_guild_avatar(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    image_path = " ".join(parts[2:]).strip()
    await _reply_cli(
        event,
        [
            "manage",
            "upload-guild-avatar",
            "--guild-id",
            guild_id,
            "--image-path",
            image_path,
            "--json",
        ],
        title="频道改头像",
        guild_id=guild_id,
    )


async def handle_member_list(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    if len(parts) >= 3 and re.fullmatch(r"m[0-9a-f]+", parts[2]):
        payload = _load_token_payload(parts[2], kind="member_page")
        if not payload:
            await event.reply("成员翻页令牌无效或已过期，请重新打开成员列表后再试")
            return
        # 本地翻页：从缓存取全部成员数据，按 page_index 切片渲染
        if "all_members" in payload and "page_index" in payload:
            page_idx = payload["page_index"]
            all_members = payload["all_members"]
            next_idx = page_idx + 1
            page_slice = all_members[
                next_idx * MEMBER_PAGE_SIZE : (next_idx + 1) * MEMBER_PAGE_SIZE
            ]
            if not page_slice:
                await event.reply("已经是最后一页了")
                return
            # 构造假 payload 给 _render_summary，只包含当前页的成员 + 翻页信息
            fake_payload = dict(payload.get("raw_payload", {}))
            # 用当前切片替换原始分组，让渲染逻辑正常工作
            for role_key in ("owners", "admins", "robots", "ai_members", "members"):
                fake_payload.pop(role_key, None)
            fake_payload["_local_page_items"] = page_slice
            fake_payload["_local_page_index"] = next_idx
            fake_payload["_local_total"] = len(all_members)
            fake_payload["_local_guild_id"] = payload.get("guild_id") or guild_id
            # 更新令牌的 page_index
            payload["page_index"] = next_idx
            new_token = _save_token_payload("member_page", payload)
            fake_payload["_local_next_token"] = new_token
            fake_payload["_local_prev_cmd"] = payload.get(
                "prev_cmd", f"频道成员 {guild_id}"
            )
            ok_output = json.dumps(
                {"success": True, "data": fake_payload},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            await event.reply(
                _render_result(
                    "频道成员",
                    True,
                    ok_output,
                    [],
                    guild_id=payload.get("guild_id") or guild_id,
                )
            )
            return
        # 旧式 API 翻页令牌兼容（API 正常工作时走这里）
        await _reply_cli(
            event,
            [
                "manage",
                "get-guild-member-list",
                "--guild-id",
                payload["guild_id"],
                "--next-page-token",
                payload["next_page_token"],
                "--json",
            ],
            title="频道成员",
            guild_id=payload["guild_id"],
        )
        return
    args = ["manage", "get-guild-member-list", "--guild-id", guild_id, "--json"]
    if len(parts) >= 3:
        next_page_token = " ".join(parts[2:]).strip()
        if next_page_token:
            args += ["--next-page-token", next_page_token]
    await _reply_cli(event, args, title="频道成员", guild_id=guild_id)


async def handle_member_search(event, match):
    parts = _parts(event)
    guild_id = parts[1]
    keyword = " ".join(parts[2:]).strip()
    await _reply_cli(
        event,
        [
            "manage",
            "guild-member-search",
            "--guild-id",
            guild_id,
            "--keyword",
            keyword,
            "--json",
        ],
        title="频道搜成员",
        guild_id=guild_id,
    )


async def handle_user_info(event, match):
    parts = _parts(event)
    if len(parts) == 1:
        await _reply_cli(event, ["manage", "get-user-info", "--json"], title="用户资料")
        return
    if len(parts) == 2:
        guild_id = parts[1]
        await _reply_cli(
            event,
            ["manage", "get-user-info", "--guild-id", guild_id, "--json"],
            title="用户资料",
            guild_id=guild_id,
        )
        return
    guild_id = parts[1]
    tiny_id = parts[2]
    await _reply_cli(
        event,
        [
            "manage",
            "get-user-info",
            "--guild-id",
            guild_id,
            "--tiny-id",
            tiny_id,
            "--json",
        ],
        title="用户资料",
        guild_id=guild_id,
    )


async def handle_add_admin(event, match):
    guild_id, tiny_id = _parts(event)[1], _parts(event)[2]
    await _reply_cli(
        event,
        [
            "manage",
            "add-admin",
            "--guild-id",
            guild_id,
            "--tiny-ids",
            tiny_id,
            "--yes",
            "--json",
        ],
        title="设置管理员",
        guild_id=guild_id,
    )


async def handle_remove_admin(event, match):
    guild_id, tiny_id = _parts(event)[1], _parts(event)[2]
    await _reply_cli(
        event,
        [
            "manage",
            "remove-admin",
            "--guild-id",
            guild_id,
            "--tiny-ids",
            tiny_id,
            "--yes",
            "--json",
        ],
        title="取消管理员",
        guild_id=guild_id,
    )


async def handle_shut_up_member(event, match):
    m = re.match(r"^频道禁言\s+(\S+)\s+(\S+)\s+(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道禁言 <频道ID> <用户ID> <时长>")
        return
    guild_id, tiny_id, duration_text = m.groups()
    timestamp = _parse_duration_to_timestamp(duration_text.strip())
    if timestamp is None:
        await event.reply(
            "禁言时长格式错误，示例：频道禁言 频道ID 用户ID 3天2小时5分钟10秒"
        )
        return
    await _reply_cli(
        event,
        [
            "manage",
            "modify-member-shut-up",
            "--guild-id",
            guild_id,
            "--tiny-id",
            tiny_id,
            "--time-stamp",
            str(timestamp),
            "--json",
        ],
        title="设置禁言",
        guild_id=guild_id,
    )


async def handle_unshut_up_member(event, match):
    guild_id, tiny_id = _parts(event)[1], _parts(event)[2]
    await _reply_cli(
        event,
        [
            "manage",
            "modify-member-shut-up",
            "--guild-id",
            guild_id,
            "--tiny-id",
            tiny_id,
            "--time-stamp",
            "0",
            "--json",
        ],
        title="解除禁言",
        guild_id=guild_id,
    )


async def handle_kick_member(event, match):
    guild_id, tiny_id = _parts(event)[1], _parts(event)[2]
    await _reply_cli(
        event,
        [
            "manage",
            "kick-guild-member",
            "--guild-id",
            guild_id,
            "--tiny-id",
            tiny_id,
            "--yes",
            "--json",
        ],
        title="踢出成员",
        guild_id=guild_id,
    )


async def handle_search_guilds(event, match):
    parts = _parts(event)
    # 支持翻页令牌（g 开头）
    if len(parts) >= 2 and re.fullmatch(r"s[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="search_guild_page")
        if not payload:
            await event.reply("搜频道翻页令牌无效或已过期，请重新搜索后再试")
            return
        args = ["manage", "search-guild-content", "--scope", "channel"]
        if payload.get("keyword"):
            args += ["--keyword", payload["keyword"]]
        if payload.get("next_page_token"):
            args += ["--page-token", payload["next_page_token"]]
        args += ["--json"]
        await _reply_cli(event, args, title="搜频道")
        return
    keyword = _text(event).split(None, 1)[1].strip()
    await _reply_cli(
        event,
        [
            "manage",
            "search-guild-content",
            "--keyword",
            keyword,
            "--scope",
            "channel",
            "--json",
        ],
        title="搜频道",
    )


async def handle_search_authors(event, match):
    parts = _parts(event)
    # 支持翻页令牌（g 开头）
    if len(parts) >= 2 and re.fullmatch(r"s[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="search_guild_page")
        if not payload:
            await event.reply("搜作者翻页令牌无效或已过期，请重新搜索后再试")
            return
        args = ["manage", "search-guild-content", "--scope", "author"]
        if payload.get("keyword"):
            args += ["--keyword", payload["keyword"]]
        if payload.get("next_page_token"):
            args += ["--page-token", payload["next_page_token"]]
        args += ["--json"]
        await _reply_cli(event, args, title="搜作者")
        return
    keyword = _text(event).split(None, 1)[1].strip()
    await _reply_cli(
        event,
        [
            "manage",
            "search-guild-content",
            "--keyword",
            keyword,
            "--scope",
            "author",
            "--json",
        ],
        title="搜作者",
    )


async def handle_search_feeds_global(event, match):
    parts = _parts(event)
    # 支持翻页令牌（s 开头）
    if len(parts) >= 2 and re.fullmatch(r"s[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="search_feed_global_page")
        if not payload:
            await event.reply("全局搜帖翻页令牌无效或已过期，请重新搜索后再试")
            return
        args = ["manage", "search-guild-content", "--scope", "feed"]
        if payload.get("keyword"):
            args += ["--keyword", payload["keyword"]]
        if payload.get("next_page_token"):
            args += ["--page-token", payload["next_page_token"]]
        args += ["--json"]
        await _reply_cli(event, args, title="全局搜帖")
        return
    keyword = _text(event).split(None, 1)[1].strip()
    await _reply_cli(
        event,
        [
            "manage",
            "search-guild-content",
            "--keyword",
            keyword,
            "--scope",
            "feed",
            "--json",
        ],
        title="全局搜帖",
    )


async def handle_join_guild(event, match):
    guild_id = _parts(event)[1]
    await _reply_cli(
        event,
        ["manage", "join-guild", "--guild-id", guild_id, "--json"],
        title="加入频道",
        guild_id=guild_id,
    )


async def handle_join_guild_with_comment(event, match):
    m = re.match(r"^频道加入附言\s+(\S+)\s+(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道加入附言 <频道ID> <附言>")
        return
    guild_id, comment = m.groups()
    payload = {"guild_id": guild_id, "join_guild_comment": comment.strip()}
    await _reply_cli_json_stdin(
        event,
        ["manage", "join-guild", "--json"],
        payload,
        title="加入频道",
        guild_id=guild_id,
    )


async def handle_join_guild_with_answers(event, match):
    m = re.match(r"^频道加入答题\s+(\S+)\s+(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道加入答题 <频道ID> <答案1|答案2|答案3>")
        return
    guild_id, answers_text = m.groups()
    answers = [x.strip() for x in answers_text.split("|") if x.strip()]
    if not answers:
        await event.reply(
            "至少需要提供一个答案，格式：频道加入答题 <频道ID> <答案1|答案2|答案3>"
        )
        return
    payload = {
        "guild_id": guild_id,
        "join_guild_answers": [{"answer": x} for x in answers],
    }
    await _reply_cli_json_stdin(
        event,
        ["manage", "join-guild", "--json"],
        payload,
        title="加入频道",
        guild_id=guild_id,
    )


async def handle_join_setting(event, match):
    guild_id = _parts(event)[1]
    await _reply_cli(
        event,
        ["manage", "get-join-guild-setting", "--guild-id", guild_id, "--json"],
        title="加入方式",
        guild_id=guild_id,
    )


async def handle_join_setting_direct(event, match):
    guild_id = _parts(event)[1]
    await _reply_cli(
        event,
        [
            "manage",
            "update-join-guild-setting",
            "--guild-id",
            guild_id,
            "--join-type",
            "JOIN_GUILD_TYPE_DIRECT",
            "--json",
        ],
        title="设置直接加入",
        guild_id=guild_id,
    )


async def handle_join_setting_audit(event, match):
    guild_id = _parts(event)[1]
    await _reply_cli(
        event,
        [
            "manage",
            "update-join-guild-setting",
            "--guild-id",
            guild_id,
            "--join-type",
            "JOIN_GUILD_TYPE_ADMIN_AUDIT",
            "--json",
        ],
        title="设置审核加入",
        guild_id=guild_id,
    )


async def handle_join_setting_disable(event, match):
    guild_id = _parts(event)[1]
    await _reply_cli(
        event,
        [
            "manage",
            "update-join-guild-setting",
            "--guild-id",
            guild_id,
            "--join-type",
            "JOIN_GUILD_TYPE_DISABLE",
            "--json",
        ],
        title="设置禁止加入",
        guild_id=guild_id,
    )


async def handle_join_setting_question_audit(event, match):
    m = re.match(r"^频道加入提问审核\s+(\S+)\s+(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道加入提问审核 <频道ID> <问题1|问题2>")
        return
    guild_id, questions_text = m.groups()
    questions = [x.strip() for x in questions_text.split("|") if x.strip()]
    if not questions:
        await event.reply(
            "至少需要一个问题，格式：频道加入提问审核 <频道ID> <问题1|问题2>"
        )
        return
    payload = {
        "guild_id": guild_id,
        "join_type": "JOIN_GUILD_TYPE_QUESTION_WITH_ADMIN_AUDIT",
        "setting": {"question": {"items": [{"title": x} for x in questions]}},
    }
    await _reply_cli_json_stdin(
        event,
        ["manage", "update-join-guild-setting", "--json"],
        payload,
        title="设置提问审核",
        guild_id=guild_id,
    )


async def handle_join_setting_multi_question(event, match):
    m = re.match(r"^频道加入多题验证\s+(\S+)\s+(.+)$", _text(event), re.S)
    if not m:
        await event.reply("格式：频道加入多题验证 <频道ID> <问题1=答案1|问题2=答案2>")
        return
    guild_id, body = m.groups()
    items = []
    for part in [x.strip() for x in body.split("|") if x.strip()]:
        if "=" not in part:
            await event.reply(
                "格式错误，示例：频道加入多题验证 频道ID 1+1=?=2|你是谁?=管理员"
            )
            return
        title, answer = part.rsplit("=", 1)
        if not title.strip() or not answer.strip():
            await event.reply("问题和答案都不能为空")
            return
        items.append({"title": title.strip(), "answer": answer.strip()})
    payload = {
        "guild_id": guild_id,
        "join_type": "JOIN_GUILD_TYPE_MULTI_QUESTION",
        "setting": {"question": {"items": items}},
    }
    await _reply_cli_json_stdin(
        event,
        ["manage", "update-join-guild-setting", "--json"],
        payload,
        title="设置多题验证",
        guild_id=guild_id,
    )


async def handle_join_setting_quiz(event, match):
    m = re.match(
        r"^频道加入测试题\s+(\S+)\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$", _text(event), re.S
    )
    if not m:
        await event.reply(
            "格式：频道加入测试题 <频道ID> <题目> | <选项1,选项2,选项3> | <正确答案>"
        )
        return
    guild_id, question, answers_text, correct_answer = m.groups()
    answers = [x.strip() for x in answers_text.split(",") if x.strip()]
    correct_answer = correct_answer.strip()
    if len(answers) < 2:
        await event.reply("测试题至少需要 2 个选项")
        return
    payload = {
        "guild_id": guild_id,
        "join_type": "JOIN_GUILD_TYPE_QUIZ",
        "setting": {
            "quiz": {
                "items": [
                    {
                        "question": question.strip(),
                        "answers": answers,
                        "correctAnswer": correct_answer,
                    }
                ],
                "minAnswerNum": 1,
                "minCorrectAnswerNum": 1,
            }
        },
    }
    await _reply_cli_json_stdin(
        event,
        ["manage", "update-join-guild-setting", "--json"],
        payload,
        title="设置测试题",
        guild_id=guild_id,
    )


async def handle_push_group_dm(event, match):
    parts = _parts(event)
    source_guild_id = parts[1]
    peer_tiny_id = parts[2]
    text = " ".join(parts[3:]).strip()
    await _reply_cli(
        event,
        [
            "manage",
            "push-group-dm-msg",
            "--source-guild-id",
            source_guild_id,
            "--peer-tiny-id",
            peer_tiny_id,
            "--text",
            text,
            "--json",
        ],
        title="发送频道私信",
        guild_id=source_guild_id,
    )


async def handle_leave_guild(event, match):
    guild_id = _parts(event)[1]
    await _reply_cli(
        event,
        ["manage", "leave-guild", "--guild-id", guild_id, "--yes", "--json"],
        title="退出频道",
        guild_id=guild_id,
    )


async def handle_notices(event, match):
    parts = _parts(event)
    # 支持翻页令牌（n 开头）
    if len(parts) >= 2 and re.fullmatch(r"n[0-9a-f]+", parts[1]):
        payload = _load_token_payload(parts[1], kind="notice_page")
        if not payload:
            await event.reply("互动消息翻页令牌无效或已过期，请重新打开互动消息后再试")
            return
        args = ["feed", "get-notices"]
        if payload.get("guild_id"):
            args += ["--guild-id", payload["guild_id"]]
        args += ["--attach-info", payload["attach_info"], "--json"]
        await _reply_cli(
            event, args, title="互动消息", guild_id=payload.get("guild_id")
        )
        return
    args = ["feed", "get-notices"]
    if len(parts) >= 2:
        args += ["--guild-id", parts[1]]
    if len(parts) >= 3:
        args += ["--attach-info", parts[2]]
    args += ["--json"]
    await _reply_cli(
        event, args, title="互动消息", guild_id=parts[1] if len(parts) >= 2 else None
    )


__all__ = [name for name in globals() if name.startswith("handle_")]
