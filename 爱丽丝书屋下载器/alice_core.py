# -*- coding: utf-8 -*-
"""
alice_core.py —— 爱丽丝书屋小说下载核心
========================================
只负责「拿数据 + 解析 + 写文件」，不含任何界面代码，
CLI（爱丽丝书屋下载器.py）和 GUI（alice_gui.py）共用这一份逻辑。

对外主要接口：
    Downloader(out_dir, ...).download(urls, ...)   # 批量下载
    normalize_url(text) -> (book_id, url) | None   # 解析用户输入
"""

import os
import random
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import urllib3

try:
    import lxml.html
except ImportError:  # pragma: no cover
    lxml = None

urllib3.disable_warnings()

DEFAULT_BASE = "https://www.alicesw2.homes"

UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
]

_THREAD_LOCAL = threading.local()


class DownloadCancelled(Exception):
    """用户点了停止。"""


# ---------------------------------------------------------------- HTTP

def new_session(proxy=None):
    s = requests.Session()
    s.headers.update({
        "User-Agent": random.choice(UA_POOL),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    })
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    s.mount("https://", requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=16))
    s.mount("http://", requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=16))
    return s


def _session(proxy):
    s = getattr(_THREAD_LOCAL, "session", None)
    if s is None or getattr(_THREAD_LOCAL, "proxy", None) != proxy:
        s = new_session(proxy)
        _THREAD_LOCAL.session = s
        _THREAD_LOCAL.proxy = proxy
    return s


def fetch(url, proxy=None, tries=14, timeout=25, min_len=800, cancel_event=None):
    """带重试的 GET，返回解码后的 HTML；彻底失败返回 None。"""
    last_err = None
    for i in range(tries):
        if cancel_event is not None and cancel_event.is_set():
            return None
        try:
            r = _session(proxy).get(url, timeout=timeout)
            if r.status_code == 200 and len(r.content) >= min_len:
                r.encoding = "utf-8"
                return r.text
            last_err = "HTTP %s / %s bytes" % (r.status_code, len(r.content))
        except Exception as e:  # 连接重置、超时等
            last_err = type(e).__name__
            try:
                _THREAD_LOCAL.session = new_session(proxy)
            except Exception:
                pass
        time.sleep(min(0.35 * (i + 1), 3.0) * (0.7 + random.random() * 0.6))
    return None


def detect_proxy():
    """本机常见代理端口在监听就返回代理地址。"""
    for host, port in (("127.0.0.1", 7897), ("127.0.0.1", 7890),
                       ("127.0.0.1", 10809), ("127.0.0.1", 1080),
                       ("127.0.0.1", 7891)):
        s = socket.socket()
        s.settimeout(0.25)
        try:
            s.connect((host, port))
            return "http://%s:%d" % (host, port)
        except OSError:
            pass
        finally:
            try:
                s.close()
            except Exception:
                pass
    return None


# ---------------------------------------------------------------- 输入解析

def normalize_url(text):
    """接受完整链接 / 只带 id 的片段，返回 (book_id, 规范化URL) 或 None。"""
    if not text:
        return None
    text = text.strip()
    m = re.search(r"https?://[^\s]+", text)
    if m:
        url = m.group(0).rstrip(".,;)]}\"'")
        mid = re.search(r"/novel/(\d+)\.html", url)
        if not mid:
            mid = re.search(r"/novel/(\d+)", url)
        if not mid:
            return None
        base = re.match(r"(https?://[^/]+)", url).group(1)
        return mid.group(1), "%s/novel/%s.html" % (base, mid.group(1))
    m = re.fullmatch(r"(\d{1,8})", text)
    if m:
        return m.group(1), "%s/novel/%s.html" % (DEFAULT_BASE, m.group(1))
    return None


def parse_book_id(url):
    m = re.search(r"/novel/(\d+)\.html", url or "")
    return m.group(1) if m else None


# ---------------------------------------------------------------- 解析

def clean_text(s):
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


HEADING_TAIL = re.compile(
    r"^(第[0-9０-９一二三四五六七八九十百千万亿零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+"
    r"[章节回卷话集部篇幕])[】\]〕]+$")

AD_PATTERNS = re.compile(
    r"(最新网址|最新地址|请记住本站|记住本站|本站域名|永久域名|备用网址|"
    r"http[s]?://|www\.|手机阅读|手机版阅读|下载.{0,4}APP|最新章节来自)", re.I)

SKIP_NAMES = {"小说链接.txt", "下载日志.txt"}


def clean_heading(name):
    t = (name or "").strip()
    m = HEADING_TAIL.match(t)
    return m.group(1) if m else t


def safe_filename(name, maxlen=90):
    name = re.sub(r"[\u200b-\u200f\u2028-\u202f\u2060\ufeff\u00ad]", "", name or "")
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > maxlen:
        name = name[:maxlen].rstrip(" .")
    return name or "未命名"


def strip_ads(paras):
    out = [p for p in paras if not (len(p) < 60 and AD_PATTERNS.search(p))]
    return out or paras


