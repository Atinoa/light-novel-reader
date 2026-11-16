# -*- coding: utf-8 -*-
"""
爱丽丝书屋下载器（图形界面）
============================
只输入小说网址即可下载，一本一个 txt，自动排版（空行分段 + UTF-8 BOM）。

运行：python alice_gui.py
打包：build_exe.cmd（PyInstaller 单文件 exe）
"""

import json
import os
import queue
import re
import sys
import threading
import tkinter as tk
import traceback
from tkinter import filedialog, messagebox, ttk

import alice_core
from alice_core import Downloader, detect_proxy, normalize_url

APP_TITLE = "爱丽丝书屋下载器"
APP_VERSION = "1.0"
CONFIG_NAME = "config.json"


# ---------------------------------------------------------------- 路径

def app_dir():
    """exe 所在目录；源码运行时是本文件目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _reader_library_folders():
    """读取轻小说阅读器的书库文件夹列表（如果有）。"""
    p = os.path.join(os.environ.get("APPDATA", ""), "light-novel-reader", "reader-data.json")
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
        out = []
        for item in data.get("folders") or []:
            path = (item or {}).get("path")
            name = (item or {}).get("name") or ""
            if path and os.path.isdir(path):
                out.append((name, path))
        return out
    except Exception:
        return []


def library_dir():
    """默认保存目录：优先阅读器里登记过、名字带「爱丽丝」的书库，
    其次程序附近名为「爱丽丝」的文件夹，最后退到程序旁的「下载」。"""
    for name, path in _reader_library_folders():
        if "爱丽丝" in name or "爱丽丝" in os.path.basename(path):
            return path
    libs = _reader_library_folders()
    if libs:
        return libs[-1][1]

    base = app_dir()
    near = [os.path.join(base, "爱丽丝"),
            os.path.join(os.path.dirname(base), "爱丽丝"),
            os.path.join(os.path.dirname(os.path.dirname(base)), "爱丽丝")]
    # 常见布局：...\轻小说阅读区\这个是epub文件存放点，不可动\爱丽丝
    near.append(os.path.join(os.path.dirname(os.path.dirname(base)),
                             "这个是epub文件存放点，不可动", "爱丽丝"))
    for cand in near:
        if os.path.isdir(cand):
            return cand
    try:
        default = os.path.join(base, "下载")
        os.makedirs(default, exist_ok=True)
        return default
    except Exception:
        return base


def config_path():
    for d in (app_dir(), os.path.join(os.environ.get("APPDATA", ""), "AliceDownloader")):
        try:
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, CONFIG_NAME)
            open(p, "a", encoding="utf-8").close()
            return p
        except Exception:
            continue
    return None


def load_config():
    p = config_path()
    if not p or not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save_config(data):
    p = config_path()
    if not p:
        return
    try:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ---------------------------------------------------------------- 界面

class App:
    def __init__(self, root):
        self.root = root
        self.queue = queue.Queue()
        self.worker = None
        self.cancel_event = threading.Event()
        self.running = False
        self.last_dir = None
        self.finished_books = 0
        self.total_books = 0
        self.current_book = ""
        self.cfg = load_config()

        root.title("%s v%s" % (APP_TITLE, APP_VERSION))
        root.geometry("880x640")
        root.minsize(760, 560)
        try:
            root.iconbitmap(os.path.join(app_dir(), "icon.ico"))
        except Exception:
            pass

        self._build_ui()
        self._load_defaults()
        root.after(120, self._drain_queue)
        root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ---- 布局 ----
    def _build_ui(self):
        pad = dict(padx=12, pady=(10, 0))
        style = ttk.Style()
        try:
            style.configure("Big.TButton", padding=(14, 6))
        except Exception:
            pass

        top = ttk.Frame(self.root)
        top.pack(fill="x", **pad)
        ttk.Label(top, text="小说网址（一行一个，可直接粘贴；也支持只填作品 ID，如 54008）",
                  font=("Microsoft YaHei UI", 9)).pack(anchor="w")

        url_box = ttk.Frame(self.root)
        url_box.pack(fill="x", padx=12, pady=(4, 0))
        self.txt_urls = tk.Text(url_box, height=4, wrap="none",
                                font=("Consolas", 10), undo=True)
        ys = ttk.Scrollbar(url_box, orient="vertical", command=self.txt_urls.yview)
        xs = ttk.Scrollbar(url_box, orient="horizontal", command=self.txt_urls.xview)
        self.txt_urls.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)
        self.txt_urls.grid(row=0, column=0, sticky="nsew")
        ys.grid(row=0, column=1, sticky="ns")
        xs.grid(row=1, column=0, sticky="ew")
        url_box.rowconfigure(0, weight=1)
        url_box.columnconfigure(0, weight=1)

        row = ttk.Frame(self.root)
        row.pack(fill="x", padx=12, pady=(6, 0))
        ttk.Button(row, text="粘贴", width=6, command=self._paste).pack(side="left")
        ttk.Button(row, text="清空", width=6, command=lambda: self.txt_urls.delete("1.0", "end")).pack(side="left", padx=(6, 0))
        self.lbl_parse = ttk.Label(row, text="", foreground="#666")
        self.lbl_parse.pack(side="left", padx=(10, 0))

        # 保存位置
        row2 = ttk.Frame(self.root)
        row2.pack(fill="x", padx=12, pady=(10, 0))
        ttk.Label(row2, text="保存到").pack(side="left")
        self.var_out = tk.StringVar(value=library_dir())
        ttk.Entry(row2, textvariable=self.var_out).pack(side="left", fill="x", expand=True, padx=(8, 6))
        ttk.Button(row2, text="浏览…", command=self._browse).pack(side="left")
        ttk.Button(row2, text="打开", width=6, command=self._open_folder).pack(side="left", padx=(6, 0))

        # 选项
        row3 = ttk.Frame(self.root)
        row3.pack(fill="x", padx=12, pady=(10, 0))
        ttk.Label(row3, text="并发").pack(side="left")
        self.var_workers = tk.IntVar(value=6)
        ttk.Spinbox(row3, from_=1, to=12, width=4, textvariable=self.var_workers).pack(side="left", padx=(6, 14))

        ttk.Label(row3, text="代理").pack(side="left")
        self.var_proxy = tk.StringVar(value="")
        ttk.Entry(row3, textvariable=self.var_proxy, width=26).pack(side="left", padx=(6, 6))
        self.var_auto_proxy = tk.BooleanVar(value=True)
        ttk.Checkbutton(row3, text="自动检测本机代理", variable=self.var_auto_proxy).pack(side="left")

        self.var_overwrite = tk.BooleanVar(value=False)
        ttk.Checkbutton(row3, text="覆盖已存在", variable=self.var_overwrite).pack(side="left", padx=(12, 0))

        # 按钮 + 进度
        row4 = ttk.Frame(self.root)
        row4.pack(fill="x", padx=12, pady=(12, 0))
        self.btn_start = ttk.Button(row4, text="下载", style="Big.TButton", command=self._start)
        self.btn_start.pack(side="left")
        self.btn_stop = ttk.Button(row4, text="停止", command=self._stop, state="disabled")
        self.btn_stop.pack(side="left", padx=(8, 0))
        self.btn_reformat = ttk.Button(row4, text="修复已有 txt 排版", command=self._reformat)
        self.btn_reformat.pack(side="right")

        self.pb = ttk.Progressbar(self.root, mode="determinate", maximum=100)
        self.pb.pack(fill="x", padx=12, pady=(10, 0))
        self.lbl_status = ttk.Label(self.root, text="就绪", font=("Microsoft YaHei UI", 9))
        self.lbl_status.pack(fill="x", padx=12, pady=(4, 0))

        # 日志
        logf = ttk.Frame(self.root)
        logf.pack(fill="both", expand=True, padx=12, pady=(8, 12))
        self.txt_log = tk.Text(logf, height=10, wrap="word", state="disabled",
                               font=("Microsoft YaHei UI", 9), background="#fbfbfb")
        ysl = ttk.Scrollbar(logf, orient="vertical", command=self.txt_log.yview)
        self.txt_log.configure(yscrollcommand=ysl.set)
        self.txt_log.pack(side="left", fill="both", expand=True)
        ysl.pack(side="right", fill="y")

        self.txt_urls.bind("<<Modified>>", self._on_url_change)
        self.root.bind("<Control-Return>", lambda e: self._start())
        self._set_log_lines = 0

    def _load_defaults(self):
        cfg = self.cfg
        if cfg.get("out_dir") and os.path.isdir(cfg["out_dir"]):
            self.var_out.set(cfg["out_dir"])
        if cfg.get("workers"):
            try:
                self.var_workers.set(int(cfg["workers"]))
            except Exception:
                pass
        if cfg.get("proxy") is not None:
            self.var_proxy.set(cfg["proxy"])
        if "auto_proxy" in cfg:
            self.var_auto_proxy.set(bool(cfg["auto_proxy"]))
        if cfg.get("overwrite") is not None:
            self.var_overwrite.set(bool(cfg["overwrite"]))
        self._append_log("把小说网址粘到上面，点「下载」即可。默认保存到：%s" % self.var_out.get())
        p = detect_proxy()
        if p:
            self._append_log("检测到本机代理：%s（下载时会自动使用）" % p)

    # ---- 小工具 ----
    def _append_log(self, text):
        self.txt_log.configure(state="normal")
        self.txt_log.insert("end", text + "\n")
        # 控制日志长度
        lines = int(self.txt_log.index("end-1c").split(".")[0])
        if lines > 3000:
            self.txt_log.delete("1.0", "400.0")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _parse_urls(self):
        raw = self.txt_urls.get("1.0", "end")
        entries, seen = [], set()
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            got = normalize_url(line)
            if got and got[0] not in seen:
                seen.add(got[0])
                entries.append(got)
        return entries

    def _on_url_change(self, _e=None):
        try:
            self.txt_urls.edit_modified(False)
        except Exception:
            pass
        entries = self._parse_urls()
        n = len(entries)
        if n:
            self.lbl_parse.configure(text="识别到 %d 个作品" % n, foreground="#1a7f37")
        else:
            self.lbl_parse.configure(text="还没识别到有效网址", foreground="#b42318")

    def _paste(self):
        try:
            data = self.root.clipboard_get()
        except Exception:
            return
        if data:
            if self.txt_urls.get("1.0", "end").strip():
                self.txt_urls.insert("end", "\n" + data)
            else:
                self.txt_urls.delete("1.0", "end")
                self.txt_urls.insert("1.0", data)
            self._on_url_change()

    def _browse(self):
        d = filedialog.askdirectory(initialdir=self.var_out.get() or os.path.expanduser("~"))
        if d:
            self.var_out.set(d)
            self._on_url_change()

    def _open_folder(self):
        d = self.var_out.get()
        if not os.path.isdir(d):
            messagebox.showwarning(APP_TITLE, "目录不存在：%s" % d)
            return
        try:
            os.startfile(d)
        except Exception as e:
            messagebox.showerror(APP_TITLE, "打不开目录：%s" % e)

    # ---- 下载 ----
    def _start(self):
        if self.running:
            return
        entries = self._parse_urls()
        if not entries:
            messagebox.showinfo(APP_TITLE, "请先粘贴小说网址，例如：\nhttps://www.alicesw2.homes/novel/54008.html")
            return
        out = self.var_out.get().strip()
        if not out:
            messagebox.showinfo(APP_TITLE, "请选择保存目录")
            return
        try:
            os.makedirs(out, exist_ok=True)
        except Exception as e:
            messagebox.showerror(APP_TITLE, "无法创建目录：%s" % e)
            return

        proxy = self.var_proxy.get().strip() or None
        if not proxy and self.var_auto_proxy.get():
            proxy = detect_proxy()

        self.running = True
        self.cancel_event.clear()
        self.finished_books = 0
        self.total_books = len(entries)
        self.pb.configure(value=0)
        self.btn_start.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.btn_reformat.configure(state="disabled")
        self._append_log("\n" + "=" * 46)
        self._append_log("开始下载 %d 本，保存到 %s" % (len(entries), out))
        if proxy:
            self._append_log("使用代理：%s" % proxy)

        save_config({
            "out_dir": out,
            "workers": self.var_workers.get(),
            "proxy": self.var_proxy.get().strip(),
            "auto_proxy": self.var_auto_proxy.get(),
            "overwrite": self.var_overwrite.get(),
        })

        def log_cb(m):
            self.queue.put(("log", m))

        def start_cb(info, idx, total):
            self.queue.put(("book_start", (info, idx, total)))

        def prog_cb(done, total):
            self.queue.put(("progress", (done, total)))

        def done_cb(status, title, detail):
            self.queue.put(("book_done", (status, title, detail)))

        dl = Downloader(
            out_dir=out,
            workers=self.var_workers.get(),
            proxy=proxy,
            overwrite=self.var_overwrite.get(),
            on_log=log_cb,
            on_book_start=start_cb,
            on_book_progress=prog_cb,
            on_book_done=done_cb,
            cancel_event=self.cancel_event,
        )

        def run():
            stats, problems = {}, []
            try:
                stats, problems = dl.download(entries)
            except Exception:
                self.queue.put(("log", "下载线程异常：\n" + traceback.format_exc()))
            self.queue.put(("finished", (stats, problems)))

        self.worker = threading.Thread(target=run, daemon=True)
        self.worker.start()

    def _stop(self):
        if self.running:
            self.cancel_event.set()
            self.btn_stop.configure(state="disabled")
            self._append_log("正在停止…（等当前章节抓完）")

    def _reformat(self):
        d = self.var_out.get().strip()
        if not os.path.isdir(d):
            messagebox.showwarning(APP_TITLE, "目录不存在")
            return
        files = [os.path.join(d, n) for n in sorted(os.listdir(d))
                 if n.lower().endswith(".txt") and n not in alice_core.SKIP_NAMES]
        if not files:
            messagebox.showinfo(APP_TITLE, "这个目录里没有 txt")
            return
        if not messagebox.askyesno(APP_TITLE, "要把这 %d 个 txt 重排成「空行分段 + UTF-8 BOM」吗？\n（只调整排版，不改正文）" % len(files)):
            return
        ok = 0
        for p in files:
            try:
                if alice_core.reformat_file(p):
                    ok += 1
            except Exception:
                pass
        self._append_log("已重排 %d / %d 个 txt" % (ok, len(files)))
        messagebox.showinfo(APP_TITLE, "完成：重排 %d / %d 个文件" % (ok, len(files)))

    # ---- 主线程消息泵 ----
    def _drain_queue(self):
        try:
            while True:
                kind, payload = self.queue.get_nowait()
                if kind == "log":
                    self._append_log(payload)
                elif kind == "book_start":
                    info, idx, total = payload
                    self.current_book = info.get("title") or info.get("id")
                    self.lbl_status.configure(text="[%d/%d] %s" % (idx, total, self.current_book))
                elif kind == "progress":
                    done, total = payload
                    frac = (done / total) if total else 0
                    pct = ((self.finished_books + frac) / max(1, self.total_books)) * 100
                    self.pb.configure(value=pct)
                    self.lbl_status.configure(
                        text="%s　%d/%d 章" % (self.current_book, done, total))
                elif kind == "book_done":
                    status, title, detail = payload
                    self.finished_books += 1
                    tag = {"OK": "完成", "PART": "部分", "SKIP": "跳过", "FAIL": "失败"}.get(status, status)
                    self._append_log("[%s] %s —— %s" % (tag, title, detail))
                    self.pb.configure(value=(self.finished_books / max(1, self.total_books)) * 100)
                elif kind == "finished":
                    stats, problems = payload
                    self.running = False
                    self.btn_start.configure(state="normal")
                    self.btn_stop.configure(state="disabled")
                    self.btn_reformat.configure(state="normal")
                    self.lbl_status.configure(text="就绪")
                    ok = stats.get("OK", 0)
                    part = stats.get("PART", 0)
                    fail = stats.get("FAIL", 0)
                    skip = stats.get("SKIP", 0)
                    self._append_log("\n本次结束：成功 %d，部分 %d，失败 %d，跳过 %d"
                                     % (ok, part, fail, skip))
                    if self.cancel_event.is_set():
                        messagebox.showinfo(APP_TITLE, "已停止。\n成功 %d 本，部分 %d 本。" % (ok, part))
                    elif fail or part:
                        messagebox.showwarning(APP_TITLE, "完成，但有 %d 本失败 / %d 本缺章。\n详情见下方日志。"
                                               % (fail, part))
                    else:
                        messagebox.showinfo(APP_TITLE, "全部完成：%d 本。\n保存位置：%s" % (ok + skip, self.var_out.get()))
        except queue.Empty:
            pass
        self.root.after(150, self._drain_queue)

    def _on_close(self):
        if self.running:
            if not messagebox.askyesno(APP_TITLE, "正在下载，确定要退出吗？"):
                return
            self.cancel_event.set()
        self.root.destroy()


def main():
    if alice_core.lxml is None:
        messagebox.showerror(APP_TITLE, "缺少 lxml 库，请先运行：\npython -m pip install lxml")
        return
    # 高分屏下文字清晰（Windows）
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
