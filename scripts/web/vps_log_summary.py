#!/usr/bin/env python3
"""PostDeck website analytics: read-only nginx log + form relay summary.

Piped over SSH from the Mac and run on the VPS:
  ssh my-vps python3 - --days 14 --tz America/New_York \
      --domains a.com,b.com [--self-ip X ...] [--active-window 30] < vps_log_summary.py

Reads /var/log/nginx/access.log* (vhost format, host first; gz too) and
`journalctl -u form-relay`. Writes nothing to disk. Prints one JSON object.
Standard library only. Parsing rules are copied from
/opt/agentic-os/reports/traffic_report.py (not imported).

Hidden test options: --log-dir, --journal-file, --now (ISO, fixed clock).
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from zoneinfo import ZoneInfo

LINE = re.compile(
    r'^(?P<host>\S+) (?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] "(?P<method>[A-Z]+) (?P<path>\S+)[^"]*" '
    r'(?P<status>\d{3}) \S+ "(?P<ref>[^"]*)" "(?P<ua>[^"]*)"'
)
SEARCH_BOTS = ["googlebot", "bingbot"]
AI_BOTS = ["gptbot", "oai-searchbot", "chatgpt-user", "claudebot", "claude-user", "perplexitybot",
           "google-extended", "applebot", "bytespider", "ccbot", "amazonbot"]
BOT_UA = re.compile(
    r"bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|curl|wget|python|"
    r"go-http|okhttp|axios|node-fetch|undici|headless|lighthouse|pagespeed|scan|httpclient|"
    r"java/|libwww|zgrab|masscan|censys|nmap|agentic-os|dataforseo|ahrefs|semrush|feed|"
    r"whatsapp|telegram|discord|slack|skype|^-$|^$", re.I)
SCANNER_PATH = re.compile(r"wp-|xmlrpc|/\.(env|git|aws|ssh|vscode|DS_Store)|readme\.html|phpmyadmin|"
                          r"/cgi-bin|\.(php|asp|aspx|jsp|cgi|bak|sql|zip|tar|gz)$|/vendor/|/admin|/config", re.I)
ASSET = re.compile(r"\.(css|js|mjs|map|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|mp4|webm|"
                   r"pdf|txt|xml|json|webmanifest|php)$", re.I)

SEARCH_RE = re.compile(r"(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex|ecosia|brave)\.[a-z.]+$")
SEARCH_NAMES = {"google", "bing", "duckduckgo", "yahoo", "baidu", "yandex", "ecosia", "brave"}
SOCIAL_HOSTS = {
    "linkedin.com": "linkedin", "lnkd.in": "linkedin",
    "facebook.com": "facebook", "l.facebook.com": "facebook", "m.facebook.com": "facebook",
    "lm.facebook.com": "facebook", "instagram.com": "instagram", "l.instagram.com": "instagram",
    "t.co": "x", "x.com": "x", "twitter.com": "x", "threads.net": "threads",
    "tiktok.com": "tiktok", "youtube.com": "youtube", "bsky.app": "bluesky",
    "pinterest.com": "pinterest", "reddit.com": "reddit",
}
SOCIAL_NAMES = {"linkedin", "facebook", "instagram", "x", "threads", "tiktok", "youtube",
                "bluesky", "pinterest", "reddit"}
SOCIAL_ALIASES = {"twitter": "x", "li": "linkedin", "fb": "facebook", "ig": "instagram",
                  "yt": "youtube", "bsky": "bluesky", "lnkd.in": "linkedin"}
AI_HOSTS = {"chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com",
            "copilot.microsoft.com", "claude.ai", "you.com"}
WEBMAIL_HOSTS = {"mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
                 "mail.yahoo.com", "mail.proton.me", "mail.aol.com"}


def bare(host: str) -> str:
    host = (host or "").lower().split(":")[0]
    return host[4:] if host.startswith("www.") else host


def host_in(host: str, table) -> bool:
    return any(host == h or host.endswith("." + h) for h in table)


def classify_host(host: str):
    """referrer host -> (channel, src) or None when it is an unknown site."""
    if host in WEBMAIL_HOSTS:
        return ("email", host)
    if host in AI_HOSTS or host_in(host, AI_HOSTS):
        return ("ai", host)
    if host in SOCIAL_HOSTS:
        return ("social", SOCIAL_HOSTS[host])
    for h, name in SOCIAL_HOSTS.items():
        if host.endswith("." + h):
            return ("social", name)
    m = SEARCH_RE.search(host)
    if m:
        return ("search", m.group(2))
    return None


# Referral spam, from the Agentic OS traffic report. Applied only to referrers that
# are not a known search, social, AI or email host, so linkedin.com stays social.
SPAM_REF = re.compile(r"backlink|linkbuild|dofollow|domainrating|seo|traffic|"
                      r"\.(space|website|site|store|shop|xyz|top|online|buzz|icu)$|^\d+\.\d+\.\d+\.\d+$", re.I)


def is_spam_ref(domain: str, ref: str) -> bool:
    if not ref or ref == "-":
        return False
    rh = bare(urlsplit(ref).hostname or "")
    if not rh or rh == domain or rh.endswith("." + domain) or classify_host(rh):
        return False
    return bool(SPAM_REF.search(rh))


def classify_session(domain: str, ref: str, query: str):
    q = {k: v[0] for k, v in parse_qs(query, keep_blank_values=False).items()}
    u_src = (q.get("utm_source") or "").strip().lower()
    u_med = (q.get("utm_medium") or "").strip().lower()
    u_camp = (q.get("utm_campaign") or "").strip()
    u_cont = (q.get("utm_content") or "").strip()
    has_utm = bool(u_src or u_med or u_camp or u_cont)
    channel, src = None, ""
    if has_utm:
        if u_med in ("social", "social-media", "paid-social", "organic-social") or (u_med == "paid_social"):
            channel = "social"
            src = SOCIAL_ALIASES.get(u_src, u_src)
            if u_src in SOCIAL_HOSTS:
                src = SOCIAL_HOSTS[u_src]
        elif u_med in ("email", "e-mail", "newsletter"):
            channel, src = "email", u_src
        elif u_med in ("cpc", "ppc", "paid", "paidsearch", "paid-search", "display"):
            channel, src = "paid", u_src
        elif u_src:
            c = classify_host(u_src) or (
                ("search", u_src) if u_src in SEARCH_NAMES else
                ("social", SOCIAL_ALIASES.get(u_src, u_src)) if (u_src in SOCIAL_NAMES or u_src in SOCIAL_ALIASES) else None)
            if c:
                channel, src = c
                if channel == "social":
                    src = SOCIAL_ALIASES.get(src, src)
    if channel is None:
        rh = ""
        if ref and ref != "-":
            rh = bare(urlsplit(ref).hostname or "")
        if rh and (rh == domain or rh.endswith("." + domain)):
            channel, src = "direct", ""
        elif rh:
            c = classify_host(rh)
            channel, src = c if c else ("referral", rh)
        elif has_utm:
            channel, src = "other", u_src
        else:
            channel, src = "direct", ""
    return {"channel": channel, "src": src, "medium": u_med if has_utm else "",
            "campaign": u_camp if has_utm else "", "content": u_cont if has_utm else ""}


def open_log(p: Path):
    return gzip.open(p, "rt", errors="replace") if p.suffix == ".gz" else p.open(errors="replace")


def read_lines(log_dir: Path, since_utc: datetime):
    files = sorted(log_dir.glob("access.log*"), key=lambda p: p.stat().st_mtime)
    for p in files:
        if datetime.fromtimestamp(p.stat().st_mtime, timezone.utc) < since_utc:
            continue
        try:
            with open_log(p) as f:
                for line in f:
                    yield line
        except (OSError, EOFError):
            continue


def read_journal(a, since_utc: datetime) -> list:
    if a.journal_file:
        try:
            return Path(a.journal_file).read_text(errors="replace").splitlines()
        except OSError:
            return []
    try:
        since = since_utc.strftime("%Y-%m-%d %H:%M:%S UTC")
        r = subprocess.run(["journalctl", "-u", "form-relay", "-o", "cat", "--since", since],
                           capture_output=True, text=True, timeout=60)
        return r.stdout.splitlines()
    except Exception:  # noqa: BLE001
        return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--tz", default="UTC")
    ap.add_argument("--domains", default="")
    ap.add_argument("--self-ip", action="append", default=[])
    ap.add_argument("--active-window", type=int, default=30)
    ap.add_argument("--log-dir", default="/var/log/nginx")
    ap.add_argument("--journal-file", default="")
    ap.add_argument("--now", default="")
    a = ap.parse_args()

    tz = ZoneInfo(a.tz)
    now = datetime.fromisoformat(a.now) if a.now else datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now_local = now.astimezone(tz)
    start_local = datetime.combine(now_local.date() - timedelta(days=max(a.days, 1) - 1),
                                   datetime.min.time(), tzinfo=tz)
    since_utc = start_local.astimezone(timezone.utc)
    domains = [bare(d) for d in a.domains.split(",") if d.strip()]
    dset = set(domains)

    ssh_ip = (os.environ.get("SSH_CLIENT") or "").split(" ")[0] or None

    # Pass 1: parse all matching lines in the window.
    rows = []
    scanners, optout = set(), set()
    first_day = {}
    for line in read_lines(Path(a.log_dir), since_utc):
        m = LINE.match(line)
        if not m:
            continue  # combined-format lines (PrimeWright) carry no host
        d = bare(m["host"])
        if d not in dset:
            continue
        try:
            ts = datetime.strptime(m["ts"], "%d/%b/%Y:%H:%M:%S %z")
        except ValueError:
            continue
        if ts < since_utc:
            continue
        raw_path = m["path"]
        if "pd_internal=" in raw_path:
            optout.add(m["ip"])
        if SCANNER_PATH.search(raw_path.split("?")[0]):
            scanners.add(m["ip"])
        rows.append((d, ts, m))
        day = ts.astimezone(tz).date()
        if d not in first_day or day < first_day[d]:
            first_day[d] = day

    excluded = set(a.self_ip) | optout | ({ssh_ip} if ssh_ip else set())

    def new_day():
        return {"pageviews": 0, "visitors": set(), "search_bot_hits": 0, "ai_bot_hits": 0,
                "pages": defaultdict(lambda: {"views": 0, "v": set(), "entrances": 0}),
                "sessions": Counter(), "channels": {}, "not_found": Counter(), "forms": Counter()}

    days = {d: defaultdict(new_day) for d in domains}
    human = []  # (domain, ts, ip, ua, path, query, ref)
    for d, ts, m in rows:
        ua, ip = m["ua"], m["ip"]
        raw = m["path"]
        path, _, query = raw.partition("?")
        low = ua.lower()
        key = ts.astimezone(tz).strftime("%Y-%m-%d")
        if any(b in low for b in SEARCH_BOTS):
            days[d][key]["search_bot_hits"] += 1
        if any(b in low for b in AI_BOTS):
            days[d][key]["ai_bot_hits"] += 1
        if m["method"] != "GET" or BOT_UA.search(ua) or ip in scanners or ip in excluded:
            continue
        if m["status"] == "404" and not ASSET.search(path):
            days[d][key]["not_found"][path] += 1
        if m["status"] not in ("200", "304") or ASSET.search(path):
            continue
        if is_spam_ref(d, m["ref"]):
            continue  # referral spam ("backlink" sites): a bot, not a visitor
        human.append((d, ts, ip, ua, path, query, m["ref"]))

    human.sort(key=lambda r: r[1])
    seen_session = set()
    for d, ts, ip, ua, path, query, ref in human:
        key = ts.astimezone(tz).strftime("%Y-%m-%d")
        vid = hashlib.sha1(f"{ip}|{ua}".encode()).hexdigest()
        dd = days[d][key]
        dd["pageviews"] += 1
        dd["visitors"].add(vid)
        pg = dd["pages"][path]
        pg["views"] += 1
        pg["v"].add(vid)
        if (d, key, vid) not in seen_session:
            seen_session.add((d, key, vid))
            pg["entrances"] += 1
            c = classify_session(d, ref, query)
            ck = (c["channel"], c["src"], c["medium"], c["campaign"], c["content"])
            dd["channels"][ck] = dd["channels"].get(ck, 0) + 1

    # Form relay outcomes.
    for line in read_journal(a, since_utc):
        if '"evt"' not in line or '"form"' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("evt") != "form":
            continue
        d = bare(e.get("site") or "")
        if d not in dset:
            continue
        try:
            ts = datetime.fromisoformat(str(e.get("ts")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts < since_utc:
            continue
        key = ts.astimezone(tz).strftime("%Y-%m-%d")
        days[d][key]["forms"][str(e.get("outcome") or "unknown")] += 1

    # Active now.
    cutoff = now - timedelta(minutes=a.active_window)
    active = {d: set() for d in domains}
    for d, ts, ip, ua, *_ in human:
        if cutoff <= ts <= now:
            active[d].add(hashlib.sha1(f"{ip}|{ua}".encode()).hexdigest())

    out_sites = {}
    for d in domains:
        out_days = {}
        # Emit every day from the first logged day through today so zero days are real zeros.
        lo = first_day.get(d)
        if lo is None and days[d]:
            lo = min(datetime.strptime(k, "%Y-%m-%d").date() for k in days[d])
        keys = set(days[d].keys())
        if lo is not None:
            cur = lo
            while cur <= now_local.date():
                keys.add(cur.strftime("%Y-%m-%d"))
                cur += timedelta(days=1)
        for key in sorted(keys):
            x = days[d][key] if key in days[d] else new_day()
            top = sorted(x["pages"].items(), key=lambda kv: -kv[1]["views"])[:200]
            out_days[key] = {
                "pageviews": x["pageviews"],
                "visitors": len(x["visitors"]),
                "sessions": sum(x["channels"].values()),
                "search_bot_hits": x["search_bot_hits"],
                "ai_bot_hits": x["ai_bot_hits"],
                "pages": {p: {"views": v["views"], "visitors": len(v["v"]), "entrances": v["entrances"]}
                          for p, v in top},
                "channels": [{"channel": k[0], "src": k[1], "medium": k[2], "campaign": k[3],
                              "content": k[4], "sessions": n} for k, n in sorted(x["channels"].items(), key=lambda kv: -kv[1])],
                "not_found": dict(x["not_found"].most_common(50)),
                "forms": dict(x["forms"]),
            }
        out_sites[d] = {"days": out_days, "active_now": len(active[d])}

    print(json.dumps({
        "generated_at": now.isoformat(), "tz": a.tz, "ssh_client_ip": ssh_ip,
        "optout_ips": sorted(optout), "sites": out_sites,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