def fetch_book_info(book_id, base, proxy=None, cancel_event=None):
    url = "%s/novel/%s.html" % (base, book_id)
    html = fetch(url, proxy=proxy, cancel_event=cancel_event)
    if not html:
        return None
    doc = lxml.html.fromstring(html)

    title = ""
    for xp in ('//div[contains(@class,"novel_title")]',
               '//h1[contains(@class,"novel_title")]',
               '//h1'):
        els = doc.xpath(xp)
        if els:
            t = clean_text(els[0].text_content())
            if t:
                title = t
                break
    if not title:
        m = re.search(r"<title>(.*?)</title>", html, re.S)
        if m:
            title = clean_text(m.group(1)).split("-")[0]

    info_text = ""
    els = doc.xpath('//div[contains(@class,"novel_info")]')
    if els:
        info_text = clean_text(" ".join(els[0].text_content().split()))

    author = ""
    m = re.search(r"作\s*者[：:]\s*([^\s]+)", info_text)
    if m:
        author = m.group(1).strip()

    chapter_count = 0
    m = re.search(r"章\s*节[：:]\s*(\d+)", info_text)
    if m:
        chapter_count = int(m.group(1))

    words = ""
    m = re.search(r"字\s*数[：:]\s*([\d.]+\s*万?)", info_text)
    if m:
        words = m.group(1).replace(" ", "")

    catalog_url = "%s/other/chapters/id/%s.html" % (base, book_id)
    hrefs = doc.xpath('//a[contains(@href,"/other/chapters/id/")]/@href')
    picked = None
    for href in hrefs:
        if re.search(r"/other/chapters/id/%s(?:\.html|/)" % re.escape(book_id), href):
            picked = href
            break
    if picked is None and hrefs:
        picked = hrefs[0]
    if picked:
        catalog_url = picked if picked.startswith("http") else base + picked

    return {
        "id": book_id,
        "title": title,
        "author": author,
        "words": words,
        "chapter_count": chapter_count,
        "url": "%s/novel/%s.html" % (base, book_id),
        "catalog_url": catalog_url,
    }


def fetch_catalog(catalog_url, base, proxy=None, cancel_event=None):
    html = fetch(catalog_url, proxy=proxy, cancel_event=cancel_event)
    if not html:
        return None
    doc = lxml.html.fromstring(html)
    out, seen = [], set()
    for a in doc.xpath('//a[@href]'):
        href = a.get("href") or ""
        if not re.search(r"/book/\d+/[0-9a-zA-Z]+\.html", href):
            continue
        full = href if href.startswith("http") else base + href
        if full in seen:
            continue
        seen.add(full)
        out.append((clean_text(a.text_content()), full))
    return out


def fetch_chapter(url, proxy=None, cancel_event=None):
    html = fetch(url, proxy=proxy, min_len=600, cancel_event=cancel_event)
    if not html:
        return None
    doc = lxml.html.fromstring(html)
    body = None
    for xp in ('//div[contains(@class,"read-content")]',
               '//div[@id="chaptercontent"]',
               '//div[contains(@class,"content")]'):
        els = doc.xpath(xp)
        if els:
            body = els[0]
            break
    if body is None:
        return None

    for bad in body.xpath('.//div|.//script|.//ins|.//iframe'):
        bad.getparent().remove(bad)

    ps = body.xpath(".//p")
    raw = [p.text_content() for p in ps] if ps else body.text_content().split("\n")
    paras = [clean_text(t) for t in raw]
    paras = [p for p in paras if p]
    if not paras:
        return None

    title = ""
    for xp in ('//div[contains(@class,"text-head")]',
               '//h1[contains(@class,"text-head")]'):
        els = doc.xpath(xp)
        if els:
            title = clean_text(els[0].text_content().split("\n")[0])
            break
    return title, paras


# ---------------------------------------------------------------- 写文件

def write_book(info, chapters, folder, overwrite=False):
    """写出单本 txt（空行分段 + UTF-8 BOM）。返回路径。"""
    title = info["title"] or ("书籍" + info["id"])
    fname = safe_filename(title) + ".txt"
    path = os.path.join(folder, fname)
    if os.path.exists(path) and not overwrite:
        base, ext = os.path.splitext(fname)
        path = os.path.join(folder, "%s_%s%s" % (base, info["id"], ext))

    blocks = [title, "作者：%s" % (info.get("author") or "未知")]
    blocks.append("来源：%s" % info["url"])
    if info.get("words"):
        blocks.append("字数：%s" % info["words"])
    blocks.append("共 %d 章" % len(chapters))
    blocks.append("=" * 40)

    for ctitle, paras in chapters:
        if ctitle:
            blocks.append(clean_heading(ctitle))
        blocks.extend(p for p in paras if p.strip())

    body = "\ufeff" + "\n\n".join(b.strip() for b in blocks if b.strip()) + "\n"
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    os.replace(tmp, path)
    return path


def reformat_file(path):
    """把已有 txt 重排成空行分段 + BOM（只动排版，不改文字）。"""
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks = []
    for line in lines:
        t = line.strip().lstrip("\ufeff")
        if t:
            blocks.append(clean_heading(t))
    if not blocks:
        return False
    body = "\ufeff" + "\n\n".join(blocks) + "\n"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    os.replace(tmp, path)
    return True


