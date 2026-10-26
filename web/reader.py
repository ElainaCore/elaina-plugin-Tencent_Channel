"""只读网页接口适配：使用网页登录 Cookie，不借用 CLI 的频道成员身份。"""

import base64
import json
import re
from urllib.parse import quote
from datetime import datetime
from typing import Any

import httpx


class WebReadError(RuntimeError):
    pass


def _decode(value: Any) -> str:
    if not isinstance(value, str):
        return str(value or "")
    try:
        return base64.b64decode(value, validate=True).decode("utf-8")
    except (ValueError, UnicodeError):
        return value


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_text(item) for item in value)
    if isinstance(value, dict):
        if "text" in value:
            return _text(value["text"])
        for key in ("contents", "text_content", "rich_text"):
            if key in value:
                return _text(value[key])
    return ""


def avatar_url(poster: dict) -> str:
    icon = poster.get("icon") or {}
    url = poster.get("avatar_url") or icon.get("iconUrl") or ""
    if url:
        return url
    meta = _decode(poster.get("bytes_avatar_meta") or icon.get("bytes_avatar_meta") or "")
    parts = meta.split("#")
    if len(parts) != 4:
        return ""
    kind, key, flags, stamp = parts
    try:
        flags = int(flags)
    except ValueError:
        return ""
    key, stamp = quote(key, safe=""), quote(stamp, safe="")
    if kind == "0":
        size = 100 if flags & 4 else 40
        return f"https://thirdqq.qlogo.cn/g?b=oidb&k={key}&s={size}&t={stamp}"
    if kind == "1":
        size = "/140" if flags & 4 else "/100" if flags & 2 else ""
        return f"https://qqchannel-profile-1251316161.file.myqcloud.com/{key}{size}?={stamp}"
    return ""


def normalize_guild(record: dict) -> dict:
    info = record.get("msg_guild_info") or {}
    gid = str(record.get("uint64_guild_id") or "")
    member = record.get("msg_cmd_uin_info") or {}
    return {
        "guild_id": gid, "guild_number": _decode(info.get("bytes_guild_number")) or info.get("str_guild_number") or "",
        "name": _decode(info.get("bytes_guild_name")) or info.get("str_guild_name") or "",
        "profile": _decode(info.get("bytes_profile") or ""), "member_count": info.get("uint32_member_num") or 0,
        "avatar_url": f"https://groupprohead.gtimg.cn/{gid}/100?t={info.get('uint64_face_seq', '')}",
        "cover_url": f"https://groupprocover.gtimg.cn/{gid}?imageView2/1/w/750/h/388&t={info.get('uint64_cover_seq', '')}",
        "joined": member.get("uint32_is_member") == 2, "role": member.get("uint32_role", 0), "read_source": "web",
    }


def normalize_feed(feed: dict, guild_id: str = "", guild_number: str = "") -> dict:
    channel = feed.get("channelInfo") or feed.get("guild_info") or {}
    sign = channel.get("sign") or {}
    poster = feed.get("poster") or {}
    stats = feed.get("feed_stat") or feed.get("total_prefer") or {}
    images = []
    for item in feed.get("images") or []:
        url = item if isinstance(item, str) else item.get("picUrl") or item.get("url")
        if url:
            images.append(url)
    if not images:
        images = [item["url"] for item in (feed.get("image") or {}).get("thumb_images", []) if item.get("url")]
    content = _text(feed.get("title"))
    body = _text(feed.get("content")) or _text(feed.get("contents")) or _text(feed.get("rich_text")) or content
    raw_time = feed.get("createTime") or feed.get("create_time") or 0
    return {
        "feed_id": str(feed.get("id") or feed.get("feed_id") or ""),
        "guild_id": str(sign.get("guild_id") or channel.get("guild_id") or guild_id),
        "guild_number": str(channel.get("guild_number") or guild_number),
        "guild_name": channel.get("guild_name") or "",
        "guild_avatar": channel.get("icon_url") or channel.get("guild_icon") or "",
        "channel_id": str(sign.get("channel_id") or channel.get("channel_id") or ""),
        "author": poster.get("nick") or poster.get("nickname") or "",
        "author_id": str(poster.get("id") or poster.get("tiny_id") or ""),
        "author_avatar": avatar_url(poster),
        "title": content if isinstance(feed.get("title"), str) else "",
        "content": body, "content_snippet": body,
        "create_time_raw": raw_time, "create_time": _time_text(raw_time),
        "prefer_count": stats.get("prefer_count") or 0,
        "comment_count": feed.get("commentCount") or stats.get("total_comment_count") or 0,
        "images": images,
        "feed_type": feed.get("feed_type") or 1,
        "share_url": "https://pd.qq.com/g/" + str(channel.get("guild_number") or guild_number or guild_id) + "/post/" + str(feed.get("id") or feed.get("feed_id") or ""),
        "read_source": "web",
    }


