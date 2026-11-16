# 轻小说 EPUB 阅读器（LightNovelReader）

一个本地、离线的 Windows 桌面阅读器，同时支持 **无 DRM 的 EPUB**、**TXT 小说** 与 **漫画（图片文件夹 / ZIP / CBZ）**。
基于 Electron + epub.js 0.3.93，使用 electron-store 持久化书库、设置、阅读进度与书签。

> **仓库说明**：本仓库只包含源码，不包含任何 EPUB/TXT/漫画等版权内容或下载产物。
> 阅读器源码在根目录；爱丽丝书屋下载器源码在 `爱丽丝书屋下载器/`。

- 不使用后端服务，不上传任何文件
- 不实现 DRM 破解（仅支持无 DRM 的 EPUB）
- 不使用 CDN，epub.js 以本地文件打包，完全离线可用
- 不使用付费 API

---

## 功能概览

**书库**
- 导入一个或多个包含 `.epub` / `.txt` / 漫画的文件夹（递归扫描，默认最大深度 5，忽略隐藏目录与 `node_modules`）
- 书库按「全部 / EPUB / TXT / 漫画」分区筛选，卡片带类型角标；TXT / 漫画使用占位封面
- 单独打开 `.epub` / `.txt` / `.zip` / `.cbz`；支持拖拽文件或图片文件夹到窗口
- 漫画：含 ≥3 张图片的文件夹、ZIP/CBZ；CBR/RAR 标记为“暂不支持，请转换为 CBZ”
- 网格 / 列表视图切换；按书名、作者、文件名搜索
- 封面、书名、作者懒加载解析（解析结果缓存到 electron-store）
- 刷新书库、移除书库文件夹、移除单本书（**均绝不删除源文件**）
- “在资源管理器中显示”某本书所在位置

**阅读器**
- 目录跳转与当前章节高亮、阅读进度百分比
- 分页 / 滚动两种模式；上一页/下一页、键盘快捷键、点击左右侧翻页、左右滑动翻页
- 书签：添加当前页、删除、跳转（保存 CFI 与章节标题）
- 搜索：当前章节搜索（可勾选“全书搜索”）
- 设置：字体大小、行距、页边距、字体族、主题（浅色/深色/护眼米色/夜间）、阅读模式、最大宽度、双栏
- 自动保存阅读位置（CFI + 进度百分比），重开恢复；失败回退到开头并提示
- “重置本书阅读数据”

**TXT 阅读器（独立视图，与 EPUB 渲染完全分离）**
- 编码自动检测：UTF-8（含 BOM）、UTF-16 LE/BE（含 BOM）、GBK/GB18030，手动可选 Big5
- 乱码时可手动切换编码重新读取（设置面板 / 错误页下拉）
- 章节识别：第X章/节/回/卷/话、Chapter X、序章/楔子/前言/番外/尾声 等；识别不到时按约 5000 字分节
- 分页 / 滚动两种模式；滚动模式按章节或子块窗口化渲染，接近底部再追加
- 进度用「字符偏移 + 百分比」保存恢复；书签按字符偏移跳转
- 当前章节搜索 + 全文搜索（最多 200 条，带上下文片段）
- 段首缩进（两个全角空格，可关闭）、主题/字体/行距/页边距与 EPUB 共用

**漫画阅读器（独立视图，不复用 epub.js iframe / TXT 文本渲染）**
- 来源：图片文件夹（≥3 张图片）、ZIP、CBZ；CBR/RAR 暂不支持并提示
- 图片通过自定义 `manga://` 协议读取，主进程做白名单校验；ZIP 用 yauzl 按需流式读取单张图片
- 自然排序（2.jpg 在 10.jpg 之前）；过滤 `__MACOSX`、`.DS_Store`、`Thumbs.db`、隐藏文件
- 单页 / 双页（窄屏自动降级单页）、右到左 / 左到右、适合宽度 / 适合高度 / 原始大小、双击缩放与拖拽平移
- 预加载当前页前后各 2 页，离开窗口后 `revokeObjectURL` 释放
- 页码进度恢复、书签、目录（多子目录按卷/章分组）