def allowed_path_for(dirpath, title, book_id):
    """预测某本书会写到哪个文件（用于「已存在就跳过」）。"""
    return os.path.join(dirpath, safe_filename(title) + ".txt")


# ---------------------------------------------------------------- 下载器

class Downloader:
    """一个可复用的下载器，GUI/CLI 都包它。

    回调（都可在任意线程触发，GUI 侧需自行丢进队列）：
        on_log(str)
        on_book_start(info, index, total)
        on_book_progress(done, total_chapters)
        on_book_done(status, title, detail)   # status: OK/PART/FAIL/SKIP
    """

    def __init__(self, out_dir, workers=6, proxy=None, overwrite=False,
                 on_log=None, on_book_start=None, on_book_progress=None,
                 on_book_done=None, cancel_event=None):
        self.out_dir = out_dir
        self.workers = max(1, int(workers))
        self.proxy = proxy
        self.overwrite = overwrite
        self.on_log = on_log or (lambda m: None)
        self.on_book_start = on_book_start or (lambda i, idx, n: None)
        self.on_book_progress = on_book_progress or (lambda d, t: None)
        self.on_book_done = on_book_done or (lambda s, t, d: None)
        self.cancel_event = cancel_event or threading.Event()

    def log(self, msg):
        self.on_log(msg)

    # ---- 单本 ----
    def download_book(self, book_id, base):
        if self.cancel_event.is_set():
            raise DownloadCancelled()

        info = fetch_book_info(book_id, base, self.proxy, self.cancel_event)
        if not info or not info["title"]:
            return "FAIL", "书籍 %s" % book_id, "书籍页获取失败"

        title = info["title"]
        dst = allowed_path_for(self.out_dir, title, info["id"])
        if os.path.exists(dst) and not self.overwrite:
            return "SKIP", title, "文件已存在"

        self.log("[书籍] %s  作者:%s  章节:%s  字数:%s" % (
            title, info["author"] or "?", info["chapter_count"] or "?", info["words"] or "?"))

        catalog = fetch_catalog(info["catalog_url"], base, self.proxy, self.cancel_event)
        if not catalog:
            return "FAIL", title, "目录页获取失败"
        self.log("[目录] 共 %d 个章节链接" % len(catalog))

        results = {}
        failed = []
        done = 0
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            futs = {ex.submit(fetch_chapter, u, self.proxy, self.cancel_event): i
                    for i, (n, u) in enumerate(catalog)}
            for fut in as_completed(futs):
                i = futs[fut]
                name, u = catalog[i]
                try:
                    r = fut.result()
                except Exception:
                    r = None
                if r is None:
                    failed.append(i)
                else:
                    ctitle, paras = r
                    results[i] = (name or ctitle, strip_ads(paras))
                done += 1
                self.on_book_progress(done, len(catalog))

        if self.cancel_event.is_set():
            raise DownloadCancelled()

        # 补漏：失败章节串行重试
        if failed:
            self.log("[重试] 失败章节 %d 个，逐个补抓" % len(failed))
            still = []
            for i in failed:
                name, u = catalog[i]
                r = fetch_chapter(u, self.proxy, self.cancel_event)
                if r is None:
                    still.append(i)
                else:
                    ctitle, paras = r
                    results[i] = (name or ctitle, strip_ads(paras))
            failed = still

        chapters = [results[i] for i in range(len(catalog)) if i in results]
        if not chapters:
            return "FAIL", title, "正文全部获取失败"

        path = write_book(info, chapters, self.out_dir, overwrite=self.overwrite)
        if failed:
            return "PART", title, "缺 %d 章（已写出 %d 章）" % (len(failed), len(chapters))
        return "OK", title, "%d 章" % len(chapters)

    # ---- 批量 ----
    def download(self, entries):
        """entries: [(book_id, url), ...]；返回 stats 与问题列表。"""
        os.makedirs(self.out_dir, exist_ok=True)
        stats = {"OK": 0, "PART": 0, "FAIL": 0, "SKIP": 0}
        problems = []
        total = len(entries)

        for idx, (book_id, url) in enumerate(entries, 1):
            if self.cancel_event.is_set():
                break
            base = re.match(r"(https?://[^/]+)", url).group(1)
            self.log("\n=== [%d/%d] %s ===" % (idx, total, url))
            try:
                info = fetch_book_info(book_id, base, self.proxy, self.cancel_event)
                if info:
                    self.on_book_start(info, idx, total)
                status, title, detail = self.download_book(book_id, base)
            except DownloadCancelled:
                self.log("[停止] 用户取消")
                break
            except Exception as e:
                status, title, detail = "FAIL", "书籍 %s" % book_id, "%s: %s" % (type(e).__name__, e)

            stats[status] = stats.get(status, 0) + 1
            self.on_book_done(status, title, detail)
            if status != "SKIP":
                time.sleep(random.uniform(0.6, 1.6))

        return stats, problems
