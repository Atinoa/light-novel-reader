// preload.cjs
// 渲染进程与主进程之间的受控桥接。
//
// 安全要求（在 main.js 的 webPreferences 中配置）：
//   nodeIntegration: false —— 渲染进程无法使用 Node
//   contextIsolation: true —— 隔离上下文
//   sandbox: true             —— 渲染进程运行在沙箱中
//
// 这里只通过 contextBridge 暴露“白名单”API，绝不把 ipcRenderer、Node 或
// electron 本身暴露给页面脚本，只暴露封装好的函数。
// 注意：文件用 .cjs 后缀，确保在 package.json 的 "type": "module" 下仍按
// CommonJS 加载（沙箱 preload 必须为 CommonJS）。

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  // ---- 文件夹与扫描 ----
  selectFolder: () => invoke('select-folder'),
  scanFolders: (paths) => invoke('scan-folders', paths),

  // ---- 书库 ----
  getLibrary: () => invoke('get-library'),
  saveLibrary: (lib) => invoke('save-library', lib),
  removeFolder: (p) => invoke('remove-folder', p),
  removeBook: (p) => invoke('remove-book', p),

  // ---- 文件读取 ----
  readEpub: (bookPath) => invoke('read-epub', bookPath),
  readTxt: (bookPath) => invoke('read-txt', bookPath),
  readTxtRaw: (bookPath, encoding) => invoke('read-txt-raw', bookPath, encoding),
  getTxtCache: (bookPath) => invoke('get-txt-cache', bookPath),
  setTxtCache: (bookPath, data) => invoke('set-txt-cache', bookPath, data),
  openMangaFolder: () => invoke('open-manga-folder'),
  getMangaPages: (bookPath) => invoke('get-manga-pages', bookPath),
  openEpubFile: () => invoke('open-epub-file'),
  registerDroppedFiles: (files) => invoke('register-dropped-files', files),
  statBook: (p) => invoke('stat-book', p),
  showInFolder: (p) => invoke('show-in-folder', p),

  // ---- 进度 / 书签 ----
  getBookData: (bookPath) => invoke('get-book-data', bookPath),
  setBookData: (key, data) => invoke('set-book-data', { key, data }),

  // ---- 设置 ----
  getSettings: () => invoke('get-settings'),
  setSettings: (settings) => invoke('set-settings', settings),

  // ---- 应用信息 ----
  getAppInfo: () => invoke('get-app-info'),

  // 拖拽时通过 webUtils 拿到真实文件路径（Electron 29+ 移除 File.path 后
  // 的标准做法；不暴露任何 Node 能力，只能对真实的拖拽 File 对象取路径）。
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (e) {
      /* 忽略 */
    }
    return null;
  }
});