def _time_text(value: Any) -> str:
    try:
        return datetime.fromtimestamp(int(value)).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError, OverflowError, OSError):
        return str(value or "")


def normalize_comment(comment: dict, parent: str = "") -> dict:
    poster = comment.get("poster") or comment.get("user") or {}
    target = comment.get("targetUser") or comment.get("target_user") or {}
    stamp = comment.get("createTime") or comment.get("create_time") or 0
    result = {
        "comment_id": parent or str(comment.get("id") or comment.get("comment_id") or ""),
        "author": poster.get("nick") or poster.get("nickname") or "",
        "author_id": str(poster.get("id") or poster.get("tiny_id") or ""),
        "author_avatar": avatar_url(poster),
        "content_text": _text(comment.get("richContents")) or _text(comment.get("content")),
        "create_time_raw": stamp, "create_time": _time_text(stamp),
        "reply_count": comment.get("replyCount") or 0,
        "attach_info": comment.get("attachInfo") or comment.get("attach_info") or "",
        "target_user_nick": target.get("nick") or "",
        "target_user_id": str(target.get("id") or target.get("tiny_id") or ""),
    }
    if parent:
        result["reply_id"] = str(comment.get("id") or comment.get("reply_id") or "")
    else:
        result["reply_list"] = [normalize_comment(reply, result["comment_id"]) for reply in comment.get("vecReply") or []]
    return result


