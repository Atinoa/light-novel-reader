# 爱丽丝书屋下载器

只输入小说网址，就能把小说下载成本地 TXT（一本一个文件，自动分段、UTF-8 编码）。

## 使用

1. 发布版双击 `爱丽丝书屋下载器.exe`；从源码运行使用 `python alice_gui.py`
2. 把小说网址粘到输入框（一行一个，可以一次粘很多；也支持只填作品 ID，如 `54008`）
3. 点「下载」

首次从源码运行前，复制 `config.example.json` 为 `config.json`，按需修改保存目录和代理：

```bat
copy config.example.json config.json
pip install -r requirements.txt
python alice_gui.py
```

默认保存到阅读器里登记的书库「爱丽丝」文件夹，可在界面上改成任意目录。
已存在的同名 txt 会自动跳过；勾选「覆盖已存在」则重新下载。

## 支持的网址

```
https://www.alicesw2.homes/novel/54008.html
https://www.alicesw2.homes/novel/2773.html
54008
```

## 下载格式

- 一本小说 = 一个 txt
- 每个自然段之间空一行（阅读器按空行分段）
- UTF-8 带 BOM（双击打开不会乱码）
- 开头带书名、作者、来源链接、字数、章数
- 缺章 / 失败会在日志里标出来，可重跑（不会重复下载已有的）

## 关于网络

站点在部分网络下会被随机重置连接，程序内置了重试与退避。
如果你有代理软件（Clash 等），程序会自动检测 `127.0.0.1:7897` 等常见端口并使用；
也可以在「代理」框里手填，例如 `http://127.0.0.1:7897`。

## 「修复已有 txt 排版」

如果某些 TXT 在阅读器里没有分段或乱码，点这个按钮会把目标目录下的 txt
重排成「空行分段 + UTF-8 BOM」。只调整排版，不改正文。

## 源码 / 重新打包

```
alice_core.py    # 下载核心（抓取、解析、写文件）
alice_gui.py     # 图形界面（tkinter）
icon.ico         # 图标（icon.png 为预览图）
version_info.txt # exe 版本资源
```

重新打包（需 Python + `pip install pyinstaller requests lxml`）：

```bat
python -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name "爱丽丝书屋下载器" --icon icon.ico --version-file version_info.txt ^
  --exclude-module numpy --exclude-module pandas --exclude-module matplotlib ^
  --exclude-module PIL --exclude-module scipy alice_gui.py
```

产物在 `dist\爱丽丝书屋下载器.exe`。

## 命令行版本

当前仓库只包含 GUI 版本；命令行脚本未包含。
