#!/usr/bin/env python
"""腾讯频道插件入口：指令 / Web 管理面板 / 定时发帖调度器。"""

from core.plugin.decorators import on_unload

from . import env_setup  # noqa: F401
from .commands import channel  # noqa: F401
from .commands.runtime import shutdown_blocking_pool
from .services import notifications, scheduling  # noqa: F401
from .web import panel  # noqa: F401


@on_unload
def _txpd_unload():
    """卸载时收尾：CLI 专用线程池的线程不是 daemon，不释放会拖住进程退出。"""
    try:
        shutdown_blocking_pool()
    except Exception:
        pass


__plugin_meta__ = {
    "name": "腾讯频道(新)",
    "description": "腾讯频道管理：指令控制，Web管理面板，定时发帖",
    "version": "1.0.4",
    "author": "ElainaBot",
}
