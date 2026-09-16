#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""腾讯频道插件入口：指令 / Web 管理面板 / 定时发帖调度器。"""

from . import env_setup  # noqa: F401
from .commands import channel  # noqa: F401
from .services import notifications, scheduling  # noqa: F401
from .web import panel  # noqa: F401

__plugin_meta__ = {
    "name": "腾讯频道(新)",
    "description": "腾讯频道管理：指令控制，Web管理面板，定时发帖",
    "version": "1.0.2",
    "author": "ElainaBot",
}
