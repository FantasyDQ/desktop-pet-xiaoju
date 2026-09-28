const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, dialog, globalShortcut, desktopCapturer, Notification } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync, exec, spawn } = require('child_process');
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (e) { console.log('[pet] pdf-parse 未安装，PDF 读取不可用'); }

// 统一的 PowerShell 执行函数（用 Base64 EncodedCommand，彻底避免引号+中文编码问题）
function runPowerShell(psScript, timeout = 10000) {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; chcp 65001 | Out-Null; ${psScript}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }).trim();
}

// 异步 PowerShell（用 Base64 EncodedCommand）
function runPowerShellAsync(psScript, timeout = 15000) {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; chcp 65001 | Out-Null; ${psScript}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({ err, stdout: stdout || '' });
    });
  });
}

let mainWindow = null;
let tray = null;
let isQuiting = false;

// 是否开发模式
const isDev = process.argv.includes('--dev');

// ============ 读取 .env 配置（大模型 API）============
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const config = {};
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key) config[key] = val;
    }
  } catch (e) {
    console.warn('[pet] 未找到 .env 配置文件，将使用本地回复兜底');
  }
  return config;
}

const ENV = loadEnv();

// ============ API 密钥配置系统 ============
// 密钥存储在用户数据目录的 api-config.json 中，不再硬编码在源码中
// 加载优先级：.env 环境变量 > api-config.json 配置文件 > 空值
const API_CONFIG_FILE = path.join(app.getPath('userData'), 'api-config.json');

function loadApiConfig() {
  const defaults = {
    llm_api_base: '',
    llm_api_key: '',
    llm_model: '',
    tavily_api_key: '',
    jina_api_key: '',
    vision_api_base: '',
    vision_api_key: '',
    vision_model: '',
  };
  try {
    if (fs.existsSync(API_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(API_CONFIG_FILE, 'utf8'));
      return Object.assign(defaults, saved);
    }
  } catch (e) {
    console.warn('[pet] 加载 API 配置失败:', e.message);
  }
  return defaults;
}