---

## 环境要求

- Windows 10/11（打包目标为 Windows x64）
- Node.js ≥ 18（推荐 20+）
- npm

---

## 快速开始

```bash
# 1. 安装依赖（会自动执行 postinstall 把 epub.js 复制到 renderer/vendor/）
npm install

# 2. 开发运行（先复制 vendor，再启动 Electron）
npm run dev
```

启动后显示的是**书库首页**，点击“导入 EPUB 文件夹”选择包含 EPUB 的目录即可。

> 若 `renderer/vendor/epub.min.js` 缺失，可手动执行 `npm run copy:vendor` 生成。

---

## 打包 Windows x64

```bash
npm run build:win
```

脚本会先复制 vendor，再调用 electron-builder 生成：

- NSIS 安装包：`dist/LightNovelReader-Setup-1.2.0-x64.exe`
- 便携版：`dist/LightNovelReader-Portable-1.2.0-x64.exe`

产物统一输出在 `dist/` 目录。

### 未签名 exe 的 Windows 提示

本项目**不进行代码签名**。双击未签名的 exe 时，Windows SmartScreen 可能显示
“Windows 已保护你的电脑”。此时请点击 **“更多信息” → “仍要运行”**。
如需消除该提示，需要购买代码签名证书，并在 electron-builder 中配置签名。

---

## 数据存储位置

所有数据由 electron-store 保存在 Electron 的 `userData` 目录（`reader-data.json`）：

- Windows：`%APPDATA%\LightNovelReader\`（即 `C:\Users\<你>\AppData\Roaming\LightNovelReader\`）

包含：书库文件夹列表、书籍列表与元数据缓存（含封面缩略图）、每本书的进度/书签（EPUB/TXT/漫画按 `type` 区分）、TXT 章节缓存（`txtCache`）、全局阅读设置、最近打开记录。
应用内“设置”弹窗会显示当前版本与数据目录完整路径。

---

## 使用说明

| 操作 | 说明 |
| --- | --- |
| 导入文件夹 | 顶部“导入文件夹”，选择目录后递归扫描 EPUB / TXT / 漫画 |
| 打开文件 | 顶部“打开文件”，可多选 EPUB / TXT / ZIP / CBZ |
| 打开漫画 | 顶部“打开漫画”，选择一个图片文件夹作为漫画导入 |
| 拖拽导入 | 把文件或图片文件夹拖到窗口（单文件会自动打开） |
| 类型分区 | 书库顶部「全部 / EPUB / TXT / 漫画」切换，不刷新页面、保留滚动位置 |
| TXT 阅读 | 双击 TXT 卡片进入独立 TXT 阅读器；设置里可切换分页/滚动与文件编码 |
| 漫画阅读 | 双击漫画卡片进入独立漫画阅读器；支持单/双页、方向、适合宽度/高度、缩放 |
| 打开书籍 | 双击书卡，或右键“打开阅读” |
| 翻页 | ←/→、PageUp/PageDown、空格、点击阅读区左右两侧、左右滑动 |
| 返回书库 | Esc（无面板时）或左上角 ← |
| 目录/书签/搜索/设置 | 阅读器顶部按钮，侧边栏切换 |

**安全设计**
- 渲染进程 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`
- preload 仅通过 `contextBridge` 暴露白名单 API
- `read-epub` / `read-txt` 只允许读取“书库已登记路径 / 已登记文件夹内路径 / 刚刚通过对话框或拖拽选择的路径”，拒绝任意路径读取
- 漫画图片只通过 `manga://` 协议读取，主进程校验 bookId、来源类型、图片扩展名与路径是否在已登记漫画范围内
- EPUB 内容在 `allowScriptedContent: false` 下渲染，不执行书内脚本

---

## TXT 功能说明

