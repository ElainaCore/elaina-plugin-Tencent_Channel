"""腾讯频道命令兼容聚合入口。"""

# 共享层先加载公共常量、存储、CLI 适配和结果渲染，再导入按职责拆开的
# 命令模块。各模块中的装饰器会在导入时完成框架注册。
from .shared import *  # noqa: F401,F403
from .system import *  # noqa: F401,F403
from .management import *  # noqa: F401,F403
from .feeds import *  # noqa: F401,F403
from .accounts import *  # noqa: F401,F403

__all__ = [name for name in globals() if not name.startswith("__")]