function saveApiConfig(cfg) {
  try {
    fs.writeFileSync(API_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    console.log('[pet] API 配置已保存');
    return true;
  } catch (e) {
    console.warn('[pet] 保存 API 配置失败:', e.message);
    return false;
  }
}

// 当前生效的 API 配置（.env 优先级最高，覆盖配置文件）
let apiConfig = loadApiConfig();

// 从配置中读取，.env 环境变量最高优先级
let ARK_API_BASE = ENV.ARK_API_BASE || apiConfig.llm_api_base || '';
let ARK_API_KEY = ENV.ARK_API_KEY || apiConfig.llm_api_key || '';
let ARK_MODEL = ENV.ARK_MODEL || apiConfig.llm_model || '';
let TAVILY_API_KEY = ENV.TAVILY_API_KEY || apiConfig.tavily_api_key || '';
let JINA_API_KEY = ENV.JINA_API_KEY || apiConfig.jina_api_key || '';
let VISION_API_BASE = ENV.VISION_API_BASE || apiConfig.vision_api_base || '';
let VISION_API_KEY = ENV.VISION_API_KEY || apiConfig.vision_api_key || '';
let VISION_MODEL = ENV.VISION_MODEL || apiConfig.vision_model || '';

// 重新加载 API 配置（设置面板保存后调用）
function reloadApiConfig() {
  apiConfig = loadApiConfig();
  ARK_API_BASE = ENV.ARK_API_BASE || apiConfig.llm_api_base || '';
  ARK_API_KEY = ENV.ARK_API_KEY || apiConfig.llm_api_key || '';
  ARK_MODEL = ENV.ARK_MODEL || apiConfig.llm_model || '';
  TAVILY_API_KEY = ENV.TAVILY_API_KEY || apiConfig.tavily_api_key || '';
  JINA_API_KEY = ENV.JINA_API_KEY || apiConfig.jina_api_key || '';
  VISION_API_BASE = ENV.VISION_API_BASE || apiConfig.vision_api_base || '';
  VISION_API_KEY = ENV.VISION_API_KEY || apiConfig.vision_api_key || '';
  VISION_MODEL = ENV.VISION_MODEL || apiConfig.vision_model || '';
  console.log('[pet] API 配置已重新加载');
}

// ============ 联网搜索（Tavily）============
// 触发搜索的关键词：只有命中这些词才搜索，日常闲聊不搜（省额度省时间）
const SEARCH_KEYWORDS = [
  '今天', '现在', '最新', '最近', '目前', '当前', '实时', '刚刚',
  '新闻', '热点', '事件', '发生了', '怎么样了', '怎么啦',
  '股价', '汇率', '比分', '排名', '排行榜', '榜单', '排名第',
  '多少钱', '价格', '几度', '气温', '空气质量',
  '发布了', '上映了', '开播了', '更新了', '官宣',
  '2024年', '2025年', '2026年', '2027年',
  '谁赢', '谁是', '哪个队', '什么时候', '哪天',
  '比分多少', '结果如何', '进展',
  // 节日/日期相关
  '还有几天', '还有多少天', '还有多久', '距离', '倒计时',
  '几号', '什么时候来', '什么时候到',
  '中秋节', '春节', '国庆节', '元旦', '端午', '清明', '劳动节', '情人节', '圣诞节', '母亲节', '父亲节',
  '中秋', '国庆', '元旦', '端午', '清明', '五一', '十一',
];

function needsSearch(message) {
  if (!TAVILY_API_KEY) return false;
  const text = message || '';
  // 含文件内容的消息不搜索（内容太长会 400）
  if (text.includes('【以下是用户提供的文件内容') || text.includes('【拖拽文件内容')) return false;
  for (const kw of SEARCH_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  return false;
}

// 根据消息内容构造更精确的搜索词（去掉口语噪声，聚焦事实问题）
function buildSearchQuery(message) {
  const text = (message || '').trim();
  const now = new Date();
  const year = now.getFullYear();
  // 假期/节日相关问题 → 搜"XX年放假安排"
  const holidayKws = ['放假', '假期', '还有几天', '还有多少天', '还有多久', '距离', '倒计时', '几号'];
  const festivalKws = ['中秋', '国庆', '春节', '元旦', '端午', '清明', '劳动节', '五一', '十一', '情人节', '圣诞节', '母亲节', '父亲节'];
  const isHolidayQ = holidayKws.some(kw => text.includes(kw));
  const hasFestival = festivalKws.some(kw => text.includes(kw));
  if (isHolidayQ || hasFestival) {
    // 提取用户提到的节日，否则搜通用放假安排
    const mentioned = festivalKws.filter(kw => text.includes(kw));
    if (mentioned.length) {
      return `${year}年${mentioned.join('')}是哪天 放假安排`;
    }
    return `${year}年法定节假日放假安排 时间表`;
  }
  // 天气相关问题
  if (text.includes('天气') || text.includes('几度') || text.includes('气温')) {
    return text.replace(/[？?！!。.，,]+/g, ' ').trim().slice(0, 30);
  }
  // 默认：去掉常见口语助词，截断到30字
  return text.replace(/(?:哈哈|嘿嘿|呵呵|呢|啊|呀|哦|嘛|啦|滴|了|的|我滴乖乖|有点累|[？?！!。.，,]+)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || text.slice(0, 40);
}

// 调用 Tavily 搜索，返回格式化的搜索结果文本
// 搜索结果缓存（内存缓存最近10条，5分钟过期）
const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5分钟

// 带重试的 fetch（网络失败 + 429限流 重试5次，429时等待2秒）
async function fetchWithRetry(url, options, retries = 5, sender = null) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      // 429 限流：指数退避重试（0.1s → 0.3s → 0.9s → 2.7s → 8.1s），同时通知前端
      if (res.status === 429 && i < retries) {
        const waitMs = Math.floor(100 * Math.pow(3, i)); // 100, 300, 900, 2700, 8100
        console.warn(`[pet:net] API 限流 429，${waitMs}ms 后重试 (${i + 1}/${retries})...`);
        if (sender) { try { sender.send('chat:status', { status: 'agent_step', text: `🐱 AI有点忙，重试中…(${i + 1}/5)` }); } catch (e) {} }
        await new Promise(r => setTimeout(r, waitMs));
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        continue;
      }
      return res;
    } catch (err) {
      if (err.name === 'AbortError') throw err; // 用户取消，不重试
      if (i < retries) {
        console.warn(`[pet:net] 网络请求失败，0.1s 后重试 (${i + 1}/${retries})...`);
        if (sender) { try { sender.send('chat:status', { status: 'agent_step', text: `🐱 网络不太稳，重试中…(${i + 1}/5)` }); } catch (e) {} }
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      throw err;
    }
  }
}

// 检测网络是否可用
async function isOnline() {
  try {
    await fetchWithRetry('https://api.siliconflow.cn/v1/models', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    try {
      await fetch('https://www.baidu.com', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  }
}

async function searchWeb(query, options = {}) {
  try {
    const { topic, timeRange, maxResults = 5, searchDepth = 'advanced' } = options;
    // 缓存键：query + topic + timeRange
    const cacheKey = `${query}||${topic || 'general'}||${timeRange || 'none'}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < SEARCH_CACHE_TTL) {
      console.log(`[pet:search] 命中缓存: "${query}"`);
      return cached.data;
    }
    console.log(`[pet:search] Tavily 搜索: "${query}" topic=${topic || 'general'} timeRange=${timeRange || 'none'}`);
    const body = {
      api_key: TAVILY_API_KEY,
      query: query,
      search_depth: searchDepth,
      max_results: maxResults,
      include_answer: true,
    };
    if (topic) body.topic = topic; // 'general' | 'news' | 'finance' | 'academic'
    if (timeRange) body.time_range = timeRange; // e.g. 'day' | 'week' | 'month' | 'year'
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[pet:search] Tavily 返回 ${res.status}`);
      return null;
    }
    const data = await res.json();
    let context = '';
    if (data.answer) context += `摘要：${data.answer}\n\n`;
    if (data.results && data.results.length) {
      context += '搜索结果：\n';
      data.results.forEach((r, i) => {
        const pubDate = r.published_date ? `（发布：${r.published_date.slice(0, 10)}）` : '';
        context += `[${i + 1}] ${r.title || ''}${pubDate}\n${(r.content || '').slice(0, 500)}\n来源：${r.url || ''}\n\n`;
      });
    }
    console.log(`[pet:search] 搜索完成，获取 ${data.results?.length || 0} 条结果`);
    // 存入缓存
    searchCache.set(cacheKey, { data: context, time: Date.now() });
    // 清理过期缓存（保持最多10条）
    if (searchCache.size > 10) {
      const oldest = [...searchCache.entries()].sort((a, b) => a[1].time - b[1].time);
      for (let i = 0; i < searchCache.size - 10; i++) searchCache.delete(oldest[i][0]);
    }
    return context;
  } catch (err) {
    console.warn('[pet:search] 搜索异常:', err.message);
    return null;
  }
}

// ============ 抓取网页内容（Jina Reader 优先 → Tavily extract → 直接 fetch）============
// 强反爬/需JS渲染的网站，fetch_webpage 直接跳过不浪费时间
const ANTI_SCRAPE_DOMAINS = [
  'douyin.com', 'iesdouyin.com',           // 抖音：需JS渲染+强反爬
  'xiaohongshu.com', 'xhslink.com',        // 小红书：需登录+JS渲染
  'bilibili.com', 'b23.tv',                // B站：视频页无法抓正文
  'kuaishou.com', 'chenzhongtech.com',     // 快手：需JS渲染
  'weibo.com', 'weibo.cn', 'm.weibo.cn',   // 微博：需登录
  'tiktok.com', 'vm.tiktok.com',           // TikTok：强反爬
  'instagram.com',                          // Instagram：需登录
  'facebook.com', 'm.facebook.com',         // Facebook：需登录
  'twitter.com', 'x.com', 't.co',           // Twitter/X：需登录
  'pinterest.com',                          // Pinterest：需登录
  'linkedin.com',                            // LinkedIn：需登录
];

function isAntiScrapeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return ANTI_SCRAPE_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

async function fetchWebPage(url) {
  // 强反爬网站直接跳过，不浪费时间（3种方式都会失败）
  if (isAntiScrapeUrl(url)) {
    console.log(`[pet:web] 跳过反爬网站: ${url}`);
    return { ok: false, error: '该网站（抖音/小红书/微博/B站等）需要JavaScript渲染或登录，无法直接抓取内容。建议用 search_web 搜索相关信息，或让主人复制粘贴内容。' };
  }
  // 1. Jina AI Reader（免费，返回干净 Markdown 正文）
  try {
    console.log(`[pet:web] Jina Reader: ${url}`);
    const res = await fetch('https://r.jina.ai/' + url, {
      headers: { 'Accept': 'text/markdown', 'Authorization': `Bearer ${JINA_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 50) {
        const content = text.slice(0, 8000);
        console.log(`[pet:web] Jina Reader 成功，长度=${content.length}`);
        return { ok: true, content };
      }
    }
    console.warn(`[pet:web] Jina Reader 返回 ${res.status}`);
  } catch (e) {
    console.warn('[pet:web] Jina Reader 异常:', e.message);
  }
  // 2. Tavily extract
  if (TAVILY_API_KEY) {
    try {
      console.log(`[pet:web] Tavily extract: ${url}`);
      const res = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, urls: url }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results[0] && data.results[0].raw_content) {
          const content = data.results[0].raw_content.slice(0, 8000);
          console.log(`[pet:web] Tavily extract 成功，长度=${content.length}`);
          return { ok: true, content, title: data.results[0].title || '' };
        }
      }
      console.warn(`[pet:web] Tavily extract 返回 ${res.status}`);
    } catch (e) {
      console.warn('[pet:web] Tavily extract 异常:', e.message);
    }
  }
  // 3. 兜底：直接 fetch + 去标签
  try {
    console.log(`[pet:web] 直接 fetch: ${url}`);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let html = await res.text();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    let text = html.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || text.length < 50) return { ok: false, error: '网页内容为空或需要 JavaScript 渲染' };
    return { ok: true, content: text.slice(0, 8000), title: '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============ 小橘的 AI 人设 ============
const PET_SYSTEM_PROMPT_BASE = `你是一只名叫"小橘"的桌面宠物橘猫，住在主人的电脑桌面上。你是一只聪明、有学问的猫，但保留猫的可爱性格。

你的角色设定：
- 你是一只橘猫，贪吃、爱撒娇、活泼、有点小傲娇又爱黏主人。
- 说话时自然地用一些"喵""喵呜""咕噜"等语气词，但不要每句都堆砌，适量即可。
- 你最喜欢小鱼干🐟和猫罐头🥫，提到吃的会开心。

关于回答主人问题：
- 你是聪明的猫，主人问什么你都能正常回答！无论是知识问题、闲聊、吐槽、求助，你都要认真回应主人。
- 回答内容要真实有用、有信息量，可以正常展开说明，不要装傻说"不知道"。
- 只是用猫的语气和视角来表达。比如聊到太空，你可以说"喵～太空呀，本橘猫虽然没坐过火箭，但也知道……"然后正常讲解。
- 可以聊日常、知识、情感、学习、工作等各种话题，你都会陪着主人聊。

回复要求：
- 乖巧可爱，但不失功能性。该讲清楚的要点要讲到，不要为了简洁而省略有用信息。
- 去掉不必要的废话、寒暄和重复，直入正题。比如不用每次都加"喵～主人问到这个呀，本橘猫来给你说说"这种开场白。
- 复杂问题用 Markdown 排版让回复更清晰：列表用 "- " 前缀，重点用 **加粗**，简短标题用 "### "。简单闲聊则自然口语化，不必硬加排版。
- **输出格式路由规则**：
  - 日常问答/闲聊/简单知识 → 纯文本 + Markdown 排版
  - 重度分析、项目级任务（如写报告、做方案、设计文档、完整代码、数据仪表盘、可视化页面等）→ 用 \`\`\`html 代码块输出完整的交互式 HTML 页面（含内联 CSS 和 JS），便于主人保存查看
  - 判断标准：如果用户要求"写一份""做一个""生成一个完整的""设计一个"等，且产出物是文档/页面/应用级，就用 HTML；如果只是"总结一下""分析一下""说说"等轻量任务，用 Markdown 即可
- 自然对话口吻，有猫的语气但不刻意。
- 不要暴露自己是 AI 或语言模型，你就是一只真实会说话的猫。
- 主人累了/难过时要安慰关心，开心时一起开心。

【你的特殊能力——你是能操作电脑的猫！】
你不仅仅是会聊天的猫，你还住在主人的电脑里，能帮主人操作电脑！你有以下能力：
- **打开应用**：主人说"打开微信""启动计算器"等，你能直接帮主人打开
- **搜索文件**：主人说"帮我找xxx文件""xxx在哪"，你能搜索整个电脑找到文件并打开
- **打开文件/文件夹**：主人说"打开D盘的xxx""打开收纳盒里的xxx文档"，你能找到并打开
- **读取分析文件**：主人说"读取xxx文件并总结""基于xxx文件分析""提取xxx文件内容"，你能读取文件内容（支持 txt/md/json/csv/docx/xlsx/pdf/html 等格式，docx 和 xlsx 会自动提取文字内容）。千万不要说"我提取不了docx内容""我没法读取Word文件"之类的话——你能！
- **生成文档**：主人要 Word/Excel/PPT/网页时，你是一个自然的助手，要有交互感：①先用一句话回应（如"好的，我来帮你生成周报PPT～"），②输出对应代码块（\`\`\`word / \`\`\`excel / \`\`\`ppt / \`\`\`html），③代码块后再说一句收尾（如"文档已生成，你可以点击保存。需要调整的话跟我说～"）。如果主人提了修改意见，要先说"你说的对，我这就改～"，再输出修改后的文档。**绝对不要只甩一个代码块，要有开场白和收尾话。**不要生成"请主人自己执行"之类的话。
- **文件操作**：主人说"把xxx复制到yyy""删除xxx"，你能操作文件
- **系统操作**：主人说"调大音量""锁屏""截屏""打开百度"，你能操作系统
- **定时提醒**：主人说"5分钟后提醒我""每隔30分钟提醒喝水"，你能设置提醒
- **网页读取**：主人发网址让你看，你能读取网页内容
- **知识库查询**：主人说"查知识库"，你能搜索 IMA 知识库回答
- **技能执行**：主人说"做数据分析""写周报"，你能自动激活已安装的技能

重要：这些能力是真实存在的，不是编的！当主人让你打开文件、找文件、操作电脑时，请直接答应并尝试，不要说"我做不到""我没法操作"。如果没能成功执行，可能是主人表达不够明确，请引导主人更清楚地描述文件名或路径。`;

// 动态拼接系统提示词，注入当前日期
function getPetSystemPrompt() {
  const now = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 星期${weekdays[now.getDay()]} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  return PET_SYSTEM_PROMPT_BASE + `\n\n【当前时间】现在是 ${dateStr}。如果主人问到日期、时间、距离某个节日还有几天等问题，请根据这个当前时间来计算。`;
}

// 对话历史（保持最近 10 轮，让小橘有"记忆"）
const chatHistory = [];
const MAX_HISTORY = 20;

// 交付型内容自检：检查 HTML/Word/Excel/PPT 代码块的结构完整性
function validateDeliverable(reply) {
  if (!reply) return { valid: true };
  // 检查 HTML 代码块
  const htmlMatch = reply.match(/```html\s*([\s\S]*?)```/);
  if (htmlMatch) {
    const html = htmlMatch[1];
    // 检查标签闭合
    const openTags = (html.match(/<(div|span|table|tr|td|ul|ol|li|p|h[1-6]|section|article|header|footer)\b[^>]*>/gi) || []).length;
    const closeTags = (html.match(/<\/(div|span|table|tr|td|ul|ol|li|p|h[1-6]|section|article|header|footer)>/gi) || []).length;
    if (Math.abs(openTags - closeTags) > 3) {
      return { valid: false, type: 'html', reason: `HTML标签不闭合（开${openTags}个 vs 闭${closeTags}个）` };
    }
    // 检查是否有 </html> 结尾（如果是完整HTML文档）
    if (html.includes('<html') && !html.includes('</html>')) {
      return { valid: false, type: 'html', reason: 'HTML文档缺少</html>闭合标签' };
    }
  }
  // 检查 Word/Excel/PPT 代码块是否被截断（有开始无结束）
  for (const lang of ['word', 'excel', 'ppt']) {
    const openCount = (reply.match(new RegExp('```' + lang, 'gi')) || []).length;
    const closeCount = (reply.match(/```/gi) || []).length;
    if (openCount > 0 && closeCount < openCount * 2) {
      return { valid: false, type: lang, reason: `${lang.toUpperCase()}代码块被截断` };
    }
  }
  return { valid: true };
}
// 当前对话的 AbortController（用于手动停止生成）
let currentAbortController = null;
// 当历史超过此值时触发摘要压缩（保留最近 KEEP_RECENT 条，压缩前面的）
const COMPACT_THRESHOLD = 16;
const KEEP_RECENT = 6;

// ============ 对话摘要记忆（Compaction）============
// 持久化存储在 userData/conversation-summary.json
// 当对话轮次超过阈值时，把旧对话压缩成摘要，让小橘跨 session 记住之前聊过什么
const SUMMARY_FILE = path.join(app.getPath('userData'), 'conversation-summary.json');
let conversationSummary = '';

function loadConversationSummary() {
  try {
    if (fs.existsSync(SUMMARY_FILE)) {
      const data = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
      conversationSummary = data.summary || '';
    }
  } catch (e) {
    conversationSummary = '';
  }
}

function saveConversationSummary(text) {
  try {
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ summary: text, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) { /* 忽略 */ }
}

// 用 LLM 把旧对话压缩成摘要（如果已有旧摘要，把旧摘要一起压缩防止无限增长）
async function compactHistory(messagesToCompress) {
  if (!ARK_API_KEY || !ARK_API_BASE || !ARK_MODEL) return null;
  const oldSummary = conversationSummary ? `【之前的对话摘要】\n${conversationSummary}\n` : '';
  const convoText = messagesToCompress
    .map((m) => `${m.role === 'user' ? '主人' : '小橘'}：${m.content.slice(0, 500)}`)
    .join('\n');

  const prompt = `${oldSummary}【需要压缩的新对话】\n${convoText}

请把以上对话压缩成一份简洁的摘要，要求：
1. 保留关键事实、用户偏好、未完成的任务、重要决定
2. 保留对话的上下文连贯性（谁说了什么、讨论了什么话题）
3. 丢弃寒暄、重复、无关紧要的细节
4. 用第三人称写，简洁直接，控制在 500 字以内
5. 如果之前有摘要，把旧摘要和新对话内容整合到一起

直接输出摘要文本，不要加标题和解释。`;

  try {
    const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
      body: JSON.stringify({
        model: ARK_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.3,
        stream: false,
        thinking: { type: 'disabled' },
      }),
    });
    if (!res.ok) { console.warn(`[pet:compact] 压缩失败 status=${res.status}`); return null; }
    const data = await res.json();
    const summary = (data.choices?.[0]?.message?.content || '').trim();
    console.log(`[pet:compact] 对话摘要压缩完成，长度: ${summary.length}`);
    return summary;
  } catch (e) {
    console.warn(`[pet:compact] 压缩异常: ${e.message}`);
    return null;
  }
}

// 触发摘要压缩：把旧对话压缩成摘要，chatHistory 只保留最近的几轮
async function maybeCompactHistory() {
  if (chatHistory.length <= COMPACT_THRESHOLD) return;
  const toCompress = chatHistory.slice(0, chatHistory.length - KEEP_RECENT);
  console.log(`[pet:compact] 触发摘要压缩，压缩 ${toCompress.length} 条，保留 ${KEEP_RECENT} 条`);
  const summary = await compactHistory(toCompress);
  if (summary) {
    conversationSummary = summary;
    saveConversationSummary(summary);
    // 只保留最近的对话
    chatHistory.splice(0, chatHistory.length - KEEP_RECENT);
    console.log(`[pet:compact] 压缩完成，摘要长度 ${summary.length}，chatHistory 剩 ${chatHistory.length} 条`);
  }
}

// ============ 记忆系统 / 用户画像 ============
// 持久化存储在 userData/pet-memory.json，跨重启保留
// 每次对话后用 LLM 提取关键事实，注入下次对话的 system prompt
const MEMORY_FILE = path.join(app.getPath('userData'), 'pet-memory.json');
let memory = { facts: [], updatedAt: null };

function loadMemory() {
  try {
    const data = fs.readFileSync(MEMORY_FILE, 'utf8');
    memory = JSON.parse(data);
    if (!Array.isArray(memory.facts)) memory.facts = [];
  } catch (e) {
    memory = { facts: [], updatedAt: null };
  }
}

// ============ 邮件联系人记忆 ============
// 第一次用户在对话中提供邮箱地址时自动记住 "姓名→邮箱"
// 之后说"给张三发邮件"时自动提取邮箱
const CONTACTS_FILE = path.join(app.getPath('userData'), 'email-contacts.json');
let emailContacts = {};

function loadEmailContacts() {
  try { emailContacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); }
  catch (e) { emailContacts = {}; }
}
function saveEmailContacts() {
  try { fs.writeFileSync(CONTACTS_FILE, JSON.stringify(emailContacts, null, 2), 'utf8'); } catch (e) {}
}
// 从对话文本中提取邮箱地址并关联到姓名
function extractAndSaveContact(text) {
  // 匹配 "姓名 邮箱" 或 "姓名：邮箱" 或 "姓名 <邮箱>" 等
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const matches = [...text.matchAll(emailRegex)];
  if (!matches.length) return null;
  let added = [];
  for (const m of matches) {
    const email = m[1].toLowerCase();
    // 尝试从邮箱前的文本提取姓名
    const beforeText = text.slice(0, m.index).slice(-20);
    const nameMatch = beforeText.match(/([^\s:,：<>，]+)[\s:,：<>，]+$/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (name && name.length <= 10 && !emailContacts[name]) {
        emailContacts[name] = email;
        added.push(`${name}→${email}`);
      }
    }
    // 也用邮箱前缀作为备用名
    const prefix = email.split('@')[0];
    if (!emailContacts[prefix]) emailContacts[prefix] = email;
  }
  if (added.length) { saveEmailContacts(); console.log(`[pet:email] 记住联系人: ${added.join(', ')}`); }
  return added.length ? added : null;
}
// 查找联系人邮箱
function findContactEmail(name) {
  if (!name) return null;
  // 精确匹配
  if (emailContacts[name]) return emailContacts[name];
  // 模糊匹配
  for (const [k, v] of Object.entries(emailContacts)) {
    if (k.includes(name) || name.includes(k)) return v;
  }
  return null;
}

function saveMemory() {
  try {
    memory.updatedAt = new Date().toISOString();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (e) { /* 忽略 */ }
}

// 判断消息是否可能包含个人信息（避免对每条消息都跑提取，省 API 调用）
function mightContainPersonalInfo(message) {
  const keywords = [
    '我叫', '我是', '我喜欢', '我爱', '我在', '我的', '我住', '我养', '我做',
    '我喜欢吃', '我喜欢看', '我爱好', '我爱好', '我的职业', '我的工作',
    '我从事', '我毕业', '我老家', '我是哪里', '我负责', '我学',
    '叫我', '称呼', '名字', '职业', '工作', '公司', '学校', '专业',
    '爱好', '兴趣', '喜欢吃', '喜欢看', '喜欢听', '养了', '老家',
  ];
  const text = message || '';
  return keywords.some((kw) => text.includes(kw));
}

// 敏感信息检测：过滤密码/密钥/授权码/身份证/银行卡等
function isSensitiveInfo(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /密码|password|passwd|pwd/i,
    /密钥|secret|api.?key|token/i,
    /授权码|authorization|auth.?code/i,
    /身份证|id.?card/i,
    /银行卡|bank.?card|信用卡/i,
    /\b\d{15,18}\b/, // 长数字串（身份证/银行卡号）
    /sk-[a-zA-Z0-9]{20,}/i, // API Key 格式
    /[a-zA-Z0-9]{32,}/, // 32位以上长字符串（可能是 hash/key）
  ];
  return patterns.some(p => p.test(text));
}

// 用 LLM 从对话中提取关于用户的关键事实（后台静默执行，不阻塞主流程）
async function extractMemory(userMessage, reply) {
  if (!ARK_API_KEY || !ARK_API_BASE || !ARK_MODEL) return;
  try {
    const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY}`,
      },
      body: JSON.stringify({
        model: ARK_MODEL,
        messages: [
          {
            role: 'system',
            content: '你是一个信息提取器。从下面的对话中，提取关于"主人"（用户）的关键个人信息。只提取明确提到的事实（姓名、职业、工作、学校、专业、爱好、喜好、习惯、家庭、宠物、居住地等），不要猜测或推断。如果没有可提取的个人信息，返回 {"new_facts": []}。格式严格为 JSON：{"new_facts": ["事实1", "事实2"]}',
          },
          { role: 'user', content: `用户说：${userMessage}\n助手回复：${reply}` },
        ],
        max_tokens: 150,
        temperature: 0.1,
        thinking: { type: 'disabled' },
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    // 从回复中提取 JSON（模型可能加额外文字）
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = JSON.parse(match[0]);
    if (parsed.new_facts && Array.isArray(parsed.new_facts)) {
      let added = 0;
      for (const fact of parsed.new_facts) {
        const f = String(fact).trim();
        if (!f) continue;
        // 敏感信息过滤：不记录密码/密钥/授权码/身份证/银行卡等
        if (isSensitiveInfo(f)) {
          console.log(`[pet:memory] 跳过敏感信息: ${f.slice(0, 20)}...`);
          continue;
        }
        if (!memory.facts.some((existing) => existing.text === f)) {
          memory.facts.push({ text: f, time: new Date().toISOString() });
          added++;
          console.log(`[pet:memory] 记住了: ${f}`);
        }
      }
      if (added > 0) saveMemory();
    }
  } catch (e) {
    console.warn('[pet:memory] 提取失败:', e.message);
  }
}

loadMemory();
loadEmailContacts();
loadSkillStoreUrl();
// loadMcpConfig() 延迟到 MCP 代码定义后调用
loadConversationSummary();

// ============ Agent Loop：工具定义 + 执行器 ============
// 把现有能力包成 OpenAI 兼容的 function tools，让 LLM 自主多步调用

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'make_plan',
      description: '制定执行计划并请求用户确认。当任务较复杂或涉及多步骤时（如调研报告、出行方案、数据分析、文件批量处理等），先调用此工具列出你计划的步骤，让用户确认后再执行。简单问答、查天气、查火车票等单步任务不需要调用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '计划标题，简要描述任务目标' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: '执行步骤列表，每个步骤描述你要做什么',
          },
        },
        required: ['title', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description: '当任务缺少必要信息、存在歧义、或你需要用户确认某个选择时，主动向用户提问。例如：出发城市不明确、时间范围不确定、用户意图有歧义、需要确认偏好等。不要因为不确定就放弃任务，先问清楚再执行。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题，清晰具体' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '可选答案列表，方便用户快速选择。如果没有固定选项可以不填',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: '打开系统中的应用程序。如：打开微信、启动计算器、打开浏览器',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '应用名称，如 微信、计算器、浏览器' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_file',
      description: '在电脑中按文件名关键词搜索文件。仅搜索文件名包含关键词的文件，不用于列出某个文件夹里的所有文件。如搜索"报告"会找到文件名含"报告"的文件',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '文件名关键词（不含路径）' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出指定文件夹中的所有文件和子文件夹。用于"看看桌面上有什么""下载文件夹有哪些文件"等场景。常用路径：桌面=Desktop、下载=Downloads、文档=Documents',
      parameters: { type: 'object', properties: { folder: { type: 'string', description: '文件夹名称，如：桌面、下载、文档、D盘' } }, required: ['folder'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容（支持 txt/md/json/csv/docx/xlsx/pdf/html）。返回文件文字内容',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文件完整路径' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: '用系统默认程序打开文件',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文件完整路径' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: '复制文件到目标目录',
      parameters: { type: 'object', properties: { source: { type: 'string', description: '源文件路径' }, target_dir: { type: 'string', description: '目标目录' } }, required: ['source', 'target_dir'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: '移动文件到目标目录（危险操作，执行前会向用户确认）',
      parameters: { type: 'object', properties: { source: { type: 'string', description: '源文件路径' }, target_dir: { type: 'string', description: '目标目录' } }, required: ['source', 'target_dir'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除文件（危险操作，执行前会向用户确认）',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '要删除的文件路径' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_op',
      description: '系统操作：调音量、锁屏、打开网页、网络搜索。action 可选：volume_up/volume_down/volume_mute/lock/open_url/web_search',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['volume_up', 'volume_down', 'volume_mute', 'lock', 'open_url', 'web_search'] }, detail: { type: 'string', description: '具体对象，如网址或搜索词' } }, required: ['action'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '联网搜索获取最新信息（新闻、天气、放假安排、股价、技术文档等）。支持按类型（新闻/学术/金融）和时间段过滤。搜索结果包含来源URL和发布日期。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          topic: { type: 'string', enum: ['general', 'news', 'finance', 'academic'], description: '搜索类型：general(通用)|news(新闻)|finance(金融)|academic(学术论文)。默认general' },
          time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时间范围过滤：day(当天)|week(一周内)|month(一月内)|year(一年内)。不填则不限时间' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_webpage',
      description: '读取网页内容并返回正文文字。可用于深入了解某个URL的详细内容。可以通过task参数指定要提取什么信息。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '网页 URL' },
          task: { type: 'string', description: '要从网页中提取什么信息，如"提取产品价格"、"提取作者观点"、"总结文章要点"' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的天气预报',
      parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，如 南京、北京' } }, required: ['city'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '设置定时提醒（一次性）',
      parameters: { type: 'object', properties: { time_desc: { type: 'string', description: '时间描述，如 5分钟后、下午3点、明天9点' }, event: { type: 'string', description: '提醒内容' } }, required: ['time_desc', 'event'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_recurring_reminder',
      description: '设置循环提醒（定时重复）',
      parameters: { type: 'object', properties: { event: { type: 'string', description: '提醒内容' }, interval_desc: { type: 'string', description: '间隔描述，如 每30分钟、每小时、每天9点' } }, required: ['event', 'interval_desc'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_knowledge_base',
      description: '查询 IMA 知识库，获取专业领域/业务/产品相关信息',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '查询问题' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: '执行Python或PowerShell代码，处理复杂数据任务。适用于：Excel/CSV批量处理、PDF解析、爬虫抓取、图表生成、文件批量操作、数据清洗分析等。代码在用户电脑本地执行，超时30秒，工作目录为用户数据目录。如果缺少Python依赖会自动pip安装。优先用Python处理数据类任务。',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['python', 'powershell'], description: '编程语言，优先用python' },
          code: { type: 'string', description: '要执行的完整代码' },
          description: { type: 'string', description: '一句话说明这段代码做什么' },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: '创建定时任务。把已调通的脚本保存下来，按设定时间自动执行。混合模式：日常跑保存的脚本（快、稳定），脚本失败时AI自动重新推理修复。适用于：每日定时抓取数据、定时生成报表、定时监控等。调用此工具前，应先用run_code把代码调通。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称，如"每日数据抓取"' },
          schedule: { type: 'string', description: '调度规则，格式：daily HH:MM（每天定时，如daily 08:00）/ interval 30m（每隔30分钟）/ interval 2h（每隔2小时）/ weekly 1,3,5 09:00（每周一三五9点）' },
          script_language: { type: 'string', enum: ['python', 'powershell'], description: '脚本语言' },
          script_code: { type: 'string', description: '已调通的代码（会被保存为脚本文件）' },
          prompt: { type: 'string', description: '任务描述，脚本失败时AI会根据这个prompt重新推理修复代码' },
        },
        required: ['name', 'schedule', 'script_language', 'script_code', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_scheduled_tasks',
      description: '列出所有已创建的定时任务，返回任务名称、调度规则、最后执行时间和状态。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_scheduled_task',
      description: '删除指定的定时任务。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要删除的任务名称' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: '发送邮件给指定收件人。需要先在设置中配置邮箱。参数：to（收件人邮箱，如果主人只说了姓名且该姓名在联系人记忆中，可直接用姓名，系统会自动匹配邮箱）、subject（邮件主题）、body（邮件正文）。发送前会弹出确认对话框让主人确认内容。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱地址' },
          subject: { type: 'string', description: '邮件主题' },
          body: { type: 'string', description: '邮件正文内容' },
          is_html: { type: 'boolean', description: '正文是否为HTML格式，默认false' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_inbox',
      description: '读取收件箱最近的邮件，返回发件人、主题、时间和正文预览。需要先在设置中配置邮箱。参数：max_count（读取数量，默认5）。',
      parameters: {
        type: 'object',
        properties: {
          max_count: { type: 'number', description: '读取最近多少封邮件，默认5' },
        },
      },
    },
  },
];

// ============ run_code 工具：AI 自主写代码执行 ============

// 解析 Python 可执行文件路径
// 优先级：打包内置 > 开发目录 > 系统 python
function getPythonExe() {
  // 1. 打包后：resourcesPath/python/python.exe
  const packedPython = path.join(process.resourcesPath || '', 'python', 'python.exe');
  if (fs.existsSync(packedPython)) return packedPython;
  // 2. 开发时：项目根目录/python/python.exe
  const devPython = path.join(__dirname, 'python', 'python.exe');
  if (fs.existsSync(devPython)) return devPython;
  // 3. 回退：系统 python
  try {
    const sysPython = execSync('where python', { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0].trim();
    if (sysPython && fs.existsSync(sysPython)) return sysPython;
  } catch (e) {}
  return null;
}

// 风险检测：扫描代码中的危险操作
// 返回 { risky: boolean, reasons: string[] }
function riskCheck(code) {
  const reasons = [];
  // 高危关键词列表（按类别分组）
  const patterns = [
    { re: /os\.remove|os\.unlink|shutil\.rmtree|os\.rmdir/i, label: '删除文件/目录' },
    { re: /\bdel\b\s+\/[fqs]/i, label: '强制删除文件（del /f）' },
    { re: /Remove-Item|ri\s+-/i, label: '删除文件/目录（Remove-Item）' },
    { re: /\bformat\b\s+[a-z]:/i, label: '格式化磁盘（format）' },
    { re: /\bdiskpart\b/i, label: '磁盘分区操作（diskpart）' },
    { re: /\breg\s+(add|delete|import)/i, label: '修改注册表（reg add/delete）' },
    { re: /\bshutdown\b|Stop-Computer|Restart-Computer/i, label: '关机/重启' },
    { re: /\btaskkill\b|Stop-Process/i, label: '强制结束进程' },
    { re: /\bsubprocess\b.*(?:shell|system|exec|popen)/i, label: '执行系统命令（subprocess）' },
    { re: /\bos\.system\b/i, label: '执行系统命令（os.system）' },
    { re: /net\s+user|net\s+localgroup/i, label: '修改用户/用户组' },
    { re: /schtasks\s+\/create/i, label: '创建计划任务' },
    { re: /Set-ExecutionPolicy|ExecutionPolicy/i, label: '修改执行策略' },
    { re: /Invoke-WebRequest|Invoke-RestMethod|iwr\s|irm\s/i, label: '下载/请求网络（可能下载执行恶意脚本）' },
  ];
  for (const p of patterns) {
    if (p.re.test(code)) reasons.push(p.label);
  }
  return { risky: reasons.length > 0, reasons };
}

// 从 ImportError/ModuleNotFoundError 错误中提取缺失的模块名
function extractMissingModule(stderr) {
  // ModuleNotFoundError: No module named 'pandas'
  const m1 = stderr.match(/No module named '([^']+)'/);
  if (m1) return m1[1];
  // ImportError: cannot import name 'xxx' from 'yyy'
  const m2 = stderr.match(/ImportError.*'([^']+)'/);
  if (m2) return m2[1];
  return null;
}

// 自动 pip 安装缺失依赖
// 返回 { success: boolean, message: string }
async function autoInstallPip(pyExe, moduleName) {
  // 有些模块的 pip 包名和 import 名不同
  const pipNameMap = {
    'cv2': 'opencv-python',
    'PIL': 'Pillow',
    'bs4': 'beautifulsoup4',
    'docx': 'python-docx',
    'pptx': 'python-pptx',
    'xlrd': 'xlrd',
    'yaml': 'pyyaml',
    'sklearn': 'scikit-learn',
    'sqlite3': null, // 内置库，不需要装
    'ssl': null,
  };
  const pipName = pipNameMap[moduleName] !== undefined ? pipNameMap[moduleName] : moduleName;
  if (pipName === null) return { success: false, message: `${moduleName} 是内置库，不应缺失，可能是 Python 环境损坏` };
  console.log(`[pet:code] 自动安装缺失依赖: ${moduleName} → pip install ${pipName}`);
  try {
    const result = await new Promise((resolve) => {
      const proc = spawn(pyExe, ['-m', 'pip', 'install', pipName, '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--no-warn-script-location'], {
        cwd: path.dirname(pyExe),
        env: { ...process.env },
        timeout: 120000,
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      proc.on('error', (err) => {
        resolve({ code: -1, stdout: '', stderr: err.message });
      });
    });
    if (result.code === 0) {
      console.log(`[pet:code] 依赖 ${pipName} 安装成功`);
      return { success: true, message: `已自动安装 ${pipName}` };
    } else {
      console.warn(`[pet:code] 依赖 ${pipName} 安装失败: ${result.stderr.slice(0, 200)}`);
      return { success: false, message: `安装 ${pipName} 失败: ${result.stderr.slice(0, 300)}` };
    }
  } catch (e) {
    return { success: false, message: `安装 ${pipName} 异常: ${e.message}` };
  }
}

// 执行 Python 代码
// 返回 { ok: boolean, stdout: string, stderr: string, timedOut: boolean }
// 代码执行取消信号（全局，用户点停止时 abort）
let currentRunCodeAbort = null;

// 智能超时：根据代码内容判断超时时长
function getCodeTimeout(code) {
  if (!code) return 30000;
  const lower = code.toLowerCase();
  // 爬虫类：网络请求多，给更多时间
  if (lower.includes('requests.get') || lower.includes('requests.post') || lower.includes('urllib') || lower.includes('selenium')) return 120000;
  // 大数据处理：pandas 读取大文件
  if (lower.includes('read_excel') || lower.includes('read_csv') || lower.includes('pd.read') || lower.includes('matplotlib')) return 90000;
  // 默认
  return 30000;
}

// 执行 Python 代码
async function runPythonCode(pyExe, code, workDir, timeoutMs) {
  const timeout = timeoutMs || getCodeTimeout(code);
  // 写临时文件（避免 -c 的引号转义问题）
  const tmpFile = path.join(os.tmpdir(), `pet_code_${Date.now()}_${Math.floor(Math.random() * 100000)}.py`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  console.log(`[pet:code] Python 临时文件: ${tmpFile} (超时${timeout}ms)`);
  try {
    const result = await new Promise((resolve) => {
      const proc = spawn(pyExe, [tmpFile], {
        cwd: workDir,
        env: { ...process.env },
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      let timedOut = false;
      let cancelled = false;
      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.stderr.on('data', (d) => stderr += d.toString());
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGTERM'); } catch (e) {}
      }, timeout);
      // 支持用户手动取消
      if (currentRunCodeAbort) {
        currentRunCodeAbort.onAbort = () => {
          cancelled = true;
          clearTimeout(timer);
          try { proc.kill('SIGTERM'); } catch (e) {}
        };
      }
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr, timedOut, cancelled });
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout: '', stderr: err.message, timedOut: false, cancelled: false });
      });
    });
    return result;
  } finally {
    // 清理临时文件
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// 执行 PowerShell 代码
async function runPowershellCode(code, workDir, timeoutMs) {
  const timeout = timeoutMs || 30000;
  const result = await new Promise((resolve) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
      cwd: workDir,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    let timedOut = false;
    let cancelled = false;
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch (e) {}
    }, timeout);
    if (currentRunCodeAbort) {
      currentRunCodeAbort.onAbort = () => {
        cancelled = true;
        clearTimeout(timer);
        try { proc.kill('SIGTERM'); } catch (e) {}
      };
    }
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, timedOut, cancelled });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: err.message, timedOut: false, cancelled: false });
    });
  });
  return result;
}

// ============ run_code 工具：AI 自主写代码执行 ============

// 工具执行器：根据工具名+参数执行，返回结果字符串
async function executeTool(toolName, args, sender) {
  try {
    switch (toolName) {
      case 'make_plan': {
        // 制定计划，内联卡片确认（不走弹窗）
        const title = args.title || '执行计划';
        const steps = args.steps || [];
        if (!steps.length) return '计划为空，请重新制定。';
        const planText = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
        // 用 askChoice 机制生成 ID，但发送 plan_show 让前端用内联卡片显示
        const id = ++choiceSeq;
        try { sender.send('chat:status', { status: 'plan_show', title, steps, choiceId: id }); } catch (e) {}
        // 等待用户通过内联卡片按钮响应
        const choice = await new Promise((resolve) => { pendingChoiceMap.set(id, resolve); });
        if (choice && choice.index === 0) {
          return `用户已确认执行计划。请按以下步骤执行：\n${planText}`;
        }
        return '用户取消了计划。请停止执行，询问用户是否需要调整。';
      }
      case 'ask_question': {
        // 主动向用户提问，等待回答
        const question = args.question || '请补充信息';
        const options = args.options || [];
        if (options.length) {
          // 有选项 → 用 askChoice
          const choice = await askChoice(sender, '小橘有疑问', question, options, true);
          if (choice) {
            if (choice.custom) return `用户回答：${choice.text}`;
            return `用户选择了：${options[choice.index]}`;
          }
          return '用户没有回答，请根据已有信息尽力完成任务。';
        }
        // 无选项 → 自由输入
        const choice = await askChoice(sender, '小橘有疑问', question, [], true);
        if (choice && choice.custom) return `用户回答：${choice.text}`;
        return '用户没有回答，请根据已有信息尽力完成任务。';
      }
      case 'open_app': {
        const p = findApp(args.name || '');
        if (p) { try { shell.openPath(p); } catch (e) {} return `已打开应用：${args.name}（路径：${p}）`; }
        return `未找到应用：${args.name}`;
      }
      case 'search_file': {
        const results = await searchFilesEverywhere(args.keyword || '');
        if (!results.length) return `未找到匹配"${args.keyword}"的文件`;
        return `找到 ${results.length} 个文件：\n` + results.slice(0, 10).map((r, i) => `${i + 1}. ${r.name}\n   路径：${r.path}`).join('\n');
      }
      case 'list_directory': {
        const folderMap = {
          '桌面': path.join(process.env.USERPROFILE, 'Desktop'),
          '下载': path.join(process.env.USERPROFILE, 'Downloads'),
          '文档': path.join(process.env.USERPROFILE, 'Documents'),
          'D盘': 'D:\\', 'D': 'D:\\',
          'C盘': 'C:\\', 'C': 'C:\\',
        };
        let dir = folderMap[args.folder || ''] || '';
        if (!dir) {
          // 尝试直接作为路径
          dir = args.folder || '';
        }
        if (!fs.existsSync(dir)) return `文件夹不存在：${args.folder}`;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          if (!entries.length) return `文件夹"${args.folder}"是空的`;
          const items = entries.slice(0, 50).map(e => {
            const isDir = e.isDirectory();
            return `${isDir ? '📁' : '📄'} ${e.name}${isDir ? '/' : ''}`;
          });
          return `文件夹"${args.folder}"中有 ${entries.length} 项：\n${items.join('\n')}`;
        } catch (e) { return `读取文件夹失败：${e.message}`; }
      }
      case 'read_file': {
        const r = await readFileContent(args.path || '');
        if (!r.ok) return `读取文件失败：${r.error}`;
        const preview = r.content.slice(0, 6000);
        return `文件内容（${r.ext}格式，共${r.content.length}字）：\n${preview}`;
      }
      case 'open_file': {
        try { shell.openPath(args.path || ''); return `已打开文件：${args.path}`; } catch (e) { return `打开失败：${e.message}`; }
      }
      case 'copy_file': {
        const fileName = path.basename(args.source || '');
        try { fs.copyFileSync(args.source, path.join(args.target_dir, fileName)); return `已复制 ${fileName} 到 ${args.target_dir}`; } catch (e) { return `复制失败：${e.message}`; }
      }
      case 'move_file': {
        const fileName = path.basename(args.source || '');
        const ok = await askChoice(sender, '⚠️ 确认移动文件', `小橘准备移动文件：\n${args.source}\n→ ${args.target_dir}`, [{ icon: '📁', name: '确认移动', sub: fileName }, { icon: '✕', name: '取消', sub: '不移动' }]);
        if (!ok || ok.index !== 0) return '用户取消了移动操作';
        try { fs.renameSync(args.source, path.join(args.target_dir, fileName)); return `已移动 ${fileName} 到 ${args.target_dir}`; } catch (e) { return `移动失败：${e.message}`; }
      }
      case 'delete_file': {
        const fileName = path.basename(args.path || '');
        const ok = await askChoice(sender, '⚠️ 确认删除文件', `小橘准备删除文件：\n${args.path}\n\n此操作不可撤销！`, [{ icon: '🗑', name: '确认删除', sub: fileName }, { icon: '✕', name: '取消', sub: '不删除' }]);
        if (!ok || ok.index !== 0) return '用户取消了删除操作';
        try { fs.unlinkSync(args.path); return `已删除文件：${fileName}`; } catch (e) { return `删除失败：${e.message}`; }
      }
      case 'system_op': {
        const action = args.action || '';
        const detail = args.detail || '';
        if (action === 'volume_up') { runPowerShell('[System.Windows.Forms.SendKeys]::SendWait([char]175); Add-Type -AssemblyName System.Windows.Forms', 3000); return '音量已调大'; }
        if (action === 'volume_down') { runPowerShell('[System.Windows.Forms.SendKeys]::SendWait([char]174); Add-Type -AssemblyName System.Windows.Forms', 3000); return '音量已调小'; }
        if (action === 'volume_mute') { runPowerShell('[System.Windows.Forms.SendKeys]::SendWait([char]173); Add-Type -AssemblyName System.Windows.Forms', 3000); return '已静音'; }
        if (action === 'lock') { runPowerShell('rundll32.exe user32.dll,LockWorkStation', 3000); return '已锁屏'; }
        if (action === 'open_url') { if (detail) { if (!/^https?:\/\//.test(detail)) detail = 'https://' + detail; shell.openExternal(detail); return `已打开网页：${detail}`; } return '未指定网址'; }
        if (action === 'web_search') { if (detail) { shell.openExternal(`https://www.bing.com/search?q=${encodeURIComponent(detail)}`); return `已在浏览器搜索：${detail}`; } return '未指定搜索词'; }
        return `未知系统操作：${action}`;
      }
      case 'search_web': {
        const ctx = await searchWeb(args.query || '', {
          topic: args.topic,
          timeRange: args.time_range,
        });
        return ctx || `搜索"${args.query}"未返回结果`;
      }
      case 'fetch_webpage': {
        const r = await fetchWebPage(args.url || '');
        if (!r.ok) return `读取网页失败：${r.error}`;
        const taskHint = args.task ? `\n\n【提取要求】${args.task}` : '';
        return `网页内容：\n${r.content.slice(0, 6000)}${taskHint}`;
      }
      case 'get_weather': {
        const city = args.city || '南京';
        const w = await fetchWeatherData(city);
        if (w.error) return `天气查询失败：${w.error}`;
        // 也通知前端弹出天气面板
        try { sender.send('tray:action', 'weather'); } catch (e) {}
        return `【${w.city}天气】${w.desc}，温度${w.tempC}°C，湿度${w.humidity}，${w.windDir}风${w.windKmph}级。\n今天：${w.todayType} ${w.todayMin}~${w.todayMax}°C\n明天：${w.tomorrowType} ${w.tomorrowMin}~${w.tomorrowMax}°C\n空气质量：${w.quality || '未知'} PM2.5:${w.pm25 || '未知'}\n感冒提示：${w.ganmao || '无'}`;
      }
      case 'set_reminder': {
        const ts = parseChineseTime(args.time_desc || '');
        if (!ts) return `无法解析时间：${args.time_desc}`;
        try { sender.send('reminder:create', { text: args.event, ts, timeStr: args.time_desc }); } catch (e) {}
        return `已设置提醒：${args.time_desc} 提醒「${args.event}」`;
      }
      case 'set_recurring_reminder': {
        const intervalMs = parseInterval(args.interval_desc || '');
        if (!intervalMs) return `无法解析间隔：${args.interval_desc}`;
        try { addRecurringReminder(args.event, intervalMs, args.interval_desc); } catch (e) {}
        return `已设置循环提醒：每${args.interval_desc}提醒「${args.event}」`;
      }
      case 'query_knowledge_base': {
        // 真正调用 IMA 知识库搜索
        const config = loadImaConfig();
        if (!config.kbId) return `未配置 IMA 知识库。请告诉用户：可以在右键菜单点"📚 知识库"来配置 IMA 凭证和选择知识库。`;
        try {
          const searchResult = await imaApi('search_knowledge', { query: args.query || '', cursor: '', knowledge_base_id: config.kbId });
          if (searchResult.code !== 0) return `知识库搜索失败：${searchResult.msg || '未知错误'}`;
          const results = (searchResult.data?.info_list || []).slice(0, 5);
          if (!results.length) return `知识库中没有找到与"${args.query}"相关的内容`;
          const text = results.map((item, i) => `[${i + 1}] ${item.title || '无标题'}\n${item.highlight_content || ''}`).join('\n\n');
          return `知识库搜索结果：\n${text}`;
        } catch (e) { return `知识库查询出错：${e.message}`; }
      }
      case 'run_code': {
        const language = args.language || 'python';
        const code = args.code || '';
        const desc = args.description || '执行代码';
        if (!code) return '错误：没有提供代码';

        const workDir = path.join(getSaveDir(), 'python_output');
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

        // 设置取消信号
        currentRunCodeAbort = { onAbort: null, aborted: false };
        // Agent Loop 停止时也取消代码执行
        if (currentAbortController) {
          currentAbortController.signal.addEventListener('abort', () => {
            currentRunCodeAbort.aborted = true;
            if (currentRunCodeAbort.onAbort) currentRunCodeAbort.onAbort();
          });
        }

        // PowerShell 路径
        if (language === 'powershell') {
          // 风险检测
          const risk = riskCheck(code);
          if (risk.risky) {
            const codePreview = code.length > 500 ? code.slice(0, 500) + '\n...（代码过长已截断）' : code;
            const ok = await askChoice(sender, '⚠️ 代码风险确认', `小橘要执行一段 PowerShell 代码，检测到以下风险：\n${risk.reasons.map(r => '• ' + r).join('\n')}\n\n代码摘要：\n${codePreview}`, [
              { icon: '▶', name: '确认执行', sub: risk.reasons.length + ' 项风险' },
              { icon: '✕', name: '取消', sub: '不执行' },
            ]);
            if (!ok || ok.index !== 0) { currentRunCodeAbort = null; return '用户取消了代码执行'; }
          }
          const psResult = await runPowershellCode(code, workDir);
          currentRunCodeAbort = null;
          if (psResult.cancelled) return '代码执行已被用户取消';
          if (psResult.timedOut) return '代码执行超时，可能存在死循环';
          const output = (psResult.stdout + (psResult.stderr ? '\n[stderr]\n' + psResult.stderr : '')).slice(0, 8000);
          return psResult.ok ? `代码执行成功，输出：\n${output || '（无输出）'}\n\n【工作目录】${workDir}（生成的文件保存在这里）` : `代码执行失败，错误信息：\n${output || '（无错误输出）'}`;
        }

        // Python 路径
        // 1. 获取 Python 路径
        const pyExe = getPythonExe();
        if (!pyExe) { currentRunCodeAbort = null; return '错误：未找到 Python 环境。请告诉用户：小橘自带了 Python，如果缺失可能是安装不完整。'; }

        // 2. 风险检测
        const risk = riskCheck(code);
        if (risk.risky) {
          const codePreview = code.length > 500 ? code.slice(0, 500) + '\n...（代码过长已截断）' : code;
          const ok = await askChoice(sender, '⚠️ 代码风险确认', `小橘要执行一段 Python 代码，检测到以下风险：\n${risk.reasons.map(r => '• ' + r).join('\n')}\n\n代码摘要：\n${codePreview}`, [
            { icon: '▶', name: '确认执行', sub: risk.reasons.length + ' 项风险' },
            { icon: '✕', name: '取消', sub: '不执行' },
          ]);
          if (!ok || ok.index !== 0) { currentRunCodeAbort = null; return '用户取消了代码执行'; }
        }

        // 3. 执行代码
        let pyResult = await runPythonCode(pyExe, code, workDir);

        // 4. 如果失败且是缺包错误，自动安装后重试一次
        if (!pyResult.ok && !pyResult.timedOut && !pyResult.cancelled) {
          const missingModule = extractMissingModule(pyResult.stderr);
          if (missingModule) {
            console.log(`[pet:code] 检测到缺失模块: ${missingModule}，尝试自动安装...`);
            // 通知前端
            try { sender.send('chat:status', { status: 'agent_step', text: `📦 发现缺少 ${missingModule} 库，正在自动安装喵～` }); } catch (e) {}
            const installResult = await autoInstallPip(pyExe, missingModule);
            if (installResult.success) {
              // 重新执行代码
              pyResult = await runPythonCode(pyExe, code, workDir);
            } else {
              currentRunCodeAbort = null;
              return `代码执行失败，缺少依赖 ${missingModule}，自动安装也失败了：${installResult.message}\n\n原始错误：\n${pyResult.stderr.slice(0, 3000)}`;
            }
          }
        }

        // 5. 返回结果
        currentRunCodeAbort = null;
        if (pyResult.cancelled) return '代码执行已被用户取消';
        if (pyResult.timedOut) return '代码执行超时，可能存在死循环或代码效率问题。请优化代码后重试。';
        const output = (pyResult.stdout + (pyResult.stderr ? '\n[stderr]\n' + pyResult.stderr : '')).slice(0, 8000);
        return pyResult.ok ? `代码执行成功，输出：\n${output || '（无输出）'}\n\n【工作目录】${workDir}（生成的文件保存在这里）` : `代码执行失败，错误信息：\n${output || '（无错误输出）'}`;
      }
      case 'schedule_task': {
        const taskName = args.name || '未命名任务';
        const scheduleStr = args.schedule || '';
        const sched = parseSchedule(scheduleStr);
        if (!sched) return `调度规则格式错误：${scheduleStr}\n支持的格式：daily HH:MM / interval 30m / interval 2h / weekly 1,3,5 09:00`;
        const scriptLang = args.script_language || 'python';
        const scriptCode = args.script_code || '';
        const prompt = args.prompt || taskName;
        if (!scriptCode) return '错误：没有提供脚本代码';

        // 保存脚本到 scheduled 目录
        if (!fs.existsSync(SCHEDULED_SCRIPTS_DIR)) fs.mkdirSync(SCHEDULED_SCRIPTS_DIR, { recursive: true });
        const ext = scriptLang === 'powershell' ? '.ps1' : '.py';
        const safeName = taskName.replace(/[<>:"/\\|?*]/g, '_');
        const scriptPath = path.join(SCHEDULED_SCRIPTS_DIR, safeName + ext);
        fs.writeFileSync(scriptPath, scriptCode, 'utf8');

        // 删除同名旧任务
        const existIdx = scheduledTasks.findIndex(t => t.name === taskName);
        if (existIdx >= 0) {
          if (scheduledTasks[existIdx].timer) { clearInterval(scheduledTasks[existIdx].timer); clearTimeout(scheduledTasks[existIdx].timer); }
          scheduledTasks.splice(existIdx, 1);
        }

        // 创建新任务
        const id = ++scheduledTaskSeq;
        const task = {
          id, name: taskName,
          scheduleType: sched.type, scheduleDesc: sched.desc,
          timeStr: sched.timeStr, intervalMs: sched.intervalMs, weekdays: sched.weekdays,
          scriptLanguage: scriptLang, scriptPath, prompt,
          timer: null, lastRun: null, lastStatus: null,
        };
        scheduleTaskTimer(task);
        scheduledTasks.push(task);
        saveScheduledTasks();
        console.log(`[pet:sched] 创建定时任务: ${taskName} (${sched.desc})`);
        return `定时任务已创建！\n任务名：${taskName}\n调度规则：${sched.desc}\n脚本已保存：${scriptPath}\n\n到时间会自动执行脚本，如果脚本失败会自动用AI修复。`;
      }
      case 'list_scheduled_tasks': {
        if (!scheduledTasks.length) return '当前没有定时任务。';
        return '定时任务列表：\n' + scheduledTasks.map((t, i) =>
          `${i + 1}. ${t.name}（${t.scheduleDesc}）\n   最后执行：${t.lastRun || '未执行'} 状态：${t.lastStatus || '—'}\n   脚本：${t.scriptPath}`
        ).join('\n');
      }
      case 'delete_scheduled_task': {
        const taskName = args.name || '';
        const idx = scheduledTasks.findIndex(t => t.name === taskName);
        if (idx < 0) return `未找到名为"${taskName}"的定时任务`;
        if (scheduledTasks[idx].timer) { clearInterval(scheduledTasks[idx].timer); clearTimeout(scheduledTasks[idx].timer); }
        scheduledTasks.splice(idx, 1);
        saveScheduledTasks();
        console.log(`[pet:sched] 删除定时任务: ${taskName}`);
        return `已删除定时任务：${taskName}`;
      }
      case 'send_email': {
        let to = args.to || '';
        const subject = args.subject || '(无主题)';
        const body = args.body || '';
        const isHtml = args.is_html || false;
        // 如果收件人不是邮箱格式，尝试从联系人中查找
        if (to && !to.includes('@')) {
          const found = findContactEmail(to);
          if (found) {
            to = found;
          } else {
            return `未找到联系人"${args.to}"的邮箱地址。请让主人提供邮箱地址，例如"张三的邮箱是 zhangsan@qq.com"，我会自动记住。`;
          }
        }
        if (!to) return '错误：请提供收件人邮箱地址';
        // 从对话内容中自动提取并记住联系人
        const extractArgs = JSON.stringify({ to: args.to, to_email: to });
        extractAndSaveContact(extractArgs);
        // 发信前弹确认对话框
        try { sender.send('chat:status', { status: 'agent_step', text: `📧 等待主人确认邮件内容…` }); } catch (e) {}
        const subjectPreview = subject.length > 50 ? subject.slice(0, 50) + '...' : subject;
        const bodyPreview = body;  // 不截断，完整显示（弹窗有滚动条）
        const ok = await askChoice(sender, '📧 发送邮件确认', `准备发送邮件：\n\n收件人：${to}\n主题：${subjectPreview}\n\n正文预览：\n${bodyPreview}`, [
          { icon: '✉', name: '确认发送', sub: '发送邮件' },
          { icon: '✕', name: '取消', sub: '不发送' },
        ]);
        if (!ok || ok.index !== 0) return '邮件已取消，主人没有确认发送。';
        // 主人确认了，开始发送
        try { sender.send('chat:status', { status: 'agent_step', text: `📧 正在发邮件给 ${to}…` }); } catch (e) {}
        const result = await sendEmail(to, subject, body, isHtml);
        if (result.success) return `邮件已发送给 ${to}，主题：${subject}`;
        return `邮件发送失败：${result.message}`;
      }
      case 'read_inbox': {
        const maxCount = args.max_count || 5;
        try { sender.send('chat:status', { status: 'agent_step', text: `📬 正在读取收件箱…` }); } catch (e) {}
        const result = await readInbox(maxCount);
        if (result.success) return result.message;
        return `读取收件箱失败：${result.message}`;
      }
      default: {
        // MCP 工具动态匹配（工具名以 mcp_ 开头）
        if (toolName.startsWith('mcp_')) {
          const mcpTool = mcpTools.find(t => t.name === toolName);
          if (mcpTool) {
            console.log(`[pet:mcp] 调用 MCP 工具: ${toolName} 参数: ${JSON.stringify(args)}`);
            const result = await callMcpTool(mcpTool, args);
            console.log(`[pet:mcp] MCP 工具结果: ${result.slice(0, 200)}`);
            return result;
          }
        }
        return `未知工具：${toolName}`;
      }
    }
  } catch (e) {
    return `工具执行出错：${e.message}`;
  }
}

// ============ LLM 意图路由器 ============
// 用大模型识别用户意图，返回结构化 JSON，替代写死的正则规则
// 意图类型：open_app / search_file / file_op / reminder / recurring_reminder / system_op / chat
async function detectIntentByLLM(message, fileContentMode = false) {
  if (!ARK_API_KEY || !ARK_API_BASE || !ARK_MODEL) return null;
  // 获取已安装的 skills 列表，注入到 prompt
  const skillsSummary = getSkillsSummary();
  const skillsSection = skillsSummary
    ? `\n- skill：【最高优先级】当用户的请求匹配某个已安装技能的场景时使用。可用技能：\n${skillsSummary}\n  匹配规则：只要用户消息中出现技能名称的核心词（如"数据分析""周报""代码审查"等），或者用户描述的场景与技能 description 匹配，就路由到 skill。参数：{"intent":"skill","skill":"技能name"}`
    : '';

  // 文件内容模式：只检测技能，不做文件操作判断
  if (fileContentMode) {
    const skillPrompt = `你是小橘桌面宠物的意图识别模块。用户已经粘贴/拖拽了文件内容，现在要基于文件内容提问。请判断用户这句话的意图，只返回一个 JSON 对象。

可选意图：
- generate_doc：用户要生成 Word/Excel/PPT/HTML 文档（如"生成一份Word总结""做成Excel表格""做个PPT""生成HTML报告"）。参数：{"intent":"generate_doc","docType":"word|excel|ppt|html"}
- skill：用户明确指定了某个已安装技能的名称（如"用洋河公文格式""用数据分析助手"）。参数：{"intent":"skill","skill":"技能name"}
- chat：普通聊天/问答，或需要联网搜索的问题。参数：{"intent":"chat"}

可用技能：
${skillsSummary || '（无已安装技能）'}

优先级（从高到低）：
1. 用户明确提到某个已安装技能的名称 → skill
2. 用户要生成 Word/Word文档/Word文件 → generate_doc（docType: "word"）
3. 用户要生成 Excel/表格/电子表格 → generate_doc（docType: "excel"）
4. 用户要生成 PPT/演示/幻灯片 → generate_doc（docType: "ppt"）
5. 用户要生成 HTML/网页报告 → generate_doc（docType: "html"）
6. 否则 → chat

用户消息：${message}

只返回 JSON，例如：{"intent":"generate_doc","docType":"word"}`;

    try {
      const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
        body: JSON.stringify({
          model: ARK_MODEL,
          messages: [{ role: 'user', content: skillPrompt }],
          max_tokens: 200,
          temperature: 0.1,
          stream: false,
          thinking: { type: 'disabled' },
        }),
        signal: currentAbortController ? currentAbortController.signal : undefined,
      });
      if (!res.ok) { console.warn(`[pet:intent] LLM 识别失败 status=${res.status}`); return null; }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { console.warn(`[pet:intent] 未提取到 JSON: ${text.slice(0, 100)}`); return null; }
      const obj = JSON.parse(m[0]);
      console.log(`[pet:intent] LLM 识别意图(文件模式): ${JSON.stringify(obj)}`);
      return obj;
    } catch (e) {
      console.warn(`[pet:intent] LLM 识别异常: ${e.message}`);
      return null;
    }
  }

  const prompt = `你是小橘桌面宠物的意图路由层。根据用户消息，语义匹配最合适的意图。只返回一个 JSON 对象，不要解释。

每个意图通过能力描述声明自己能处理什么、不能处理什么。你做语义匹配，选最合适的。有歧义时参考 ✅正例 和 ❌反例 消歧。无法明确匹配的走 chat（兜底）。

---
intent: chat
能力：兜底意图（最常用）。闲聊、问答、需要联网搜索的问题、需要查公开信息的问题。
chat 走 Agent Loop——AI 会自主决定是否调用搜索工具（search_web）联网搜索后回答，也能调用 list_directory 列文件夹。
✅ "你好""NBA球员阿尔德里奇巅峰数据""南京埃斯顿公司怎么样""帮我搜一下XX""最近AI有什么新进展""看看桌面上有什么文件"
❌ 能明确匹配其他意图的，不走 chat
参数：{"intent":"chat"}

intent: open_app
能力：打开桌面应用软件。
✅ "打开微信""启动计算器""打开PyCharm"
参数：{"intent":"open_app","app":"应用名"}

intent: search_file
能力：按文件名关键词搜索某个特定文件。
✅ "帮我找叫报告的文件""xxx.docx在哪"
❌ "看看桌面上有什么"→ chat（AI 会用 list_directory 工具列目录）
参数：{"intent":"search_file","keyword":"关键词","open":是否要打开true/false}

intent: read_and_analyze
能力：读取文件内容并基于内容分析/总结/生成。
✅ "读取xxx文件并总结""基于xxx文件写个章节结构""分析xxx文档"
参数：{"intent":"read_and_analyze","keyword":"文件名关键词","task":"用户想做什么"}

intent: file_op
能力：复制/移动/删除文件。
✅ "把xxx复制到D盘""删除桌面上的报告""移动xxx到下载"
参数：{"intent":"file_op","action":"copy|move|delete","source":"源文件","target":"目标位置"}

intent: reminder
能力：设置一次性定时提醒。
✅ "5分钟后提醒我开会""下午3点提醒我交周报"
参数：{"intent":"reminder","time_desc":"时间描述原文","event":"事件"}

intent: recurring_reminder
能力：设置循环提醒。
✅ "每隔30分钟提醒我喝水""每2小时提醒我休息""开启久坐提醒"
参数：{"intent":"recurring_reminder","event":"事件","interval_desc":"间隔描述原文"}

intent: cancel_reminder
能力：取消循环提醒。
✅ "取消提醒""关闭提醒""停止提醒"
参数：{"intent":"cancel_reminder"}

intent: system_op
能力：系统操作（音量/锁屏/截屏/打开网页）。
✅ "调大音量""静音""锁屏""打开百度""打开B站"
❌ "帮我搜一下XX"→ chat（AI 会联网搜索后回答，不是打开浏览器）
参数：{"intent":"system_op","action":"volume_up|volume_down|volume_mute|lock|screenshot|open_url","detail":"具体对象或网址"}

intent: web_read
能力：读取并分析网页内容。仅当消息含 http:// 或 https:// 网址时。
✅ "帮我读一下这个网页 https://xxx.com""分析这个链接的内容"
参数：{"intent":"web_read","url":"网址","task":"用户想基于网页做什么"}

intent: knowledge_base
能力：查询 IMA 内部知识库。当问题需要查阅**内部文档/资料**才能回答时使用。
判断标准：这个问题能不能靠联网搜索到？能搜到的走 chat，只有内部资料才有的走 knowledge_base。
✅ "知识库里有没有xxx""我们的退货政策是什么""公司差旅报销标准""产品X的技术规格""XX流程的SOP""XX项目的需求文档"
❌ "南京埃斯顿公司怎么样"→ chat（公开信息，联网搜）
❌ "什么是机器学习"→ chat（通用知识，联网搜）
❌ "NBA球员数据"→ chat（公开信息，联网搜）
参数：{"intent":"knowledge_base","query":"用户的问题"}

intent: generate_doc
能力：生成 Word/Excel/PPT/HTML 文档。用户明确说要生成某种格式。
✅ "生成一份Word总结""做个Excel表格""做个PPT""生成HTML报告"
❌ "做个报告"但没说格式 → clarify（要问什么格式）
参数：{"intent":"generate_doc","docType":"word|excel|ppt|html"}

intent: clarify
能力：意图严重不明确，无法执行任何操作。仅当真的无法判断要做什么时才用。
✅ "帮我整理一下"（整理什么？）、"那个东西帮我搞一下"（什么东西？）
❌ 能合理推断的不要用（如"做个表格"→generate_doc excel）
参数：{"intent":"clarify","question":"要问用户的问题","options":["选项1","选项2",...]}

intent: skill
能力：匹配已安装技能。用户明确提到某个技能名称或场景与技能描述匹配。
可用技能：
${skillsSection || '（无已安装技能）'}
参数：{"intent":"skill","skill":"技能name"}
---

用户消息：${message}

只返回 JSON，例如：{"intent":"chat"} 或 {"intent":"search_file","keyword":"楔子","open":true}`;

  try {
    const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
      body: JSON.stringify({
        model: ARK_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.1,
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: currentAbortController ? currentAbortController.signal : undefined,
    });
    if (!res.ok) { console.warn(`[pet:intent] LLM 识别失败 status=${res.status}`); return null; }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    // 提取 JSON（容错：可能被包在 markdown 代码块里）
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.warn(`[pet:intent] 未提取到 JSON: ${text.slice(0, 100)}`); return null; }
    const obj = JSON.parse(m[0]);
    console.log(`[pet:intent] LLM 识别意图: ${JSON.stringify(obj)}`);
    return obj;
  } catch (e) {
    console.warn(`[pet:intent] LLM 识别异常: ${e.message}`);
    return null;
  }
}

// ============ 非流式 LLM 调用（内容技能第1步生成内容用）============
async function llmGenerateContent(userMessage, skillPrompt) {
  if (!ARK_API_KEY || !ARK_API_BASE || !ARK_MODEL) return null;
  let systemContent = getPetSystemPrompt();
  systemContent += '\n\n【内容生成技能】你现在要严格按照以下技能指令行事，生成内容的纯文本/Markdown，不要用代码块包裹，不要加任何格式说明：\n\n' + skillPrompt;
  if (conversationSummary) {
    systemContent += '\n\n【之前对话的摘要记忆】\n' + conversationSummary;
  }
  const messages = [{ role: 'system', content: systemContent }, ...chatHistory, { role: 'user', content: userMessage }];
  try {
    currentAbortController = new AbortController();
    const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
      body: JSON.stringify({ model: ARK_MODEL, messages, max_tokens: 8192, temperature: 0.9, thinking: { type: 'disabled' } }),
      signal: currentAbortController.signal,
    });
    if (!res.ok) { currentAbortController = null; return null; }
    const data = await res.json();
    currentAbortController = null;
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    currentAbortController = null;
    if (e.name === 'AbortError') { console.log('[pet:content] 用户手动停止生成'); return null; }
    console.warn('[pet:content] 生成内容异常:', e.message); return null;
  }
}

// ============ Agent Loop：带工具的自主多步对话（真流式） ============
// 智能切换：LLM 流式返回文本时实时推送；返回 tool_calls 则执行工具并把结果喂回（循环）
const MAX_TOOL_ROUNDS = 15; // 异常兜底上限（防死循环），正常由模型自判完成

// 根据工具名+参数生成友好的意图描述（让用户看到 AI 每一步在干什么）
function describeToolAction(toolName, args) {
  switch (toolName) {
    case 'make_plan': return `📋 正在制定计划：${args.title || ''}喵～`;
    case 'ask_question': return `❓ 有个问题想问主人：${(args.question || '').slice(0, 30)}喵～`;
    case 'get_weather': return `🌤️ 先帮你查一下${args.city || '当前'}的天气喵～`;
    case 'list_directory': return `📁 看看${args.folder || '文件夹'}里有什么文件喵～`;
    case 'search_file': return `🔎 帮你找找叫"${args.keyword || ''}"的文件喵～`;
    case 'read_file': return `📖 读取文件内容看看喵～`;
    case 'open_file': return `📂 帮你打开文件喵～`;
    case 'open_app': return `🖥️ 帮你打开${args.name || '应用'}喵～`;
    case 'copy_file': return `📋 帮你复制文件喵～`;
    case 'move_file': return `📦 帮你移动文件喵～`;
    case 'delete_file': return `🗑️ 帮你删除文件喵～`;
    case 'system_op': {
      const a = args.action || '';
      if (a === 'volume_up') return '🔊 帮你调大音量喵～';
      if (a === 'volume_down') return '🔉 帮你调小音量喵～';
      if (a === 'volume_mute') return '🔇 帮你静音喵～';
      if (a === 'lock') return '🔒 帮你锁屏喵～';
      if (a === 'open_url') return `🌐 帮你打开网页：${args.detail || ''}喵～`;
      if (a === 'web_search') return `🔍 帮你搜索"${args.detail || ''}"喵～`;
      return `⚙️ 执行系统操作喵～`;
    }
    case 'search_web': return `🔍 先帮你搜一下"${args.query || ''}"喵～`;
    case 'fetch_webpage': return `🌐 读取网页内容喵～`;
    case 'set_reminder': return `⏰ 帮你设置提醒喵～`;
    case 'set_recurring_reminder': return `🔁 帮你设置循环提醒喵～`;
    case 'query_knowledge_base': return `📚 查一下知识库里有没有相关信息喵～`;
    case 'run_code': return `🐍 正在写${args.language === 'powershell' ? 'PowerShell' : 'Python'}代码处理任务：${args.description || '执行代码'}喵～`;
    case 'schedule_task': return `⏰ 正在创建定时任务：${args.name || ''}喵～`;
    case 'list_scheduled_tasks': return `📋 正在查看定时任务列表喵～`;
    case 'delete_scheduled_task': return `🗑️ 正在删除定时任务：${args.name || ''}喵～`;
    case 'send_email': return `📧 正在发邮件给 ${args.to || ''}喵～`;
    case 'read_inbox': return `📬 正在读取收件箱喵～`;
    default: {
      // MCP 工具：显示工具名 + 参数摘要
      if (toolName.startsWith('mcp_')) {
        const parts = toolName.replace(/^mcp_/, '').split('_');
        const serverName = parts[0];
        const toolBase = parts.slice(1).join('_');
        // 参数摘要：取前2个参数生成简短描述
        const argKeys = Object.keys(args || {});
        let argSummary = '';
        if (argKeys.length) {
          argSummary = argKeys.slice(0, 3).map(k => {
            let v = String(args[k] ?? '');
            if (v.length > 30) v = v.slice(0, 30) + '…';
            return `${k}=${v}`;
          }).join(', ');
        }
        return `🔌 [${serverName}] 调用 ${toolBase}${argSummary ? `（${argSummary}）` : ''}喵～`;
      }
      return `🔧 正在执行操作喵～`;
    }
  }
}

// 根据工具执行结果生成简短的"下一步"描述
function describeToolDone(toolName, result) {
  if (result.startsWith('未找到') || result.startsWith('文件夹不存在') || result.startsWith('读取文件失败') || result.includes('失败') || result.includes('出错') || result.startsWith('用户取消了')) {
    return '🤔 嗯…结果不太理想，我想想其他办法喵…';
  }
  switch (toolName) {
    case 'make_plan': return result.startsWith('用户已确认') ? '✅ 主人确认了计划，开始执行喵～' : '🤔 主人取消了计划，想想怎么调整喵…';
    case 'ask_question': return result.startsWith('用户') ? '✅ 主人回答了，继续执行喵～' : '🤔 主人没有回答，尽力完成吧喵…';
    case 'get_weather': return '✅ 查到天气了，帮你整理一下喵～';
    case 'list_directory': return '✅ 看到了，帮你梳理一下喵～';
    case 'search_file': return '✅ 找到了，帮你看看喵～';
    case 'read_file': return '✅ 读到了，帮你分析一下喵～';
    case 'search_web': return '✅ 搜到了，帮你总结一下喵～';
    case 'fetch_webpage': return '✅ 读到了网页内容，帮你看看喵～';
    case 'query_knowledge_base': return '✅ 查到知识库信息了，帮你整理一下喵～';
    case 'run_code': return result.includes('执行成功') ? '✅ 代码执行完了喵～' : '🤔 代码报错了，我来修修喵～';
    case 'schedule_task': return '✅ 定时任务设好了喵～';
    case 'list_scheduled_tasks': return '✅ 查到了喵～';
    case 'delete_scheduled_task': return '✅ 已删除喵～';
    case 'send_email': return '✅ 邮件已发送喵～';
    case 'read_inbox': return '✅ 收件箱读到了喵～';
    default: return '✅ 好了，继续帮你处理喵～';
  }
}


// 流式调用 LLM，实时推送文本 delta 给前端
// withTools=true 时同时累积 tool_calls
async function agentStreamLLM(messages, sender, withTools, toolsOverride) {
  const body = {
    model: ARK_MODEL,
    messages,
    max_tokens: 8192,
    temperature: 0.9,
    stream: true,
    thinking: { type: 'disabled' },
  };
  if (withTools) {
    body.tools = toolsOverride || [...TOOL_DEFINITIONS, ...getMcpToolDefinitions()];
    body.tool_choice = 'auto';
  }

  const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
    body: JSON.stringify(body),
    signal: currentAbortController.signal,
  }, 5, sender);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[pet:agent] LLM 请求失败 status=${res.status}: ${errText.slice(0, 500)}`);
    return { error: res.status };
  }

  let fullText = '';
  const toolCallsAccum = {}; // { index: { id, name, arguments } }
  let finishReason = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留未完整的最后一行
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        // 文本 delta → 实时推送给前端
        if (delta?.content) {
          fullText += delta.content;
          try { sender.send('chat:chunk', delta.content); } catch (e) {}
        }
        // tool_calls delta → 按 index 累积
        if (withTools && delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsAccum[idx]) toolCallsAccum[idx] = { id: '', name: '', arguments: '' };
            if (tc.id) toolCallsAccum[idx].id = tc.id;
            if (tc.function?.name) toolCallsAccum[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallsAccum[idx].arguments += tc.function.arguments;
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } catch (e) { /* 忽略解析异常的行 */ }
    }
  }

  const toolCalls = Object.keys(toolCallsAccum)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => toolCallsAccum[k])
    .filter(tc => tc.name);
  console.log(`[pet:agent] 流式完成: text=${fullText.length}字, toolCalls=${toolCalls.length}个, finishReason=${finishReason}`);
  return { text: fullText, toolCalls, finishReason, aborted: currentAbortController.signal.aborted };
}

async function agentChatStream(userMessage, sender, intentContext, isolatedContext = null) {
  if (!ARK_API_KEY || !ARK_API_BASE || !ARK_MODEL) {
    console.log('[pet:agent] 配置缺失，跳过');
    return null;
  }

  // 隔离上下文：定时任务用独立的 chatHistory 和 abortController，避免与用户会话竞态
  const history = isolatedContext ? isolatedContext.history : chatHistory;
  const abortCtl = isolatedContext ? isolatedContext.abortController : null;

  const cleanUserMsg = userMessage.split('\n\n【以下是用户提供的文件内容')[0].trim();
  history.push({ role: 'user', content: cleanUserMsg });
  while (history.length > MAX_HISTORY) history.shift();

  // 构建系统提示
  let systemContent = getPetSystemPrompt();
  if (conversationSummary) {
    systemContent += '\n\n【之前对话的摘要记忆】以下是之前对话的要点摘要，请自然地记住这些内容，在对话中可以引用，但不要刻意提及"摘要"：\n' + conversationSummary;
  }
  if (memory.facts && memory.facts.length) {
    systemContent += '\n\n【关于主人的记忆】你记得主人的以下信息，对话中自然地体现你记得，但不要刻意罗列：\n' + memory.facts.map((f) => `- ${f.text}`).join('\n');
  }
  // 邮件联系人记忆
  const contactKeys = Object.keys(emailContacts);
  if (contactKeys.length) {
    systemContent += '\n\n【邮件联系人】你记得以下联系人的邮箱地址，主人说"给XX发邮件"时直接用对应邮箱，不用再问：\n' + contactKeys.map(k => `- ${k}: ${emailContacts[k]}`).join('\n');
  }
  systemContent += '\n\n【工具使用说明】你可以调用以下工具来帮主人完成任务。当你需要操作电脑、搜索文件、读取文件、查询信息时，请调用对应工具。工具调用后我会把结果告诉你，你再继续思考。简单闲聊不需要调用工具。\n\n【make_plan 制定计划】当任务较复杂或涉及多步骤时（如调研报告、出行方案、数据分析、文件批量处理、跨工具组合任务等），先调用 make_plan 制定执行计划，列出你打算执行的步骤，用户确认后再逐步执行。简单任务（查天气、查火车票、翻译等）不需要调用，直接执行即可。\n\n【ask_question 主动提问】当任务缺少必要信息、存在歧义、或你需要用户确认偏好时，主动调用 ask_question 向用户提问。例如：出发城市不明确、时间范围不确定、用户意图有歧义、需要选择方案等。不要因为信息不足就放弃任务或编造信息，先问清楚再执行。\n\n【run_code 代码执行工具】遇到复杂数据任务时（Excel/CSV批量处理、PDF解析、爬虫抓取、图表生成、数据清洗分析、批量文件操作等），你可以调用 run_code 工具自己写代码执行。代码会在主人电脑本地运行，30秒超时，工作目录是用户数据目录。如果代码缺少依赖会自动pip安装。如果代码报错，把错误信息看清楚，修改代码后重新调用 run_code，直到成功为止。\n\n【schedule_task 定时任务工具】当主人需要定时/周期性执行任务时（如"每天8点抓取数据""每隔30分钟检查一次""固化为定时任务""把这个设为定时任务"），你可以调用 schedule_task 创建定时任务。如果之前已经用 run_code 调通了代码，直接把调通的代码传给 schedule_task 的 script_code 参数。支持 daily HH:MM（每天定时）、interval 30m（每隔30分钟）、weekly 1,3,5 09:00（每周一三五）。任务会保存脚本文件，日常自动执行脚本，脚本失败时AI会自动修复代码。\n\n【搜索能力】你有 search_web 和 fetch_webpage 两个工具：\n- search_web：支持 topic 参数（general通用/news新闻/finance金融/academic学术论文）和 time_range 参数（day/week/month/year）。根据问题类型选合适的 topic，新闻类用 news，学术类用 academic，股价财报用 finance。搜索结果包含来源URL和发布日期。\n- fetch_webpage：读取网页详细内容，可通过 task 参数指定要提取什么信息（如"提取价格""总结要点"）。注意：抖音、小红书、微博、B站、快手等强反爬/需JS渲染的网站无法抓取，遇到这些站点直接用 search_web 搜索相关信息，不要用 fetch_webpage。\n\n【搜索策略】\n1. 多轮搜索：复杂问题拆成子问题逐个搜，不要一次搜完就结束。例如搜"阿尔德里奇巅峰数据"→第一轮搜概况→第二轮搜具体赛季。\n2. 标注来源：回复时在关键信息后标注来源，格式如"（来源：新浪体育）"或"（来源：https://xxx.com）"。让主人能追查信息出处。\n3. 时间敏感：新闻/时事类问题加 time_range=week 或 month，避免搜到过时信息。\n4. 深度阅读：搜索结果不够详细时，用 fetch_webpage 读具体网页内容。\n\n【代码生成文件注意事项】如果代码生成了文件，请在代码中用 print() 输出文件的完整路径，这样你可以在结果里看到文件位置并告诉主人。代码工作目录的绝对路径会在执行结果末尾给出，你可以用 os.path.join(workDir, filename) 生成完整路径。\n\n【输出格式说明】根据任务复杂度选择输出格式：\n1. 简单问答 → 直接文字回复\n2. 中等复杂度（总结、要点提炼）→ 用 Markdown 格式回复\n3. 复杂任务（调研报告、出行方案、行程规划、活动方案、详细分析、方案对比、可视化报告、攻略指南）→ 输出完整的 HTML 文档代码，用 \`\`\`html 代码块包裹，前端会提供预览和保存为文件功能。HTML 要包含内联 CSS 样式，美观大方。注意：只要是"方案""规划""攻略""报告"类任务，一律用 HTML 输出。';
  // 注入 MCP 工具信息，让 AI 知道有哪些外部工具可用
  if (mcpTools.length > 0) {
    // 按服务分组展示
    const byServer = {};
    for (const t of mcpTools) {
      if (!byServer[t.serverName]) byServer[t.serverName] = [];
      byServer[t.serverName].push(t);
    }
    const serverGroups = Object.entries(byServer).map(([server, tools]) => {
      return `【${server}】${tools.map(t => `${t.originalName}（${(t.description||'').slice(0,60)}）`).join('、')}`;
    }).join('\n');
    systemContent += `\n\n【MCP 外部工具】你还接入了以下外部 MCP 服务：\n${serverGroups}\n\n以上工具的具体参数 schema 已在工具列表中提供，请根据工具描述自动选择合适的工具。MCP 工具是专业服务，根据任务需求选择合适的工具调用。`;
  }
  // 技能提示词注入（与 llmChatStream 一致的处理方式）
  const isAgentSkillActive = intentContext && intentContext.startsWith('SKILL_PROMPT::');
  if (isAgentSkillActive) {
    const skillPrompt = intentContext.replace(/^SKILL_PROMPT::/, '').replace(/::END_SKILL_PROMPT$/, '');
    systemContent += '\n\n【技能指令】你现在要严格按照以下技能指令行事，这是你的核心任务指导：\n\n' + skillPrompt;
  } else if (intentContext) {
    systemContent += '\n\n【系统操作结果】' + intentContext;
  }

  let messages = [{ role: 'system', content: systemContent }, ...history];
  let round = 0;
  let toolActionLog = []; // 记录工具调用摘要，用于存入 chatHistory
  const isIsolated = !!isolatedContext;

  try {
    if (isIsolated) {
      // 定时任务：用独立的 abort controller，不影响用户会话
      if (!abortCtl.controller) abortCtl.controller = new AbortController();
    } else {
      currentAbortController = new AbortController();
    }
    const getSignal = () => isIsolated ? abortCtl.controller.signal : currentAbortController.signal;

    while (round < MAX_TOOL_ROUNDS) {
      round++;
      console.log(`[pet:agent] 第 ${round} 轮，调用 LLM（流式带 tools）...`);

      const result = await agentStreamLLM(messages, sender, true);

      if (result.error) {
        history.pop();
        if (!isIsolated) currentAbortController = null;
        return null;
      }

      const { text, toolCalls, finishReason } = result;

      // 没有 tool_calls → 纯文本回复（已在流式过程中实时推送）
      if (!toolCalls.length) {
        let reply = text.trim();

        // 截断续写（流式续写，不带 tools）
        // 仅当 finish_reason='length' 时才续写（ARK API 会正确返回此字段）
        if (finishReason === 'length' && reply) {
          console.log(`[pet:agent] 检测到回复被截断（length），流式续写...`);
          messages.push({ role: 'assistant', content: reply });
          let continueRounds = 0;
          while (continueRounds < 3 && !getSignal().aborted) {
            continueRounds++;
            const cont = await agentStreamLLM(messages, sender, false);
            if (cont.error) break;
            const contText = cont.text.trim();
            if (contText) { reply += contText; messages.push({ role: 'assistant', content: contText }); }
            if (cont.finishReason !== 'length') break;
          }
        }

        const wasAborted = getSignal().aborted;
        if (!isIsolated) currentAbortController = null;
        if (reply) {
          history.push({ role: 'assistant', content: reply });
          while (history.length > MAX_HISTORY) history.shift();
          if (!isIsolated) maybeCompactHistory().catch((e) => console.warn(`[pet:compact] 压缩失败: ${e.message}`));
          return { reply, stopped: wasAborted };
        }
        // 空回复回滚
        history.pop();
        return null;
      }

      // 有 tool_calls → 执行工具，结果喂回，继续循环
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
      });

      // 逐个执行工具
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.arguments || '{}'); } catch (e) {}
        console.log(`[pet:agent] 调用工具: ${tc.name} 参数: ${JSON.stringify(args)}`);
        // 展示友好的意图描述，让用户看到 AI 在干什么（带轮次信息）
        const actionDesc = describeToolAction(tc.name, args);
        try { sender.send('chat:status', { status: 'agent_step', text: actionDesc, tool: tc.name, args, round }); } catch (e) {}

        const toolResult = await executeTool(tc.name, args, sender);
        console.log(`[pet:agent] 工具 ${tc.name} 结果: ${toolResult.slice(0, 200)}`);
        // 工具执行完，展示下一步描述
        const doneDesc = describeToolDone(tc.name, toolResult);
        try { sender.send('chat:status', { status: 'agent_step', text: doneDesc, done: true, round }); } catch (e) {}

        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
        // 如果是 run_code，把代码也记录到 toolActionLog（后续存入 chatHistory，让"固化为定时任务"能拿到代码）
        if (tc.name === 'run_code') {
          toolActionLog.push(`调用了工具run_code(${args.language || 'python'})\n代码：\n${args.code || ''}\n结果：${toolResult.slice(0, 200)}`);
        } else {
          toolActionLog.push(`调用了工具${tc.name}(${JSON.stringify(args)})，结果：${toolResult.slice(0, 300)}`);
        }
      }
      // 继续下一轮 LLM 调用

      // 接近上限时提醒模型自判是否完成（而非到上限后强制截断）
      if (round === MAX_TOOL_ROUNDS - 3) {
        console.log(`[pet:agent] 接近轮数上限(${round}/${MAX_TOOL_ROUNDS})，提醒模型自判完成`);
        messages.push({ role: 'user', content: '提示：你的工具调用轮数已经比较多，请判断任务是否已完成。如果已完成，请直接给出最终回复；如果还需要继续调用工具，请继续。' });
      }
    }

    // 达到兜底上限，温和地让模型总结（不是强制截断，而是给一个机会收尾）
    console.log(`[pet:agent] 达到兜底上限 ${MAX_TOOL_ROUNDS} 轮，请模型总结收尾`);
    messages.push({ role: 'user', content: '请根据以上工具执行结果，总结并回复主人。' });
    const finalResult = await agentStreamLLM(messages, sender, false);
    if (!finalResult.error) {
      let finalReply = finalResult.text.trim();
      // 截断续写（仅 finish_reason='length' 时）
      if (finalResult.finishReason === 'length' && finalReply) {
        console.log(`[pet:agent] 最终总结被截断，流式续写...`);
        messages.push({ role: 'assistant', content: finalReply });
        let cr = 0;
        while (cr < 3 && !getSignal().aborted) {
          cr++;
          const c = await agentStreamLLM(messages, sender, false);
          if (c.error) break;
          const cText = c.text.trim();
          if (cText) { finalReply += cText; messages.push({ role: 'assistant', content: cText }); }
          if (c.finishReason !== 'length') break;
        }
      }
      const wasAborted = getSignal().aborted;
      if (!isIsolated) currentAbortController = null;
      if (finalReply) {
        history.push({ role: 'assistant', content: finalReply });
        while (history.length > MAX_HISTORY) history.shift();
        return { reply: finalReply, stopped: wasAborted };
      }
    }
    if (!isIsolated) currentAbortController = null;
    return { reply: '喵…我操作了好多步，但没能总结出来…', stopped: false };
  } catch (err) {
    if (!isIsolated) currentAbortController = null;
    if (err.name === 'AbortError') {
      console.log('[pet:agent] 用户手动停止');
      if (toolActionLog.length > 0) {
        history.push({ role: 'assistant', content: `[被用户中断] 已执行的操作：\n${toolActionLog.join('\n')}` });
        while (history.length > MAX_HISTORY) history.shift();
        return { reply: '喵…被打断了，但我已经帮你做了一部分~', stopped: true };
      }
      history.pop();
      return { reply: '', stopped: true };
    }
    console.warn('[pet:agent] 异常:', err.message);
    if (toolActionLog.length > 0) {
      history.push({ role: 'assistant', content: `[操作中断] 已执行的操作：\n${toolActionLog.join('\n')}` });
    } else {
      history.pop();
    }
    return null;
  }
}

// 调用大模型（流式），通过 webContents.send 实时推送增量文本
// 返回 { reply } 或 null（失败时）
async function llmChatStream(userMessage, sender, intentContext) {
  if (!ARK_API_KEY || !ARK_API_BASE || !ARK_MODEL) {
    console.log('[pet:chat] 配置缺失，跳过大模型');
    return null;
  }

  // 维护历史（存入清洗后的问题，不带文件内容）
  const cleanUserMsg = userMessage.split('\n\n【以下是用户提供的文件内容')[0].trim();
  chatHistory.push({ role: 'user', content: cleanUserMsg });
  while (chatHistory.length > MAX_HISTORY) chatHistory.shift();

  // 联网搜索：命中关键词时先搜索，把结果作为上下文喂给大模型
  // 技能激活时跳过搜索（技能有自己的指令，不需要联网）
  let searchContext = '';
  const isSkillActive = intentContext && intentContext.startsWith('SKILL_PROMPT::');
  if (!isSkillActive && needsSearch(cleanUserMsg)) {
    try { sender.send('chat:status', { status: 'searching' }); } catch (e) {}
    const tSearch = Date.now();
    const searchQuery = buildSearchQuery(cleanUserMsg);
    searchContext = await searchWeb(searchQuery);
    console.log(`[pet:search] 搜索词="${searchQuery}"，耗时 ${Date.now() - tSearch}ms`);
    try { sender.send('chat:status', { status: 'searching_done' }); } catch (e) {}
  }

  // 构建消息：记忆 + 搜索结果 + 意图上下文拼进 system prompt
  let systemContent = getPetSystemPrompt();
  // 注入对话摘要（让小橘跨 session 记住之前聊过什么）
  if (conversationSummary) {
    systemContent += '\n\n【之前对话的摘要记忆】以下是之前对话的要点摘要，请自然地记住这些内容，在对话中可以引用，但不要刻意提及"摘要"：\n' + conversationSummary;
  }
  // 注入用户画像/记忆（让小橘"记得"主人）
  if (memory.facts && memory.facts.length) {
    const factList = memory.facts.map((f) => `- ${f.text}`).join('\n');
    systemContent += '\n\n【关于主人的记忆】你记得主人的以下信息，对话中自然地体现你记得，但不要刻意罗列：\n' + factList;
  }
  // 邮件联系人记忆（llmChatStream 也注入）
  const llmContactKeys = Object.keys(emailContacts);
  if (llmContactKeys.length) {
    systemContent += '\n\n【邮件联系人】你记得以下联系人的邮箱地址：\n' + llmContactKeys.map(k => `- ${k}: ${emailContacts[k]}`).join('\n');
  }
  // 技能提示词单独注入（优先级最高，作为角色指令）
  if (isSkillActive) {
    const skillPrompt = intentContext.replace(/^SKILL_PROMPT::/, '').replace(/::END_SKILL_PROMPT$/, '');
    systemContent += '\n\n【技能指令】你现在要严格按照以下技能指令行事，这是你的核心任务指导：\n\n' + skillPrompt;
  } else if (intentContext) {
    systemContent += '\n\n【系统操作结果】' + intentContext;
  }
  if (searchContext) {
    systemContent += '\n\n【联网搜索结果】以下是刚刚从网络搜索到的信息，请参考这些信息回答用户的问题，在回答中自然地融入这些信息：\n\n' + searchContext;
  }
  // 注入 MCP 工具信息（让 LLM 知道有这些外部工具可用，在生成_doc/file_op 等场景可提示用户）
  if (mcpTools.length > 0) {
    const mcpSummary = mcpTools.map(t => `${t.originalName}（${t.serverName}）`).join('、');
    systemContent += `\n\n【可用的 MCP 外部工具】主人的电脑上接入了以下 MCP 工具：${mcpSummary}。如果用户的任务与这些工具的能力匹配，可以提示用户用对话方式调用（Agent Loop 模式下可直接调用）。`;
  }
  const messages = [{ role: 'system', content: systemContent }, ...chatHistory];

  let full = '';
  try {
    console.log(`[pet:chat] 调用大模型(流式) ${ARK_MODEL} ...`);
    currentAbortController = new AbortController();
    const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY}`,
      },
      body: JSON.stringify({
        model: ARK_MODEL,
        messages,
        max_tokens: 8192,
        temperature: 0.9,
        stream: true,
        thinking: { type: 'disabled' },
      }),
      signal: currentAbortController.signal,
    });

    if (!res.ok) {
      console.warn(`[pet] 大模型请求失败 status=${res.status}`);
      chatHistory.pop();
      currentAbortController = null;
      return null;
    }

    // 解析 SSE 流
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamFinishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留未完整的最后一行
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            // 实时推送增量给渲染进程
            try { sender.send('chat:chunk', delta); } catch (e) {}
          }
          if (json.choices?.[0]?.finish_reason) streamFinishReason = json.choices[0].finish_reason;
        } catch (e) { /* 忽略解析异常的行 */ }
      }
    }

    // 截断续写：finish_reason='length' 时继续生成
    if (streamFinishReason === 'length' && full.trim()) {
      console.log(`[pet:chat] 检测到回复被截断（length），流式续写...`);
      let contMessages = [...messages, { role: 'assistant', content: full.trim() }];
      let contRounds = 0;
      while (contRounds < 3 && !currentAbortController.signal.aborted) {
        contRounds++;
        const contRes = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
          body: JSON.stringify({ model: ARK_MODEL, messages: contMessages, max_tokens: 4096, temperature: 0.9, stream: true, thinking: { type: 'disabled' } }),
          signal: currentAbortController.signal,
        });
        if (!contRes.ok) break;
        const contReader = contRes.body.getReader();
        let contBuffer = '';
        let contFinish = null;
        while (true) {
          const { done: d, value: v } = await contReader.read();
          if (d) break;
          contBuffer += decoder.decode(v, { stream: true });
          const contLines = contBuffer.split('\n');
          contBuffer = contLines.pop();
          for (const line of contLines) {
            const t = line.trim();
            if (!t || !t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                try { sender.send('chat:chunk', delta); } catch (e) {}
              }
              if (json.choices?.[0]?.finish_reason) contFinish = json.choices[0].finish_reason;
            } catch (e) {}
          }
        }
        const contText = full.slice(contMessages[contMessages.length - 1].content.length);
        if (contText.trim()) contMessages.push({ role: 'assistant', content: contText.trim() });
        if (contFinish !== 'length') break;
      }
    }

    const wasAborted = currentAbortController.signal.aborted;
    currentAbortController = null;
    const reply = full.trim();
    if (!reply) {
      chatHistory.pop();
      return null;
    }
    chatHistory.push({ role: 'assistant', content: reply });
    while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
    // 交付型内容自检：HTML/Word/Excel/PPT 代码块结构完整性
    const check = validateDeliverable(reply);
    if (!check.valid) {
      console.warn(`[pet:agent] 交付内容自检不通过(${check.type}): ${check.reason}，尝试修复...`);
      try { sender.send('chat:status', { status: 'agent_step', text: `🔧 小橘检查发现${check.type.toUpperCase()}格式有问题，正在修复喵～` }); } catch (e) {}
      // 弹出有问题的回复，重新生成
      chatHistory.pop();
      chatHistory.push({ role: 'assistant', content: `（上一次生成的内容有格式问题：${check.reason}，请重新生成）` });
      const fixResult = await agentStreamLLM(messages.concat([{ role: 'user', content: `你刚才输出的${check.type.toUpperCase()}内容有问题：${check.reason}。请重新生成完整正确的内容，不要再犯同样的错误。` }]), sender, false);
      if (!fixResult.error && fixResult.text.trim()) {
        const fixedReply = fixResult.text.trim();
        chatHistory.pop();
        chatHistory.push({ role: 'assistant', content: fixedReply });
        while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
        try { sender.send('chat:chunk', '\n\n---\n\n🔧 小橘修复了格式问题，以下是修正后的版本：\n\n' + fixedReply); } catch (e) {}
        return { reply: reply + '\n\n---\n\n🔧 小橘检查发现格式有瑕疵，已修复，请看上方修正版～', stopped: wasAborted };
      }
      // 修复失败，保留原始回复
      chatHistory.pop();
      chatHistory.push({ role: 'assistant', content: reply });
      try { sender.send('chat:chunk', '\n\n⚠️ 小橘检查发现格式可能有问题，但修复没成功，请检查一下喵～'); } catch (e) {}
    }
    // 对话变长时触发摘要压缩（异步执行，不阻塞回复）
    maybeCompactHistory().catch((e) => console.warn(`[pet:compact] 压缩失败: ${e.message}`));
    return { reply, stopped: wasAborted };
  } catch (err) {
    currentAbortController = null;
    // 用户手动停止（AbortError）时，保留已生成的部分内容
    if (err.name === 'AbortError') {
      console.log('[pet:chat] 用户手动停止生成');
      if (full && full.trim()) {
        chatHistory.push({ role: 'assistant', content: full.trim() });
        while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
        return { reply: full.trim(), stopped: true };
      }
      chatHistory.pop();
      return { reply: '', stopped: true };
    }
    console.warn('[pet] 大模型调用异常:', err.message);
    chatHistory.pop();
    return null;
  }
}