### 支持的编码
自动检测顺序：BOM（UTF-8 / UTF-16 LE / UTF-16 BE）→ 无 BOM UTF-16 启发式 → 严格 UTF-8 校验 → 回退 GB18030（兼容 GBK）。
手动可选：UTF-8、GBK、GB18030、UTF-16 LE/BE、Big5。若乱码，在 TXT 阅读器「设置 → 文件编码」切换后会自动重新读取。

### 章节识别规则
章节标题行需满足：整行较短（≤40 字符）、单独成行、不以 `，。！？；、：` 等标点结尾、章节标记后必须跟空格/冒号/分隔符或行尾。
支持：`第X章/节/回/卷/话/集/部/篇/幕`、`Chapter X`、`序章/序言/楔子/前言/引子/后记/终章/尾声/番外/外传/附录/结局`、`卷X`。
识别不到章节时退化为每约 5000 字一个「分节」，目录与进度仍可用。

### 大文件与虚拟滚动
- 超过 20MB 会提示但仍允许打开；超过 250MB 直接拒绝以防内存耗尽。
- 分页模式只把「当前页」插入 DOM，不会整本渲染。
- 滚动模式按章节/子块（单块 ≤30000 字）窗口化渲染：接近底部才追加下一块，并回收远离视口的旧块（最多保留约 20 块），因此 DOM 不会随阅读无限增长。
- 全文搜索最多返回 200 条，每 50 条让出一次事件循环，避免界面卡死。

### 编码库
主进程使用 `iconv-lite` 解码 GBK/GB18030/Big5/UTF-16；它已被列入 `dependencies` 并打进 asar。

---

## 漫画功能说明

### 支持的格式
- 图片文件夹：目录内直接包含 ≥3 张图片（jpg/jpeg/png/webp/gif/avif/bmp）即视为一本漫画；子目录各自成卷
- ZIP / CBZ：扩展名不区分大小写；只读取图片条目，忽略 `__MACOSX`、`.DS_Store`、`Thumbs.db`、隐藏文件
- CBR / RAR：不支持，书库中会标记“暂不支持”，双击给出转换为 CBZ 的提示

### 图片排序
按自然排序（natural sort），保证 `2.jpg` 在 `10.jpg` 之前；ZIP 内条目与文件夹图片使用同一规则。

### 阅读方向与模式
- 右到左（日漫，默认）：点击阅读区左侧 / 按 ← 翻到下一页，双页时按从右到左排列
- 左到右（韩漫/国漫）：方向反转
- 双页模式在宽屏（≥900px）并排，窄屏自动降级为单页；封面单独一页
- 适合宽度 / 适合高度 / 原始大小；双击放大，放大后可拖拽平移

### 大文件与性能
- ZIP/CBZ 超过 500MB 或图片条目超过 2000 个会提示，但仍允许打开
- 单张图片超过 20MB 会提示
- ZIP 只读取中央目录、按需流式解压单张图片，不整体解压到内存或临时目录
- 预加载当前页前后各 2 页，离开窗口后 `revokeObjectURL` 释放

### 协议与打包
- 自定义 `manga://` 协议在主进程注册，仅允许读取已登记漫画文件夹 / ZIP 内的图片
- `yauzl` 为纯 JS 依赖，已列入 `dependencies` 并打进 asar，无需 `asarUnpack`

---

## 已知限制

- EPUB 仅支持**无 DRM**；带 DRM 会提示“文件不是有效的 EPUB 或包含 DRM”
- 封面解析可能失败（部分 EPUB 封面格式特殊），此时显示占位封面，不影响阅读
- 超大 EPUB（数百 MB）加载与全书搜索可能较慢
- 文件夹递归扫描默认最大深度 5，更深层级的文件需放到更浅目录
- 路径中含特殊字符（中文、空格等）已在 Windows 下测试基本可用，极端情况可能需反馈
- 双栏显示依赖 epub.js 的 spread 能力，部分书籍排版可能与预期不同；**TXT 不支持双栏，已降级为单栏**
- 未对受版权保护书籍做任何内置或下载
- TXT 章节识别是启发式规则，个别排版奇特的文件可能漏识别或多识别；漏识别时可退回分节阅读
- TXT 分页按「实测校准的每页字符数」切片，不同字体下可能仍有一两行误差
- 硬换行（把一段话按固定宽度折断）的 TXT 会被逐行当成段落，缩进效果可能不理想
- 超大 TXT（接近 250MB）解码后字符串会占用较多内存
- 漫画暂不支持 CBR/RAR（请转换为 CBZ）；超大 ZIP 中的图片解码可能较慢
- 漫画双页模式在窄屏自动降级为单页；放大后需拖拽平移
- 漫画阅读方向/单双页/背景色/预加载为独立设置，不影响 EPUB/TXT
- 图片解码失败或协议 404 时显示占位与重试按钮

