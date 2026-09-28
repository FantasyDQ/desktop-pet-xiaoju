# 🐱 小橘猫缘缘 — AI 桌面宠物

> 一只住在主人电脑里的 AI 橘猫，贪吃爱撒娇，但干活绝不含糊！

双击聊天，右键开菜单，拖文件进来帮你读。能写代码、操作电脑、生成文档、接入外部工具……远不止聊天。

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 💬 **智能对话** | 基于 AI 大脑，能聊天、答疑、写文案、做分析。支持联网搜索，跨对话记住你聊过什么。执行过程透明可见——每一步工具调用都实时展示在对话里。 |
| 🔌 **MCP 外部工具** | 支持接入 MCP 服务——查火车票（12306）、查地图天气（百度地图）、思维导图、旅游攻略……只需从魔搭复制配置粘贴进来就能用。AI 自动判断该用哪个工具。 |
| 🐍 **自主写代码** | 遇到复杂数据任务（Excel 批量处理、PDF 解析、爬虫抓取、图表生成），AI 自己写 Python 代码并执行！自带 Python 环境，缺包自动安装，代码报错自动修复重试。 |
| 📋 **任务规划 & 主动提问** | 复杂任务 AI 先制定计划让你确认再执行；信息不全时 AI 主动提问，不会瞎猜。 |
| 🔄 **定时任务** | 说「每天 8 点抓取数据」「固化为定时任务」，自动创建定时任务。脚本失败时 AI 自动修复代码重跑。支持每天定时、间隔循环、每周定时三种模式。 |
| 💻 **操作电脑** | 打开应用、搜索文件、读取分析文件、调节音量、锁屏——说一句就帮你操作。 |
| 📄 **文档生成** | 一键生成 Word / Excel / PPT / HTML，内置排版美化技能，输出即成品。 |
| 🧩 **技能库** | 已安装的技能自动激活。支持从技能商店一键安装更多技能。 |
| 📚 **知识库** | 连接 IMA 知识库回答专业问题。 |
| 🎙️ **会议纪要** | 实时录音→自动转写整理→生成结构化纪要，也支持上传音频文件。 |
| 📧 **邮箱集成** | 配置邮箱后，直接跟 AI 说「发邮件给 XX」「查收件箱」。 |
| 🐾 **桌宠互动** | 右键可以喂猫罐头、陪玩，有饱腹度和心情值。还能自定义聊天头像。 |

---

## 🚀 快速开始（新手必读）

### 第一步：下载安装

1. 前往 [Releases 页面](../../releases) 下载最新版
2. 选择适合你的版本：
   - **安装版**（`小橘猫缘缘 Setup 2.1.0.exe`）：双击安装，支持开机自启
   - **免安装版**（`小橘猫缘缘-免安装版-2.1.0.exe`）：下载即用，无需安装
3. 打开后，屏幕右下角会出现一只小橘猫 🐱

### 第二步：配置 API 密钥（必须！）

> ⚠️ **重要：标准版不内置任何 API 密钥，必须自己配置才能使用 AI 功能。**

1. **右键**小橘猫 → 点击「设置」
2. 找到「🔑 API 密钥配置」→ 点击展开
3. 填入你的 API 配置（详见下方表格）
4. 点击「💾 保存配置」
5. **关闭并重新打开**小橘猫，配置生效

#### 需要配置什么？