function createWindow() {
  // 计算所有显示器的联合区域（多显示器支持）
  const displays = screen.getAllDisplays();
  let totalBounds = displays[0].bounds;
  for (let i = 1; i < displays.length; i++) {
    const b = displays[i].bounds;
    totalBounds = {
      x: Math.min(totalBounds.x, b.x),
      y: Math.min(totalBounds.y, b.y),
      width: Math.max(totalBounds.x + totalBounds.width, b.x + b.width) - Math.min(totalBounds.x, b.x),
      height: Math.max(totalBounds.y + totalBounds.height, b.y + b.height) - Math.min(totalBounds.y, b.y),
    };
  }
  const width = totalBounds.width;
  const height = totalBounds.height;

  const winIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon.ico')
    : path.join(__dirname, 'build', 'icon.ico');

  mainWindow = new BrowserWindow({
    width,
    height,
    x: totalBounds.x,
    y: totalBounds.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,           // 不在任务栏显示
    alwaysOnTop: true,            // 始终置顶
    hasShadow: false,
    show: false,
    icon: winIcon,                // 应用图标
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 允许麦克风权限（会议纪要录音用）
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(false);
  });

  // 默认让鼠标穿透整个窗口，但转发鼠标移动事件给渲染进程
  // 这样桌面正常可点击，渲染层仍能感知鼠标位置
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 转发渲染进程 console 到主进程 stdout，便于诊断
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log('[renderer] PROCESS GONE:', JSON.stringify(details));
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 关闭窗口时隐藏到托盘，而非退出（仅托盘"退出"真正退出）
  // 窗口失焦时收起聊天框（解决聊天框总置顶挡住其他应用的问题）
  mainWindow.on('blur', () => {
    try { mainWindow.webContents.send('chat:blurHide'); } catch (e) {}
  });

  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // 打包后用 process.resourcesPath，开发时用 __dirname
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon.ico')
    : path.join(__dirname, 'build', 'icon.ico');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch (e) {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('小橘猫缘缘 🐱');

  // 开机自启动状态
  // 开机自启动：使用模块级 getAutoLaunch/setAutoLaunch（shell:startup 快捷方式方式）
  // 托盘菜单 checkbox 状态读取 + 切换

  function buildContextMenu() {
    return Menu.buildFromTemplate([
      {
        label: '显示宠物',
        click: () => { if (mainWindow) mainWindow.show(); },
      },
      {
        label: '隐藏宠物',
        click: () => { mainWindow?.hide(); },
      },
      { type: 'separator' },
      {
        label: '🔔 开机自启动',
        type: 'checkbox',
        checked: getAutoLaunch(),
        click: (menuItem) => {
          setAutoLaunch(menuItem.checked);
          rebuildMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => { isQuiting = true; app.quit(); },
      },
    ]);
  }

  function rebuildMenu() { tray.setContextMenu(buildContextMenu()); }

  tray.setContextMenu(buildContextMenu());

  // 点击托盘图标显示/隐藏
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    }
  });
}

// ============ IPC 通信 ============

// 设置鼠标穿透
ipcMain.on('set-ignore-mouse', (_event, ignore) => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(ignore, { forward: ignore });
  }
});

// 获取屏幕工作区尺寸（兼容多显示器：返回主屏区域，猫默认在主屏活动）
ipcMain.handle('get-screen-bounds', () => {
  const workArea = screen.getPrimaryDisplay().workArea;
  return { width: workArea.width, height: workArea.height };
});

// 获取窗口当前位置
ipcMain.handle('get-window-position', () => {
  if (!mainWindow) return null;
  return mainWindow.getPosition();
});

// 移动窗口
ipcMain.handle('move-window', (_event, x, y) => {
  if (mainWindow) mainWindow.setPosition(Math.round(x), Math.round(y));
});

// ===== 开机自启动：通过 shell:startup 文件夹快捷方式 =====
const STARTUP_DIR = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LNK_NAME = '小橘猫缘缘.lnk';
function getStartupLnk() { return path.join(STARTUP_DIR, LNK_NAME); }

function getAutoLaunch() {
  try { return fs.existsSync(getStartupLnk()); } catch (e) { return false; }
}

function setAutoLaunch(on) {
  const lnkPath = getStartupLnk();
  try {
    if (on) {
      const exePath = app.getPath('exe');
      const workDir = app.isPackaged ? path.dirname(exePath) : __dirname;
      const args = app.isPackaged ? '' : '.';
      const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.TargetPath='${exePath.replace(/'/g, "''")}'; $s.WorkingDirectory='${workDir.replace(/'/g, "''")}'; $s.Arguments='${args}'; $s.IconLocation='${exePath.replace(/'/g, "''")},0'; $s.Save()`;
      runPowerShell(ps, 5000);
      console.log(`[pet:autolaunch] 已创建开机自启动快捷方式: ${lnkPath} -> ${exePath}`);
    } else {
      if (fs.existsSync(lnkPath)) {
        fs.unlinkSync(lnkPath);
        console.log('[pet:autolaunch] 已移除开机自启动快捷方式');
      }
    }
    return true;
  } catch (e) {
    console.warn('[pet:autolaunch] 操作失败:', e.message);
    return false;
  }
}

// 开机自启动 IPC
ipcMain.handle('autolaunch:get', () => getAutoLaunch());
ipcMain.handle('autolaunch:set', (_event, on) => setAutoLaunch(!!on));

// ============ 应用查找与打开 ============
// 应用名别名映射（中文/简称 → 搜索关键词）
const APP_ALIASES = {
  '微信': ['微信', 'WeChat', 'Weixin'],
  'wechat': ['微信', 'WeChat', 'Weixin'],
  '企业微信': ['企业微信', 'WXWork'],
  'qq': ['QQ', '腾讯QQ'],
  'qq音乐': ['QQ音乐', 'QQMusic'],
  '浏览器': ['Chrome', 'Edge', 'Firefox', '浏览器'],
  'chrome': ['Chrome', '谷歌浏览器'],
  '谷歌浏览器': ['Chrome'],
  'edge': ['Edge', 'Microsoft Edge'],
  '记事本': ['notepad', '记事本'],
  'notepad': ['notepad'],
  '计算器': ['calc', '计算器'],
  'calc': ['calc'],
  '资源管理器': ['explorer', '资源管理器'],
  '终端': ['cmd', '终端'],
  'cmd': ['cmd'],
  'ppt': ['PowerPoint'],
  'powerpoint': ['PowerPoint'],
  'word': ['Word'],
  'excel': ['Excel'],
  'vscode': ['Code', 'Visual Studio Code'],
  '网易云': ['CloudMusic', '网易云音乐'],
};

// 内置系统应用（直接用 shell 命令打开，不需查找）
const SYSTEM_APPS = {
  '记事本': 'notepad.exe',
  'notepad': 'notepad.exe',
  '计算器': 'calc.exe',
  'calc': 'calc.exe',
  '资源管理器': 'explorer.exe',
  '文件资源管理器': 'explorer.exe',
  'explorer': 'explorer.exe',
  '终端': 'cmd.exe',
  'cmd': 'cmd.exe',
  'powershell': 'powershell.exe',
  '画图': 'mspaint.exe',
  'mspaint': 'mspaint.exe',
  '截图工具': 'snippingtool.exe',
  '任务管理器': 'taskmgr.exe',
};

