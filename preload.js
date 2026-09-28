const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 通过 contextBridge 安全地向渲染进程暴露受控 API
contextBridge.exposeInMainWorld('pet', {
  // 从拖拽的 File 对象获取真实文件路径（Electron 33+ 需用 webUtils）
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return null; } },
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  // 截图选区结果发送（截图覆盖窗口用）
  screenshotRegion: (rect) => ipcRenderer.send('screenshot:region', rect),
  screenshotCancel: () => ipcRenderer.send('screenshot:cancel'),
  // 通用选择弹窗（AI 不确定时给选项）
  choiceResult: (index) => ipcRenderer.send('choice:result', index),
  onChoiceShow: (cb) => { const l = (_e, data) => cb(data); ipcRenderer.on('choice:show', l); return () => ipcRenderer.removeListener('choice:show', l); },

  // 窗口失焦时收起聊天框
  onChatBlurHide: (cb) => { const l = () => cb(); ipcRenderer.on('chat:blurHide', l); return () => ipcRenderer.removeListener('chat:blurHide', l); },

  // 屏幕尺寸 / 窗口位置
  getScreenBounds: () => ipcRenderer.invoke('get-screen-bounds'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  moveWindow: (x, y) => ipcRenderer.invoke('move-window', x, y),

  // AI 对话（流式：发起请求 + 监听增量 chunk）
  chat: (message) => ipcRenderer.invoke('chat:request', message),

  // 手动停止当前对话生成
  chatStop: () => ipcRenderer.invoke('chat:stop'),

  // 删除指定索引的聊天记录
  chatDeleteRecord: (index) => ipcRenderer.invoke('chat:deleteRecord', index),

  // 清除全部聊天记录（聊天历史 + 对话记忆，保留用户画像）
  chatClearHistory: () => ipcRenderer.invoke('chat:clearHistory'),

  // 注入一轮对话到 LLM 内存上下文（如自我介绍）
  chatInjectTurn: (userText, petText) => ipcRenderer.invoke('chat:injectTurn', userText, petText),

  // 按内容删除一条聊天记录（文件 + 内存上下文，保留摘要和用户画像）
  chatDeleteByContent: (role, text) => ipcRenderer.invoke('chat:deleteByContent', role, text),

  // 监听流式输出增量，返回取消监听函数
  onChatChunk: (callback) => {
    const handler = (_event, delta) => callback(delta);
    ipcRenderer.on('chat:chunk', handler);
    return () => ipcRenderer.removeListener('chat:chunk', handler);
  },

  // 监听聊天状态变化（searching / searching_done），返回取消监听函数
  onChatStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('chat:status', handler);
    return () => ipcRenderer.removeListener('chat:status', handler);
  },

  // 监听注入消息（定时面板等外部调用发消息）
  onInjectMessage: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('chat:injectMessage', handler);
    return () => ipcRenderer.removeListener('chat:injectMessage', handler);
  },

  // 天气查询（forceRefresh=true 时跳过缓存）
  getWeather: (city, forceRefresh) => ipcRenderer.invoke('weather:get', city, forceRefresh),

  // 开机自启动
  getAutoLaunch: () => ipcRenderer.invoke('autolaunch:get'),
  setAutoLaunch: (on) => ipcRenderer.invoke('autolaunch:set', on),

  // 打开应用
  openApp: (name) => ipcRenderer.invoke('app:open', name),

  // 文件操作
  onFileChoose: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('file:choose', handler);
    return () => ipcRenderer.removeListener('file:choose', handler);
  },
  execFileOp: (action, srcPath, targetDir) => ipcRenderer.invoke('file:exec', action, srcPath, targetDir),

  // 读取文件内容（拖拽文件时用）
  readFileContent: (filePath) => ipcRenderer.invoke('file:read', filePath),
  // 保存内容到配置文件夹（AI 输出 HTML/Markdown 时用）
  saveFile: (content, suggestedName) => ipcRenderer.invoke('file:save', content, suggestedName),
  getSaveDir: () => ipcRenderer.invoke('file:getSaveDir'),
  setSaveDir: (dir) => ipcRenderer.invoke('file:setSaveDir', dir),
  chooseSaveDir: () => ipcRenderer.invoke('file:chooseDir'),
  // 用默认程序打开文件（HTML 预览时用）
  openFile: (filePath) => ipcRenderer.invoke('file:open', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('file:showInFolder', filePath),

  // 头像管理（自定义聊天头像）
  saveAvatar: (type, base64) => ipcRenderer.invoke('avatar:save', type, base64),
  loadAvatar: () => ipcRenderer.invoke('avatar:load'),
  deleteAvatar: (type) => ipcRenderer.invoke('avatar:delete', type),

  // 截屏（返回 base64）
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),
  // 区域截屏（微信风格选区框，返回 base64）
  captureRegion: () => ipcRenderer.invoke('screenshot:region'),
  // 截屏开始通知（快捷键触发时隐藏聊天框）
  onScreenshotStart: (cb) => { const l = (_e) => cb(); ipcRenderer.on('screenshot:start', l); return () => ipcRenderer.removeListener('screenshot:start', l); },
  // 截屏完成通知（回来显示，并将截图加入待发送图片）
  onScreenshotDone: (cb) => { const l = (_e, res) => cb(res); ipcRenderer.on('screenshot:done', l); return () => ipcRenderer.removeListener('screenshot:done', l); },
  // 图片理解（图片数组 + 问题 → vision 模型分析）
  chatVision: (images, question) => ipcRenderer.invoke('chat:vision', images, question),

  // Skills 技能系统
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsAdd: (content) => ipcRenderer.invoke('skills:add', content),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsImportZip: (filePath) => ipcRenderer.invoke('skills:importZip', filePath),
  skillsFetchHub: (name) => ipcRenderer.invoke('skills:fetchHub', name),
  skillsBrowseHub: () => ipcRenderer.invoke('skills:browseHub'),
  skillsSearchHub: (keyword) => ipcRenderer.invoke('skills:searchHub', keyword),

  // 聊天记录持久化
  loadChatHistory: () => ipcRenderer.invoke('chat:loadHistory'),
  saveChatHistory: (history) => ipcRenderer.invoke('chat:saveHistory', history),
  onChatSkill: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat:skill', h);
    return () => ipcRenderer.removeListener('chat:skill', h);
  },

  // IMA 知识库
  imaSaveConfig: (config) => ipcRenderer.invoke('ima:saveConfig', config),
  imaLoadConfig: () => ipcRenderer.invoke('ima:loadConfig'),
  imaTestConnection: () => ipcRenderer.invoke('ima:testConnection'),
  imaSearchKb: (query) => ipcRenderer.invoke('ima:searchKb', query),
  imaSearchKnowledge: (kbId, query) => ipcRenderer.invoke('ima:searchKnowledge', kbId, query),
  imaAsk: (query) => ipcRenderer.invoke('ima:ask', query),

  // 邮箱集成
  emailGetConfig: () => ipcRenderer.invoke('email:getConfig'),
  emailSaveConfig: (cfg) => ipcRenderer.invoke('email:saveConfig', cfg),
  emailGetPreset: (email) => ipcRenderer.invoke('email:getPreset', email),
  emailSend: (to, subject, body, isHtml) => ipcRenderer.invoke('email:send', to, subject, body, isHtml),
  emailReadInbox: (maxCount) => ipcRenderer.invoke('email:readInbox', maxCount),
  emailGetContacts: () => ipcRenderer.invoke('email:getContacts'),
  emailDeleteContact: (name) => ipcRenderer.invoke('email:deleteContact', name),

  // 技能商店
  skillstoreGetUrl: () => ipcRenderer.invoke('skillstore:getUrl'),
  skillstoreSetUrl: (url) => ipcRenderer.invoke('skillstore:setUrl', url),
  skillstoreSearch: (query) => ipcRenderer.invoke('skillstore:search', query),
  skillstoreInstall: (skill) => ipcRenderer.invoke('skillstore:install', skill),
  skillstoreList: () => ipcRenderer.invoke('skillstore:list'),

  // MCP 客户端
  mcpGetConfig: () => ipcRenderer.invoke('mcp:getConfig'),
  mcpSaveConfig: (cfg) => ipcRenderer.invoke('mcp:saveConfig', cfg),
  mcpConnect: () => ipcRenderer.invoke('mcp:connect'),
  mcpTools: () => ipcRenderer.invoke('mcp:tools'),
  mcpImportJson: (jsonText) => ipcRenderer.invoke('mcp:importJson', jsonText),

  // 循环提醒
  listReminders: () => ipcRenderer.invoke('reminder:list'),
  cancelReminders: () => ipcRenderer.invoke('reminder:cancel'),
  deleteReminder: (id) => ipcRenderer.invoke('reminder:delete', id),
  addReminderDirect: (text, intervalMs, intervalText) => ipcRenderer.invoke('reminder:add', text, intervalMs, intervalText),
  addWeeklyReminder: (text, weekdays, timeStr) => ipcRenderer.invoke('reminder:addWeekly', text, weekdays, timeStr),
  onRecurringRemind: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('recurring:remind', handler);
    return () => ipcRenderer.removeListener('recurring:remind', handler);
  },
  onReminderCreate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('reminder:create', handler);
    return () => ipcRenderer.removeListener('reminder:create', handler);
  },

  // 记忆系统（用户画像）
  getMemory: () => ipcRenderer.invoke('memory:get'),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  addMemory: (text) => ipcRenderer.invoke('memory:add', text),
  deleteMemory: (index) => ipcRenderer.invoke('memory:delete', index),
  updateMemory: (index, newText) => ipcRenderer.invoke('memory:update', index, newText),

  // 托盘菜单动作回调
  onTrayAction: (callback) => {
    ipcRenderer.on('tray:action', (_event, action) => callback(action));
  },

  // ============ 会议纪要 ============
  meetingSaveAudio: (arrayBuffer, filename) => ipcRenderer.invoke('meeting:saveAudio', arrayBuffer, filename),
  meetingTranscribe: (audioPath) => ipcRenderer.invoke('meeting:transcribe', audioPath),
  meetingSummary: (transcriptText) => ipcRenderer.invoke('meeting:summary', transcriptText),
  meetingSaveSummary: (content, audioPath) => ipcRenderer.invoke('meeting:saveSummary', content, audioPath),
  onMeetingChunk: (callback) => {
    const handler = (_event, delta) => callback(delta);
    ipcRenderer.on('meeting:chunk', handler);
    return () => ipcRenderer.removeListener('meeting:chunk', handler);
  },

  // ============ 定时任务管理 ============
  listScheduledTasks: () => ipcRenderer.invoke('scheduled:list'),
  deleteScheduledTask: (name) => ipcRenderer.invoke('scheduled:delete', name),
  toggleScheduledTask: (name) => ipcRenderer.invoke('scheduled:toggle', name),
  runScheduledTaskNow: (name) => ipcRenderer.invoke('scheduled:runNow', name),
  updateScheduledTask: (name, updates) => ipcRenderer.invoke('scheduled:update', name, updates),
  createScheduledTaskDirect: (data) => ipcRenderer.invoke('scheduled:createDirect', data),
  sendChatMessage: (msg) => ipcRenderer.invoke('chat:send', msg),

  // ============ API 密钥配置 ============
  apiConfigGet: () => ipcRenderer.invoke('api-config:get'),
  apiConfigSave: (cfg) => ipcRenderer.invoke('api-config:save', cfg),
});