---

## 项目结构

```
light-novel-reader/
├─ package.json              # 依赖（含 yauzl）、脚本、electron-builder 配置
├─ main.js                   # 主进程：窗口、扫描、安全 IPC、electron-store
├─ preload.cjs               # contextBridge 白名单 API
├─ txt-decoder.js            # 主进程 TXT 编码检测与解码（iconv-lite，可单测）
├─ renderer/
│  ├─ index.html             # 书库 + EPUB 阅读器 + TXT 阅读器
│  ├─ styles.css             # 样式与主题变量
│  ├─ app.js                 # 主控：导航、书库操作、事件
│  ├─ library.js             # 书库渲染、类型分区、元数据懒加载
│  ├─ reader.js              # EPUB 阅读器（epub.js 集成）
│  ├─ txt-parser.js          # TXT 章节解析器（偏移量计算，可单测）
│  ├─ txt-reader.js          # TXT 阅读器（分页/滚动/进度/书签/搜索）
│  ├─ manga-reader.js        # 漫画阅读器（manga://、单/双页、缩放、预加载）
│  ├─ manga.css              # 漫画阅读器样式
│  └─ vendor/                # 由 scripts/copy-vendor.js 生成
│     ├─ epub.min.js         # epub.js 0.3.93
│     └─ jszip.min.js        # epub.js 打开 ArrayBuffer 所必需
├─ scripts/
│  ├─ copy-vendor.js         # 复制 epub.min.js 与 jszip.min.js 到 renderer/vendor
│  └─ make-icon.py           # （可选）生成 build/icon.ico
├─ build/
│  └─ icon.ico               # 应用图标（占位生成，可自行替换）
└─ README.md
```

---

## 自定义图标

`build/icon.ico` 为脚本生成的一个简单“书本”占位图标。如需替换：

1. 准备一个多尺寸 `.ico`（建议含 16/32/48/64/128/256 px）
2. 覆盖 `build/icon.ico`
3. 重新执行 `npm run build:win`

也可以用 Python 重新生成占位图标：

```bash
python scripts/make-icon.py
```

---

## 更新日志

### v1.2.0（2026-11-15）

**TXT 阅读修复**

- 修复编码检测误判：检测只读取文件前 64KB，若切片刚好把一个多字节汉字切断，
  合法的 UTF-8 会被严格校验判为失败并回退成 GB18030，导致打开大型 UTF-8 TXT
  时先显示乱码。现在校验前会最多回退 3 个字节，UTF-8 与 GBK 都能正确识别。
- 记住每本书手动选择的编码：自动检测结果「不确定」时沿用上次的选择，退出重进
  不必再手动切换一次。
- 重新明确 TXT 排版约定：**空行 = 段落分隔**（段内单换行会被合并），并建议 TXT
  存为带 BOM 的 UTF-8，打开即正确分段、正确解码。

**构建**

- Windows：`dist/LightNovelReader-Setup-1.2.0-x64.exe`、`dist/LightNovelReader-Portable-1.2.0-x64.exe`
- Android：`轻小说阅读器-v1.2-android-debug.apk`（versionCode 3，归档于 `APK/`）

### v1.1

- 移动端（Capacitor）适配层、漫画阅读、TXT 编码切换等首轮功能完善。