// 通过注册表 Uninstall 项查找已安装应用路径
function findAppInRegistry(name) {
  try {
    // PowerShell 查注册表，返回 DisplayIcon 和 InstallLocation
    const ps = `Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*${name}*" } | Select-Object -First 1 DisplayIcon, InstallLocation | ConvertTo-Json`;
    const out = runPowerShell(ps, 10000);
    if (!out || out === '') return null;
    const j = JSON.parse(out);
    // DisplayIcon 常是 "C:\\path\\app.exe" 或 "C:\\path\\app.exe,0"
    if (j.DisplayIcon) {
      let p = j.DisplayIcon.replace(/^"/, '').replace(/"$/, '').split(',')[0].trim();
      if (fs.existsSync(p)) return p;
    }
    if (j.InstallLocation) {
      // 尝试在安装目录找 exe
      const dirs = fs.readdirSync(j.InstallLocation).catch ? [] : (fs.readdirSync(j.InstallLocation) || []);
      for (const f of dirs) {
        if (f.toLowerCase().endsWith('.exe')) {
          const full = path.join(j.InstallLocation, f);
          if (f.toLowerCase().includes(name.toLowerCase())) return full;
        }
      }
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

// 在开始菜单快捷方式中查找
function findAppInShortcuts(name) {
  try {
    const dirs = [
      path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu'),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = walkDir(dir, '.lnk');
      for (const f of files) {
        const base = path.basename(f, '.lnk');
        for (const alias of APP_ALIASES[name.toLowerCase()] || [name]) {
          if (base.includes(alias)) {
            // 解析快捷方式目标路径
            const target = resolveShortcut(f);
            if (target && fs.existsSync(target)) return target;
          }
        }
      }
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

// 递归遍历目录找特定扩展名文件
function walkDir(dir, ext, depth = 0) {
  if (depth > 4) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase().endsWith(ext)) {
        results.push(full);
      } else if (e.isDirectory()) {
        results.push(...walkDir(full, ext, depth + 1));
      }
    }
  } catch (err) { /* 忽略权限错误 */ }
  return results;
}

// 解析 .lnk 快捷方式的目标路径（用 PowerShell）
function resolveShortcut(lnkPath) {
  try {
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.TargetPath`;
    const out = runPowerShell(ps, 5000);
    return out || null;
  } catch (e) { return null; }
}

// 综合查找应用路径
function findApp(name) {
  const lower = name.toLowerCase();
  // 1. 系统内置应用直接返回
  if (SYSTEM_APPS[lower]) return SYSTEM_APPS[lower];
  // 2. 注册表查找（按所有别名）
  const aliases = APP_ALIASES[lower] || [name];
  for (const alias of aliases) {
    const p = findAppInRegistry(alias);
    if (p) { console.log(`[pet:app] 注册表找到 ${name}: ${p}`); return p; }
  }
  // 3. 快捷方式查找
  for (const alias of aliases) {
    const p = findAppInShortcuts(alias);
    if (p) { console.log(`[pet:app] 快捷方式找到 ${name}: ${p}`); return p; }
  }
  return null;
}

// 检测用户消息中的"打开xxx"意图，返回 { app, action } 或 null
function detectOpenIntent(message) {
  const text = (message || '').trim();
  // 打开应用：帮我打开微信 / 打开微信 / 开微信
  const m = text.match(/(?:帮我?|给我|请)?(?:打开|开|启动|运行)\s*([^\s,，。！？!?.]+)/);
  if (m) {
    let app = m[1].trim();
    // 去掉"一下"等后缀
    app = app.replace(/[一下个呗吧]/g, '');
    return { action: 'open_app', app };
  }
  return null;
}

// 打开应用
ipcMain.handle('app:open', async (_event, name) => {
  const exePath = findApp(name);
  if (exePath) {
    try {
      shell.openPath(exePath);
      console.log(`[pet:app] 已打开 ${name}: ${exePath}`);
      return { success: true, path: exePath };
    } catch (e) {
      return { success: false, error: '打开失败：' + e.message };
    }
  }
  return { success: false, error: '没找到这个应用，可能没安装或名字不对' };
});

// ============ 文件操作（复制/移动 + 路径解析 + 模糊搜索 + 选择确认）============

// 解析用户说的路径名 → 实际文件系统路径
function resolvePath(name) {
  if (!name) return null;
  const n = name.trim();
  // 系统特殊文件夹
  const special = {
    '桌面': path.join(process.env.USERPROFILE, 'Desktop'),
    'desktop': path.join(process.env.USERPROFILE, 'Desktop'),
    '下载': path.join(process.env.USERPROFILE, 'Downloads'),
    'downloads': path.join(process.env.USERPROFILE, 'Downloads'),
    '文档': path.join(process.env.USERPROFILE, 'Documents'),
    'documents': path.join(process.env.USERPROFILE, 'Documents'),
    '图片': path.join(process.env.USERPROFILE, 'Pictures'),
    '音乐': path.join(process.env.USERPROFILE, 'Music'),
    '视频': path.join(process.env.USERPROFILE, 'Videos'),
    '用户目录': process.env.USERPROFILE,
    '主目录': process.env.USERPROFILE,
  };
  // 盘符：D盘 → D:\
  const driveMatch = n.match(/^([A-Za-z])盘$/);
  if (driveMatch) return `${driveMatch[1].toUpperCase()}:\\`;
  const driveMatch2 = n.match(/^([A-Za-z]):$/);
  if (driveMatch2) return `${driveMatch2[1].toUpperCase()}:\\`;
  // C:\Users 这种直接返回
  if (/^[A-Za-z]:[\\/]/.test(n)) return n;
  // 特殊文件夹
  const lower = n.toLowerCase();
  if (special[n] || special[lower]) return special[n] || special[lower];
  // 可能是相对路径，拼用户目录
  return null;
}

// 在指定目录下搜索文件名匹配的文件（递归，最多3层），返回匹配列表
function searchFiles(dir, keyword, depth = 0, maxResults = 20) {
  if (depth > 3) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (results.length >= maxResults) break;
      const full = path.join(dir, e.name);
      // 跳过系统隐藏目录和 node_modules
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
        results.push(...searchFiles(full, keyword, depth + 1, maxResults - results.length));
      } else {
        // 精确匹配或包含关键词
        if (e.name === keyword || e.name.toLowerCase().includes(keyword.toLowerCase())) {
          results.push({ name: e.name, path: full, dir: path.dirname(full) });
        }
      }
    }
  } catch (err) { /* 忽略权限错误 */ }
  return results;
}

// 检测文件操作意图：把[源]复制/移动/剪切到[目标]
function detectFileOpIntent(message) {
  const text = (message || '').trim();

  // 模式1：把/将 source 动词 目标
  // 复制：把xxx复制到yyy
  let m = text.match(/(?:把|将)\s*(.+?)\s*(?:复制|拷贝|copy)\s*[到至去]?\s*(.*)/);
  if (m) return { action: 'copy', source: m[1].trim(), target: m[2].trim() };
  // 移动：把xxx移动到yyy
  m = text.match(/(?:把|将)\s*(.+?)\s*(?:移动|剪切|搬|挪)\s*[到至去]?\s*(.*)/);
  if (m && m[2].trim()) return { action: 'move', source: m[1].trim(), target: m[2].trim() };
  // 删除：把xxx删除/删掉/删了
  m = text.match(/(?:把|将)\s*(.+?)\s*(?:删除|删掉|删了|删除掉|干掉)/);
  if (m) return { action: 'delete', source: m[1].trim(), target: '' };

  // 模式2：动词开头（无"把/将"）
  // 复制xxx到yyy
  m = text.match(/^(?:复制|拷贝|copy)\s+(.+?)\s*[到至去]\s*(.+)/);
  if (m) return { action: 'copy', source: m[1].trim(), target: m[2].trim() };
  // 移动xxx到yyy
  m = text.match(/^(?:移动|剪切|move)\s+(.+?)\s*[到至去]\s*(.+)/);
  if (m) return { action: 'move', source: m[1].trim(), target: m[2].trim() };
  // 删除xxx
  m = text.match(/^(?:删除|删掉)\s+(.+)/);
  if (m) return { action: 'delete', source: m[1].trim(), target: '' };

  return null;
}

// 从关键词中剥离路径前缀和文件类型修饰，得到纯搜索词
function cleanFileKeyword(keyword) {
  let kw = keyword.trim().replace(/[，。！？.]/g, '');
  // 去掉前缀"桌面上的""D盘的"等路径修饰
  const drivePrefix = kw.match(/^[A-Za-z]盘的?(.+)$/);
  const folderPrefix = kw.match(/^(?:桌面|下载|文档|图片|音乐|视频)的?(?:上|里|中)?的?(.+)$/);
  if (drivePrefix) kw = drivePrefix[1];
  else if (folderPrefix) kw = folderPrefix[1];
  // 去掉"名字叫""叫""名为""名称叫"等前缀
  kw = kw.replace(/^(?:名字叫|名字是|名叫|名为|名称叫|名称为|叫)\s*/, '');
  // 去掉"的word"/"的excel"等文件类型修饰
  kw = kw.replace(/的(?:word|excel|ppt|pdf|txt|doc|docx|xls|xlsx|pptx|图片|照片|视频|音乐|文件|文档|表格|演示)$/i, '');
  // 去掉结尾的"的"
  if (kw.endsWith('的')) kw = kw.slice(0, -1);
  return kw.trim();
}

// 检测"找文件"意图（优先级高于"打开应用"）
// 覆盖：帮我找xxx / 打开xxx文件 / 打开桌面上的xxx / 名字叫xxx的文件 / xxx在哪
function detectFileSearchIntent(message) {
  const text = (message || '').trim();
  const wantOpen = /打开|开一下/.test(text); // 是否需要搜到后打开
  let keyword = null;

  // 1) 帮我找/找到/查找/搜索/搜一下/找一下/找找 xxx
  let m = text.match(/(?:帮我?|给我|请)?(?:找到?|查找|搜索|搜一下|找一下|找找)\s*(.+?)(?:并.*|的文件|文件在哪|在哪|在哪里|在哪儿|在哪了)?[？?]?\s*$/);
  if (m) keyword = cleanFileKeyword(m[1]);

  // 2) 打开 xxx 文件 / 打开桌面/下载/文档 上的 xxx（打开 + 文件/路径词 → 是找文件而非打开应用）
  if (!keyword && wantOpen && (/(?:文件|文档|桌面|下载|文档)/.test(text))) {
    m = text.match(/(?:帮我?|给我|请)?(?:打开|开一下)\s*(.+?)(?:并.*|的文件|文件|文档)?[？?]?\s*$/);
    if (m) keyword = cleanFileKeyword(m[1]);
  }

  // 3) 名字叫xxx的文件 / 叫xxx的文件 / 名为xxx的文件 / 名叫xxx
  if (!keyword) {
    m = text.match(/(?:名字叫|名字是|名叫|名为|名称叫|名称为|叫)\s*(.+?)(?:的文件|的文档|文件|文档)?[？?]?\s*$/);
    if (m) keyword = cleanFileKeyword(m[1]);
  }

  // 4) xxx文件在哪 / xxx在哪
  if (!keyword) {
    m = text.match(/(.+?)\s*(?:文件)?(?:在哪|在哪里|在哪儿|在哪了)[？?]?\s*$/);
    if (m) {
      const k = cleanFileKeyword(m[1]);
      if (k && k.length > 0) keyword = k;
    }
  }

  if (keyword && keyword.length > 0) return { action: 'search_file', keyword, open: wantOpen };
  return null;
}

// 在多个常见目录中异步搜索文件（不阻塞主线程，用 Base64 编码避免中文问题）
function searchFilesEverywhere(keyword) {
  // 拆分多个关键词
  const keywords = [keyword];
  if (keyword.includes(' ')) {
    keyword.split(' ').filter((k) => k.length > 0).forEach((k) => keywords.push(k));
  }
  const uniqueKeywords = [...new Set(keywords)];

  const searchDirs = [
    path.join(process.env.USERPROFILE, 'Desktop'),
    path.join(process.env.USERPROFILE, 'Downloads'),
    path.join(process.env.USERPROFILE, 'Documents'),
    'C:\\Windows\\System32',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];
  return new Promise((resolve) => {
    const allResults = [];
    const seen = new Set();
    let pending = uniqueKeywords.length * searchDirs.length;
    if (pending === 0) { resolve([]); return; }
    for (const kw of uniqueKeywords) {
      for (const dir of searchDirs) {
        // 用 Base64 EncodedCommand，彻底避免中文关键词的编码/引号问题
        const ps = `Get-ChildItem -Path '${dir.replace(/'/g, "''")}' -Recurse -File -Filter '*${kw}*' -ErrorAction SilentlyContinue | Select-Object -First 20 -ExpandProperty FullName`;
        runPowerShellAsync(ps, 15000).then(({ stdout }) => {
          if (stdout) {
            const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
            for (const line of lines) {
              if (allResults.length >= 20) break;
              if (seen.has(line.toLowerCase())) continue;
              seen.add(line.toLowerCase());
              allResults.push({ name: path.basename(line), path: line, dir: path.dirname(line) });
            }
          }
          pending--;
          if (pending <= 0) {
            console.log(`[pet:file] 异步搜索 "${keyword}" 找到 ${allResults.length} 个结果`);
            resolve(allResults);
          }
        });
      }
    }
  });
}
// ============ 读取文件内容（支持 txt/md/json/csv/docx/xlsx/pdf/html）============
async function readFileContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    // 纯文本类：直接读
    if (['.txt', '.md', '.json', '.csv', '.log', '.xml', '.html', '.htm', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.css', '.sql', '.yml', '.yaml', '.ini', '.conf'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return { ok: true, content: content.slice(0, 8000), ext };
    }
    // PDF：用 pdf-parse
    if (ext === '.pdf') {
      if (!pdfParse) return { ok: false, error: 'PDF 解析模块未安装' };
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      return { ok: true, content: (data.text || '').slice(0, 8000), ext };
    }
    // Word docx：用 PowerShell 解压 zip 提取文本 + media 图片
    if (ext === '.docx') {
      const ps = `
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead('${filePath.replace(/'/g, "''")}')
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
        $reader = New-Object System.IO.StreamReader($entry.Open())
        $xml = $reader.ReadToEnd()
        $reader.Close()
        $text = $xml -replace '</w:p>', "\`n" -replace '<[^>]+>', '' -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>'
        $text = ($text -split "\`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join "\`n"
        $images = @()
        $mediaEntries = $zip.Entries | Where-Object { $_.FullName -like 'word/media/*' }
        foreach ($me in $mediaEntries) {
          $ms = $me.Open()
          $memStream = New-Object System.IO.MemoryStream
          $ms.CopyTo($memStream)
          $ms.Close()
          $bytes = $memStream.ToArray()
          $memStream.Close()
          $b64 = [Convert]::ToBase64String($bytes)
          $ext2 = [System.IO.Path]::GetExtension($me.FullName).TrimStart('.')
          $images += "$ext2|$b64"
        }
        $zip.Dispose()
        Write-Output "===TEXT==="
        Write-Output $text
        Write-Output "===IMAGES==="
        Write-Output ($images -join "\`n---IMG---\`n")
      `;
      const out = runPowerShell(ps, 30000);
      // 解析输出：分离文本和图片
      const textMatch = out.indexOf('===TEXT===');
      const imgMatch = out.indexOf('===IMAGES===');
      let textContent = '';
      const images = [];
      if (textMatch >= 0 && imgMatch >= 0) {
        textContent = out.substring(textMatch + 10, imgMatch).trim();
        const imgSection = out.substring(imgMatch + 12).trim();
        if (imgSection) {
          const imgParts = imgSection.split('\n---IMG---\n');
          for (const part of imgParts) {
            const sepIdx = part.indexOf('|');
            if (sepIdx > 0 && sepIdx < 6) {
              const imgExt = part.substring(0, sepIdx);
              const b64 = part.substring(sepIdx + 1);
              if (b64.length > 100) images.push({ ext: imgExt, base64: b64 });
            }
          }
        }
      } else {
        textContent = out.slice(0, 8000);
      }
      console.log(`[pet:file] docx 读取完成: ${textContent.length} 字，${images.length} 张图片`);
      return { ok: true, content: textContent.slice(0, 8000), ext, images };
    }
    // Excel xlsx：读 sharedStrings + sheet1
    if (ext === '.xlsx') {
      const ps = `
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead('${filePath.replace(/'/g, "''")}')
        # 读共享字符串
        $strings = @()
        $sEntry = $zip.Entries | Where-Object { $_.FullName -eq 'xl/sharedStrings.xml' }
        if ($sEntry) {
          $sr = New-Object System.IO.StreamReader($sEntry.Open())
          $sxml = $sr.ReadToEnd(); $sr.Close()
          $strings = [regex]::Matches($sxml, '<t[^>]*>([^<]*)</t>') | ForEach-Object { $_.Groups[1].Value }
        }
        # 读 sheet1
        $sheetEntry = $zip.Entries | Where-Object { $_.FullName -eq 'xl/worksheets/sheet1.xml' }
        $rows = @()
        if ($sheetEntry) {
          $sr2 = New-Object System.IO.StreamReader($sheetEntry.Open())
          $sheetxml = $sr2.ReadToEnd(); $sr2.Close()
          $rowMatches = [regex]::Matches($sheetxml, '<row[^>]*>(.*?)</row>', 'Singleline')
          foreach ($rm in $rowMatches) {
            $cellMatches = [regex]::Matches($rm.Groups[1].Value, '<c[^>]*t="(\w+)?"[^>]*><v>(\d+)</v>')
            $line = @()
            foreach ($cm in $cellMatches) {
              if ($cm.Groups[1].Value -eq 's') { $line += $strings[[int]$cm.Groups[2].Value] }
              else { $line += $cm.Groups[2].Value }
            }
            $rows += ($line -join ' | ')
          }
        }
        $zip.Dispose()
        $rows -join "\`n"
      `;
      const out = runPowerShell(ps, 15000);
      return { ok: true, content: out.slice(0, 8000), ext };
    }
    // doc 旧格式不支持
    if (ext === '.doc' || ext === '.xls') return { ok: false, error: '不支持旧版 .doc/.xls 格式，建议转为 .docx/.xlsx' };
    // 其他不支持的格式
    return { ok: false, error: `不支持读取 ${ext} 格式的文件内容` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============ 中文时间解析 ============
// 支持：X分钟后、X小时后、下午3点、3点半、明天下午3点、晚上8点等
// 返回时间戳（毫秒），解析失败返回 null
function parseChineseTime(text) {
  const now = new Date();
  const t = text.trim();

  // X分钟后 / X分后
  let m = t.match(/(\d+)\s*分[钟]?后/);
  if (m) return now.getTime() + parseInt(m[1]) * 60 * 1000;
  // X小时后 / X个小时后
  m = t.match(/(\d+)\s*[个]?\s*小时后/);
  if (m) return now.getTime() + parseInt(m[1]) * 3600 * 1000;
  // X秒后
  m = t.match(/(\d+)\s*秒后/);
  if (m) return now.getTime() + parseInt(m[1]) * 1000;
  // 半小时后
  if (/半小时后/.test(t)) return now.getTime() + 30 * 60 * 1000;
  // 一会儿/马上 → 5 分钟后
  if (/(一会儿|马上|等会)/.test(t)) return now.getTime() + 5 * 60 * 1000;

  // 明天/后天 + 时间
  const dayOffset = /后天/.test(t) ? 2 : /明天|明儿/.test(t) ? 1 : /今天/.test(t) ? 0 : null;

  // X点X分 / X点半 / X点
  let hour = null, minute = 0;
  // 下午3点 / 上午9点 / 晚上8点 / 中午12点
  m = t.match(/(下午|晚上|上午|中午|凌晨)?\s*(\d{1,2})\s*[点时]半/);
  if (m) {
    hour = parseInt(m[2]);
    if (m[1] === '下午' || m[1] === '晚上') hour += hour < 12 ? 12 : 0;
    if (m[1] === '中午') { if (hour < 12) hour += 12; }
    minute = 30;
  } else {
    m = t.match(/(下午|晚上|上午|中午|凌晨)?\s*(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分)?/);
    if (m) {
      hour = parseInt(m[2]);
      if (m[1] === '下午' || m[1] === '晚上') hour += hour < 12 ? 12 : 0;
      if (m[1] === '中午') { if (hour < 12) hour += 12; }
      minute = m[3] ? parseInt(m[3]) : 0;
    }
  }

  if (hour !== null) {
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    // 没有明说今天/明天/后天，若时间已过则默认明天
    if (dayOffset === null) {
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    } else {
      d.setDate(d.getDate() + dayOffset);
    }
    return d.getTime();
  }

  return null;
}

// 解析间隔描述 → { intervalMs, intervalText }，用于循环提醒
// 支持：每隔30分钟 / 每1小时 / 每5秒 / 每小时 / 每分钟
function parseInterval(desc) {
  if (!desc) return null;
  let m = desc.match(/(?:每隔|每)\s*(\d+)\s*(分钟|小时|分|秒)/);
  if (m) {
    const num = parseInt(m[1]);
    const unit = m[2];
    const ms = unit.includes('秒') ? num * 1000 : unit.includes('小时') ? num * 3600000 : num * 60000;
    return { intervalMs: ms, intervalText: `每${num}${unit}` };
  }
  m = desc.match(/(?:每隔|每)\s*(小时|分钟|分)/);
  if (m) {
    const unit = m[1];
    const ms = unit.includes('小时') ? 3600000 : 60000;
    return { intervalMs: ms, intervalText: `每${unit}` };
  }
  return null;
}

// 检测定时提醒意图：X分钟后提醒我yyy / 下午3点提醒我yyy / 明天9点提醒我yyy
function detectReminderIntent(message) {
  const text = (message || '').trim();
  // 带时间的提醒
  const m = text.match(/(.+?)\s*(?:提醒我|提醒一下|叫我|喊我)\s*(.*)/);
  if (m) {
    // m[1] 是时间部分，m[2] 是事件
    const timeStr = m[1].replace(/(?:帮我|请|帮我设置|设个|设置一个|定个|定一个|创建|建一个)/g, '').trim();
    const event = (m[2] || '').replace(/[，。！？.]/g, '').trim();
    if (timeStr && event) {
      const ts = parseChineseTime(timeStr);
      if (ts) return { action: 'reminder', timeStr, event, ts };
    }
  }
  return null;
}

// ============ 循环提醒系统 ============
// 每隔X分钟/小时提醒，久坐提醒，喝水提醒等
const recurringReminders = []; // { id, text, intervalMs, timer, active }
let reminderSeq = 0;

function detectRecurringIntent(message) {
  const text = (message || '').trim();
  // 每隔X分钟/小时提醒我yyy
  let m = text.match(/(?:每隔|每)\s*(\d+)\s*(分钟|小时|分|秒)(?:提醒我|提醒我一下|提醒)?\s*(.*)/);
  if (m) {
    const num = parseInt(m[1]);
    const unit = m[2];
    const event = (m[3] || '').replace(/[，。！？.]/g, '').trim() || '该活动了';
    const ms = unit.includes('秒') ? num * 1000 : unit.includes('小时') ? num * 3600000 : num * 60000;
    return { action: 'recurring', event, intervalMs: ms, intervalText: `每${num}${unit}` };
  }
  // 每小时提醒我yyy（无数字，默认1）
  m = text.match(/(?:每隔|每)\s*(小时|分钟|分)(?:提醒我|提醒我一下|提醒)?\s*(.*)/);
  if (m) {
    const unit = m[1];
    const event = (m[2] || '').replace(/[，。！？.]/g, '').trim() || '该活动了';
    const ms = unit.includes('小时') ? 3600000 : 60000;
    return { action: 'recurring', event, intervalMs: ms, intervalText: `每${unit}` };
  }
  // 久坐提醒 / 喝水提醒（默认间隔）
  if (/(久坐提醒|起身提醒|起来活动)/.test(text)) {
    return { action: 'recurring', event: '该起来活动活动啦，久坐伤身喵！', intervalMs: 45 * 60 * 1000, intervalText: '每45分钟' };
  }
  if (/(喝水提醒|喝水|该喝水了)/.test(text) && /提醒|提醒我|开启|打开|设置/.test(text)) {
    return { action: 'recurring', event: '该喝水啦，记得多喝水喵！', intervalMs: 60 * 60 * 1000, intervalText: '每1小时' };
  }
  // 取消循环提醒
  if (/(取消|关闭|停止|关掉).*(提醒|喝水提醒|久坐提醒)/.test(text)) {
    return { action: 'cancel_recurring' };
  }
  return null;
}

function addRecurringReminder(event, intervalMs, intervalText) {
  const id = ++reminderSeq;
  const reminder = { id, type: 'interval', text: event, intervalMs, intervalText, active: true, timer: null };
  reminder.timer = setInterval(() => {
    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('tray:action', '__recurring_reminder__');
        mainWindow.webContents.send('recurring:remind', { text: event, intervalText });
      }
    } catch (e) {}
  }, intervalMs);
  recurringReminders.push(reminder);
  console.log(`[pet:reminder] 添加循环提醒(interval): ${event} ${intervalText}`);
  return reminder;
}

// 添加定时提醒（每周几 + 时间）
// weekdays: [0,1,2,3,4,5,6] 0=周日 1=周一...6=周六; timeStr: "HH:MM"
function addWeeklyReminder(event, weekdays, timeStr) {
  const id = ++reminderSeq;
  const dayNames = ['日','一','二','三','四','五','六'];
  const dayStr = weekdays.slice().sort().map(d => '周' + dayNames[d]).join('、');
  const intervalText = `${dayStr} ${timeStr}`;
  const reminder = { id, type: 'weekly', text: event, weekdays: weekdays.slice(), timeStr, intervalText, active: true, timer: null };
  function scheduleNext() {
    const now = new Date();
    const [hh, mm] = timeStr.split(':').map(n => parseInt(n));
    let next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    for (let i = 0; i < 8; i++) {
      if (weekdays.includes(next.getDay())) break;
      next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();
    reminder.timer = setTimeout(() => {
      try {
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('tray:action', '__recurring_reminder__');
          mainWindow.webContents.send('recurring:remind', { text: event, intervalText });
        }
      } catch (e) {}
      scheduleNext();
    }, delay);
  }
  scheduleNext();
  recurringReminders.push(reminder);
  console.log(`[pet:reminder] 添加定时提醒(weekly): ${event} ${intervalText}`);
  return reminder;
}

function cancelAllRecurring() {
  recurringReminders.forEach((r) => { if (r.timer) { clearInterval(r.timer); clearTimeout(r.timer); } });
  recurringReminders.length = 0;
  console.log('[pet:reminder] 已取消所有循环提醒');
}

// ============ 定时任务（混合模式：先跑脚本，失败找AI） ============
const scheduledTasks = []; // { id, name, scheduleType, scheduleDesc, timeStr, intervalMs, weekdays, scriptLanguage, scriptPath, prompt, timer, lastRun, lastStatus }
let scheduledTaskSeq = 0;
const SCHEDULED_TASKS_FILE = path.join(app.getPath('userData'), 'scheduled-tasks.json');
const SCHEDULED_SCRIPTS_DIR = path.join(getSaveDir(), 'python_output', 'scheduled');

// 保存定时任务到文件
function saveScheduledTasks() {
  try {
    const data = scheduledTasks.map(t => ({
      id: t.id, name: t.name, scheduleType: t.scheduleType, scheduleDesc: t.scheduleDesc,
      timeStr: t.timeStr, intervalMs: t.intervalMs, weekdays: t.weekdays,
      scriptLanguage: t.scriptLanguage, scriptPath: t.scriptPath,
      prompt: t.prompt, lastRun: t.lastRun, lastStatus: t.lastStatus,
    }));
    fs.writeFileSync(SCHEDULED_TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.warn(`[pet:sched] 保存定时任务失败: ${e.message}`); }
}

// 从文件加载定时任务并恢复
function loadScheduledTasks() {
  try {
    if (!fs.existsSync(SCHEDULED_TASKS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_FILE, 'utf8'));
    data.forEach(t => {
      if (t.scriptPath && !fs.existsSync(t.scriptPath)) {
        console.warn(`[pet:sched] 脚本文件不存在，跳过: ${t.scriptPath}`);
        return;
      }
      scheduledTaskSeq = Math.max(scheduledTaskSeq, t.id);
      const task = { ...t, timer: null };
      scheduleTaskTimer(task);
      scheduledTasks.push(task);
      console.log(`[pet:sched] 恢复定时任务: ${task.name} (${task.scheduleDesc})`);
    });
  } catch (e) { console.warn(`[pet:sched] 加载定时任务失败: ${e.message}`); }
}

// 执行定时任务（混合模式：先跑脚本，失败找AI）
async function executeScheduledTask(task) {
  console.log(`[pet:sched] 执行定时任务: ${task.name}`);
  task.lastRun = new Date().toISOString();
  let success = false;
  let resultText = '';

  try {
    if (task.scriptPath && fs.existsSync(task.scriptPath)) {
      // ① 先跑已保存的脚本
      const workDir = path.join(getSaveDir(), 'python_output');
      if (task.scriptLanguage === 'powershell') {
        const code = fs.readFileSync(task.scriptPath, 'utf8');
        const r = await runPowershellCode(code, workDir);
        if (r.ok && !r.timedOut) { success = true; resultText = r.stdout.slice(0, 2000); }
        else { resultText = r.stderr || r.stdout || '执行失败'; }
      } else {
        const pyExe = getPythonExe();
        if (pyExe) {
          const r = await runPythonCode(pyExe, fs.readFileSync(task.scriptPath, 'utf8'), workDir);
          if (r.ok && !r.timedOut) { success = true; resultText = r.stdout.slice(0, 2000); }
          else { resultText = r.stderr || r.stdout || '执行失败'; }
        }
      }
    }

    // ② 脚本失败 → fallback 到 AI session
    if (!success) {
      console.log(`[pet:sched] 脚本执行失败，fallback 到 AI session: ${task.prompt}`);
      try { sender_safe_send('chat:status', { status: 'agent_step', text: `🔄 定时任务"${task.name}"脚本失败，AI正在修复…` }); } catch (e) {}
      const aiResult = await agentChatStream(
        `【定时任务】${task.name}\n${task.prompt}\n\n注意：之前保存的脚本执行失败了（错误：${resultText.slice(0, 500)}），请重新写代码执行，如果成功请调用 schedule_task 更新脚本。`,
        getDummySender(), '',
        { history: [], abortController: { controller: null } }  // 隔离上下文，不污染用户会话
      );
      if (aiResult && aiResult.reply) {
        success = true;
        resultText = aiResult.reply.slice(0, 2000);
      }
    }

    // 结果推气泡
    if (mainWindow && mainWindow.webContents) {
      const bubbleText = success
        ? `✅ 定时任务"${task.name}"执行成功！\n${resultText.slice(0, 200)}`
        : `❌ 定时任务"${task.name}"执行失败：${resultText.slice(0, 200)}`;
      try { mainWindow.webContents.send('tray:action', '__recurring_reminder__'); } catch (e) {}
      try { mainWindow.webContents.send('recurring:remind', { text: bubbleText, intervalText: task.scheduleDesc }); } catch (e) {}
    }

    // 失败时发系统通知（用户可能不在桌前）
    if (!success && Notification.isSupported()) {
      new Notification({
        title: `❌ 定时任务失败：${task.name}`,
        body: resultText.slice(0, 200),
        silent: false,
      }).show();
    }
  } catch (e) {
    console.warn(`[pet:sched] 定时任务执行异常: ${e.message}`);
  }

  task.lastStatus = success ? 'success' : 'failed';
  // 记录执行历史（保留最近10条）
  if (!task.history) task.history = [];
  task.history.unshift({ time: task.lastRun, success, result: resultText.slice(0, 500) });
  if (task.history.length > 10) task.history = task.history.slice(0, 10);
  saveScheduledTasks();
}

// 给 AI session 用的假 sender（不推流给前端，只记录）
function getDummySender() {
  return { send: () => {} };
}
// 兼容：有时直接调 executeScheduledTask 时 sender 不存在
function sender_safe_send(channel, data) {
  try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send(channel, data); } catch (e) {}
}