class WebReader:
    def __init__(self, cookie: str, *, transport=None):
        self.cookie = cookie
        self.transport = transport
        self.cookies = dict(part.strip().split("=", 1) for part in cookie.split(";") if "=" in part)
        self.logged_in = bool(self.cookies.get("p_skey") or self.cookies.get("skey"))

    async def rpc(self, method: str, body: dict, service: int, command: str = "") -> dict:
        token = self.cookies.get("p_skey") or self.cookies.get("skey") or ""
        bkn = 5381
        for char in token:
            bkn = (bkn * 33 + ord(char)) & 0x7fffffff
        mode = "auth" if self.logged_in else "noauth"
        oidb = {"uint32_service_type": service}
        if command:
            oidb["uint32_command"] = command
        headers = {
            "Content-Type": "application/json",
            "Referer": "https://pd.qq.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "X-QQ-Client-AppId": "537246381",
            "x-oidb": json.dumps(oidb),
        }
        if self.cookie:
            headers["Cookie"] = self.cookie
        try:
            async with httpx.AsyncClient(timeout=25, transport=self.transport) as client:
                response = await client.post(
                    httpx.URL(f"https://pd.qq.com/qunng/guild/gotrpc/{mode}/{method}").copy_merge_params({"bkn": bkn} if token else {}),
                    headers=headers, json=body,
                )
                if response.status_code != 200:
                    raise WebReadError(f"频道网页接口暂不可用（HTTP {response.status_code}）")
                payload = response.json()
        except WebReadError:
            raise
        except (httpx.HTTPError, ValueError) as error:
            # 不把包含 bkn 的请求 URL 或 Cookie 暴露到错误信息里。
            raise WebReadError("频道网页接口连接失败，请稍后重试") from error
        if not isinstance(payload, dict):
            raise WebReadError("频道网页接口返回了无效数据")
        error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        if str(payload.get("retcode", 0)) != "0" or str(error.get("code", 0)) != "0":
            message = str(error.get("message") or payload.get("message") or "频道暂不可访问")
            hint = "请在插件管理中检查网页登录状态" if self.logged_in else "请在插件管理中完成网页登录后重试"
            raise WebReadError(f"{message}；{hint}")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise WebReadError("频道网页接口未返回内容")
        return data

    async def guild(self, number: str, guild_id: str = "") -> dict:
        # 与官方路由一致：纯数字路径就是 guild_id，字母数字频道号通过 guild_num 解析。
        if not guild_id and number.isdecimal():
            guild_id = number
        fields = {key: 1 for key in (
            "uint32_guild_number", "uint32_guild_name", "uint32_member_num", "uint32_profile",
            "uint32_face_seq", "uint32_cover_seq", "uint32_vistor_interaction_all_switch",
            "uint32_is_visible_for_visitor",
        )}
        data = await self.rpc("trpc.group_pro.cmd0x907e.Cmd0x907e/HandleProcess?guild_fetchGuildInfo", {
            "guild_num": None if guild_id else number, "guild_info_type": 132,
            "cmd0xf57_req": {
                "msg_field_filter": {"msg_guild_info_filter": fields, "msg_cmd_uin_info_filter": {"uint32_role": 1, "uint32_join_time": 1}},
                "rpt_req_guild_info_list": [{"uint64_guild_id": guild_id} if guild_id else {}],
            },
            "cmd0xf5d_req": {
                "rpt_uint64_guild_id": [guild_id or None], "uint32_client_source_flag": 1,
                "msg_field_filter": {"uint32_category_info": 1, "uint32_show_private_channel": 1},
                "channel_info_filter": {"uint32_is_need_name": 1, "uint32_is_need_channel_type": 1, "msg_text_channel_info_filter": {"uint32_is_need_sub_type_id": 1}},
            },
        }, 1 if self.logged_in else 2)
        records = (data.get("cmd0xf57_rsp") or {}).get("rpt_rsp_guild_info_list") or []
        if not records or not records[0].get("msg_guild_info"):
            raise WebReadError("网页账号暂时无法读取该频道，请检查网页登录状态或频道访问权限")
        record = records[0]
        info = record["msg_guild_info"]
        actual_id = str(record.get("uint64_guild_id") or guild_id)
        if not actual_id:
            raise WebReadError("网页接口未返回频道 ID，请从探索页重新打开")
        groups = (data.get("cmd0xf5d_rsp") or {}).get("rpt_msg_guild_info_list") or []
        channels = []
        for group in groups:
            for channel in group.get("rpt_msg_channel_list") or []:
                text = channel.get("msg_text_channel_info") or {}
                channels.append({"channel_id": str(channel.get("uint64_channel_id") or ""), "channel_name": _decode(text.get("bytes_channel_name") or channel.get("bytes_channel_name") or ""), "channel_type": channel.get("uint32_channel_type")})
        return {**normalize_guild({**record, "uint64_guild_id": actual_id}), "channels": channels}

    async def joined_guilds(self) -> dict:
        if not self.logged_in:
            return {"guilds": [], "read_source": "web"}
        guilds, cursor, seen = {}, "", set()
        while True:
            data = await self.rpc("trpc.group_pro.cmd0xf59.GetMyGuildInfo/HandleProcess3", {
                "msg_field_filter": {
                    "msg_guild_info_filter": {key: 1 for key in ("uint32_member_num", "uint32_guild_name", "uint32_profile", "uint32_face_seq", "uint32_cover_seq", "uint32_guild_number", "uint32_guild_status")},
                    "msg_cmd_uin_info_filter": {"uint32_join_time": 1, "uint32_role": 1, "uint32_tinyid": 1},
                }, "msg_req_guild_info_list": [], "bytes_cookie": cursor,
            }, 3)
            for record in data.get("msg_rsp_change_guilds") or []:
                if record.get("msg_guild_info"):
                    guild = normalize_guild(record)
                    if guild["guild_id"]:
                        guild["joined"] = True
                        guilds[guild["guild_id"]] = guild
            cursor = data.get("bytes_cookie") or ""
            if not cursor or cursor in seen or data.get("uint32_is_end") == 1:
                break
            seen.add(cursor)
        return {"guilds": list(guilds.values()), "read_source": "web"}

    async def profile(self) -> dict:
        if not self.logged_in:
            return {"logged_in": False, "read_source": "web"}
        data = await self.rpc("trpc.group_pro.cmd0xf88.GetGroupProUserInfo/HandleProcess", {
            "msg_filter": {"uint32_nick_name": 1, "uint32_head_info": 1, "uint32_avatar_meta": 1, "uint32_need_group_pro_profile": 1},
        }, 1)
        info = data.get("msg_user_info") or {}
        return {"logged_in": True, "nickname": _decode(info.get("bytes_nick_name")),
                "avatar_url": avatar_url(info), "user_id": str(info.get("uint64_member_tinyid") or ""), "read_source": "web"}

    async def search(self, keyword: str, cursor: str = "", guild_id: str = "") -> dict:
        if guild_id:
            data = await self.rpc("trpc.group_pro.in_guild_search_svr.InGuildSearch/NewSearch", {
                "guild_id": guild_id, "query": keyword, "cookie": cursor, "member_cookie": "",
                "search_type": {"type": 2, "feed_type": 0},
                "cond": {"channel_ids": [], "feed_rank_type": 0, "type_list": [2]}, "guild_feed_data_type": 1,
            }, 2, "0x9287")
            result = data.get("union_result") or {}
            feeds = []
            for item in result.get("guild_feeds") or []:
                try:
                    feed = json.loads(_decode(item.get("st_feed_json")))
                except (ValueError, TypeError):
                    continue
                feeds.append(normalize_feed(feed, guild_id, result.get("guild_number") or ""))
            return {"feeds": feeds, "cursor": "" if result.get("feed_is_end") else result.get("feed_cookie") or "", "read_source": "web"}
        try:
            continuation = json.loads(cursor) if cursor else {}
        except (ValueError, TypeError):
            continuation = {}
        if not isinstance(continuation, dict):
            continuation = {}
        data = await self.rpc("trpc.group_pro.guild_search_aggregation.GuildSearchAggregation/Search", {
            "key_word": keyword, "tab": {"tab_name": "频道", "tab_mask": "3"},
            "session_info": continuation.get("session", ""), "extension": continuation.get("extension", ""),
            "device_info": {"platform": 5, "night_mode_status": 0},
            "channel_condition_filter": {"rank_type": 0}, "result_serialize": 1,
        }, 1 if self.logged_in else 2, "0x9610")
        channels = []
        for item in (data.get("tab_content_result") or {}).get("result_items") or []:
            try:
                layout = json.loads(_decode(item.get("layout_content")))
                # 大整数 ID 保持为字符串，避免交给 JS 时丢失精度。
                card = json.loads(re.sub(r':\s*(-?\d{16,})', r':"\1"', _decode(layout.get("data"))))
            except (ValueError, TypeError, AttributeError):
                continue
            sign = ((card.get("title") or {}).get("jump_link") or {}).get("guild_jump") or {}
            if not sign.get("guild_id"):
                continue
            clean = lambda value: re.sub(r'<em class="highlight">(.*?)</em>', r'\1', value or "")
            channels.append({"guild_id": str(sign["guild_id"]), "guild_number": str(sign.get("guild_number") or ""),
                             "name": clean((card.get("title") or {}).get("text")),
                             "profile": clean((card.get("sub_title") or {}).get("text")),
                             "avatar_url": (card.get("icon") or {}).get("icon_link") or "", "joined": sign.get("join_status") == 2,
                             "read_source": "web"})
        next_cursor = json.dumps({"session": data.get("session_info") or "", "extension": data.get("extension") or ""}) if data.get("is_end") != 1 and data.get("session_info") else ""
        return {"channels": channels, "cursor": next_cursor, "read_source": "web"}

    async def feeds(self, guild_id: str, number: str, channel: str = "", cursor: str = "", kind: str = "1") -> dict:
        body = {"count": 20, "from": 7, "feedAttchInfo": cursor, "need_top_info": False}
        if channel:
            method = "GetChannelTimelineFeeds"
            body.update(channelSign={"guild_id": guild_id, "channel_id": channel}, sortOption=2)
            service = 10 if self.logged_in else 11
        else:
            method = "GetGuildFeeds"
            body.update(guild_id=guild_id, get_type=int(kind) if kind in ("1", "2") else 1, sortOption=0, need_channel_list=False)
            service = 13 if self.logged_in else 12
        data = await self.rpc(f"trpc.qchannel.commreader.ComReader/{method}", body, service)
        return {"feeds": [normalize_feed(feed, guild_id, number) for feed in data.get("vecFeed") or []], "feed_attach_info": data.get("feedAttchInfo") or "", "read_source": "web"}

    async def feed(self, feed_id: str, guild_id: str, channel: str = "") -> dict:
        sign = {"guild_id": guild_id}
        if channel:
            sign["channel_id"] = channel
        data = await self.rpc("trpc.qchannel.commreader.ComReader/GetFeedDetail", {
            "feedId": feed_id, "from": 2, "detail_type": 1,
            "channelSign": sign,
            "extInfo": {"mapInfo": [{"key": "qc-tabid", "value": "ark"}, {"key": "qc-pageid", "value": "pc"}]},
        }, 6 if self.logged_in else 5)
        if not data.get("feed"):
            raise WebReadError("网页账号暂时无法读取该帖子")
        return {"feed": normalize_feed(data["feed"], guild_id), "read_source": "web"}

    async def comments(self, feed_id: str, guild_id: str, channel: str = "", cursor: str = "") -> dict:
        sign = {"guild_id": guild_id}
        if channel:
            sign["channel_id"] = channel
        data = await self.rpc("trpc.qchannel.commreader.ComReader/GetFeedComments", {
            "feedId": feed_id, "listNum": 20, "from": 1, "src": 0,
            "attchInfo": cursor, "rankingType": 1, "replyListNum": 10, "channelSign": sign,
        }, 6 if self.logged_in else 5)
        return {"comments": [normalize_comment(comment) for comment in data.get("vecComment") or []], "attach_info": data.get("attchInfo") or "", "read_source": "web"}

    async def replies(self, feed_id: str, guild_id: str, channel: str, comment_id: str, cursor: str = "") -> dict:
        sign = {"guild_id": guild_id}
        if channel:
            sign["channel_id"] = channel
        data = await self.rpc("trpc.qchannel.commreader.ComReader/GetNextPageReplies", {
            "feed_id": feed_id, "comment_id": comment_id, "page_size": 20,
            "attach_info": cursor, "channelSign": sign,
        }, 2 if self.logged_in else 1)
        return {"replies": [normalize_comment(reply, comment_id) for reply in data.get("replies") or []], "attach_info": data.get("attach_info") or "", "read_source": "web"}