| 配置项 | 说明 | 在哪里获取？ | 必填？ |
|--------|------|-------------|:---:|
| 🧠 **AI 大脑** | 你的 LLM API 地址 + 密钥 + 模型名 | 见下方「支持的 AI 服务商」 | ✅ 必填 |
| 🔍 **联网搜索** | Tavily API Key | [tavily.com](https://tavily.com) 注册免费获取（每月 1000 次） | 推荐 |
| 🌐 **网页读取** | Jina API Key | [jina.ai](https://jina.ai) 注册免费获取 | 可选 |
| 👁️ **图片理解** | Vision 模型 API 地址 + 密钥 + 模型名 | 同 AI 大脑，需要支持图片的模型 | 可选 |

#### 支持的 AI 服务商（OpenAI 兼容格式）

小橘猫支持任何兼容 OpenAI 接口的 AI 服务商，以下是常见选择：

**🧠 AI 大脑（对话用）：**

| 服务商 | API 地址 | 模型名示例 | 获取方式 |
|--------|---------|-----------|---------|
| 火山方舟（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | `glm-5-2-260617`、`doubao-pro-32k` | [火山引擎控制台](https://console.volcengine.com/ark) |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`、`deepseek-reasoner` | [DeepSeek 开放平台](https://platform.deepseek.com/) |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3`、`Qwen/Qwen2.5-72B-Instruct` | [硅基流动控制台](https://cloud.siliconflow.cn/) |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o`、`gpt-4o-mini` | [OpenAI Platform](https://platform.openai.com/) |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k`、`moonshot-v1-32k` | [Kimi 开放平台](https://platform.moonshot.cn/) |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`、`glm-4-plus` | [智谱开放平台](https://open.bigmodel.cn/) |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`、`qwen-turbo` | [阿里云百炼](https://dashscope.console.aliyun.com/) |

**👁️ 图片理解（Vision 模型，用于截屏理解/图片分析）：**

| 服务商 | API 地址 | 模型名示例 |
|--------|---------|-----------|
| 硅基流动 | `https://api.siliconflow.cn/v1` | `zai-org/GLM-4.5V`、`Qwen/Qwen2-VL-72B-Instruct` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o`、`gpt-4o-mini` |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-vision-pro-32k` |

> 💡 **小白推荐**：用 [硅基流动](https://cloud.siliconflow.cn/)，注册送额度，AI 大脑和图片理解都能用，填同一个 API 地址和密钥就行。

### 第三步：开始使用

- **双击**小橘猫 → 打开聊天框
- **右键**小橘猫 → 打开菜单（设置、技能、MCP 工具、定时任务等）
- **拖文件**到小橘猫身上 → 自动读取文件内容并分析

试试说：
- 「帮我写一份项目周报」
- 「查一下明天北京到上海的火车票」
- 「帮我用 Python 分析桌面的销售数据，画个趋势图」
- 「打开微信」「5分钟后提醒我开会」

---

## 🔧 其他配置（按需）

### 联网搜索（Tavily）

1. 前往 [tavily.com](https://tavily.com) 注册账号
2. 获取 API Key（免费 1000 次/月）
3. 在设置 → API 密钥配置 → 「🔍 联网搜索」填入 Key
4. 保存重启后，AI 对话时需要实时信息会自动搜索

### MCP 外部工具

1. 前往 [魔搭 MCP](https://modelscope.cn/mcp) 浏览可用工具
2. 复制 MCP Server 配置 JSON
3. 右键小橘猫 → MCP 工具 → 粘贴配置 → 自动连接
4. 之后跟小橘猫说「查火车票」「查南京天气」就会自动调用

### 邮箱集成

1. 右键 → 设置 → 邮箱集成
2. 填入邮箱地址和授权码（不是登录密码！）
3. 保存后，跟小橘猫说「给张三发邮件」「查收件箱」

### IMA 知识库

1. 前往 [腾讯 IMA](https://ima.qq.com/) 开通知识库 API
2. 获取 Client ID 和 API Key
3. 在知识库面板中配置

### 文件保存路径

默认保存在桌面。可在设置 → 文件输出路径中修改。

---

## 📸 截图

（在这里添加你的应用截图）

---

## 🛠️ 开发者指南

### 从源码运行

```bash
# 克隆仓库
git clone https://github.com/你的用户名/小橘猫缘缘.git
cd 小橘猫缘缘

# 安装依赖
npm install

# 开发模式运行
npm start

# 打包
npm run dist
```

### 技术栈

- **Electron 33** — 桌面应用框架
- **原生 HTML/CSS/JS** — 前端（无框架依赖）
- **Python 3.11** — 内嵌运行时（自主写代码用）
- **OpenAI 兼容 API** — AI 大脑
- **MCP 协议** — 外部工具接入

### 项目结构

```
小橘猫缘缘/
├── main.js              # Electron 主进程（AI 对话、工具调用、IPC）
├── preload.js           # 安全 IPC 桥接
├── src/
│   ├── index.html       # 主界面
│   ├── css/main.css     # 全局样式（橙色主题）
│   └── js/
│       ├── renderer.js  # 渲染进程入口
│       ├── chat.js      # 聊天界面 + 流式输出
│       ├── settings.js  # 设置面板（API 密钥、邮箱、记忆等）
│       ├── mcp.js       # MCP 工具面板
│       ├── skills.js    # 技能管理面板
│       ├── whoami.js    # 自我介绍
│       └── interaction.js # 鼠标交互（拖拽、双击、右键）
├── python/              # 内嵌 Python 3.11 运行时
├── build/               # 图标资源
└── package.json
```

### 数据存储

所有用户数据存储在系统用户目录下，不会随应用打包：

| 数据 | 路径（Windows） |
|------|----------------|
| API 密钥 | `%APPDATA%\desktop-pet\api-config.json` |
| 聊天记录 | `%APPDATA%\desktop-pet\chat-history.json` |
| 用户画像 | `%APPDATA%\desktop-pet\pet-memory.json` |
| 邮箱配置 | `%APPDATA%\desktop-pet\email-config.json` |
| MCP 配置 | `%APPDATA%\desktop-pet\mcp-config.json` |
| 头像 | `%APPDATA%\desktop-pet\avatars\` |
| 定时任务 | `%APPDATA%\desktop-pet\scheduled-tasks.json` |

---

## 📋 系统要求

- **操作系统**：Windows 10/11（64 位）
- **内存**：建议 8GB 以上
- **网络**：需要联网（调用 AI API）

---

## ❓ 常见问题

### Q：打开后小橘猫不说话 / 提示「还没配置 API 密钥」

**A：** 标准版不内置任何密钥。请右键小橘猫 → 设置 → 🔑 API 密钥配置，填入你的 API 地址、密钥和模型名，保存后重启。

### Q：密钥安全吗？会不会泄露？

**A：** 密钥保存在你电脑的本地配置文件中（`%APPDATA%\desktop-pet\api-config.json`），不会上传到任何服务器。设置面板中密钥以掩码显示（只显示前6位和后4位）。

### Q：支持哪些 AI 服务商？

**A：** 任何兼容 OpenAI 接口的服务商都支持。详见上方「支持的 AI 服务商」表格。

### Q：MCP 工具怎么用？

**A：** 去魔搭 MCP 市场（modelscope.cn/mcp）找到你需要的工具，复制配置 JSON，在小橘猫右键 → MCP 工具中粘贴即可。之后直接跟小橘猫说你的需求，它会自动调用对应工具。

### Q：Python 代码在哪里执行？

**A：** 小橘猫自带 Python 3.11 运行时（打包在应用内），不需要你额外安装 Python。代码在本地沙箱执行，生成的文件保存在你配置的输出目录（默认桌面）。

### Q：如何卸载？

**A：**
- **安装版**：在系统设置 → 应用中卸载，或在安装目录运行卸载程序
- **免安装版**：直接删除 exe 文件即可
- 用户数据不会自动删除，如需清理请手动删除 `%APPDATA%\desktop-pet\` 文件夹

---

## 📄 开源协议

MIT License — 可自由使用、修改、分发。

---

## 👤 作者

**duansihang**

如果小橘猫对你有帮助，欢迎 Star ⭐ 支持！

喵~有什么问题随时提 Issue 喵～🐱