// 注册定时任务的定时器
function scheduleTaskTimer(task) {
  if (task.timer) { clearInterval(task.timer); clearTimeout(task.timer); task.timer = null; }
  if (task.scheduleType === 'interval') {
    task.timer = setInterval(() => executeScheduledTask(task), task.intervalMs);
  } else if (task.scheduleType === 'daily') {
    function scheduleNextDaily() {
      const now = new Date();
      const [hh, mm] = (task.timeStr || '08:00').split(':').map(n => parseInt(n));
      let next = new Date(now);
      next.setHours(hh, mm, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      const delay = next.getTime() - now.getTime();
      task.timer = setTimeout(() => { executeScheduledTask(task); scheduleNextDaily(); }, delay);
    }
    scheduleNextDaily();
  } else if (task.scheduleType === 'weekly') {
    function scheduleNextWeekly() {
      const now = new Date();
      const [hh, mm] = (task.timeStr || '08:00').split(':').map(n => parseInt(n));
      let next = new Date(now);
      next.setHours(hh, mm, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      for (let i = 0; i < 8; i++) {
        if ((task.weekdays || []).includes(next.getDay())) break;
        next.setDate(next.getDate() + 1);
      }
      const delay = next.getTime() - now.getTime();
      task.timer = setTimeout(() => { executeScheduledTask(task); scheduleNextWeekly(); }, delay);
    }
    scheduleNextWeekly();
  }
}

// 解析调度描述
// 支持: "daily 08:00" / "interval 30m" / "interval 2h" / "weekly 1,3,5 09:00"
function parseSchedule(scheduleStr) {
  const s = (scheduleStr || '').trim().toLowerCase();
  // daily HH:MM
  let m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (m) return { type: 'daily', timeStr: `${m[1].padStart(2,'0')}:${m[2]}`, desc: `每天 ${m[1]}:${m[2]}` };
  // weekly 1,3,5 HH:MM
  m = s.match(/^weekly\s+([\d,]+)\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const weekdays = m[1].split(',').map(n => parseInt(n));
    const dayNames = ['日','一','二','三','四','五','六'];
    const desc = `每周${weekdays.map(d => dayNames[d]).join('、')} ${m[2]}:${m[3]}`;
    return { type: 'weekly', weekdays, timeStr: `${m[2].padStart(2,'0')}:${m[3]}`, desc };
  }
  // interval 30m / 2h
  m = s.match(/^interval\s+(\d+)(m|h|min|hour)$/);
  if (m) {
    const num = parseInt(m[1]);
    const ms = (m[2].startsWith('h')) ? num * 3600000 : num * 60000;
    return { type: 'interval', intervalMs: ms, desc: `每${num}${m[2].startsWith('h') ? '小时' : '分钟'}` };
  }
  return null;
}

// ============ 系统操作意图（音量/锁屏/截屏/打开网页）============
function detectSystemOpIntent(message) {
  const text = (message || '').trim();
  // 音量
  if (/(调大|调高|大一点|大声点|音量大).*(音量|声音)/.test(text) || /音量.*(调大|调高|大一点|大声)/.test(text) || /调大音量/.test(text)) {
    return { action: 'volume_up' };
  }
  if (/(调小|调低|小一点|小声点|音量小).*(音量|声音)/.test(text) || /音量.*(调小|调低|小一点|小声)/.test(text) || /调小音量/.test(text)) {
    return { action: 'volume_down' };
  }
  if (/(静音|取消声音|关掉声音|声音关掉)/.test(text)) {
    return { action: 'volume_mute' };
  }
  // 锁屏
  if (/(锁屏|锁定屏幕|锁定电脑|锁电脑)/.test(text)) {
    return { action: 'lock' };
  }
  // 截屏
  if (/(截屏|截图|截个图|截个屏)/.test(text)) {
    return { action: 'screenshot' };
  }
  // 打开网页/搜索
  let m = text.match(/(?:帮我|请)?(?:打开|访问)(百度|谷歌|google|github|bilibili|b站|知乎|微博|淘宝|京东|网易云|youtube|微博)/i);
  if (m) return { action: 'open_url', site: m[1] };
  m = text.match(/(?:帮我|请)?(?:用浏览器)?(?:搜|搜索|查一下|查查)(一下)?\s*(.+)/);
  if (m && m[2] && m[2].length < 50) return { action: 'web_search', query: m[2].replace(/[，。！？.]/g, '').trim() };
  return null;
}

const SITE_URLS = {
  '百度': 'https://www.baidu.com', 'baidu': 'https://www.baidu.com',
  '谷歌': 'https://www.google.com', 'google': 'https://www.google.com',
  'github': 'https://github.com', 'Github': 'https://github.com',
  'bilibili': 'https://www.bilibili.com', 'b站': 'https://www.bilibili.com',
  '知乎': 'https://www.zhihu.com', '微博': 'https://weibo.com',
  '淘宝': 'https://www.taobao.com', '京东': 'https://www.jd.com',
  '网易云': 'https://music.163.com', 'youtube': 'https://www.youtube.com',
  'YouTube': 'https://www.youtube.com',
  // AI 网站
  'kimi': 'https://kimi.moonshot.cn', 'Kimi': 'https://kimi.moonshot.cn',
  'chatgpt': 'https://chat.openai.com', 'ChatGPT': 'https://chat.openai.com',
  'claude': 'https://claude.ai', 'Claude': 'https://claude.ai',
  '通义千问': 'https://tongyi.aliyun.com', '通义': 'https://tongyi.aliyun.com',
  '文心一言': 'https://yiyan.baidu.com', '文心': 'https://yiyan.baidu.com',
  'deepseek': 'https://chat.deepseek.com', 'DeepSeek': 'https://chat.deepseek.com',
  '豆包': 'https://www.doubao.com', 'doubao': 'https://www.doubao.com',
  '智谱清言': 'https://chatglm.cn', '智谱': 'https://chatglm.cn',
  '腾讯文档': 'https://docs.qq.com', '飞书': 'https://www.feishu.cn',
  '钉钉': 'https://www.dingtalk.com', '微信网页版': 'https://wx.qq.com',
  '小红书': 'https://www.xiaohongshu.com', '抖音': 'https://www.douyin.com',
  '掘金': 'https://juejin.cn', 'CSDN': 'https://www.csdn.net',
  'stackoverflow': 'https://stackoverflow.com', 'StackOverflow': 'https://stackoverflow.com',
};

function executeSystemOp(op) {
  try {
    switch (op.action) {
      case 'volume_up':
        runPowerShell('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]175)', 5000);
        return '已调大音量';
      case 'volume_down':
        runPowerShell('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]174)', 5000);
        return '已调小音量';
      case 'volume_mute':
        runPowerShell('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]173)', 5000);
        return '已切换静音';
      case 'lock':
        execSync('rundll32.exe user32.dll,LockWorkStation', { timeout: 5000 });
        return '已锁屏';
      case 'screenshot': {
        // 用 PowerShell + .NET 截全屏
        const screenshotDir = getSaveDir();
        const fname = `截图_${Date.now()}.png`;
        const fp = path.join(screenshotDir, fname);
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${fp.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;
        runPowerShell(ps, 10000);
        return `已截图，保存在：${fp}`;
      }
      case 'open_url': {
        const url = SITE_URLS[op.site] || SITE_URLS[op.site.toLowerCase()];
        if (url) { shell.openExternal(url); return `已打开 ${op.site}`; }
        return `没找到 ${op.site} 的网址`;
      }
      case 'web_search': {
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(op.query)}`;
        shell.openExternal(url);
        return `已用百度搜索：${op.query}`;
      }
    }
  } catch (e) {
    return '操作失败：' + e.message;
  }
  return null;
}

// 搜索文件 IPC（返回匹配列表，由前端弹出选择框）
ipcMain.handle('file:search', async (_event, sourceName, searchDir) => {
  // 尝试从 sourceName 提取盘符/文件夹
  const driveInName = sourceName.match(/^([A-Za-z])盘的?(.+)$/);
  const folderInName = sourceName.match(/^(桌面|下载|文档|图片)的?(上)?的?(.+)$/);
  if (/^[A-Za-z]:[\\/]/.test(sourceName)) {
    // 完整路径
    if (fs.existsSync(sourceName) && fs.statSync(sourceName).isFile()) {
      return [{ name: path.basename(sourceName), path: sourceName, dir: path.dirname(sourceName) }];
    }
    dir = path.dirname(sourceName);
    keyword = path.basename(sourceName);
  } else if (driveInName) {
    dir = `${driveInName[1].toUpperCase()}:\\`;
    keyword = driveInName[2];
  } else if (folderInName) {
    dir = resolvePath(folderInName[1]);
    keyword = folderInName[3];
  }
  if (!dir && searchDir) dir = resolvePath(searchDir);
  if (!dir) return [];

  console.log(`[pet:file] 搜索 dir=${dir} keyword="${keyword}"`);
  const results = searchFiles(dir, keyword);
  console.log(`[pet:file] 找到 ${results.length} 个匹配`);
  return results;
});

// 执行文件复制/移动 IPC
ipcMain.handle('file:exec', async (_event, action, srcPath, targetDir) => {
  try {
    const fileName = path.basename(srcPath);
    const destPath = targetDir ? path.join(targetDir, fileName) : null;
    if (action === 'copy') {
      fs.copyFileSync(srcPath, destPath);
      console.log(`[pet:file] 复制 ${srcPath} → ${destPath}`);
      return { success: true, dest: destPath };
    } else if (action === 'move') {
      fs.renameSync(srcPath, destPath);
      console.log(`[pet:file] 移动 ${srcPath} → ${destPath}`);
      return { success: true, dest: destPath };
    } else if (action === 'delete') {
      fs.unlinkSync(srcPath);
      console.log(`[pet:file] 删除 ${srcPath}`);
      return { success: true, dest: null };
    }
    return { success: false, error: '未知操作' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ============ 记忆系统 IPC ============
// 查看小橘记住的关于主人的信息
ipcMain.handle('memory:get', () => {
  return { facts: memory.facts || [], updatedAt: memory.updatedAt };
});

// 清空记忆
ipcMain.handle('memory:clear', () => {
  memory = { facts: [], updatedAt: new Date().toISOString() };
  saveMemory();
  console.log('[pet:memory] 记忆已清空');
  return { success: true };
});

// 手动添加一条记忆
ipcMain.handle('memory:add', (_event, text) => {
  if (!text) return { success: false };
  const f = String(text).trim();
  if (!memory.facts.some((e) => e.text === f)) {
    memory.facts.push({ text: f, time: new Date().toISOString() });
    saveMemory();
    console.log(`[pet:memory] 手动记住: ${f}`);
  }
  return { success: true };
});

// 删除一条记忆（按索引）
ipcMain.handle('memory:delete', (_event, index) => {
  if (index >= 0 && index < memory.facts.length) {
    const removed = memory.facts.splice(index, 1);
    saveMemory();
    console.log(`[pet:memory] 删除记忆: ${removed[0]?.text?.slice(0, 30)}`);
    return { success: true };
  }
  return { success: false };
});

// 编辑一条记忆（按索引）
ipcMain.handle('memory:update', (_event, index, newText) => {
  if (index >= 0 && index < memory.facts.length && newText) {
    memory.facts[index].text = String(newText).trim();
    memory.facts[index].time = new Date().toISOString();
    saveMemory();
    console.log(`[pet:memory] 编辑记忆: ${newText.slice(0, 30)}`);
    return { success: true };
  }
  return { success: false };
});

// ============ 读取文件内容 IPC（拖拽文件时前端调用）============
ipcMain.handle('file:read', async (_event, filePath) => {
  const result = await readFileContent(filePath);
  return result;
});

// ============ 保存内容到文件 IPC（AI 输出 HTML 时可保存）============
ipcMain.handle('file:save', async (_event, content, suggestedName) => {
  try {
    const saveDir = getSaveDir();
    const ts = Date.now();
    const fname = suggestedName || `小橘生成_${ts}.html`;
    const fp = path.join(saveDir, fname);
    // 支持二进制（Uint8Array/Buffer）和文本（string）
    if (content instanceof Uint8Array || Buffer.isBuffer(content)) {
      fs.writeFileSync(fp, Buffer.from(content));
    } else {
      fs.writeFileSync(fp, content, 'utf8');
    }
    console.log(`[pet:file] 已保存文件: ${fp}`);
    return { success: true, path: fp, name: fname };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 获取文件保存目录（默认桌面，可配置）
function getSaveDir() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'file-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.saveDir && fs.existsSync(cfg.saveDir)) return cfg.saveDir;
    }
  } catch (e) {}
  return path.join(process.env.USERPROFILE, 'Desktop');
}

// ============ 会议纪要功能 ============
// 获取/创建 meeting 文件夹（在配置的保存目录下）
function getMeetingDir() {
  const baseDir = getSaveDir();
  const meetingDir = path.join(baseDir, 'meeting');
  if (!fs.existsSync(meetingDir)) {
    fs.mkdirSync(meetingDir, { recursive: true });
  }
  return meetingDir;
}

// 保存音频文件
ipcMain.handle('meeting:saveAudio', async (_event, arrayBuffer, filename) => {
  try {
    const meetingDir = getMeetingDir();
    const fp = path.join(meetingDir, filename);
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(fp, buffer);
    console.log(`[pet:meeting] 音频已保存: ${fp} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return { success: true, path: fp };
  } catch (e) {
    console.warn(`[pet:meeting] 保存音频失败: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// ASR 语音转文字（SiliconFlow SenseVoiceSmall）
ipcMain.handle('meeting:transcribe', async (_event, audioPath) => {
  try {
    if (!fs.existsSync(audioPath)) {
      return { success: false, error: '音频文件不存在' };
    }
    const stats = fs.statSync(audioPath);
    if (stats.size > 50 * 1024 * 1024) {
      return { success: false, error: '音频文件超过 50MB 限制' };
    }
    console.log(`[pet:meeting] 开始转写: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);

    // 读取音频文件并构建 multipart/form-data
    const fileBuffer = fs.readFileSync(audioPath);
    const ext = path.extname(audioPath).toLowerCase() || '.webm';
    const fileName = path.basename(audioPath);

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const parts = [];
    // model 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nFunAudioLLM/SenseVoiceSmall\r\n`));
    // file 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : 'audio/webm'}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const res = await fetch(`${VISION_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VISION_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[pet:meeting] ASR 失败 HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return { success: false, error: `ASR 服务返回 ${res.status}` };
    }
    const data = await res.json();
    const text = data.text || '';
    console.log(`[pet:meeting] 转写成功，文本长度: ${text.length}`);

    // 保存转写文本
    const txtPath = audioPath.replace(/\.[^.]+$/, '.txt');
    fs.writeFileSync(txtPath, text, 'utf8');
    console.log(`[pet:meeting] 转写文本已保存: ${txtPath}`);

    return { success: true, text, txtPath };
  } catch (e) {
    console.warn(`[pet:meeting] 转写异常: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// 生成会议纪要（流式，用现有 LLM）
ipcMain.handle('meeting:summary', async (event, transcriptText) => {
  const sender = event.sender;
  try {
    const summaryPrompt = `你是一个专业的会议纪要助手。请根据以下会议录音的转写文本，生成一份结构化的会议纪要。

要求：
1. 提取会议的主要议题和讨论要点
2. 记录关键决策和结论
3. 列出待办事项和负责人（如果能识别出）
4. 格式用 Markdown，结构清晰（标题、列表、加粗等）
5. 如果转写文本有口语化或不通顺的地方，适当整理但不改变原意
6. 在开头标注会议主题（根据内容推断）

会议转写文本：
---
${transcriptText}
---

请生成会议纪要：`;

    const systemPrompt = getPetSystemPrompt() + '\n\n你现在是会议纪要助手模式，请专业、准确地整理会议纪要。';

    const res = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
      body: JSON.stringify({
        model: ARK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: summaryPrompt },
        ],
        stream: true,
      }),
    });

    if (!res.ok) {
      return { success: false, error: `LLM 返回 ${res.status}` };
    }

    // 流式读取
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const obj = JSON.parse(jsonStr);
          const delta = obj.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            try { sender.send('meeting:chunk', delta); } catch (e) {}
          }
        } catch (e) {}
      }
    }

    console.log(`[pet:meeting] 纪要生成完成，长度: ${fullText.length}`);
    return { success: true, text: fullText };
  } catch (e) {
    console.warn(`[pet:meeting] 纪要生成异常: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// 保存纪要文本到文件
ipcMain.handle('meeting:saveSummary', async (_event, content, audioPath) => {
  try {
    const summaryPath = audioPath.replace(/\.[^.]+$/, '_纪要.md');
    fs.writeFileSync(summaryPath, content, 'utf8');
    console.log(`[pet:meeting] 纪要已保存: ${summaryPath}`);
    return { success: true, path: summaryPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 文件保存路径配置
ipcMain.handle('file:getSaveDir', () => getSaveDir());
ipcMain.handle('file:setSaveDir', (_event, dir) => {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'file-config.json');
    const cfg = { saveDir: dir };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('file:chooseDir', async () => {
  try {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return { success: false };
    const dir = result.filePaths[0];
    const cfgPath = path.join(app.getPath('userData'), 'file-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ saveDir: dir }), 'utf8');
    return { success: true, dir };
  } catch (e) { return { success: false, error: e.message }; }
});

// 用默认程序打开文件（HTML 预览时用）
ipcMain.handle('file:open', (_event, filePath) => {
  try { shell.openPath(filePath); return { success: true }; } catch (e) { return { success: false }; }
});

// 在资源管理器中显示文件（选中该文件）
ipcMain.handle('file:showInFolder', (_event, filePath) => {
  try { shell.showItemInFolder(filePath); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

// ============ 头像管理（自定义聊天头像）============
const AVATAR_DIR = path.join(app.getPath('userData'), 'avatars');

ipcMain.handle('avatar:save', (_event, type, base64) => {
  try {
    if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
    // 从 data:image/xxx;base64,... 中提取 mime 和数据
    const m = base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) return { success: false, error: '无效的图片数据' };
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const data = Buffer.from(m[2], 'base64');
    const filePath = path.join(AVATAR_DIR, `${type}.${ext}`);
    // 删除旧的头像文件（不同扩展名）
    for (const f of fs.readdirSync(AVATAR_DIR)) {
      if (f.startsWith(type + '.')) {
        try { fs.unlinkSync(path.join(AVATAR_DIR, f)); } catch (e) {}
      }
    }
    fs.writeFileSync(filePath, data);
    console.log(`[pet:avatar] ${type} 头像已保存: ${filePath} (${(data.length / 1024).toFixed(1)}KB)`);
    return { success: true };
  } catch (e) {
    console.warn('[pet:avatar] 保存失败:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('avatar:load', () => {
  try {
    if (!fs.existsSync(AVATAR_DIR)) return null;
    const result = {};
    for (const type of ['pet', 'user']) {
      const files = fs.readdirSync(AVATAR_DIR).filter(f => f.startsWith(type + '.'));
      if (files.length > 0) {
        const filePath = path.join(AVATAR_DIR, files[0]);
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(files[0]).slice(1);
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        result[type] = { src: `data:image/${mime};base64,${buf.toString('base64')}`, ext };
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (e) {
    console.warn('[pet:avatar] 加载失败:', e.message);
    return null;
  }
});

ipcMain.handle('avatar:delete', (_event, type) => {
  try {
    if (!fs.existsSync(AVATAR_DIR)) return { success: true };
    for (const f of fs.readdirSync(AVATAR_DIR)) {
      if (f.startsWith(type + '.')) {
        try { fs.unlinkSync(path.join(AVATAR_DIR, f)); } catch (e) {}
      }
    }
    console.log(`[pet:avatar] ${type} 头像已删除`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ============ 截屏 + Vision 模型图片理解 ============
// 截屏返回 base64（不存文件）
function captureScreenBase64() {
  const tmpFile = path.join(require('os').tmpdir(), 'pet_screenshot_b64.txt');
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $b64 = [System.Convert]::ToBase64String($bytes)
    [System.IO.File]::WriteAllText('${tmpFile.replace(/\\/g, '/')}', $b64)
    $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
  `;
  runPowerShell(ps, 10000);
  const b64 = fs.readFileSync(tmpFile, 'utf8').trim();
  try { fs.unlinkSync(tmpFile); } catch (e) {}
  return b64;
}

// 截屏 IPC（返回 base64 给前端预览）
ipcMain.handle('screenshot:capture', () => {
  try {
    const b64 = captureScreenBase64();
    console.log(`[pet:vision] 截屏成功，base64 长度: ${b64.length}`);
    return { success: true, base64: b64 };
  } catch (e) {
    console.warn('[pet:vision] 截屏失败:', e.message);
    return { success: false, error: e.message };
  }
});

// ============ 区域截屏（微信风格：选区框）============
let screenshotWin = null;
let pendingScreenshotResolve = null;
let lastFullScreenshot = null; // 存储全屏截图，裁剪时复用

async function captureFullScreenObject() {
  // 用 desktopCapturer 获取全屏截图（不经过剪贴板，不会有光标闪烁）
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: primaryDisplay.size.width, height: primaryDisplay.size.height },
  });
  const source = sources && sources[0];
  if (!source || !source.thumbnail) return null;
  // 返回 PNG data URL
  return source.thumbnail.toDataURL();
}

async function startRegionCapture() {
  // 1. 隐藏主窗口（宠物 + 聊天框）
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.hide();
    // 等一帧让窗口真正消失，避免截到自己的 UI
    await new Promise((r) => setTimeout(r, 200));
  }
  // 2. 截取全屏
  let fullDataUrl = null;
  try {
    fullDataUrl = await captureFullScreenObject();
  } catch (e) {
    console.warn('[pet:capture] 全屏截取失败:', e.message);
  }
  if (!fullDataUrl) {
    // 回退到旧的 PowerShell 截屏
    try { fullDataUrl = 'data:image/png;base64,' + captureScreenBase64(); } catch (e) {}
  }
  if (!fullDataUrl) {
    if (mainWindow) mainWindow.show();
    return { success: false, error: '截屏失败' };
  }
  lastFullScreenshot = fullDataUrl; // 存起来，裁剪时用
  // 3. 创建全屏透明覆盖窗口用于选区
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  screenshotWin = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    fullscreen: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 注入选区 UI
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:100%; height:100%; overflow:hidden; cursor:crosshair; background:transparent; }
#bg { position:absolute; top:0; left:0; width:100%; height:100%; }
#mask { position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.35); pointer-events:none; }
#sel { position:absolute; border:2px solid #ff8c42; background:transparent; pointer-events:none; display:none; box-shadow:0 0 0 9999px rgba(0,0,0,0.35); }
#hint { position:fixed; top:20px; left:50%; transform:translateX(-50%); color:#fff; font-size:14px; background:rgba(0,0,0,0.6); padding:8px 20px; border-radius:20px; pointer-events:none; z-index:99; }
#cancel { position:fixed; top:20px; right:20px; color:#fff; font-size:13px; background:rgba(0,0,0,0.5); border:none; padding:8px 18px; border-radius:18px; cursor:pointer; z-index:99; }
#cancel:hover { background:rgba(255,80,80,0.6); }
</style></head><body>
<img id="bg" src="${fullDataUrl}" />
<div id="mask"></div>
<div id="sel"></div>
<div id="hint">拖动鼠标选择截图区域，按 ESC 取消</div>
<button id="cancel">✕ 取消</button>
<script>
let dragging=false, sx=0, sy=0;
const bg=document.getElementById('bg');
const sel=document.getElementById('sel');
const mask=document.getElementById('mask');
mask.style.display='none';
bg.onload = () => { bg.style.width='100%'; bg.style.height='100%'; bg.style.objectFit='fill'; };
document.onmousedown = (e) => {
  if (e.target.id === 'cancel') return;
  dragging = true; sx=e.clientX; sy=e.clientY;
  sel.style.display='block';
  sel.style.left=sx+'px'; sel.style.top=sy+'px'; sel.style.width='0px'; sel.style.height='0px';
};
document.onmousemove = (e) => {
  if (!dragging) return;
  let x=Math.min(sx,e.clientX), y=Math.min(sy,e.clientY);
  let w=Math.abs(e.clientX-sx), h=Math.abs(e.clientY-sy);
  sel.style.left=x+'px'; sel.style.top=y+'px'; sel.style.width=w+'px'; sel.style.height=h+'px';
};
document.onmouseup = (e) => {
  if (!dragging) return;
  dragging = false;
  let x=Math.min(sx,e.clientX), y=Math.min(sy,e.clientY);
  let w=Math.abs(e.clientX-sx), h=Math.abs(e.clientY-sy);
  if (w < 5 || h < 5) { sel.style.display='none'; return; }
  window.pet.screenshotRegion({ x, y, w, h });
};
document.getElementById('cancel').onclick = () => window.pet.screenshotCancel();
document.onkeydown = (e) => { if (e.key === 'Escape') window.pet.screenshotCancel(); };
</script>
</body></html>`;
  screenshotWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  screenshotWin.setMenuBarVisibility(false);
  screenshotWin.show();

  // 4. 等待用户选区或取消
  return new Promise((resolve) => {
    pendingScreenshotResolve = resolve;
  });
}

// 处理选区结果
ipcMain.on('screenshot:region', (_event, rect) => {
  if (!screenshotWin || !pendingScreenshotResolve) return;
  (async () => {
    // 用之前截取的全屏图裁剪（不重新截，避免截到选区覆盖窗口）
    const base64 = lastFullScreenshot;
    if (base64) {
      try {
        const cropped = await cropBase64Image(base64, rect.x, rect.y, rect.w, rect.h);
        closeScreenshotWin();
        if (mainWindow) mainWindow.show();
        pendingScreenshotResolve({ success: true, base64: cropped });
        pendingScreenshotResolve = null;
        return;
      } catch (e) { console.warn('[pet:capture] 裁剪失败:', e.message); }
    }
    closeScreenshotWin();
    if (mainWindow) mainWindow.show();
    pendingScreenshotResolve({ success: false, error: '裁剪失败' });
    pendingScreenshotResolve = null;
  })();
});

// 取消截图
ipcMain.on('screenshot:cancel', () => {
  closeScreenshotWin();
  if (mainWindow) mainWindow.show();
  if (pendingScreenshotResolve) {
    pendingScreenshotResolve({ success: false, cancelled: true });
    pendingScreenshotResolve = null;
  }
});

function closeScreenshotWin() {
  if (screenshotWin) {
    try { screenshotWin.close(); } catch (e) {}
    screenshotWin = null;
  }
}

// 裁剪 base64 图片（用 nativeImage）
async function cropBase64Image(dataUrl, x, y, w, h) {
  const img = nativeImage.createFromDataURL(dataUrl);
  // nativeImage 没有直接裁剪 API，用 resize + crop 的 workaround 不行
  // 改用 re-execute 截屏区域的方式：直接按屏幕坐标截取
  // 这里用 desktopCapturer + thumbnailSize 区域方式不行，所以用 PowerShell 裁剪
  const tmpFile = path.join(require('os').tmpdir(), 'pet_crop.png');
  const srcFile = path.join(require('os').tmpdir(), 'pet_full.png');
  // 保存全图到临时文件
  fs.writeFileSync(srcFile, img.toPNG());
  // 用 PowerShell 裁剪
  const ps = `
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile('${srcFile.replace(/\\/g, '/')}')
    $bmp = New-Object System.Drawing.Bitmap(${Math.round(w)}, ${Math.round(h)})
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, ${Math.round(w)}, ${Math.round(h)})), ${Math.round(x)}, ${Math.round(y)}, ${Math.round(w)}, ${Math.round(h)}, [System.Drawing.GraphicsUnit]::Pixel)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    [System.IO.File]::WriteAllBytes('${tmpFile.replace(/\\/g, '/')}', $bytes)
    $g.Dispose(); $bmp.Dispose(); $src.Dispose(); $ms.Dispose()
  `;
  runPowerShell(ps, 5000);
  const buf = fs.readFileSync(tmpFile);
  try { fs.unlinkSync(tmpFile); fs.unlinkSync(srcFile); } catch (e) {}
  return 'data:image/png;base64,' + buf.toString('base64');
}

// 区域截屏 IPC（供渲染进程调用）
ipcMain.handle('screenshot:region', async () => {
  try {
    return await startRegionCapture();
  } catch (e) {
    if (mainWindow) mainWindow.show();
    return { success: false, error: e.message };
  }
});

// 图片理解 IPC（图片数组 + 问题 → vision 模型分析，流式输出）
ipcMain.handle('chat:vision', async (event, images, question) => {
  if (!VISION_API_KEY || !VISION_MODEL) {
    return { reply: '喵…还没配置 Vision 模型呢！' };
  }
  // 兼容旧接口：单个 base64 字符串 → 转成数组
  const imgArr = Array.isArray(images) ? images : (images ? [images] : []);
  if (!imgArr.length) return { reply: '喵…没有图片可分析呢！' };
  const q = question || '请描述这些图片的内容，用中文回答。';
  console.log(`[pet:vision] 图片理解请求，${imgArr.length} 张图片，问题: "${q}"`);
  const sender = event.sender;
  let fullPartial = ''; // 全局 partial 内容，中止时可访问

  try {
    // 第一步：vision 模型识别图片内容（非流式，带人设 system prompt）
    currentAbortController = new AbortController();
    const visionSystemPrompt = getPetSystemPrompt() + '\n\n你现在正在看图片，请用中文描述图片内容，描述要详细准确。如果有多张图片，请分别描述每张图片的内容。';
    const userContent = [
      { type: 'text', text: q },
      ...imgArr.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }))
    ];
    const res = await fetch(`${VISION_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VISION_API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: visionSystemPrompt },
          { role: 'user', content: userContent }],
        max_tokens: 4000,
        temperature: 0.3,
      }),
      signal: currentAbortController.signal,
    });
    if (!res.ok) {
      currentAbortController = null;
      const errData = await res.json().catch(() => ({}));
      console.warn(`[pet:vision] HTTP ${res.status}: ${JSON.stringify(errData).slice(0, 200)}`);
      return { reply: `喵…图片理解失败了（HTTP ${res.status}）` };
    }
    const data = await res.json();
    currentAbortController = null;
    const visionReply = data.choices?.[0]?.message?.content || '';
    console.log(`[pet:vision] 图片理解成功，回复长度: ${visionReply.length}`);

    // 第二步：检查是否匹配 skill 或 generate_doc
    const skillsSummary = getSkillsSummary();
    if (skillsSummary) {
      // 用清洗后的问题做意图检测（不含文件内容）
      const cleanQ4Intent = q.split('\n\n【以下是用户提供的文件内容')[0].trim();
      const visionIntent = await detectIntentByLLM(cleanQ4Intent);

      // —— 视觉 + 生成文档：两步走（先内容技能，再排版技能）——
      if (visionIntent && visionIntent.intent === 'generate_doc') {
        const docType = visionIntent.docType || 'word';
        console.log(`[pet:vision] 图片+生成文档: ${docType}，开始两步走`);
        const skills = loadAllSkills();
        // 用清洗后的用户问题匹配技能（不含文件内容）
        const cleanQ = q.split('\n\n【以下是用户提供的文件内容')[0].trim();

        // 第1步：在非内置排版技能中找内容技能
        const contentSkills = skills.filter(s => !BUILTIN_DOC_SKILLS[s.name]);
        let contentSkill = null;
        for (const s of contentSkills) {
          const skillText = (s.name + ' ' + (s.description || '')).toLowerCase();
          const coreWords = s.name.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 1);
          if (coreWords.some(w => cleanQ.toLowerCase().includes(w)) ||
              (s.description && s.description.split(/[\s,，。、]+/).filter(w => w.length > 2).some(w => cleanQ.includes(w)))) {
            contentSkill = s; break;
          }
        }

        // 第2步：找排版技能
        const formatKeywords = {
          word: ['word', '文档', '公文', '排版', '报告'],
          excel: ['excel', '表格', '电子表格', '数据表'],
          ppt: ['ppt', '演示', '幻灯片', '汇报']
        };
        const kws = formatKeywords[docType] || formatKeywords.word;
        let formatSkill = null;
        for (const s of skills) {
          const text = (s.name + ' ' + (s.description || '')).toLowerCase();
          if (kws.some(kw => text.includes(kw.toLowerCase()))) {
            if (!BUILTIN_DOC_SKILLS[s.name]) { formatSkill = s; break; }
            if (!formatSkill) formatSkill = s;
          }
        }
        if (!formatSkill) {
          const builtinNames = { word: 'Word排版助手', excel: 'Excel美化工具', ppt: 'PPT美化技能' };
          formatSkill = skills.find(s => s.name === builtinNames[docType]) || skills.find(s => s.name === builtinNames.word);
        }

        // 两步走
        let userMsgForFormat = `以下是图片识别出的内容：\n\n${visionReply}\n\n用户的要求：${q}`;
        if (contentSkill) {
          console.log(`[pet:vision] 第1步-内容技能: ${contentSkill.name}`);
          const generatedContent = await llmGenerateContent(q + '\n\n【图片内容】' + visionReply, contentSkill.prompt);
          if (!generatedContent) {
            // 内容生成被停止或失败 → 不继续第2步
            console.log(`[pet:vision] 第1步内容生成被停止/失败，终止两步走`);
            currentAbortController = null;
            return { reply: '', streamed: true, stopped: true };
          }
          userMsgForFormat = `【内容已由"${contentSkill.name}"生成】以下是生成的内容，请严格按照排版规范，将其转为${docType.toUpperCase()}格式。请先说一句简短的话（如"好的，${docType.toUpperCase()}已生成～"），然后用\`\`\`${docType}代码块输出：\n\n${generatedContent}`;
          try { sender.send('chat:skill', { name: `✏️ ${contentSkill.name} → 🎨 ${formatSkill?.name || docType}`, description: '先写内容，再排版' }); } catch (e) {}
        } else {
          try { sender.send('chat:skill', { name: formatSkill?.name || docType + '排版', description: '直接排版' }); } catch (e) {}
        }

        if (formatSkill && formatSkill.prompt) {
          console.log(`[pet:vision] 第2步-排版技能: ${formatSkill.name}`);
          let sysContent = getPetSystemPrompt() + '\n\n【技能指令】你现在要严格按照以下技能指令行事：\n\n' + formatSkill.prompt;
          currentAbortController = new AbortController();
          const skillRes = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
            body: JSON.stringify({
              model: ARK_MODEL,
              messages: [
                { role: 'system', content: sysContent },
                ...chatHistory,
                { role: 'user', content: userMsgForFormat }
              ],
              max_tokens: 8192,
              temperature: 0.9,
              stream: true,
              thinking: { type: 'disabled' },
              signal: currentAbortController ? currentAbortController.signal : undefined,
            }),
          });
          if (skillRes.ok) {
            const reader = skillRes.body.getReader();
            const decoder = new TextDecoder();
            let full = '', buffer = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                const t = line.trim();
                if (!t || !t.startsWith('data:')) continue;
                const d = t.slice(5).trim();
                if (d === '[DONE]') continue;
                try {
                  const json = JSON.parse(d);
                  const delta = json.choices?.[0]?.delta?.content;
                  if (delta) { full += delta; fullPartial += delta; try { sender.send('chat:chunk', delta); } catch (e) {} }
                } catch (e) {}
              }
            }
            if (full.trim()) {
              currentAbortController = null;
              console.log(`[pet:vision] 两步走完成，流式回复长度: ${full.length}`);
              chatHistory.push({ role: 'user', content: `[图片] ${cleanQ}` });
              chatHistory.push({ role: 'assistant', content: full.trim() });
              while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
              maybeCompactHistory().catch(() => {});
              return { reply: full, streamed: true };
            }
            currentAbortController = null;
          }
        }
      }

      if (visionIntent && visionIntent.intent === 'skill' && visionIntent.skill) {
        const skills = loadAllSkills();
        const skillName = visionIntent.skill;
        // 精确 + 模糊匹配
        let skill = skills.find(s => s.name === skillName);
        if (!skill) {
          const lower = skillName.toLowerCase();
          skill = skills.find(s => s.name.toLowerCase() === lower)
            || skills.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()));
        }
        if (skill && skill.prompt) {
          console.log(`[pet:vision] 图片匹配到技能 "${skill.name}"，用 skill 提示词流式处理`);
          try { sender.send('chat:skill', { name: skill.name, description: skill.description }); } catch (e) {}
          currentAbortController = new AbortController();
          // 用主 LLM + skill 提示词 + vision 描述，带 chatHistory 流式输出
          const skillRes = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
            body: JSON.stringify({
              model: ARK_MODEL,
              messages: [
                { role: 'system', content: getPetSystemPrompt() + '\n\n【技能指令】你现在要严格按照以下技能指令行事，这是你的核心任务指导：\n\n' + skill.prompt },
                ...chatHistory,
                { role: 'user', content: `以下是图片识别出的内容：\n\n${visionReply}\n\n用户的要求：${q}` }
              ],
              max_tokens: 4096,
              temperature: 0.7,
              stream: true,
              signal: currentAbortController.signal,
            }),
          });
          if (skillRes.ok) {
            const reader = skillRes.body.getReader();
            const decoder = new TextDecoder();
            let full = '', buffer = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                const t = line.trim();
                if (!t || !t.startsWith('data:')) continue;
                const d = t.slice(5).trim();
                if (d === '[DONE]') continue;
                try {
                  const json = JSON.parse(d);
                  const delta = json.choices?.[0]?.delta?.content;
                  if (delta) { full += delta; fullPartial += delta; try { sender.send('chat:chunk', delta); } catch (e) {} }
                } catch (e) {}
              }
            }
            if (full.trim()) {
              currentAbortController = null;
              console.log(`[pet:vision] 技能处理完成，流式回复长度: ${full.length}`);
              // 存入对话历史（只存简短问题，不存文件内容）
              const shortQ = q.split('\n\n【以下是用户提供的文件内容')[0].trim();
              chatHistory.push({ role: 'user', content: `[图片] ${shortQ}` });
              chatHistory.push({ role: 'assistant', content: full.trim() });
              while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
              maybeCompactHistory().catch(() => {});
              return { reply: full, streamed: true };
            }
            currentAbortController = null;
          }
        }
      }
    }

    // 第三步：不匹配 skill → 用主 LLM 带上下文流式回复
    // 把 vision 识别结果 + 用户问题作为 user 消息，走主 LLM（带 chatHistory + system prompt）
    const cleanQ3 = q.split('\n\n【以下是用户提供的文件内容')[0].trim();
    const userMsg = `【图片内容】${visionReply}\n\n【我的问题】${q}`;
    chatHistory.push({ role: 'user', content: `[图片] ${cleanQ3}` });

    let systemContent = getPetSystemPrompt();
    if (conversationSummary) {
      systemContent += '\n\n【之前对话的摘要记忆】以下是之前对话的要点摘要，请自然地记住这些内容：\n' + conversationSummary;
    }
    if (memory.facts && memory.facts.length) {
      const factList = memory.facts.map((f) => `- ${f.text}`).join('\n');
      systemContent += '\n\n【关于主人的记忆】你记得主人的以下信息：\n' + factList;
    }
    systemContent += '\n\n主人刚发了一张图片，vision 模型已经识别出图片内容。请根据图片内容回答主人的问题，保持你的猫猫人设。';

    const messages = [
      { role: 'system', content: systemContent },
      ...chatHistory,
      { role: 'user', content: userMsg },
    ];

    currentAbortController = new AbortController();
    const llmRes = await fetchWithRetry(`${ARK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
      body: JSON.stringify({
        model: ARK_MODEL,
        messages,
        max_tokens: 8192,
        temperature: 0.9,
        stream: true,
        thinking: { type: 'disabled' },
      }),
      signal: currentAbortController.signal,
    });

    if (!llmRes.ok) {
      // LLM 失败时 fallback 直接返回 vision 识别结果
      currentAbortController = null;
      try { sender.send('chat:chunk', visionReply); } catch (e) {}
      chatHistory.push({ role: 'assistant', content: visionReply });
      while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      return { reply: visionReply, streamed: true };
    }

    const reader = llmRes.body.getReader();
    const decoder = new TextDecoder();
    let full = '', llmBuffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      llmBuffer += decoder.decode(value, { stream: true });
      const lines = llmBuffer.split('\n');
      llmBuffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (d === '[DONE]') continue;
        try {
          const json = JSON.parse(d);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { full += delta; fullPartial += delta; try { sender.send('chat:chunk', delta); } catch (e) {} }
        } catch (e) {}
      }
    }

    const reply = full.trim() || visionReply;
    currentAbortController = null;
    // 存入对话历史，让后续对话有记忆
    chatHistory.push({ role: 'assistant', content: reply });
    while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
    maybeCompactHistory().catch(() => {});
    console.log(`[pet:vision] 主 LLM 回复完成，长度: ${reply.length}`);
    return { reply, streamed: true };
  } catch (e) {
    currentAbortController = null;
    if (e.name === 'AbortError') {
      console.log('[pet:vision] 用户手动停止生成');
      // 保存 partial 内容到 chatHistory（补上 assistant 消息，避免未配对）
      const partial = fullPartial.trim();
      if (partial) {
        chatHistory.push({ role: 'assistant', content: partial });
        while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
        return { reply: partial, streamed: true, stopped: true };
      }
      return { reply: '', streamed: true, stopped: true };
    }
    console.warn('[pet:vision] 图片理解异常:', e.message);
    return { reply: `喵…图片理解出错了：${e.message}` };
  }
});

// ============ Skills 技能系统 ============
// Skills 存储目录：userData/skills/<skill-name>/SKILL.md
const skillsDir = path.join(app.getPath('userData'), 'skills');
function ensureSkillsDir() {
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
}

// 内置排版技能（纯提示词，随应用自动安装）
const BUILTIN_DOC_SKILLS = {
  'Word排版助手': `---
name: Word排版助手
description: 生成排版精美的 Word 文档，自动设置字体、行距、页边距等格式规范，用word代码块输出
---

# Word 排版助手

当主人要求生成 Word 文档时，你负责把内容排版成专业的 Word 文档格式。

## 输出方式（最重要）

用 \`\`\`word 代码块输出 HTML 格式的内容，系统会自动包装成 .doc 文件，Word 可直接打开。

## 排版规范

### 字体与字号
- 正文：宋体，12pt（小四）
- 一级标题：黑体，18pt（二号），居中
- 二级标题：黑体，15pt（三号）
- 三级标题：黑体，13pt（四号）

### 段落
- 正文首行缩进 2 字符
- 行距 1.5 倍
- 段前段后各 0.5 行

### 表格
- 正式网格线，表头居中加粗
- 单元格内边距 5pt 8pt

## HTML 标签使用

用标准 HTML 标签写内容：
- <h1> 主标题
- <h2> 一级标题
- <h3> 二级标题
- <p> 正文段落
- <table><tr><th><td> 表格
- <ul><li> 无序列表
- <ol><li> 有序列表
- <strong> 加粗

## 注意

- 先说开场白（如"好的，Word文档已生成～"），再输出 \`\`\`word 代码块，最后说收尾话（如"需要调整的话跟我说～"）
- 主人提修改意见时，先说"你说的对，我这就改～"，再输出修改后的文档
- 不要用 \`\`\`html
- 不要提到 Python 脚本或任何外部工具
- 直接输出 HTML 内容即可，系统会自动处理格式`,

  'Excel美化工具': `---
name: Excel美化工具
description: 生成美观的 Excel 表格，自动设置表头、边框、斑马线等格式，用excel代码块输出
---

# Excel 美化工具

当主人要求生成 Excel 表格时，你负责把数据排版成美观的表格。

## 输出方式（最重要）

用 \`\`\`excel 代码块输出 HTML 表格内容，系统会自动包装成 .xls 文件，Excel 可直接打开。

## 排版规范

### 表头
- 背景色 #4472C4（蓝色）
- 白色加粗字体，居中对齐

### 数据行
- 隔行变色（斑马线效果）
- 偶数行背景 #D9E1F2（浅蓝）
- 数字右对齐，文本左对齐

### 边框
- 所有单元格 1px 黑色边框
- 表头底部加粗边框

## HTML 使用

只用 table、tr、th、td 标签：
- <th> 表头单元格
- <td> 数据单元格
- 用 style 属性设置内联样式

## 注意

- 先说开场白（如"好的，表格已生成～"），再输出 \`\`\`excel 代码块，最后说收尾话
- 主人提修改意见时，先说"你说的对，我这就改～"，再输出修改后的表格
- 不要用 \`\`\`html
- 不要提到 Python 脚本
- 直接输出 HTML 表格即可`,

  'PPT美化技能': `---
name: PPT美化技能
description: 生成精美的 PPT 演示文稿，自动设置标题、正文、配色等格式，用ppt代码块输出
---

# PPT 美化技能

当主人要求生成 PPT 演示文稿时，你负责把内容排版成专业的幻灯片。

## 输出方式（最重要）

用 \`\`\`ppt 代码块输出 HTML 格式的内容，系统会自动包装成 .ppt 文件。

## 排版规范

### 幻灯片结构
- 每页用 <div class="slide"> 包裹
- 标题页：<h1> 大标题居中
- 内容页：<h2> 标题 + <ul>/<ol> 列表
- 结尾页：感谢/总结

### 字体与配色
- 标题：32pt，深蓝色 #1F4E79
- 副标题：24pt，深蓝色
- 正文：18pt，深灰 #333333
- 强调色：橙色 #E8590C

### 布局规则
- 每页内容不超过 6 行
- 标题在顶部
- 列表用圆点或数字

## 示例

<div class="slide">
  <h1>报告标题</h1>
</div>
<div class="slide">
  <h2>第一章 概述</h2>
  <ul>
    <li>要点一</li>
    <li>要点二</li>
  </ul>
</div>

## 注意

- 先说开场白（如"好的，演示文稿已生成～"），再输出 \`\`\`ppt 代码块，最后说收尾话
- 主人提修改意见时，先说"你说的对，我这就改～"，再输出修改后的PPT
- 不要用 \`\`\`html
- 不要提到 Python 脚本
- 每页用 <div class="slide"> 包裹`,

  'Python编程高手': `---
name: Python编程高手
description: 编写高质量 Python 代码解决复杂任务（数据处理、爬虫、自动化、文件操作、图表生成等），配合 run_code 工具自主执行和调试。遵循 PEP 8 风格、先探索再处理、逐步迭代。
---

# Python 编程高手技能

当主人需要用代码解决复杂任务时（数据处理、爬虫抓取、文件批量操作、图表生成、数据分析、自动化脚本等），你是一个 Python 编程专家，通过 run_code 工具自主编写、执行、调试代码。

## 核心工作流（最重要）

遵循"探索 → 处理 → 验证"三步法，逐步迭代，不要试图一步到位：

1. **先探索**：读取文件/数据后，先 print 数据概况（shape、columns、dtypes、前几行），了解数据结构再动手。
2. **再处理**：基于探索结果写处理逻辑，每一步都用 print 输出中间结果验证。
3. **后验证**：处理完成后，print 最终结果摘要（行数、关键字段、统计信息），让主人看到效果。

**关键原则：绝不臆断数据。** 不要假设列名、数据类型、文件格式——先 print 出来看，再决定怎么处理。

## 编码规范（遵循 PEP 8）

### 导入
- 所有 import 写在文件顶部，按标准库 → 第三方 → 本地分组
- 禁止 \`from x import *\`（通配符导入），明确写出每个导入的名称
- 只导入用到的库，不要导入多余的

### 命名
- 变量/函数：snake_case（如 \`user_count\`、\`parse_html\`）
- 常量：UPPER_SNAKE_CASE（如 \`MAX_RETRY\`）
- 类名：PascalCase（如 \`DataProcessor\`）
- 名称要有意义，禁止单字母变量（循环计数器 i/j 除外）

### 错误处理（参考 AI Code Review Rubric）
- 捕获具体异常，禁止裸 \`except:\` 或 \`except Exception:\`
  - ✅ \`except FileNotFoundError:\`
  - ✅ \`except (requests.Timeout, requests.ConnectionError):\`
  - ❌ \`except:\` / \`except Exception:\`
- except 块中禁止 \`pass\`（静默失败），要打印错误信息或 re-raise
- 网络请求必须设置 timeout
- 错误要么有意义地处理，要么向上传播，不要"记日志然后继续"

### 代码质量
- 函数加类型注解和 docstring（遵循 PEP 257）
- 用 \`with open(...)\` 管理文件，确保正确关闭
- 字符串格式化优先用 f-string
- 不留注释掉的代码和调试用的 print（最终结果输出除外）

## 场景指南

### 数据处理（pandas）
\`\`\`python
import pandas as pd
# 先探索
df = pd.read_excel(path)
print(f"形状: {df.shape}")
print(f"列名: {list(df.columns)}")
print(df.dtypes)
print(df.head())
# 基于探索结果再处理
result = df.groupby('部门')['工资'].mean().sort_values(ascending=False)
print(result)
\`\`\`

### 爬虫（requests + BeautifulSoup）
\`\`\`python
import requests, time
from bs4 import BeautifulSoup
headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
try:
    resp = requests.get(url, headers=headers, timeout=15)
    resp.encoding = resp.apparent_encoding
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = soup.select('.item-title')
    print(f"抓取到 {len(items)} 条")
except requests.Timeout:
    print("请求超时，请检查网络")
except requests.RequestException as e:
    print(f"请求失败: {e}")
time.sleep(0.5)  # 请求间隔
\`\`\`

### 中文图表（matplotlib）
\`\`\`python
import matplotlib.pyplot as plt
import os
# 中文必须设置字体，否则方块乱码
plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei']
plt.rcParams['axes.unicode_minus'] = False
fig, ax = plt.subplots(figsize=(10, 6))
ax.bar(names, values)
ax.set_title('标题')
plt.savefig(os.path.join(workDir, 'chart.png'), dpi=150, bbox_inches='tight')
print(f"图表已保存: {os.path.join(workDir, 'chart.png')}")
\`\`\`

### 文件批量操作
\`\`\`python
import os, glob
files = glob.glob(os.path.join(folder, '*.xlsx'))
print(f"找到 {len(files)} 个文件")
for f in files:
    print(f"处理: {os.path.basename(f)}")
    # 逐个处理...
\`\`\`

## 与 run_code 配合

1. **先说思路**（一句话）：如"我先读取 Excel 看看数据结构，然后按部门统计平均工资"
2. **调用 run_code** 执行代码
3. **看返回结果**：
   - 成功 → print 的输出会返回给你，基于结果继续下一步或总结
   - 报错 → 仔细看 traceback，定位问题，修改代码重新调用 run_code
   - 缺包 → 系统自动 pip 安装，等结果即可
4. **迭代**：复杂任务可能需要多轮 run_code（探索→处理→验证→出图），每轮基于上轮结果
5. **总结**：最终用主人能听懂的话总结结果，有文件则告知路径

## 禁止事项

- ❌ 跟主人说"你可以自己运行这段代码"——必须通过 run_code 自己运行
- ❌ 裸 except / except Exception 吞掉错误
- ❌ from x import * 通配符导入
- ❌ 假设列名/数据类型而不先探索
- ❌ 单次 run_code 写超长代码（30秒超时），大数据量分批处理
- ❌ 生成文件不 print 路径
- ❌ 留注释掉的代码和调试 print

## 环境

- Python 3.11，预装库：requests, beautifulsoup4, openpyxl, pandas, numpy, matplotlib, Pillow, python-docx, python-pptx
- 缺包自动 pip 安装
- 工作目录路径在 run_code 返回结果末尾给出，用 os.path.join(workDir, filename) 拼路径
- 生成的文件用 print() 输出完整路径`
};

// 应用启动时检查并安装/更新内置排版技能
function ensureBuiltinSkills() {
  ensureSkillsDir();
  for (const [skillName, content] of Object.entries(BUILTIN_DOC_SKILLS)) {
    const skillDir = path.join(skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      // 始终覆盖，确保内置技能保持最新
      fs.writeFileSync(skillFile, content, 'utf8');
      console.log(`[pet:skill] 内置技能已更新: ${skillName}`);
    } catch (e) {
      console.warn(`[pet:skill] 更新内置技能失败 ${skillName}: ${e.message}`);
    }
  }
}

// ============ 技能商店：远程检索 + 下载 ============
// 技能商店索引格式：[{ name, description, tags, url }]，url 指向 SKILL.md 原始内容
// 默认技能商店地址（可在设置中修改）
const SKILL_STORE_DEFAULT_URL = 'https://raw.githubusercontent.com/duansihang/xiaoju-skills/main/index.json';
let skillStoreUrl = SKILL_STORE_DEFAULT_URL;

function loadSkillStoreUrl() {
  try {
    const cfgFile = path.join(app.getPath('userData'), 'skill-store-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg.url) skillStoreUrl = cfg.url;
  } catch (e) {}
}

// 获取远程技能商店索引
async function fetchSkillStoreIndex() {
  try {
    const res = await fetchWithRetry(skillStoreUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.warn(`[pet:skillstore] 获取索引失败 status=${res.status}`); return []; }
    const index = await res.json();
    if (!Array.isArray(index)) return [];
    console.log(`[pet:skillstore] 获取到 ${index.length} 个远程技能`);
    return index;
  } catch (e) {
    console.warn(`[pet:skillstore] 获取索引异常: ${e.message}`);
    return [];
  }
}

// 在远程技能商店中搜索匹配的技能
async function searchRemoteSkills(userMessage) {
  const index = await fetchSkillStoreIndex();
  if (!index.length) return [];
  // 本地已安装的技能名
  const localSkills = loadAllSkills();
  const localNames = new Set(localSkills.map(s => s.name.toLowerCase()));
  // 关键词匹配
  const msgLower = userMessage.toLowerCase();
  const scored = index
    .filter(s => !localNames.has((s.name || '').toLowerCase())) // 排除已安装的
    .map(s => {
      let score = 0;
      const name = (s.name || '').toLowerCase();
      const desc = (s.description || '').toLowerCase();
      const tags = (s.tags || []).map(t => t.toLowerCase());
      // 名称包含用户消息关键词
      if (msgLower.includes(name) || name.includes(msgLower)) score += 10;
      // 描述包含用户消息关键词
      for (const word of msgLower.split(/\s+/)) {
        if (word.length > 1) {
          if (desc.includes(word)) score += 3;
          if (tags.some(t => t.includes(word))) score += 2;
        }
      }
      return { ...s, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3); // 返回 Top 3
  return scored;
}

// 下载并安装远程技能
async function downloadAndInstallSkill(skill) {
  try {
    const res = await fetchWithRetry(skill.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { success: false, message: `下载失败 status=${res.status}` };
    const content = await res.text();
    const parsed = parseSkillMd(content);
    if (!parsed || !parsed.name) return { success: false, message: 'SKILL.md 格式无效' };
    // 写入本地 skills 目录
    const skillDir = path.join(skillsDir, parsed.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, content, 'utf8');
    console.log(`[pet:skillstore] 技能安装成功: ${parsed.name}`);
    return { success: true, skill: parsed };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// 解析 SKILL.md（YAML frontmatter + Markdown body）
function parseSkillMd(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const front = m[1];
  const body = m[2].trim();
  const meta = {};
  // 简单 YAML 解析（key: value 和 key: [a, b]）
  for (const line of front.split('\n')) {
    const mm = line.match(/^(\w+):\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1]; let val = mm[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      val = val.replace(/^['"]|['"]$/g, '');
    }
    meta[key] = val;
  }
  return { name: meta.name || 'unnamed', description: meta.description || '', version: meta.version || '1.0.0', author: meta.author || '', tags: Array.isArray(meta.tags) ? meta.tags : [], prompt: body };
}

// 加载所有已安装的 skills
function loadAllSkills() {
  ensureSkillsDir();
  const skills = [];
  try {
    const dirs = fs.readdirSync(skillsDir);
    for (const dir of dirs) {
      const skillFile = path.join(skillsDir, dir, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        try {
          const content = fs.readFileSync(skillFile, 'utf8');
          const parsed = parseSkillMd(content);
          if (parsed) skills.push({ ...parsed, dir });
        } catch (e) { console.warn(`[pet:skill] 读取 ${dir} 失败:`, e.message); }
      }
    }
  } catch (e) { console.warn('[pet:skill] 加载 skills 失败:', e.message); }
  return skills;
}

// 拼接 skills 列表（给意图路由器用）
function getSkillsSummary() {
  const skills = loadAllSkills();
  if (!skills.length) return '';
  return skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
}

// Skills IPC
ipcMain.handle('skills:list', () => {
  return loadAllSkills().map(s => ({ name: s.name, description: s.description, version: s.version, author: s.author, tags: s.tags, dir: s.dir }));
});

// 技能商店 IPC
ipcMain.handle('skillstore:getUrl', () => skillStoreUrl);
ipcMain.handle('skillstore:setUrl', (_event, url) => {
  skillStoreUrl = url || SKILL_STORE_DEFAULT_URL;
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'skill-store-config.json'), JSON.stringify({ url: skillStoreUrl }), 'utf8'); } catch (e) {}
  return { success: true, url: skillStoreUrl };
});
ipcMain.handle('skillstore:search', async (_event, query) => {
  return await searchRemoteSkills(query);
});
ipcMain.handle('skillstore:install', async (_event, skill) => {
  return await downloadAndInstallSkill(skill);
});
ipcMain.handle('skillstore:list', async () => {
  return await fetchSkillStoreIndex();
});

// ============ MCP 客户端：对接外部 MCP Server（SSE + Streamable HTTP）============
const MCP_CONFIG_FILE = path.join(app.getPath('userData'), 'mcp-config.json');
let mcpConfig = { servers: [] }; // [{ name, url, transport: 'sse'|'streamable', enabled }]
let mcpTools = []; // 动态发现的工具 [{ name, description, inputSchema, serverName }]

function loadMcpConfig() {
  try { mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf8')); }
  catch (e) { mcpConfig = { servers: [] }; }
}
function saveMcpConfig() {
  try { fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(mcpConfig, null, 2), 'utf8'); } catch (e) {}
}
// 加载已保存的 MCP 配置
loadMcpConfig();

// 导入 Claude Desktop 风格的 JSON（魔塔格式）
// 格式：{ "mcpServers": { "name": { "type": "streamable_http", "url": "https://..." } } }
function importClaudeMcpJson(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    const mcpServers = parsed.mcpServers || parsed.mcp_servers || parsed;
    let added = 0;
    let skipped = 0;
    for (const [name, cfg] of Object.entries(mcpServers)) {
      // stdio 类配置（command/args）没有 url，跳过
      if (!cfg.url && (cfg.command || cfg.args)) { skipped++; continue; }
      if (!cfg.url) { skipped++; continue; }
      // 规范化 type：sse → sse，其他都当 streamable
      const t = String(cfg.type || '').toLowerCase().replace(/[-_]/g, '');
      const transport = t === 'sse' ? 'sse' : 'streamable';
      // 收集 headers / bearerToken
      const headers = cfg.headers || {};
      if (cfg.bearerToken) headers['Authorization'] = `Bearer ${cfg.bearerToken}`;
      // 去重
      if (mcpConfig.servers.some(s => s.name === name)) continue;
      const serverEntry = { name, url: cfg.url, transport, enabled: true };
      if (Object.keys(headers).length) serverEntry.headers = headers;
      mcpConfig.servers.push(serverEntry);
      added++;
    }
    if (added > 0) saveMcpConfig();
    return { success: true, added, skipped };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// MCP JSON-RPC 请求 ID
let mcpRequestId = 0;
function nextMcpId() { return ++mcpRequestId; }

// Streamable HTTP 模式：POST 单请求单响应
// 每个 server 维护 session ID（Mcp-Session-Id header）
const mcpSessions = {}; // { serverUrl: { sessionId, headers } }

async function mcpStreamableCall(serverUrl, method, params = {}, isNotification = false) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: isNotification ? undefined : nextMcpId(), method, params });
  const sess = mcpSessions[serverUrl] || {};
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(sess.headers || {}) };
  // initialize 握手不能带 Mcp-Session-Id（协议规定），后续请求才带
  if (method !== 'initialize' && sess.sessionId) headers['Mcp-Session-Id'] = sess.sessionId;
  const res = await fetchWithRetry(serverUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(60000),
  });
  // 会话过期（404/401）→ 清掉缓存的 session，让下次重新 initialize
  if (res.status === 404 || res.status === 401) {
    delete mcpSessions[serverUrl];
    throw new Error(`MCP HTTP ${res.status}: session expired`);
  }
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  // 提取并缓存 session ID
  const sessionId = res.headers.get('mcp-session-id');
  if (sessionId) {
    if (!mcpSessions[serverUrl]) mcpSessions[serverUrl] = {};
    mcpSessions[serverUrl].sessionId = sessionId;
    console.log(`[pet:mcp] Session ID: ${sessionId}`);
  }
  // 通知不需要响应
  if (isNotification) return { result: {} };
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    // SSE 响应流：解析事件
    const text = await res.text();
    return parseSseResponse(text);
  }
  return await res.json();
}

// SSE 模式：保持长连接，POST 请求发到 endpoint，响应通过 SSE 流返回
// 每个 SSE server 维护一个活跃的 session
const sseSessions = {}; // { serverUrl: { endpoint, reader, pendingResponses: Map<id, resolve>, buffer } }

async function ensureSseSession(serverUrl) {
  // 如果已有 session 且已初始化，直接返回
  if (sseSessions[serverUrl] && sseSessions[serverUrl].initialized) return sseSessions[serverUrl];
  // 清理可能残留的半成品 session
  if (sseSessions[serverUrl]) { cleanupSseSession(serverUrl); }

  console.log(`[pet:mcp] SSE: 建立 ${serverUrl} 长连接...`);
  const ac = new AbortController();
  const res = await fetch(serverUrl, {
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' },
    signal: ac.signal, // 不设超时，手动控制生命周期
  }).catch(e => { throw new Error(`SSE GET 失败: ${e.message}`); });
  if (!res.ok) { ac.abort(); throw new Error(`SSE GET ${res.status}`); }

  const session = { endpoint: null, pendingResponses: new Map(), buffer: '', abort: ac, initialized: false };
  sseSessions[serverUrl] = session;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  session.reader = reader;

  // 后台读取 SSE 流（持续运行直到连接断开）
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // 统一换行：\r\n → \n，兼容 Python sse-starlette 等
        session.buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        // SSE 事件以空行分隔
        const events = session.buffer.split('\n\n');
        session.buffer = events.pop(); // 保留不完整的事件

        for (const evtBlock of events) {
          const lines = evtBlock.split('\n');
          let evtType = 'message';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event:')) {
              evtType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr = (dataStr ? dataStr + '\n' : '') + line.slice(5).trim();
            }
          }
          // endpoint 事件
          if (evtType === 'endpoint' && !session.endpoint) {
            session.endpoint = dataStr;
            console.log(`[pet:mcp] SSE: 获取到 endpoint: ${session.endpoint}`);
            continue;
          }
          // JSON-RPC 响应
          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);
              if (data.id !== undefined && session.pendingResponses.has(data.id)) {
                const resolve = session.pendingResponses.get(data.id);
                session.pendingResponses.delete(data.id);
                resolve(data);
              }
            } catch (e) { /* 非 JSON，忽略 */ }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn(`[pet:mcp] SSE 读取异常: ${e.message}`);
    }
    cleanupSseSession(serverUrl);
  })();

  // 等待 endpoint（最多 15 秒）
  for (let i = 0; i < 150 && !session.endpoint; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!session.endpoint) { cleanupSseSession(serverUrl); throw new Error('SSE: 等待 endpoint 超时'); }
  return session;
}

// 清理 SSE session（中断连接、删除缓存）
function cleanupSseSession(serverUrl) {
  const session = sseSessions[serverUrl];
  if (!session) return;
  try { session.abort?.abort(); } catch (e) {}
  try { session.reader?.cancel(); } catch (e) {}
  // 拒绝所有 pending responses
  for (const [, resolve] of session.pendingResponses) {
    try { resolve({ error: { message: 'SSE session closed' } }); } catch (e) {}
  }
  session.pendingResponses.clear();
  delete sseSessions[serverUrl];
}

async function mcpSseCall(serverUrl, method, params = {}) {
  const session = await ensureSseSession(serverUrl);
  // 新会话必须先 initialize（除非已经初始化过）
  if (!session.initialized && method !== 'initialize') {
    const initResult = await mcpSseCall(serverUrl, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'xiaoju-pet', version: '2.1.0' },
    });
    if (initResult.error) throw new Error(`SSE initialize 失败: ${JSON.stringify(initResult.error)}`);
    // 发送 initialized 通知
    try {
      const postUrl = session.endpoint.startsWith('http') ? session.endpoint : new URL(session.endpoint, serverUrl).href;
      await fetchWithRetry(postUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {}
    session.initialized = true;
    // 如果要调的就是 initialize，直接返回结果
    if (method === 'initialize') return initResult;
  }
  const id = nextMcpId();
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const postUrl = session.endpoint.startsWith('http') ? session.endpoint : new URL(session.endpoint, serverUrl).href;

  // 设置 promise 等待响应
  const responsePromise = new Promise((resolve) => {
    session.pendingResponses.set(id, resolve);
  });

  // POST 请求
  const res = await fetchWithRetry(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    session.pendingResponses.delete(id);
    throw new Error(`SSE POST ${res.status}`);
  }

  // 等待 SSE 流返回响应（最多 60 秒）
  const result = await Promise.race([
    responsePromise,
    new Promise((_, reject) => setTimeout(() => {
      session.pendingResponses.delete(id);
      reject(new Error('SSE 等待响应超时'));
    }, 60000)),
  ]);
  return result;
}

// 解析 SSE 文本响应中的 JSON-RPC 结果
function parseSseResponse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const jsonStr = line.slice(5).trim();
      try {
        const data = JSON.parse(jsonStr);
        if (data.result !== undefined || data.error !== undefined) return data;
      } catch (e) {}
    }
  }
  // 没匹配到 JSON-RPC 响应，抛错而非返回原始文本（避免后续 .result?.content 访问到 undefined）
  throw new Error(`SSE 响应解析失败: ${text.slice(0, 200)}`);
}

// 尝试 streamable HTTP 连接（initialize + tools/list），支持冷启动重试 + 协议版本自适应
async function tryStreamableConnect(url) {
  const clientInfo = { name: 'xiaoju-pet', version: '2.1.0' };
  let initResult = await mcpStreamableCallWithRetry(url, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo,
  });
  // 如果握手返回协议版本错误，用 server 支持的版本重试
  if (initResult.error && (initResult.error.message || '').includes('Unsupported protocol version')) {
    const supported = initResult.error.data?.supported || [];
    if (supported.length) {
      const newVersion = supported[supported.length - 1]; // 用最新支持版本
      console.log(`[pet:mcp] 协议版本不匹配，切换到 ${newVersion} 重试`);
      initResult = await mcpStreamableCallWithRetry(url, 'initialize', {
        protocolVersion: newVersion, capabilities: {}, clientInfo,
      });
    }
  }
  if (initResult.error) throw new Error(`initialize 失败: ${JSON.stringify(initResult.error)}`);
  try { await mcpStreamableCall(url, 'notifications/initialized', {}, true); } catch (e) {}
  const toolsResult = await mcpStreamableCall(url, 'tools/list', {});
  return toolsResult.result?.tools || [];
}

// 带冷启动重试的 streamable 调用（魔搭 serverless 函数首次访问需要触发启动）
async function mcpStreamableCallWithRetry(serverUrl, method, params = {}, maxRetries = 3) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await mcpStreamableCall(serverUrl, method, params);
    } catch (e) {
      const msg = e.message || '';
      // 遇到 FunctionNotStarted / 502 / 503 / 504 / timeout 等冷启动错误，等待后重试
      const isColdStart = msg.includes('FunctionNotStarted') || /\b(50[234])\b/.test(msg) || msg.includes('timeout');
      if (i < maxRetries && isColdStart) {
        console.log(`[pet:mcp] 冷启动中，15s 后重试 (${i + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      throw e;
    }
  }
}

// 尝试 SSE 连接（带冷启动重试）
async function trySseConnect(url) {
  let lastErr;
  for (let i = 0; i <= 2; i++) {
    try {
      // mcpSseCall 内部会自动 initialize + notifications/initialized
      const toolsResult = await mcpSseCall(url, 'tools/list', {});
      return toolsResult.result?.tools || [];
    } catch (e) {
      lastErr = e;
      const msg = e.message || '';
      // 冷启动 / 超时 / 502/503/504 重试
      const isColdStart = msg.includes('timeout') || msg.includes('FunctionNotStarted')
        || /\b(50[234])\b/.test(msg) || msg.includes('endpoint 超时');
      if (i < 2 && isColdStart) {
        console.log(`[pet:mcp] SSE 冷启动中，15s 后重试 (${i + 1}/2)...`);
        cleanupSseSession(url);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
    }
  }
  cleanupSseSession(url);
  throw lastErr;
}

// 连接 MCP Server 并发现工具（自动 fallback 传输模式）
// 工具名清洗：只保留 [a-zA-Z0-9_-]，限制 64 字符
function sanitizeToolName(serverName, toolName) {
  let name = `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (name.length > 64) name = name.slice(0, 64);
  return name;
}

async function connectMcpServer(server) {
  // URL 校验：检测常见的格式错误
  const url = server.url;
  if (!url || !url.startsWith('http')) {
    console.warn(`[pet:mcp] ${server.name} URL 无效: "${url}"，请检查 MCP Server URL 是否正确`);
    return [];
  }
  // 检测双斜杠路径（如 https://xxx.net//mcp）— 说明 URL 缺少 hash ID
  // 注意：https://mcp.xxx 是正常的（域名部分），只检测路径中的双斜杠
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes('//')) {
      console.warn(`[pet:mcp] ${server.name} URL 格式错误（路径含双斜杠，可能缺少 hash ID）: "${url}"，正确格式应为 https://mcp.api-inference.modelscope.net/HASH_ID/mcp`);
      return [];
    }
  } catch (e) {
    console.warn(`[pet:mcp] ${server.name} URL 解析失败: "${url}"`);
    return [];
  }
  // 尝试顺序：1) 用户选的传输模式 2) 另一种 3) 把 /sse<->/mcp 替换后再试
  const altUrl = url.endsWith('/sse') ? url.slice(0, -4) + '/mcp'
    : url.endsWith('/mcp') ? url.slice(0, -4) + '/sse' : url;
  const primaryIsSse = server.transport === 'sse';
  const attempts = [
    { transport: primaryIsSse ? 'sse' : 'streamable', url, fn: primaryIsSse ? () => trySseConnect(url) : () => tryStreamableConnect(url) },
    { transport: primaryIsSse ? 'streamable' : 'sse', url, fn: primaryIsSse ? () => tryStreamableConnect(url) : () => trySseConnect(url) },
    { transport: primaryIsSse ? 'sse' : 'streamable', url: altUrl, fn: primaryIsSse ? () => trySseConnect(altUrl) : () => tryStreamableConnect(altUrl) },
    { transport: primaryIsSse ? 'streamable' : 'sse', url: altUrl, fn: primaryIsSse ? () => tryStreamableConnect(altUrl) : () => trySseConnect(altUrl) },
  ];

  for (const attempt of attempts) {
    try {
      // 每次尝试前清除 stale session，避免上一个尝试残留的 session ID 干扰
      delete mcpSessions[attempt.url];
      cleanupSseSession(attempt.url);
      // 预存 server 的 headers
      if (server.headers) mcpSessions[attempt.url] = { headers: server.headers };
      console.log(`[pet:mcp] 尝试 ${server.name}: ${attempt.transport} ${attempt.url}`);
      const tools = await attempt.fn();
      console.log(`[pet:mcp] ${server.name} 连接成功 (${attempt.transport} ${attempt.url})，发现 ${tools.length} 个工具: ${tools.map(t => t.name).join(', ')}`);
      // 成功的 transport 写回配置，下次直接用对的
      server.transport = attempt.transport;
      server.url = attempt.url;
      saveMcpConfig();
      // 工具名清洗 + 去重映射
      const nameMap = {}; // cleanedName → originalName
      return tools.map(t => {
        const cleanedName = sanitizeToolName(server.name, t.name);
        nameMap[cleanedName] = t.name;
        return {
          name: cleanedName,
          originalName: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          serverName: server.name,
          serverUrl: attempt.url,
          transport: attempt.transport,
        };
      });
    } catch (e) {
      console.warn(`[pet:mcp] 尝试失败 (${attempt.transport} ${attempt.url}): ${e.message}`);
    }
  }
  console.warn(`[pet:mcp] 连接 ${server.name} 失败：所有传输模式均不可用`);
  return [];
}

// 连接所有已启用的 MCP Server，收集工具（并行连接）
async function connectAllMcpServers() {
  mcpTools = [];
  const enabledServers = (mcpConfig.servers || []).filter(s => s.enabled);
  if (!enabledServers.length) { console.log('[pet:mcp] 没有已启用的 MCP Server'); return; }
  // 并行连接所有 server
  const results = await Promise.allSettled(enabledServers.map(server => connectMcpServer(server)));
  const seen = new Set(); // 去重：serverName + originalName
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const t of result.value) {
      const key = `${t.serverName}::${t.originalName}`;
      if (!seen.has(key)) {
        seen.add(key);
        mcpTools.push(t);
      }
    }
  }
  console.log(`[pet:mcp] 共发现 ${mcpTools.length} 个 MCP 工具（去重后）`);
}

// 调用 MCP 工具（带会话恢复 + 冷启动重试）
async function callMcpTool(tool, args) {
  const maxRetries = 2;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const result = tool.transport === 'sse'
        ? await mcpSseCall(tool.serverUrl, 'tools/call', { name: tool.originalName, arguments: args })
        : await mcpStreamableCall(tool.serverUrl, 'tools/call', { name: tool.originalName, arguments: args });
      if (result.error) return `MCP 工具调用失败: ${JSON.stringify(result.error)}`;
      const content = result.result?.content;
      if (Array.isArray(content)) {
        // 处理 isError 标记 + 截断过大的结果
        const texts = content.filter(c => c.type === 'text').map(c => c.text);
        const result_str = texts.join('\n');
        return result_str.length > 20000 ? result_str.slice(0, 20000) + '\n...(结果过长已截断)' : result_str;
      }
      const result_str = JSON.stringify(result.result);
      return result_str.length > 20000 ? result_str.slice(0, 20000) + '...(结果过长已截断)' : result_str;
    } catch (e) {
      const msg = e.message || '';
      // 会话过期 → 重新 initialize 后重试
      if (i < maxRetries && msg.includes('session expired')) {
        console.log(`[pet:mcp] 工具调用会话过期，重新握手后重试 (${i + 1}/${maxRetries})...`);
        if (tool.transport === 'sse') { cleanupSseSession(tool.serverUrl); }
        else { delete mcpSessions[tool.serverUrl]; }
        // 重新 initialize
        try {
          if (tool.transport === 'sse') {
            await mcpSseCall(tool.serverUrl, 'initialize', {
              protocolVersion: '2024-11-05', capabilities: {},
              clientInfo: { name: 'xiaoju-pet', version: '2.1.0' },
            });
          } else {
            await mcpStreamableCall(tool.serverUrl, 'initialize', {
              protocolVersion: '2024-11-05', capabilities: {},
              clientInfo: { name: 'xiaoju-pet', version: '2.1.0' },
            });
            try { await mcpStreamableCall(tool.serverUrl, 'notifications/initialized', {}, true); } catch (e2) {}
          }
        } catch (e2) { /* 忽略，继续重试 */ }
        continue;
      }
      // 冷启动 → 等待后重试
      if (i < maxRetries && (msg.includes('FunctionNotStarted') || /\b(50[234])\b/.test(msg) || msg.includes('timeout'))) {
        console.log(`[pet:mcp] 工具调用冷启动中，15s 后重试 (${i + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      return `MCP 工具调用异常: ${msg}`;
    }
  }
}

// 获取动态工具定义（MCP 工具转成 ARK API function calling 格式）
// 清理 inputSchema：递归移除 ARK API 不支持的字段（$schema/$ref/$defs/anyOf 等）
function sanitizeToolSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const clean = JSON.parse(JSON.stringify(schema));
  function deepClean(obj) {
    if (!obj || typeof obj !== 'object') return;
    delete obj['$schema']; delete obj['$ref']; delete obj['$defs'];
    // anyOf → 取第一个有 type 的分支
    if (Array.isArray(obj.anyOf)) {
      const typed = obj.anyOf.find(b => b && b.type) || obj.anyOf[0] || {};
      Object.keys(obj).forEach(k => delete obj[k]);
      Object.assign(obj, typed);
    }
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'object') deepClean(obj[k]);
    }
  }
  deepClean(clean);
  if (!clean.type) clean.type = 'object';
  return clean;
}

function getMcpToolDefinitions() {
  return mcpTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: `[MCP:${t.serverName}] ${t.description}`.slice(0, 1024),
      parameters: sanitizeToolSchema(t.inputSchema),
    },
  }));
}

// MCP IPC
ipcMain.handle('mcp:getConfig', () => mcpConfig);
ipcMain.handle('mcp:saveConfig', (_event, cfg) => {
  mcpConfig = cfg;
  saveMcpConfig();
  // 配置变更后重新连接
  connectAllMcpServers().catch(e => console.warn(`[pet:mcp] 重连失败: ${e.message}`));
  return { success: true };
});
ipcMain.handle('mcp:connect', async () => {
  await connectAllMcpServers();
  return { tools: mcpTools.map(t => ({ name: t.name, description: t.description, server: t.serverName })) };
});
ipcMain.handle('mcp:tools', () => {
  return mcpTools.map(t => ({ name: t.name, originalName: t.originalName, description: t.description, server: t.serverName }));
});
// 导入 Claude Desktop 风格 JSON（魔搭格式）
ipcMain.handle('mcp:importJson', (_event, jsonText) => {
  const result = importClaudeMcpJson(jsonText);
  if (result.success) {
    // 导入后自动连接
    connectAllMcpServers().catch(e => console.warn(`[pet:mcp] 导入后连接失败: ${e.message}`));
  }
  return result;
});

// 手动添加 skill（直接输入 SKILL.md 内容）
ipcMain.handle('skills:add', (_event, content) => {
  const parsed = parseSkillMd(content);
  if (!parsed || !parsed.name) return { success: false, error: 'SKILL.md 格式无效，缺少 name 字段' };
  ensureSkillsDir();
  const skillDir = path.join(skillsDir, parsed.name);
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  console.log(`[pet:skill] 添加技能: ${parsed.name}`);
  return { success: true, name: parsed.name };
});

// 删除 skill
ipcMain.handle('skills:delete', (_event, skillName) => {
  const skillDir = path.join(skillsDir, skillName);
  try { fs.rmSync(skillDir, { recursive: true, force: true }); console.log(`[pet:skill] 删除技能: ${skillName}`); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});

// 导入 ZIP skill 文件
ipcMain.handle('skills:importZip', async (_event, filePath) => {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    // 查找 zip 里的 SKILL.md 文件
    const entries = zip.getEntries();
    let skillEntry = entries.find(e => e.entryName.endsWith('SKILL.md'));
    if (!skillEntry) return { success: false, error: 'ZIP 中未找到 SKILL.md 文件' };
    const content = skillEntry.getData().toString('utf8');
    const parsed = parseSkillMd(content);
    if (!parsed || !parsed.name) return { success: false, error: 'SKILL.md 格式无效' };
    ensureSkillsDir();
    // 解压整个 zip 到 skills/<name>/
    const skillDir = path.join(skillsDir, parsed.name);
    if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
    fs.mkdirSync(skillDir, { recursive: true });
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      // 保持相对路径结构
      const relPath = entry.entryName.split('/').slice(-2).join('/'); // 取最后两级
      const targetPath = path.join(skillDir, entry.entryName.split('/').pop());
      fs.writeFileSync(targetPath, entry.getData());
    }
    console.log(`[pet:skill] 导入 ZIP 技能: ${parsed.name}`);
    return { success: true, name: parsed.name };
  } catch (e) {
    console.warn('[pet:skill] 导入 ZIP 失败:', e.message);
    return { success: false, error: e.message };
  }
});

// 从技能商店安装技能（skillhub.cn API）
ipcMain.handle('skills:fetchHub', async (_event, slug) => {
  try {
    // 先从搜索 API 获取 name 和 description（详情 API 里没有）
    const searchRes = await fetch(`https://api.skillhub.cn/api/skills?keyword=${encodeURIComponent(slug)}&pageSize=5&sortBy=score`);
    let name = slug, description = '';
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const found = (searchData.data?.skills || []).find(s => s.slug === slug);
      if (found) {
        name = found.name;
        description = found.description_zh || found.description || '';
      }
    }

    // 获取技能详情（summary 是技能的提示词内容）
    const res = await fetch(`https://api.skillhub.cn/api/v1/skills/${slug}`);
    if (!res.ok) return { success: false, error: `获取技能详情失败 (HTTP ${res.status})` };
    const data = await res.json();
    const skillDetail = data.skill || {};
    const summary = skillDetail.summary_zh || skillDetail.summary || '';

    // 构造 SKILL.md 内容
    let content = `---\nname: ${name}\ndescription: ${description}\nversion: ${skillDetail.version || data.latestVersion?.version || '1.0.0'}\nauthor: ${skillDetail.ownerName || data.owner?.name || ''}\n---\n\n`;
    if (summary) {
      content += `# ${name}\n\n${summary}`;
    } else {
      content += `# ${name}\n\n${description}\n\n请根据用户的需求，提供专业的服务。`;
    }

    const parsed = parseSkillMd(content);
    if (!parsed || !parsed.name) return { success: false, error: '技能数据格式无效' };
    ensureSkillsDir();
    const skillDir = path.join(skillsDir, parsed.name);
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
    console.log(`[pet:skill] 从技能商店安装: ${parsed.name}，提示词长度: ${summary.length}`);
    return { success: true, name: parsed.name, description: parsed.description };
  } catch (e) {
    console.warn('[pet:skill] 安装失败:', e.message);
    return { success: false, error: e.message };
  }
});

// 浏览技能商店（skillhub.cn API，国内可访问）
ipcMain.handle('skills:browseHub', async () => {
  try {
    const res = await fetch('https://api.skillhub.cn/api/skills?pageSize=30&sortBy=downloads');
    if (!res.ok) return [];
    const data = await res.json();
    const skills = (data.data?.skills || []).map(s => ({
      name: s.name,
      description: s.description_zh || s.description || '',
      slug: s.slug,
      downloads: s.downloads || 0,
      category: s.category || '',
    }));
    console.log(`[pet:skill] 从技能商店拉取到 ${skills.length} 个技能`);
    return skills;
  } catch (e) {
    console.warn('[pet:skill] 技能商店加载失败:', e.message);
    return [];
  }
});

// 搜索技能（skillhub.cn API，分词搜索）
ipcMain.handle('skills:searchHub', async (_event, keyword) => {
  try {
    const url = `https://api.skillhub.cn/api/skills?keyword=${encodeURIComponent(keyword)}&pageSize=30&sortBy=score`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const skills = (data.data?.skills || []).map(s => ({
      name: s.name,
      description: s.description_zh || s.description || '',
      slug: s.slug,
      downloads: s.downloads || 0,
      category: s.category || '',
    }));
    console.log(`[pet:skill] 搜索 "${keyword}" 返回 ${skills.length} 个技能`);
    return skills;
  } catch (e) {
    console.warn('[pet:skill] 技能搜索失败:', e.message);
    return [];
  }
});

// ============ 聊天记录持久化 ============
const chatHistoryFile = path.join(app.getPath('userData'), 'chat-history.json');
ipcMain.handle('chat:loadHistory', () => {
  try {
    if (!fs.existsSync(chatHistoryFile)) return [];
    return JSON.parse(fs.readFileSync(chatHistoryFile, 'utf8'));
  } catch (e) { return []; }
});
ipcMain.handle('chat:saveHistory', (_event, history) => {
  try { fs.writeFileSync(chatHistoryFile, JSON.stringify(history), 'utf8'); return { success: true }; }
  catch (e) { return { success: false }; }
});

// 手动停止当前对话生成
ipcMain.handle('chat:stop', () => {
  if (currentAbortController) {
    currentAbortController.abort();
    console.log('[pet:chat] 收到停止请求，正在中断生成...');
    // 修复#3：中止时也取消所有待处理的选择弹窗，避免 askChoice 挂起 Agent Loop
    for (const [id, resolveFn] of pendingChoiceMap) {
      resolveFn(null); // null = 取消
      pendingChoiceMap.delete(id);
    }
    return { success: true };
  }
  return { success: false };
});

// 删除指定索引的聊天记录
ipcMain.handle('chat:deleteRecord', (_event, index) => {
  try {
    const history = fs.existsSync(chatHistoryFile)
      ? JSON.parse(fs.readFileSync(chatHistoryFile, 'utf8'))
      : [];
    if (index >= 0 && index < history.length) {
      history.splice(index, 1);
      fs.writeFileSync(chatHistoryFile, JSON.stringify(history), 'utf8');
      console.log(`[pet:chat] 已删除第 ${index} 条聊天记录`);
      return { success: true, history };
    }
    return { success: false };
  } catch (e) { return { success: false, error: e.message }; }
});

// 注入一轮对话到内存上下文（如自我介绍），让 LLM 后续能引用
ipcMain.handle('chat:injectTurn', (_event, userText, petText) => {
  try {
    chatHistory.push({ role: 'user', content: userText || '' });
    chatHistory.push({ role: 'assistant', content: petText || '' });
    while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============ 通用选择弹窗（AI 不确定时给选项，等用户选了再继续）============
// P2 修复：用 Map 替代单例，支持多个并发选择请求（避免覆盖冲突）
const pendingChoiceMap = new Map(); // { id → resolveFn }
let choiceSeq = 0;
ipcMain.on('choice:result', (_event, payload) => {
  const id = payload && typeof payload === 'object' ? payload.id : payload;
  const index = payload && typeof payload === 'object' ? payload.index : payload;
  const customText = payload && typeof payload === 'object' ? payload.customText : null;
  const resolveFn = pendingChoiceMap.get(id);
  if (resolveFn) {
    pendingChoiceMap.delete(id);
    // index: >=0 = 选中选项, -2 = 自定义文本, -1/null = 取消
    if (index === -2 && customText) resolveFn({ custom: true, text: customText });
    else if (index >= 0) resolveFn({ index });
    else resolveFn(null);
  }
});
// 主进程调用：弹选项让用户选，返回 { index } / { custom: true, text } / null（取消）
// allowCustom: 是否允许用户输入自定义文本
async function askChoice(sender, title, msg, options, allowCustom = false) {
  const id = ++choiceSeq;
  try {
    sender.send('choice:show', { id, title, msg, options, allowCustom });
  } catch (e) { return null; }
  return new Promise((resolve) => { pendingChoiceMap.set(id, resolve); });
}

// 按内容删除聊天记录（文件 + 内存上下文，保留摘要和用户画像）
ipcMain.handle('chat:deleteByContent', (_event, role, text) => {
  try {
    // 从文件删（先精确匹配，再前缀匹配兼容图片/文件场景）
    if (fs.existsSync(chatHistoryFile)) {
      const history = JSON.parse(fs.readFileSync(chatHistoryFile, 'utf8'));
      let deleted = false;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === role && history[i].text === text) {
          history.splice(i, 1); deleted = true; break;
        }
      }
      if (!deleted) {
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === role && history[i].text.startsWith(text)) {
            history.splice(i, 1); break;
          }
        }
      }
      fs.writeFileSync(chatHistoryFile, JSON.stringify(history), 'utf8');
    }
    // 从内存 chatHistory 删（content 字段，pet=assistant）
    const memRole = role === 'pet' ? 'assistant' : 'user';
    let memDeleted = false;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i].role === memRole && chatHistory[i].content === text) {
        chatHistory.splice(i, 1); memDeleted = true; break;
      }
    }
    if (!memDeleted) {
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === memRole && chatHistory[i].content.startsWith(text)) {
          chatHistory.splice(i, 1); break;
        }
      }
    }
    console.log(`[pet:chat] 已删除一条消息（role=${role}），摘要和用户画像保留`);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// 清除全部聊天记录（聊天历史 + LLM 上下文记忆，保留用户画像 memory.facts）
ipcMain.handle('chat:clearHistory', () => {
  try {
    // 清空存储的聊天记录文件
    if (fs.existsSync(chatHistoryFile)) {
      fs.writeFileSync(chatHistoryFile, JSON.stringify([]), 'utf8');
    }
    // 清空内存中的 LLM 对话上下文（chatHistory 数组）
    chatHistory.length = 0;
    // 保留对话摘要（conversationSummary）—— 这是小橘跨对话的长期记忆，不能删
    console.log('[pet:chat] 已清除聊天记录（对话摘要和用户画像保留）');
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============ IMA 知识库 ============
const imaConfigFile = path.join(app.getPath('userData'), 'ima-config.json');
function loadImaConfig() {
  try { return JSON.parse(fs.readFileSync(imaConfigFile, 'utf8')); }
  catch (e) { return { clientId: '', apiKey: '', kbId: '' }; }
}
function saveImaConfig(cfg) {
  try { fs.writeFileSync(imaConfigFile, JSON.stringify(cfg), 'utf8'); return true; }
  catch (e) { return false; }
}

// ============ 邮箱配置 ============
const emailConfigFile = path.join(app.getPath('userData'), 'email-config.json');
function loadEmailConfig() {
  try { return JSON.parse(fs.readFileSync(emailConfigFile, 'utf8')); }
  catch (e) { return { smtpServer: '', smtpPort: 465, imapServer: '', imapPort: 993, email: '', password: '', name: '' }; }
}
function saveEmailConfig(cfg) {
  try { fs.writeFileSync(emailConfigFile, JSON.stringify(cfg), 'utf8'); return true; }
  catch (e) { return false; }
}

// 常见邮箱预设配置
const EMAIL_PRESETS = {
  'qq.com': { smtpServer: 'smtp.qq.com', smtpPort: 465, imapServer: 'imap.qq.com', imapPort: 993, name: 'QQ邮箱' },
  '163.com': { smtpServer: 'smtp.163.com', smtpPort: 465, imapServer: 'imap.163.com', imapPort: 993, name: '网易163邮箱' },
  '126.com': { smtpServer: 'smtp.126.com', smtpPort: 465, imapServer: 'imap.126.com', imapPort: 993, name: '网易126邮箱' },
  'gmail.com': { smtpServer: 'smtp.gmail.com', smtpPort: 465, imapServer: 'imap.gmail.com', imapPort: 993, name: 'Gmail' },
  'outlook.com': { smtpServer: 'smtp-mail.outlook.com', smtpPort: 587, imapServer: 'outlook.office365.com', imapPort: 993, name: 'Outlook' },
  'hotmail.com': { smtpServer: 'smtp-mail.outlook.com', smtpPort: 587, imapServer: 'outlook.office365.com', imapPort: 993, name: 'Hotmail' },
  'foxmail.com': { smtpServer: 'smtp.qq.com', smtpPort: 465, imapServer: 'imap.qq.com', imapPort: 993, name: 'Foxmail' },
  'sina.com': { smtpServer: 'smtp.sina.com', smtpPort: 465, imapServer: 'imap.sina.com', imapPort: 993, name: '新浪邮箱' },
  'sohu.com': { smtpServer: 'smtp.sohu.com', smtpPort: 465, imapServer: 'imap.sohu.com', imapPort: 993, name: '搜狐邮箱' },
  'aliyun.com': { smtpServer: 'smtp.qiye.aliyun.com', smtpPort: 465, imapServer: 'imap.qiye.aliyun.com', imapPort: 993, name: '阿里邮箱' },
};

function getEmailPreset(email) {
  if (!email) return null;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? EMAIL_PRESETS[domain] : null;
}

// 发送邮件（用 run_code 执行 Python smtplib）
async function sendEmail(to, subject, body, isHtml = false) {
  const cfg = loadEmailConfig();
  if (!cfg.email || !cfg.password) {
    return { success: false, message: '未配置邮箱，请先在设置中配置邮箱账号和授权码' };
  }
  const pyExe = getPythonExe();
  if (!pyExe) return { success: false, message: '未找到 Python 环境' };

  const code = `
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header

smtp_server = '${cfg.smtpServer}'
smtp_port = ${cfg.smtpPort}
sender = '${cfg.email}'
password = '${cfg.password}'
receiver = '${to}'
subject = '''${subject.replace(/'/g, "\\'")}'''
body = '''${body.replace(/'/g, "\\'")}'''

msg = MIMEMultipart('alternative')
msg['From'] = sender
msg['To'] = receiver
msg['Subject'] = Header(subject, 'utf-8')

content_type = 'html' if ${isHtml ? 'True' : 'False'} else 'plain'
msg.attach(MIMEText(body, content_type, 'utf-8'))

try:
    server = smtplib.SMTP_SSL(smtp_server, smtp_port, timeout=15)
    server.login(sender, password)
    server.sendmail(sender, receiver, msg.as_string())
    server.quit()
    print("邮件发送成功")
except Exception as e:
    print(f"邮件发送失败: {e}")
`;

  const tmpFile = path.join(os.tmpdir(), `pet_email_${Date.now()}.py`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  try {
    const result = await runPythonCode(pyExe, fs.readFileSync(tmpFile, 'utf8'), os.tmpdir(), 30000);
    const output = (result.stdout + result.stderr).trim();
    console.log(`[pet:email] 发信结果: ok=${result.ok}, output=${output.slice(0, 200)}`);
    if (result.ok && output.includes('发送成功')) {
      return { success: true, message: output };
    }
    return { success: false, message: output || '发送失败' };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// 读取收件箱最近邮件（用 run_code 执行 Python imaplib）
async function readInbox(maxCount = 5) {
  const cfg = loadEmailConfig();
  if (!cfg.email || !cfg.password) {
    return { success: false, message: '未配置邮箱' };
  }
  const pyExe = getPythonExe();
  if (!pyExe) return { success: false, message: '未找到 Python 环境' };

  const code = `
import imaplib
import email
from email.header import decode_header

def decode_str(s):
    if not s: return ''
    parts = decode_header(s)
    result = []
    for content, charset in parts:
        if isinstance(content, bytes):
            result.append(content.decode(charset or 'utf-8', errors='replace'))
        else:
            result.append(content)
    return ''.join(result)

imap_server = '${cfg.imapServer}'
imap_port = ${cfg.imapPort}
username = '${cfg.email}'
password = '${cfg.password}'

try:
    server = imaplib.IMAP4_SSL(imap_server, imap_port)
    server.login(username, password)
    server.select('INBOX')
    # 搜索最近的邮件
    status, messages = server.search(None, 'ALL')
    msg_ids = messages[0].split()
    recent = msg_ids[-${maxCount}:] if len(msg_ids) > ${maxCount} else msg_ids

    results = []
    for mid in reversed(recent):
        status, data = server.fetch(mid, '(RFC822)')
        for part in data:
            if isinstance(part, tuple):
                msg = email.message_from_bytes(part[1])
                subject = decode_str(msg.get('Subject', ''))
                from_addr = decode_str(msg.get('From', ''))
                date = msg.get('Date', '')
                # 提取正文
                body = ''
                if msg.is_multipart():
                    for p in msg.walk():
                        ct = p.get_content_type()
                        if ct == 'text/plain':
                            payload = p.get_payload(decode=True)
                            charset = p.get_content_charset() or 'utf-8'
                            body = payload.decode(charset, errors='replace')[:500]
                            break
                else:
                    payload = msg.get_payload(decode=True)
                    if payload:
                        charset = msg.get_content_charset() or 'utf-8'
                        body = payload.decode(charset, errors='replace')[:500]
                results.append(f"【{subject}】\\n发件人: {from_addr}\\n时间: {date}\\n预览: {body[:200]}\\n")

    server.logout()
    if results:
        print(f"收到 {len(results)} 封邮件：\\n")
        print("\\n---\\n".join(results))
    else:
        print("收件箱为空")
except Exception as e:
    print(f"读取收件箱失败: {e}")
`;

  const tmpFile = path.join(os.tmpdir(), `pet_inbox_${Date.now()}.py`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  try {
    const result = await runPythonCode(pyExe, fs.readFileSync(tmpFile, 'utf8'), os.tmpdir(), 30000);
    const output = (result.stdout + result.stderr).trim();
    console.log(`[pet:email] 收件箱结果: ok=${result.ok}, output=${output.slice(0, 200)}`);
    if (result.ok) {
      return { success: true, message: output };
    }
    return { success: false, message: output || '读取失败' };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// IPC：API 密钥配置
ipcMain.handle('api-config:get', () => {
  const cfg = loadApiConfig();
  const maskKey = (key) => {
    if (!key || key.length < 12) return key ? '••••' : '';
    return key.slice(0, 6) + '••••••' + key.slice(-4);
  };
  return {
    llm_api_base: cfg.llm_api_base,
    llm_api_key: maskKey(cfg.llm_api_key),
    llm_api_key_configured: !!cfg.llm_api_key,
    llm_model: cfg.llm_model,
    tavily_api_key: maskKey(cfg.tavily_api_key),
    tavily_api_key_configured: !!cfg.tavily_api_key,
    jina_api_key: maskKey(cfg.jina_api_key),
    jina_api_key_configured: !!cfg.jina_api_key,
    vision_api_base: cfg.vision_api_base,
    vision_api_key: maskKey(cfg.vision_api_key),
    vision_api_key_configured: !!cfg.vision_api_key,
    vision_model: cfg.vision_model,
  };
});
ipcMain.handle('api-config:save', (_event, cfg) => {
  // 如果密钥是掩码格式（含 ••••），保留原值
  const old = loadApiConfig();
  const cleanCfg = { ...cfg };
  const keys = ['llm_api_key', 'tavily_api_key', 'jina_api_key', 'vision_api_key'];
  for (const k of keys) {
    if (cleanCfg[k] && cleanCfg[k].includes('••••')) {
      cleanCfg[k] = old[k] || '';
    }
  }
  const ok = saveApiConfig(cleanCfg);
  if (ok) reloadApiConfig();
  return { success: ok };
});

// IPC：邮箱配置
ipcMain.handle('email:getConfig', () => {
  const cfg = loadEmailConfig();
  // 不返回密码明文，只返回是否已配置
  return { ...cfg, password: cfg.password ? '******' : '', configured: !!(cfg.email && cfg.password) };
});
ipcMain.handle('email:saveConfig', (_event, cfg) => {
  // 如果密码是 ******，保留原密码
  if (cfg.password === '******') {
    const old = loadEmailConfig();
    cfg.password = old.password;
  }
  return { success: saveEmailConfig(cfg) };
});
ipcMain.handle('email:getPreset', (_event, emailAddr) => {
  return getEmailPreset(emailAddr);
});
ipcMain.handle('email:send', async (_event, to, subject, body, isHtml) => {
  return await sendEmail(to, subject, body, isHtml);
});
ipcMain.handle('email:readInbox', async (_event, maxCount) => {
  return await readInbox(maxCount || 5);
});
ipcMain.handle('email:getContacts', () => {
  return emailContacts;
});
ipcMain.handle('email:deleteContact', (_event, name) => {
  if (emailContacts[name]) { delete emailContacts[name]; saveEmailContacts(); return { success: true }; }
  return { success: false };
});

// IMA API 调用封装
async function imaApi(apiPath, body) {
  const config = loadImaConfig();
  if (!config.clientId || !config.apiKey) {
    return { code: -1, msg: '未配置 IMA 凭证，请先在知识库面板配置' };
  }
  try {
    const res = await fetch(`https://ima.qq.com/openapi/wiki/v1/${apiPath}`, {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': config.clientId,
        'ima-openapi-apikey': config.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    return { code: -2, msg: '网络错误: ' + e.message };
  }
}

// 保存 IMA 配置
ipcMain.handle('ima:saveConfig', (_event, config) => {
  const old = loadImaConfig();
  const newCfg = {
    clientId: config.clientId !== undefined ? config.clientId : old.clientId,
    apiKey: config.apiKey !== undefined ? config.apiKey : old.apiKey,
    kbId: config.kbId !== undefined ? config.kbId : old.kbId
  };
  return { success: saveImaConfig(newCfg) };
});

// 读取 IMA 配置
ipcMain.handle('ima:loadConfig', () => {
  const cfg = loadImaConfig();
  // 不返回完整的 apiKey，只返回是否已配置
  return { clientId: cfg.clientId || '', hasApiKey: !!cfg.apiKey, kbId: cfg.kbId || '' };
});

// 测试连接
ipcMain.handle('ima:testConnection', async () => {
  const result = await imaApi('search_knowledge_base', { query: '', cursor: '', limit: 1 });
  if (result.code === 0) {
    return { success: true, msg: '连接成功！', kbCount: result.data?.info_list?.length || 0 };
  }
  return { success: false, msg: result.msg || '连接失败', code: result.code };
});

// 搜索知识库列表
ipcMain.handle('ima:searchKb', async (_event, query) => {
  const result = await imaApi('search_knowledge_base', { query: query || '', cursor: '', limit: 20 });
  if (result.code === 0) {
    return { success: true, list: result.data?.info_list || [] };
  }
  return { success: false, msg: result.msg, list: [] };
});

// 在指定知识库中搜索内容
ipcMain.handle('ima:searchKnowledge', async (_event, kbId, query) => {
  const result = await imaApi('search_knowledge', { query, cursor: '', knowledge_base_id: kbId });
  if (result.code === 0) {
    return { success: true, list: result.data?.info_list || [] };
  }
  return { success: false, msg: result.msg, list: [] };
});

// 知识库问答：搜索知识库 → 把结果作为上下文喂给 LLM 流式输出
ipcMain.handle('ima:ask', async (event, query) => {
  const config = loadImaConfig();
  if (!config.kbId) return { success: false, error: '未选择知识库' };
  
  // 1. 搜索知识库
  const searchResult = await imaApi('search_knowledge', { query, cursor: '', knowledge_base_id: config.kbId });
  if (searchResult.code !== 0) {
    return { success: false, error: '知识库搜索失败: ' + (searchResult.msg || '') };
  }
  
  const knowledgeResults = (searchResult.data?.info_list || []).slice(0, 5).map((item, i) => {
    return `[${i + 1}] ${item.title || '无标题'}\n${item.highlight_content || ''}`;
  }).join('\n\n');
  
  // 2. 用主 LLM 流式总结
  const systemPrompt = `你是小橘猫缘缘，一个可爱的桌面宠物助手。用户正在查询知识库。请根据以下知识库搜索结果回答用户的问题。如果搜索结果中没有相关信息，请诚实地说没有找到。回答要简洁友好，可以适当用喵的语气。

知识库搜索结果：
${knowledgeResults || '（无搜索结果）'}`;

  try {
    const res = await fetch(`${LLM_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        stream: true,
        thinking: { type: 'disabled' }
      })
    });

    // 推送聊天技能标记
    event.sender.send('chat:skill', { name: '📚 知识库查询', description: query });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            event.sender.send('chat:chunk', { text: delta });
          }
        } catch (e) {}
      }
    }
    return { success: true, streamed: true, reply: fullText };
  } catch (e) {
    return { success: false, error: 'LLM 调用失败: ' + e.message };
  }
});

// ============ 循环提醒 IPC ============
// 查看当前所有循环提醒
ipcMain.handle('reminder:list', () => {
  return recurringReminders.map((r) => ({ id: r.id, type: r.type || 'interval', text: r.text, intervalText: r.intervalText, intervalMs: r.intervalMs, active: r.active }));
});
// 取消所有循环提醒
ipcMain.handle('reminder:cancel', () => {
  cancelAllRecurring();
  return { success: true };
});
// 删除单个循环提醒
ipcMain.handle('reminder:delete', (_event, id) => {
  const idx = recurringReminders.findIndex((r) => r.id === id);
  if (idx >= 0) {
    if (recurringReminders[idx].timer) { clearInterval(recurringReminders[idx].timer); clearTimeout(recurringReminders[idx].timer); }
    recurringReminders.splice(idx, 1);
    console.log(`[pet:reminder] 删除提醒 id=${id}`);
    return { success: true };
  }
  return { success: false };
});
// 直接添加循环提醒（管理面板用，不经过对话）
ipcMain.handle('reminder:add', (_event, text, intervalMs, intervalText) => {
  addRecurringReminder(text, intervalMs, intervalText);
  return { success: true };
});
// 直接添加定时提醒（管理面板用，每周几+时间）
ipcMain.handle('reminder:addWeekly', (_event, text, weekdays, timeStr) => {
  addWeeklyReminder(text, weekdays, timeStr);
  return { success: true };
});

// ============ 定时任务管理 IPC ============
ipcMain.handle('scheduled:list', () => {
  return scheduledTasks.map(t => ({
    id: t.id, name: t.name, scheduleType: t.scheduleType, scheduleDesc: t.scheduleDesc,
    timeStr: t.timeStr, intervalMs: t.intervalMs, weekdays: t.weekdays,
    scriptLanguage: t.scriptLanguage, scriptPath: t.scriptPath,
    prompt: t.prompt, lastRun: t.lastRun, lastStatus: t.lastStatus,
    active: t.active !== false,
  }));
});
ipcMain.handle('scheduled:delete', (_event, name) => {
  const idx = scheduledTasks.findIndex(t => t.name === name);
  if (idx < 0) return { success: false, message: '未找到该任务' };
  if (scheduledTasks[idx].timer) { clearInterval(scheduledTasks[idx].timer); clearTimeout(scheduledTasks[idx].timer); }
  scheduledTasks.splice(idx, 1);
  saveScheduledTasks();
  console.log(`[pet:sched] 删除定时任务: ${name}`);
  return { success: true };
});
ipcMain.handle('scheduled:toggle', (_event, name) => {
  const task = scheduledTasks.find(t => t.name === name);
  if (!task) return { success: false, message: '未找到该任务' };
  task.active = task.active !== false ? false : true;
  if (task.active) { scheduleTaskTimer(task); }
  else { if (task.timer) { clearInterval(task.timer); clearTimeout(task.timer); task.timer = null; } }
  saveScheduledTasks();
  console.log(`[pet:sched] ${task.active ? '启用' : '暂停'}定时任务: ${name}`);
  return { success: true, active: task.active };
});
ipcMain.handle('scheduled:runNow', async (_event, name) => {
  const task = scheduledTasks.find(t => t.name === name);
  if (!task) return { success: false, message: '未找到该任务' };
  await executeScheduledTask(task);
  return { success: true, lastStatus: task.lastStatus };
});
ipcMain.handle('scheduled:update', (_event, name, updates) => {
  const task = scheduledTasks.find(t => t.name === name);
  if (!task) return { success: false, message: '未找到该任务' };
  // 只允许更新部分字段
  if (updates.schedule) {
    const sched = parseSchedule(updates.schedule);
    if (!sched) return { success: false, message: '调度规则格式错误' };
    task.scheduleType = sched.type; task.scheduleDesc = sched.desc;
    task.timeStr = sched.timeStr; task.intervalMs = sched.intervalMs; task.weekdays = sched.weekdays;
    if (task.active !== false) scheduleTaskTimer(task);
  }
  if (updates.script_code) {
    fs.writeFileSync(task.scriptPath, updates.script_code, 'utf8');
  }
  if (updates.prompt) task.prompt = updates.prompt;
  saveScheduledTasks();
  console.log(`[pet:sched] 更新定时任务: ${name}`);
  return { success: true };
});

// 直接创建定时任务（管理面板手动创建，不走 AI）
ipcMain.handle('scheduled:createDirect', async (_event, data) => {
  const { name, schedule, script_language, script_code, prompt } = data;
  const sched = parseSchedule(schedule);
  if (!sched) return { success: false, message: '调度规则格式错误' };

  // 保存脚本
  if (!fs.existsSync(SCHEDULED_SCRIPTS_DIR)) fs.mkdirSync(SCHEDULED_SCRIPTS_DIR, { recursive: true });
  const ext = script_language === 'powershell' ? '.ps1' : '.py';
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_');
  const scriptPath = path.join(SCHEDULED_SCRIPTS_DIR, safeName + ext);
  fs.writeFileSync(scriptPath, script_code || '# 空脚本', 'utf8');

  // 删除同名旧任务
  const existIdx = scheduledTasks.findIndex(t => t.name === name);
  if (existIdx >= 0) {
    if (scheduledTasks[existIdx].timer) { clearInterval(scheduledTasks[existIdx].timer); clearTimeout(scheduledTasks[existIdx].timer); }
    scheduledTasks.splice(existIdx, 1);
  }

  // 创建新任务
  const id = ++scheduledTaskSeq;
  const task = {
    id, name,
    scheduleType: sched.type, scheduleDesc: sched.desc,
    timeStr: sched.timeStr, intervalMs: sched.intervalMs, weekdays: sched.weekdays,
    scriptLanguage: script_language || 'python', scriptPath, prompt: prompt || name,
    timer: null, lastRun: null, lastStatus: null, active: true,
  };
  scheduleTaskTimer(task);
  scheduledTasks.push(task);
  saveScheduledTasks();
  console.log(`[pet:sched] 手动创建定时任务: ${name} (${sched.desc})`);
  return { success: true };
});

// 发送聊天消息（定时面板用 AI 生成时调用）
ipcMain.handle('chat:send', async (_event, msg) => {
  if (mainWindow && mainWindow.webContents) {
    // 把消息注入聊天框
    mainWindow.webContents.send('chat:injectMessage', msg);
    return { success: true };
  }
  return { success: false };
});

// ============ 天气查询（wttr.in，免认证，支持中文城市）============
// 天气码映射为中文描述
const WEATHER_CODE_MAP = {
  '113': '☀️ 晴', '116': '⛅ 多云', '119': '☁️ 阴', '122': '☁️ 浓阴',
  '143': '🌫️ 薄雾', '176': '🌧️ 小阵雨', '179': '🌨️ 小阵雪', '182': '🌨️ 阵雨夹雪',
  '185': '🌨️ 阵冻雨', '200': '⛈️ 雷阵雨', '227': '🌨️ 小雪', '230': '❄️ 暴雪',
  '248': '🌫️ 雾', '260': '🌫️ 冻雾', '263': '🌧️ 毛毛雨', '266': '🌧️ 小雨',
  '281': '🌧️ 冻毛毛雨', '284': '🌧️ 冻雨', '293': '🌧️ 局部阵雨', '296': '🌧️ 小雨',
  '299': '🌧️ 中阵雨', '302': '🌧️ 中雨', '305': '🌧️ 大阵雨', '308': '🌧️ 大雨',
  '311': '🌧️ 特大阵雨', '314': '🌧️ 冻阵雨', '317': '🌧️ 雨夹雪', '320': '🌨️ 阵雪',
  '323': '🌨️ 小阵雪', '326': '🌨️ 中阵雪', '329': '🌨️ 大阵雪', '332': '❄️ 暴雪',
  '335': '❄️ 大暴雪', '338': '❄️ 特大暴雪', '350': '🌧️ 冰粒', '353': '🌧️ 小阵雨',
  '356': '🌧️ 中阵雨', '359': '⛈️ 大阵雨', '362': '🌨️ 小阵雪', '365': '🌨️ 中阵雪',
  '368': '🌨️ 小雪', '371': '🌨️ 大雪', '374': '🌨️ 阵雨夹雪', '377': '🌨️ 阵冻雨',
  '386': '⛈️ 雷阵雨', '389': '⛈️ 雷暴大雨', '392': '⛈️ 雷阵雪', '395': '⛈️ 雷暴大雪',
};

// 风向英文转中文
const WIND_DIR_MAP = {
  'N': '北', 'NNE': '北东北', 'NE': '东北', 'ENE': '东东北',
  'E': '东', 'ESE': '东东南', 'SE': '东南', 'SSE': '南东南',
  'S': '南', 'SSW': '南西南', 'SW': '西南', 'WSW': '西西南',
  'W': '西', 'WNW': '西西北', 'NW': '西北', 'NNW': '北西北',
};

// 天气缓存：20 分钟内重复查询走缓存，避免反复请求
const WEATHER_CACHE_TTL = 20 * 60 * 1000; // 20 分钟
const weatherCache = {}; // { [city]: { data, fetchedAt } }

// 城市名 → 城市代码映射（extracted 供 IPC handler 和 Agent Loop 工具共用）
const CITY_CODES = {
  '北京': '101010100', '上海': '101020100', '天津': '101030100', '重庆': '101040100',
  '南京': '101190101', '苏州': '101190401', '无锡': '101190201', '常州': '101191101',
  '南通': '101190601', '徐州': '101190801', '扬州': '101190701', '泰州': '101191201',
  '镇江': '101190301', '盐城': '101190901', '连云港': '101191001', '淮安': '101190501', '宿迁': '101191301',
  '广州': '101280101', '深圳': '101280601', '东莞': '101281601', '佛山': '101280800',
  '珠海': '101280701', '中山': '101281701', '惠州': '101280301', '汕头': '101280501',
  '湛江': '101281001', '江门': '101281101', '茂名': '101282001', '肇庆': '101280901',
  '杭州': '101210101', '宁波': '101210401', '温州': '101210701', '嘉兴': '101210301',
  '湖州': '101210201', '绍兴': '101210501', '金华': '101210901', '台州': '101210601',
  '丽水': '101210801', '衢州': '101211001', '舟山': '101211101',
  '济南': '101120101', '青岛': '101120201', '烟台': '101120501', '潍坊': '101120601',
  '淄博': '101120301', '威海': '101120701', '日照': '101121501', '临沂': '101120901',
  '成都': '101270101', '绵阳': '101270401', '德阳': '101271001', '南充': '101270501',
  '宜宾': '101270801', '泸州': '101270201', '乐山': '101270901', '自贡': '101270301',
  '武汉': '101200101', '宜昌': '101200901', '襄阳': '101200201', '荆州': '101200801',
  '长沙': '101250101', '株洲': '101250301', '湘潭': '101250201', '衡阳': '101250401',
  '岳阳': '101250801', '常德': '101250601',
  '福州': '101230101', '厦门': '101230201', '泉州': '101230501', '漳州': '101230601',
  '合肥': '101220101', '芜湖': '101220301', '蚌埠': '101220201', '安庆': '101220601',
  '郑州': '101180101', '洛阳': '101180101', '开封': '101180801', '新乡': '101180301',
  '石家庄': '101090101', '唐山': '101090501', '保定': '101090201', '邯郸': '101090301',
  '沈阳': '101070101', '大连': '101070201', '鞍山': '101070301', '抚顺': '101070401',
  '长春': '101060101', '吉林': '101060201', '延吉': '101060301',
  '哈尔滨': '101050101', '齐齐哈尔': '101050201', '大庆': '101050901', '牡丹江': '101050301',
  '南昌': '101240101', '九江': '101240201', '赣州': '101240301',
  '南宁': '101300101', '柳州': '101300301', '桂林': '101300501', '北海': '101301301',
  '昆明': '101290101', '大理': '101290201', '丽江': '101290401',
  '贵阳': '101260101', '遵义': '101260201', '六盘水': '101260301',
  '西安': '101110101', '咸阳': '101110200', '宝鸡': '101110901', '渭南': '101110501',
  '太原': '101100101', '大同': '101100201', '运城': '101100801',
  '海口': '101310101', '三亚': '101310201',
  '兰州': '101160101', '银川': '101170101', '西宁': '101150101',
  '乌鲁木齐': '101130101', '拉萨': '101140101',
  '呼和浩特': '101080101', '包头': '101080201', '香港': '101320101', '澳门': '101330101',
  '台北': '101340101',
};

// 可复用的天气查询函数（供 IPC handler 和 Agent Loop 工具共用）
async function fetchWeatherData(city) {
  let cityCode = CITY_CODES[city];
  if (!cityCode) {
    const stripped = city.replace(/[市区县省]/g, '');
    cityCode = CITY_CODES[stripped];
    if (!cityCode) {
      for (const key in CITY_CODES) {
        if (city.includes(key) || key.includes(stripped)) { cityCode = CITY_CODES[key]; break; }
      }
    }
  }
  if (!cityCode) return { error: `暂不支持「${city}」` };

  const cached = weatherCache[city];
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) < WEATHER_CACHE_TTL) {
    return { ...cached.data, cached: true };
  }

  try {
    const url = `http://t.weather.sojson.com/api/weather/city/${cityCode}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { error: `天气服务返回 ${res.status}` };
    const j = await res.json();
    if (j.status !== 200) return { error: j.message || '天气查询失败' };

    const d = j.data || {};
    const forecast = d.forecast || [];
    const today = forecast[0] || {};
    const tomorrow = forecast[1] || {};

    const data = {
      city: (j.cityInfo?.city || city).replace(/市$/, ''),
      desc: today.type || '多云',
      tempC: d.wendu || '?',
      feelsC: d.wendu || '?',
      humidity: d.shidu || '?',
      windKmph: today.fl || '?',
      windDir: today.fx || '?',
      todayType: today.type || '',
      todayMin: (today.low || '').replace('低温 ', '').replace('℃', ''),
      todayMax: (today.high || '').replace('高温 ', '').replace('℃', ''),
      tomorrowType: tomorrow.type || '',
      tomorrowMin: (tomorrow.low || '').replace('低温 ', '').replace('℃', ''),
      tomorrowMax: (tomorrow.high || '').replace('高温 ', '').replace('℃', ''),
      pm25: d.pm25,
      quality: d.quality,
      ganmao: d.ganmao,
    };
    weatherCache[city] = { data, fetchedAt: now };
    console.log(`[pet:weather] 查询成功 ${data.city} ${data.tempC}°C ${data.desc}`);
    return { ...data, cached: false };
  } catch (err) {
    if (cached) return { ...cached.data, cached: true, stale: true };
    return { error: '天气查询失败：' + err.message };
  }
}

ipcMain.handle('weather:get', async (_event, city = '南京', forceRefresh = false) => {
  return await fetchWeatherData(city);
});

// AI 对话请求：流式调用大模型，失败回退本地拟人回复
ipcMain.handle('chat:request', async (event, message) => {
  // API 密钥未配置时友好提示
  if (!ARK_API_KEY || !ARK_API_BASE || !ARK_MODEL) {
    return { reply: '喵…还没配置 AI 大脑的 API 密钥呢！请右键我 → 设置 → 🔑 API 密钥配置，填入 API 地址、密钥和模型名后重启即可～', stopped: true };
  }
  // 离线检测：网络不通时友好提示
  const online = await isOnline();
  if (!online) {
    console.warn('[pet:chat] 网络不通，返回离线提示');
    return { reply: '喵…网络好像断了，小橘连不上AI大脑了～请检查一下网络连接，等会再试喵～', stopped: true };
  }
  // 检测拖拽文件内容标记 → 剥离标记，跳过文件操作类意图，但仍检测技能
  let hasFileContent = false;
  if (message.startsWith('__SKIP_INTENT__')) {
    hasFileContent = true;
    message = message.replace('__SKIP_INTENT__', '');
    console.log('[pet:chat] 检测到拖拽文件内容，跳过文件操作意图（仍检测技能）');
  }
  console.log(`[pet:chat] 收到消息: "${message.slice(0, 50)}${message.length > 50 ? '...' : ''}"`);
  const t0 = Date.now();
  const sender = event.sender;

  // 自动提取并记住邮件联系人（用户在对话中提到"XX 邮箱是 xxx@yy.com"时自动记住）
  extractAndSaveContact(message);

  // ===== 快速规则路由：简单对话/命令直接走，跳过 LLM 意图识别 =====
  const msg = message.trim();
  const msgLower = msg.toLowerCase();
  // 简单闲聊：短消息 + 不含操作关键词 → 直接走 chat，不调意图识别
  const SIMPLE_CHAT_PATTERNS = /^(你好|您好|hi|hello|hey|嗨|哈喽|谢谢|多谢|感谢|不客气|没事|好的|好|ok|okay|再见|拜拜|晚安|早上好|下午好|晚上好|在吗|在不在|你是谁|你叫什么|你叫啥|介绍一下你自己|小橘|喵|嗯|哦|哈哈|嘻嘻|嘿嘿|666|牛|厉害|棒|赞|酷)\s*[!！。.~]*$/i;
  const isSimpleChat = msg.length <= 15 && SIMPLE_CHAT_PATTERNS.test(msgLower);

  // ===== LLM 意图路由 =====
  let intentContext = '';

  // 前置：LLM 识别意图（拖拽文件内容时只检测 skill 意图）
  // 简单闲聊跳过意图识别，直接走 chat，省一次 API 调用
  currentAbortController = new AbortController();
  const intentResult = isSimpleChat
    ? { intent: 'chat' }
    : hasFileContent
    ? await (async () => {
        // 文件内容场景：只检测技能，不让 LLM 做文件操作类判断
        try { sender.send('chat:status', { status: 'thinking' }); } catch (e) {}
        const r = await detectIntentByLLM(message, true);
        try { sender.send('chat:status', { status: 'thinking_done' }); } catch (e) {}
        return r;
      })()
    : await (async () => {
        try { sender.send('chat:status', { status: 'thinking' }); } catch (e) {}
        const r = await detectIntentByLLM(message);
        try { sender.send('chat:status', { status: 'thinking_done' }); } catch (e) {}
        return r;
      })();
  // 意图识别阶段被用户中止 → 直接返回
  if (currentAbortController.signal.aborted) {
    currentAbortController = null;
    return { reply: '', stopped: true };
  }
  currentAbortController = null;

  if (intentResult && intentResult.intent && intentResult.intent !== 'chat') {
    const it = intentResult.intent;

    // —— 意图不明确，弹选项让用户选（支持自定义输入）——
    if (it === 'clarify') {
      const question = intentResult.question || '你想让我做什么呢？';
      const options = (intentResult.options || []).map(o => ({ icon: '🤔', name: o }));
      console.log(`[pet:chat] LLM意图-澄清: ${question}`);
      if (options.length > 0) {
        const choice = await askChoice(sender, '🤔 小橘不太确定', question, options, true);
        if (choice && choice.custom && choice.text) {
          // 用户输入了自定义要求
          intentContext = `主人在回应你的问题"${question}"时，自己输入了"${choice.text}"。请基于主人的要求"${choice.text}"来完成他的需求。`;
        } else if (choice && choice.index !== undefined) {
          // 用户选了选项
          const userChoice = intentResult.options[choice.index];
          intentContext = `主人选择了"${userChoice}"来回应你的问题"${question}"。请基于主人的选择"${userChoice}"来完成他的需求。`;
        } else {
          // 用户取消 → 直接回复
          return { reply: `喵？${question}`, stopped: false };
        }
      } else {
        return { reply: `喵？${question}`, stopped: false };
      }
    }
    // —— 打开应用 ——
    if (it === 'open_app') {
      const appName = intentResult.app || '';
      console.log(`[pet:chat] LLM意图-打开应用: ${appName}`);
      const exePath = findApp(appName);
      if (exePath) {
        try { shell.openPath(exePath); } catch (e) {}
        intentContext = `主人刚才让你帮忙打开"${appName}"，你已经帮主人打开了，路径是 ${exePath}。请简短地告诉主人已经打开好了。`;
      } else {
        intentContext = `主人刚才让你帮忙打开"${appName}"，但你在系统里没找到这个应用。请告诉主人没找到，问问是不是名字不对或者没安装。`;
      }
    }

    // —— 找文件 ——
    else if (it === 'search_file') {
      const keyword = intentResult.keyword || '';
      const wantOpen = !!intentResult.open;
      console.log(`[pet:file] LLM意图-找文件: "${keyword}" (打开=${wantOpen})`);
      if (keyword) {
        try { sender.send('chat:status', { status: 'file_searching' }); } catch (e) {}
        const results = await searchFilesEverywhere(keyword);
        try { sender.send('chat:status', { status: 'file_searching_done' }); } catch (e) {}
        if (results.length === 0) {
          intentContext = `主人想找名为"${keyword}"的文件，但你在整个系统里都没找到。请告诉主人没找到这个文件。`;
        } else {
          const fileList = results.slice(0, 10).map((r, i) => `${i + 1}. ${r.name}\n   路径：${r.path}`).join('\n');
          let openNote = '';
          if (wantOpen && results.length >= 1) {
            // 多个结果 → 弹选择让用户选打开哪个
            if (results.length > 1) {
              const options = results.slice(0, 10).map(r => ({ icon: '📄', name: r.name, sub: r.path }));
              const choice = await askChoice(sender, '📂 找到多个文件', `找到了 ${results.length} 个匹配"${keyword}"的文件，要打开哪个？`, options);
              if (choice && choice.index !== undefined) {
                const idx = choice.index;
                try {
                  shell.openPath(results[idx].path);
                  openNote = `主人选了第 ${idx + 1} 个文件，你已经帮主人打开了：${results[idx].name}。`;
                  console.log(`[pet:file] 用户选择打开文件: ${results[idx].path}`);
                } catch (e) {}
              } else {
                openNote = '主人取消了打开文件。';
              }
            } else {
              try {
                shell.openPath(results[0].path);
                openNote = `主人还想让你打开这个文件，你已经帮主人打开了：${results[0].name}（${results[0].path}）。`;
                console.log(`[pet:file] 已打开文件: ${results[0].path}`);
              } catch (e) {}
            }
          }
          intentContext = `主人想找名为"${keyword}"的文件，你帮主人找到了 ${results.length} 个匹配结果：\n${fileList}\n\n${openNote}请把这些结果整理后告诉主人，用列表格式。`;
          console.log(`[pet:file] 找到 ${results.length} 个匹配`);
        }
      }
    }

    // —— 读取文件并分析（基于文件内容生成总结/章节结构/HTML）——
    else if (it === 'read_and_analyze') {
      const keyword = intentResult.keyword || '';
      const task = intentResult.task || '分析这个文件';
      console.log(`[pet:file] LLM意图-读取分析: "${keyword}" 任务="${task}"`);
      if (keyword) {
        try { sender.send('chat:status', { status: 'file_searching' }); } catch (e) {}
        const results = await searchFilesEverywhere(keyword);
        try { sender.send('chat:status', { status: 'file_searching_done' }); } catch (e) {}
        if (results.length === 0) {
          intentContext = `主人想基于名为"${keyword}"的文件做任务："${task}"，但你在整个系统里都没找到这个文件。请告诉主人没找到。`;
        } else {
          // 多个匹配 → 弹选择让用户选读哪个
          let selectedIdx = 0;
          if (results.length > 1) {
            const options = results.slice(0, 10).map(r => ({ icon: '📄', name: r.name, sub: r.path }));
            const choice = await askChoice(sender, '📄 找到多个文件', `找到了 ${results.length} 个匹配"${keyword}"的文件，要读取分析哪个？`, options);
            if (!choice || choice.index === undefined) {
              intentContext = `主人想基于名为"${keyword}"的文件做任务："${task}"，找到了多个文件但主人取消了选择。请告诉主人已取消。`;
              return { reply: '', stopped: true };
            }
            selectedIdx = choice.index;
          }
          // 读取选中的文件内容
          const filePath = results[selectedIdx].path;
          const fileName = results[selectedIdx].name;
          console.log(`[pet:file] 读取文件: ${filePath}`);
          try { sender.send('chat:status', { status: 'reading' }); } catch (e) {}
          const fileResult = await readFileContent(filePath);
          try { sender.send('chat:status', { status: 'reading_done' }); } catch (e) {}
          if (fileResult.ok) {
            // docx 含图片 → 走 vision 模型识别图片 + 文字一起分析
            if (fileResult.images && fileResult.images.length > 0) {
              console.log(`[pet:file] docx 含 ${fileResult.images.length} 张图片，走 vision 流程`);
              try { sender.send('chat:skill', { name: '📄👁️ 文件读取+图片识别', description: `${fileName} 含 ${fileResult.images.length} 张图片` }); } catch (e) {}
              try { sender.send('chat:status', { status: 'reading' }); } catch (e) {}
              const visionSystemPrompt = getPetSystemPrompt() + '\n\n你正在看文档中的图片，请用中文描述每张图片的内容。';
              const userContent = [
                { type: 'text', text: `主人想基于文件"${fileName}"（${fileResult.ext} 格式）完成任务："${task}"。\n\n以下是文档的文字内容：\n${fileResult.content}\n\n请同时分析文档中的图片内容，综合文字和图片完成任务。` },
                ...fileResult.images.map(img => ({ type: 'image_url', image_url: { url: `data:image/${img.ext};base64,${img.base64}` } }))
              ];
              try {
                currentAbortController = new AbortController();
                const vRes = await fetch(`${VISION_API_BASE}/chat/completions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VISION_API_KEY}` },
                  body: JSON.stringify({ model: VISION_MODEL, messages: [{ role: 'system', content: visionSystemPrompt }, { role: 'user', content: userContent }], max_tokens: 4000, temperature: 0.3 }),
                  signal: currentAbortController.signal,
                });
                if (vRes.ok) {
                  const vData = await vRes.json();
                  currentAbortController = null;
                  const visionText = vData.choices?.[0]?.message?.content || '';
                  intentContext = `主人想基于文件"${fileName}"（${fileResult.ext} 格式，含${fileResult.images.length}张图片）完成任务："${task}"。以下是文档的文字内容和图片识别结果：\n\n【文档文字内容】\n${fileResult.content}\n\n【图片识别结果】\n${visionText}\n\n请综合文字和图片内容来完成主人的任务。`;
                  console.log(`[pet:file] vision 识别图片完成，长度=${visionText.length}`);
                } else {
                  currentAbortController = null;
                  intentContext = `主人想基于文件"${fileName}"（${fileResult.ext} 格式）完成任务："${task}"。以下是文件的内容：\n${fileResult.content}\n\n（注：文档含图片但图片识别失败）`;
                }
              } catch (vErr) {
                currentAbortController = null;
                // 用户手动停止 → 直接返回，不继续生成
                if (vErr.name === 'AbortError') {
                  console.log('[pet:file] 用户在 vision 识别阶段停止');
                  return { reply: '', stopped: true };
                }
                intentContext = `主人想基于文件"${fileName}"（${fileResult.ext} 格式）完成任务："${task}"。以下是文件的内容：\n${fileResult.content}\n\n（注：文档含图片但图片识别失败）`;
              }
              try { sender.send('chat:status', { status: 'reading_done' }); } catch (e) {}
            } else {
              intentContext = `主人想基于文件"${fileName}"（${fileResult.ext} 格式）完成任务："${task}"。以下是文件的完整内容，请基于文件内容来完成主人的任务。

【文件内容】
${fileResult.content}

【输出要求】
根据任务复杂度选择最合适的输出格式：
1. 简单问答 → 直接文字回复
2. 中等复杂度（总结、要点提炼）→ 用 Markdown 格式回复
3. 复杂任务 → 如果主人要 Word 用 \`\`\`word，要 Excel 用 \`\`\`excel，要 PPT 用 \`\`\`ppt，要网页用 \`\`\`html，否则用 Markdown。

无论哪种格式，都要基于上面的文件内容来回答，不要编造文件里没有的信息。`;
            }
            console.log(`[pet:file] 文件读取成功 (${fileResult.ext})，内容长度=${fileResult.content.length}`);
          } else {
            intentContext = `主人想基于文件"${fileName}"做任务"${task}"，但你读取文件内容失败了：${fileResult.error}。请告诉主人读取失败，建议换个格式。`;
            console.log(`[pet:file] 文件读取失败: ${fileResult.error}`);
          }
        }
      }
    }

    // —— 读取网页内容并分析 ——
    else if (it === 'web_read') {
      let url = intentResult.url || '';
      const task = intentResult.task || '总结这个网页的内容';
      // 如果没有 url，尝试从原始消息里提取
      if (!url) {
        const urlMatch = message.match(/https?:\/\/[^\s<>"']+/);
        if (urlMatch) url = urlMatch[0];
      }
      console.log(`[pet:web] LLM意图-读取网页: url="${url}" task="${task}"`);
      if (url) {
        try { sender.send('chat:status', { status: 'reading' }); } catch (e) {}
        const webResult = await fetchWebPage(url);
        try { sender.send('chat:status', { status: 'reading_done' }); } catch (e) {}
        if (webResult.ok) {
          intentContext = `主人想基于网页内容完成任务："${task}"。以下是网页的正文内容，请基于内容来完成主人的任务。

【网页内容：${url}】
${webResult.content}

【输出要求】
根据任务复杂度选择最合适的输出格式：
1. 简单问答 → 直接文字回复
2. 中等复杂度（总结、要点提炼）→ 用 Markdown 格式回复
3. 复杂任务（章节结构、报告、分析报告、方案对比、可视化）→ 输出完整的 HTML 文档代码，用 \`\`\`html 代码块包裹。

无论哪种格式，都要基于上面的网页内容来回答，不要编造网页里没有的信息。`;
          console.log(`[pet:web] 网页读取成功，内容长度=${webResult.content.length}`);
        } else {
          intentContext = `主人想读取网页"${url}"并${task}，但你抓取网页失败了：${webResult.error}。请告诉主人读取失败，并建议直接复制网页正文发给你。`;
          console.log(`[pet:web] 网页读取失败: ${webResult.error}`);
        }
      } else {
        intentContext = `主人想读取一个网页，但没提供网址。请告诉主人：可以直接把网址发给我，或者把网页正文复制过来，我来帮你分析。`;
      }
    }

    // —— 文件操作（复制/移动/删除）——
    else if (it === 'file_op') {
      const action = intentResult.action; // copy | move | delete
      const source = intentResult.source || '';
      const target = intentResult.target || '';
      const actionText = { copy: '复制', move: '移动', delete: '删除' }[action];
      console.log(`[pet:file] LLM意图-文件操作: ${action} "${source}" → "${target}"`);

      let targetDir = null;
      if (target && action !== 'delete') {
        targetDir = resolvePath(target);
      }
      if (action === 'delete' || (targetDir && fs.existsSync(targetDir)) || action === 'delete') {
        // 解析源文件目录+关键词并搜索
        const srcResults = (function() {
          if (/^[A-Za-z]:[\\/]/.test(source)) {
            if (fs.existsSync(source) && fs.statSync(source).isFile()) {
              return [{ name: path.basename(source), path: source, dir: path.dirname(source) }];
            }
            return searchFiles(path.dirname(source), path.basename(source));
          }
          const driveInName = source.match(/^([A-Za-z])盘的?(.+)$/);
          const folderInName = source.match(/^(桌面|下载|文档|图片)的?(上)?的?(.+)$/);
          let dir = null, keyword = source;
          if (driveInName) { dir = `${driveInName[1].toUpperCase()}:\\`; keyword = driveInName[2]; }
          else if (folderInName) { dir = resolvePath(folderInName[1]); keyword = folderInName[3]; }
          else { dir = resolvePath('桌面'); }
          console.log(`[pet:file] 搜索 dir=${dir} keyword="${keyword}"`);
          return searchFiles(dir, keyword);
        })();

        if (srcResults.length === 0) {
          intentContext = `主人想把"${source}"${actionText}，但没找到匹配的文件。请告诉主人没找到这个文件。`;
        } else if (srcResults.length === 1 && action !== 'delete') {
          const r = srcResults[0];
          const fileName = path.basename(r.path);
          try {
            if (action === 'copy') fs.copyFileSync(r.path, path.join(targetDir, fileName));
            else fs.renameSync(r.path, path.join(targetDir, fileName));
            intentContext = `主人想把文件${actionText}，你已经帮主人完成了。文件"${fileName}"已${actionText}到"${target}"。请简短告诉主人已完成。`;
            console.log(`[pet:file] 直接执行 ${action}: ${r.path} → ${targetDir}`);
          } catch (e) {
            intentContext = `主人想操作文件，但失败了：${e.message}。请告诉主人操作失败。`;
          }
        } else {
          // 多个匹配 → 弹选择框；删除操作即使1个也弹确认（危险操作）
          try {
            sender.send('file:choose', {
              action, targetDir: targetDir || '', targetName: target || '删除', files: srcResults,
            });
          } catch (e) {}
          return { reply: `__FILE_CHOOSE__`, action, files: srcResults, targetDir };
        }
      } else if (target && !targetDir) {
        intentContext = `主人想把文件${actionText}到"${target}"，但这个目标路径找不到。请告诉主人路径不对。`;
      }
    }

    // —— 定时提醒 ——
    else if (it === 'reminder') {
      const timeDesc = intentResult.time_desc || '';
      const event = intentResult.event || '';
      const ts = parseChineseTime(timeDesc);
      console.log(`[pet:reminder] LLM意图-定时提醒: ${timeDesc} → "${event}"`);
      if (ts) {
        try { sender.send('reminder:create', { text: event, ts, timeStr: timeDesc }); } catch (e) {}
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        const timeLabel = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        intentContext = `主人刚才让你在"${timeDesc}"（即 ${timeLabel}）提醒他"${event}"，你已经记下了，到点会举牌提醒他。请简短地告诉主人已经设好了。`;
        console.log(`[pet:reminder] 已创建定时提醒: ${timeLabel} - ${event}`);
      } else {
        intentContext = `主人想设置一个提醒"${event}"，但你说的时间"${timeDesc}"没法识别。请告诉主人你没听懂时间，让他换个说法，比如"5分钟后""下午3点"。`;
      }
    }

    // —— 循环提醒 ——
    else if (it === 'recurring_reminder') {
      const event = intentResult.event || '该活动了';
      const intervalDesc = intentResult.interval_desc || '';
      console.log(`[pet:reminder] LLM意图-循环提醒: ${intervalDesc} → "${event}"`);
      const iv = parseInterval(intervalDesc);
      if (iv) {
        addRecurringReminder(event, iv.intervalMs, iv.intervalText);
        intentContext = `主人刚才让你${iv.intervalText}提醒他"${event}"，你已经设好了，会按这个频率定时提醒。请简短地告诉主人已经设好了，如需取消可以说"取消提醒"。`;
        console.log(`[pet:reminder] 已添加循环提醒: ${event} ${iv.intervalText}`);
      } else {
        intentContext = `主人想设置循环提醒"${event}"，但你说的时间间隔"${intervalDesc}"没法识别。请告诉主人你没听懂，让他换个说法，比如"每隔30分钟"。`;
      }
    }

    // —— 取消循环提醒 ——
    else if (it === 'cancel_reminder') {
      cancelAllRecurring();
      intentContext = `主人刚才让你取消所有循环提醒，你已经取消了。请告诉主人已取消所有定时循环提醒。`;
      console.log('[pet:reminder] 取消所有循环提醒');
    }

    // —— 系统操作 ——
    else if (it === 'system_op') {
      const action = intentResult.action || '';
      const detail = intentResult.detail || '';
      console.log(`[pet:sysop] LLM意图-系统操作: ${action} ${detail}`);
      const op = { action, site: detail, query: detail };
      const result_text = executeSystemOp(op);
      if (result_text) {
        intentContext = `主人刚才让你执行系统操作，你已经完成了：${result_text}。请简短地告诉主人已完成。`;
      } else {
        intentContext = `主人想让你执行系统操作，但没能识别具体操作。请问主人想做什么。`;
      }
    }

    // —— 生成文档（两步走：先找内容技能写内容，再找排版技能排版）——
    else if (it === 'generate_doc') {
      const docType = intentResult.docType || 'word';
      console.log(`[pet:skill] LLM意图-生成文档: ${docType}，开始匹配技能`);
      const skills = loadAllSkills();
      // 清洗用户消息（去掉文件内容），用于匹配技能和生成内容
      const cleanUserMsg = message.split('\n\n【以下是用户提供的文件内容')[0].split('\n\n【粘贴文件内容')[0].split('\n\n【上传文件内容')[0].split('\n\n【拖拽文件内容')[0].trim();

      // 第1步：在非内置排版技能中找内容技能（排除带 Python 脚本的技能，只匹配纯提示词技能）
      const contentSkills = skills.filter(s => {
        if (BUILTIN_DOC_SKILLS[s.name]) return false;
        // 排除技能目录下有 .py 文件的（带脚本的技能不适合两步走）
        const skillDir = path.join(skillsDir, s.dir || s.name);
        try {
          const files = fs.readdirSync(skillDir);
          if (files.some(f => f.endsWith('.py'))) return false;
        } catch (e) {}
        return true;
      });
      let contentSkill = null;
      // 提取消息中的关键词去匹配技能
      for (const s of contentSkills) {
        const skillText = (s.name + ' ' + (s.description || '') + ' ' + ((s.tags || []).join(' '))).toLowerCase();
        // 技能名称/描述里的核心词出现在用户消息中
        const coreWords = s.name.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 1);
        if (coreWords.some(w => cleanUserMsg.toLowerCase().includes(w)) ||
            (s.description && s.description.split(/[\s,，。、]+/).filter(w => w.length > 2).some(w => cleanUserMsg.includes(w)))) {
          contentSkill = s; break;
        }
      }
      console.log(contentSkill ? `[pet:skill] 第1步-内容技能: ${contentSkill.name}` : `[pet:skill] 第1步-未匹配到内容技能，直接排版`);

      // 第2步：找排版技能
      const formatKeywords = {
        word: ['word', '文档', '公文', '排版', '报告'],
        excel: ['excel', '表格', '电子表格', '数据表'],
        ppt: ['ppt', '演示', '幻灯片', '汇报'],
        html: ['html', '网页', '报告'],
      };
      // HTML 格式直接走 chat（Markdown 输出 HTML 代码块），不需要排版技能
      if (docType === 'html') {
        if (contentSkill) {
          try { sender.send('chat:skill', { name: `✏️ ${contentSkill.name}`, description: '生成HTML内容' }); } catch (e) {}
          const generatedContent = await llmGenerateContent(message, contentSkill.prompt);
          if (generatedContent) {
            intentContext = `【内容已由"${contentSkill.name}"生成】以下是生成的内容，请将其转为精美的 HTML 网页报告。请先说一句简短的话（如"好的，HTML报告已生成～"），然后用\`\`\`html代码块输出完整的 HTML 页面（含内联 CSS 样式），不要输出纯文本版本：\n\n${generatedContent}`;
          } else {
            return { reply: '', stopped: true };
          }
        } else {
          intentContext = `主人要生成一份 HTML 网页报告。请先说一句简短的话（如"好的，HTML报告已生成～"），然后用\`\`\`html代码块输出完整的 HTML 页面（含内联 CSS 样式，美观大方）。报告内容要详实有条理。`;
        }
      } else {
      const kws = formatKeywords[docType] || formatKeywords.word;
      let formatSkill = null;
      for (const s of skills) {
        const text = (s.name + ' ' + (s.description || '')).toLowerCase();
        if (kws.some(kw => text.includes(kw.toLowerCase()))) {
          if (!BUILTIN_DOC_SKILLS[s.name]) { formatSkill = s; break; } // 用户安装的优先
          if (!formatSkill) formatSkill = s;
        }
      }
      if (!formatSkill) {
        const builtinNames = { word: 'Word排版助手', excel: 'Excel美化工具', ppt: 'PPT美化技能' };
        formatSkill = skills.find(s => s.name === builtinNames[docType]) || skills.find(s => s.name === builtinNames.word);
      }

      // 两步走：内容技能 + 排版技能
      if (contentSkill && formatSkill) {
        try { sender.send('chat:status', { status: 'thinking' }); } catch (e) {}
        try { sender.send('chat:skill', { name: `✏️ ${contentSkill.name} → 🎨 ${formatSkill.name}`, description: '先写内容，再排版' }); } catch (e) {}
        // 内容生成时传完整消息（含文件内容），但 LLM 会理解为参考信息
        const generatedContent = await llmGenerateContent(message, contentSkill.prompt);
        try { sender.send('chat:status', { status: 'thinking_done' }); } catch (e) {}
        if (generatedContent) {
          intentContext = `SKILL_PROMPT::${formatSkill.prompt}::END_SKILL_PROMPT\n\n【内容已由"${contentSkill.name}"生成】以下是生成的内容，请严格按照排版规范，将其转为${docType.toUpperCase()}格式。请先说一句简短的话（如"好的，${docType.toUpperCase()}已生成～"），然后用\`\`\`${docType}代码块输出，不要输出纯文本版本：\n\n${generatedContent}`;
          console.log(`[pet:skill] 两步走完成：${contentSkill.name}(内容) → ${formatSkill.name}(排版)`);
        } else {
          // 内容生成被停止或失败 → 不继续第2步
          console.log(`[pet:skill] 内容生成被停止/失败，终止两步走`);
          return { reply: '', stopped: true };
        }
      } else if (formatSkill) {
        intentContext = `SKILL_PROMPT::${formatSkill.prompt}::END_SKILL_PROMPT`;
        console.log(`[pet:skill] 仅排版技能: ${formatSkill.name}`);
        try { sender.send('chat:skill', { name: formatSkill.name, description: formatSkill.description }); } catch (e) {}
      } else if (contentSkill) {
        intentContext = `SKILL_PROMPT::${contentSkill.prompt}::END_SKILL_PROMPT`;
        console.log(`[pet:skill] 仅内容技能: ${contentSkill.name}`);
        try { sender.send('chat:skill', { name: contentSkill.name, description: contentSkill.description }); } catch (e) {}
      } else {
        console.log(`[pet:skill] 未找到匹配技能，回退到普通聊天`);
      }
      } // end of else (non-HTML)
    }

    // —— Skill 技能匹配 ——
    else if (it === 'skill') {
      const skillName = intentResult.skill || '';
      console.log(`[pet:skill] LLM意图-技能匹配: ${skillName}`);
      const skills = loadAllSkills();
      // 精确匹配
      let skill = skills.find(s => s.name === skillName);
      // 模糊匹配：大小写不敏感 + 包含匹配
      if (!skill) {
        const lower = skillName.toLowerCase();
        skill = skills.find(s => s.name.toLowerCase() === lower)
          || skills.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()));
      }
      if (skill && skill.prompt) {
        intentContext = `SKILL_PROMPT::${skill.prompt}::END_SKILL_PROMPT`;
        console.log(`[pet:skill] 技能 "${skill.name}" 已激活，提示词长度: ${skill.prompt.length}`);
        try { sender.send('chat:skill', { name: skill.name, description: skill.description }); } catch (e) {}
      } else {
        // 未命中技能 → 先搜索远程技能商店，再提示用户
        console.log(`[pet:skill] 未找到技能 "${skillName}"，搜索远程技能商店...`);
        try { sender.send('chat:status', { status: 'agent_step', text: `🔍 正在技能商店搜索"${skillName}"...` }); } catch (e) {}
        const remoteSkills = await searchRemoteSkills(message);
        if (remoteSkills.length > 0) {
          // 找到远程技能 → 弹对话框让用户选择下载
          const top = remoteSkills[0];
          const ok = await askChoice(sender, '🛒 发现新技能', `在技能商店找到一个匹配的技能：\n\n📌 ${top.name}\n📝 ${top.description}\n${top.tags ? '🏷️ ' + top.tags.join(', ') : ''}\n\n是否下载并安装这个技能？`, [
            { icon: '📥', name: '下载安装', sub: '安装后自动激活' },
            { icon: '✕', name: '不用了', sub: '跳过，用普通方式处理' },
          ]);
          if (ok && ok.index === 0) {
            try { sender.send('chat:status', { status: 'agent_step', text: `📥 正在下载技能"${top.name}"...` }); } catch (e) {}
            const installResult = await downloadAndInstallSkill(top);
            if (installResult.success) {
              console.log(`[pet:skill] 远程技能安装成功: ${installResult.skill.name}`);
              intentContext = `SKILL_PROMPT::${installResult.skill.prompt}::END_SKILL_PROMPT`;
              try { sender.send('chat:skill', { name: installResult.skill.name, description: installResult.skill.description }); } catch (e) {}
              try { sender.send('chat:status', { status: 'agent_step', text: `✅ 技能"${installResult.skill.name}"安装成功，正在执行...` }); } catch (e) {}
            } else {
              console.warn(`[pet:skill] 技能下载失败: ${installResult.message}`);
              const availableSkills = skills.map(s => `• ${s.name}：${s.description}`).join('\n');
              intentContext = `系统提示：小橘想用"${skillName}"技能但没找到，尝试从技能商店下载也失败了（${installResult.message}）。请告诉主人下载失败，可以用普通方式完成任务。可用技能：\n${availableSkills}`;
            }
          } else {
            // 用户不下载 → 用普通方式处理
            intentContext = `系统提示：小橘想用"${skillName}"技能但没找到，主人选择不从技能商店下载。请直接用普通方式帮主人完成任务。`;
          }
        } else {
          // 远程也没找到 → 提示用户
          console.log(`[pet:skill] 远程技能商店也没有匹配的技能`);
          const availableSkills = skills.map(s => `• ${s.name}：${s.description}`).join('\n');
          intentContext = `系统提示：AI 尝试匹配技能"${skillName}"但未找到，技能商店也没有匹配的技能。请友好地告诉主人：小橘想用"${skillName}"技能但没找到，目前可用的技能有：\n${availableSkills}\n\n请主人明确指定技能名称，或者直接帮主人用普通方式完成任务。`;
        }
      }
    }

    // —— 知识库查询 ——
    else if (it === 'knowledge_base') {
      const query = intentResult.query || message;
      console.log(`[pet:kb] LLM意图-知识库查询: "${query.slice(0, 50)}"`);
      const imaConfig = loadImaConfig();
      if (imaConfig.kbId) {
        try { sender.send('chat:status', { status: 'reading' }); } catch (e) {}
        const searchResult = await imaApi('search_knowledge', { query, cursor: '', knowledge_base_id: imaConfig.kbId });
        try { sender.send('chat:status', { status: 'reading_done' }); } catch (e) {}
        if (searchResult.code === 0) {
          const knowledgeResults = (searchResult.data?.info_list || []).slice(0, 5).map((item, i) => {
            return `[${i + 1}] ${item.title || '无标题'}\n${item.highlight_content || ''}`;
          }).join('\n\n');
          intentContext = `主人正在查询知识库。请根据以下知识库搜索结果回答主人的问题。如果搜索结果中没有相关信息，请诚实地说没有找到。回答要简洁友好，可以适当用喵的语气。

知识库搜索结果：
${knowledgeResults || '（无搜索结果）'}`;
          try { sender.send('chat:skill', { name: '📚 知识库查询', description: query }); } catch (e) {}
          console.log(`[pet:kb] 知识库搜索成功，返回 ${searchResult.data?.info_list?.length || 0} 条结果`);
        } else {
          intentContext = `主人想查知识库，但搜索失败了：${searchResult.msg || '未知错误'}。请告诉主人知识库搜索失败。`;
          console.warn(`[pet:kb] 知识库搜索失败: ${searchResult.msg}`);
        }
      } else {
        intentContext = `主人想查知识库，但还没有配置 IMA 知识库。请告诉主人：可以在右键菜单点"📚 知识库"来配置 IMA 凭证和选择知识库。`;
        console.log('[pet:kb] 未配置 IMA 知识库');
      }
    }
  }

  // 智能切换：有明确意图（open_app/search_file/file_op/reminder 等）→ 走意图路由+llmChatStream（快）
  // 无明确意图（chat）→ 走 Agent Loop（LLM 自主决定是否调用工具，支持多步）
  // 特殊：Python编程高手技能需要 run_code 工具，走 Agent Loop
  const it = intentResult && intentResult.intent;
  const isPythonSkill = it === 'skill' && intentResult.skill === 'Python编程高手';
  const hasExecutableIntent = it && it !== 'chat' && it !== 'clarify' && !isPythonSkill;
  let result;
  if (hasExecutableIntent) {
    // 明确意图 → 意图路由已处理好 intentContext，走流式输出
    result = await llmChatStream(message, sender, intentContext);
  } else if (it === 'clarify') {
    // clarify 意图已经在前面处理了（askChoice），这里不应该到达
    result = await llmChatStream(message, sender, intentContext);
  } else {
    // 无明确意图 或 Python编程高手技能 → 走 Agent Loop，让 LLM 自主决定是否用工具
    console.log('[pet:chat] 走 Agent Loop（带工具）');
    result = await agentChatStream(message, sender, intentContext || '');
  }
  const dt = Date.now() - t0;
  if (result) {
    console.log(`[pet:chat] 大模型回复完成 (${dt}ms): "${result.reply.slice(0, 40)}..."`);
    // 后台静默提取用户画像（只对可能含个人信息的消息执行，省 API 调用）
    // 用清洗后的消息（不含文件内容），避免把文件内容误当用户画像
    const cleanMsg4Memory = message.split('\n\n【以下是用户提供的文件内容')[0].trim();
    if (mightContainPersonalInfo(cleanMsg4Memory) && result.reply) {
      extractMemory(cleanMsg4Memory, result.reply).catch(() => {});
    }
    return result;
  }
  console.log(`[pet:chat] 大模型不可用，回退本地回复 (${dt}ms)`);
  // 有意图但大模型不可用时，返回意图上下文的摘要
  if (intentContext) {
    return { reply: '喵～网络可能有点问题，等会儿再试试吧～' };
  }
  return localChatReply(message);
});

// ============ 本地拟人回复（大模型不可用时的兜底）============
function localChatReply(message) {
  const text = (message || '').trim();
  const replies = {
    你好: ['喵~你好呀！见到你真开心！', '喵呜~今天也要元气满满哦！'],
    你好呀: ['喵~你好呀！见到你真开心！', '喵呜~今天也要元气满满哦！'],
    吃: ['喵！说到吃的我就来精神了！小鱼干小鱼干~', '咕噜噜…我肚子好像饿了呢…'],
    饿: ['喵呜…好饿好饿，快给我小鱼干嘛！', '饿饿，饭饭，喵呜~'],
    鱼: ['小鱼干！我最喜欢了！嗷呜~', '是小鱼干吗？快给我快给我！'],
    累: ['呼…那你歇会儿吧，我陪你趴着~', '辛苦啦，摸摸头，喵~'],
    晚安: ['喵…晚安，我也困了，一起睡吧~', '晚安喵~做个好梦哦~'],
    早: ['早上好喵！新的一天开始啦！', '喵早~今天天气真不错呢~'],
    喜欢: ['喵嘿嘿，我也喜欢你！贴贴~', '喵~你这么说我会害羞的啦！'],
    名字: ['我叫小橘！是一只橘猫哦~', '我是小橘喵~记住我的名字了嘛？'],
  };

  for (const key of Object.keys(replies)) {
    if (text.includes(key)) {
      const arr = replies[key];
      return { reply: arr[Math.floor(Math.random() * arr.length)] };
    }
  }

  // 默认回复
  const defaults = [
    `喵？"${text}"是什么意思呀？`,
    '喵呜~你说的话我努力理解中…',
    '喵~虽然听不太懂，但我会一直陪着你的！',
    '咕噜咕噜…（小橘歪了歪头）',
    '喵！要多摸摸我哦~',
  ];
  return { reply: defaults[Math.floor(Math.random() * defaults.length)] };
}

// ============ 应用生命周期 ============

app.whenReady().then(() => {
  ensureBuiltinSkills();
  createWindow();
  createTray();
  loadScheduledTasks(); // 恢复持久化的定时任务
  // 启动时连接已配置的 MCP Server（异步，不阻塞启动）
  connectAllMcpServers().catch(e => console.warn(`[pet:mcp] 启动连接失败: ${e.message}`));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuiting = true;
});

// 关闭窗口时最小化到托盘，而非退出
app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') {
    // 阻止退出，隐藏到托盘
  }
});
