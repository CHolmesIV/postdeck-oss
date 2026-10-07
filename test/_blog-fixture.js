// Builds a FAKE Website Projects tree for the blog add-on tests. The python
// scripts are tiny stand-ins that mimic the real CLIs (release.py, build_blog.py,
// qa.py). Nothing here ever touches the real Website Projects folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RELEASE_PY = String.raw`#!/usr/bin/env python3
import sys, re, json, time, argparse
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("--date"); ap.add_argument("--deploy", action="store_true"); ap.add_argument("--allow-unreviewed", action="store_true")
a = ap.parse_args()
with open(ROOT / "blog" / ".argv.log", "a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\n")
sl = ROOT / "blog" / ".sleep"
if sl.exists():
    time.sleep(float(sl.read_text()))
def fm(t):
    m = re.match(r"^---\n(.*?)\n---\n", t, re.S); d = {}
    for ln in m.group(1).splitlines():
        if ":" in ln:
            k, v = ln.split(":", 1); d[k.strip()] = v.strip().strip('"')
    return d
due = []
for f in sorted((ROOT / "blog" / "content").glob("*.md")):
    d = fm(f.read_text())
    if d.get("status") == "scheduled" and d.get("publish_date", "9999") <= a.date:
        due.append((f, d))
blocked = [f.name for f, d in due if d.get("needs_cb_review") == "true"]
if blocked and not a.allow_unreviewed:
    print("Refusing to release: these due posts still have needs_cb_review: true")
    for b in blocked: print("  " + b)
    sys.exit(1)
for f, d in due:
    if a.deploy:
        f.write_text(re.sub(r"^status:.*$", "status: published", f.read_text(), count=1, flags=re.M))
    print(("published: " if a.deploy else "would publish: ") + f.name)
print("Deployed." if a.deploy else "DRY RUN: nothing deployed.")
`;

const BUILD_PY = String.raw`#!/usr/bin/env python3
import sys, re, shutil, argparse
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
SITE = "https://fake.example"
CLUSTERS = {
    "Alpha": {"hub": "alpha", "title": "Alpha"},
    "Beta Topic": {"hub": "beta", "title": "Beta"},
}
TIERS = {"cluster": 1, "pillar": 2}

def read_post(path):
    text = path.read_text()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    meta = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        meta[k.strip()] = v.strip().strip('"')
    for key in ("title", "headline", "description", "slug", "cluster", "tier",
                "primary_keyword", "publish_date", "status"):
        if not meta.get(key):
            raise SystemExit(f"{path.name}: front matter needs '{key}'")
    return meta, m.group(2)

ap = argparse.ArgumentParser()
ap.add_argument("--preview", action="store_true"); ap.add_argument("--date"); ap.add_argument("--out")
a = ap.parse_args()
out = Path(a.out).resolve()
shutil.rmtree(out, ignore_errors=True)
shutil.copytree(ROOT / "dist", out)
n = 0
for f in sorted((ROOT / "blog" / "content").glob("*.md")):
    meta, body = read_post(f)
    if meta["status"] == "draft":
        continue
    d = out / "blog" / meta["slug"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.html").write_text(
        '<!doctype html><html><head><title>%s</title><link rel="stylesheet" href="/style.css"></head>'
        '<body><a href="/blog/">Blog</a><img srcset="/img/a.png 1x, /img/b.png 2x" src="/img/a.png"><p>%s</p></body></html>'
        % (meta["title"], body.strip()))
    n += 1
print(f"{n} posts rendered into {out}/")
`;

const QA_PY = String.raw`#!/usr/bin/env python3
import sys, argparse
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument("--preview", action="store_true"); ap.add_argument("--tree"); ap.add_argument("--all-site", action="store_true")
a = ap.parse_args()
tree = Path(a.tree)
fails = 0
for p in sorted((tree / "blog").rglob("index.html")):
    rel = p.relative_to(tree).as_posix()
    print(rel)
    print("  WARN title is short")
    if "badpost" in rel:
        print("  FAIL dash found"); fails += 1
print()
print(f"SUMMARY: {fails} FAIL, 1 WARN")
sys.exit(1 if fails else 0)
`;

export const POST = (o = {}) => {
  const f = {
    title: 'Sample Post',
    headline: 'Sample Headline',
    description: 'A sample description for a sample post.',
    slug: 'sample-post',
    cluster: 'Alpha',
    tier: 'cluster',
    primary_keyword: 'sample keyword',
    secondary_keywords: '[one, two]',
    publish_date: '2099-01-10',
    updated_date: '2099-01-10',
    status: 'scheduled',
    needs_cb_review: 'true',
    related: '[a-post, b-post]',
    ...o,
  };
  const body = f.__body ?? 'Body text here.\n\n## Section\n\nMore.\n';
  delete f.__body;
  const lines = Object.entries(f).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

/** Create a fake site "Fake Site" (id fake-site) under a fresh temp root. */
export function makeFakeRoot({ posts = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-blog-test-'));
  const site = path.join(root, 'Fake Site');
  fs.mkdirSync(path.join(site, 'blog', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(site, 'blog', 'content'), { recursive: true });
  fs.mkdirSync(path.join(site, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(site, 'dist', 'style.css'), 'body{background:url(/bg.png)}');
  fs.writeFileSync(path.join(site, 'dist', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(site, 'blog', 'tools', 'release.py'), RELEASE_PY);
  fs.writeFileSync(path.join(site, 'blog', 'tools', 'build_blog.py'), BUILD_PY);
  fs.writeFileSync(path.join(site, 'blog', 'tools', 'qa.py'), QA_PY);
  for (const [slug, text] of Object.entries(posts)) fs.writeFileSync(path.join(site, 'blog', 'content', `${slug}.md`), text);
  // a non-site sibling that must be ignored by discovery
  fs.mkdirSync(path.join(root, 'Not A Site', 'blog'), { recursive: true });
  return { root, site, content: path.join(site, 'blog', 'content'), argvLog: () => {
    const p = path.join(site, 'blog', '.argv.log');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  } };
}

export function setupEnv() {
  process.env.POSTDECK_DB_PATH = ':memory:';
  process.env.BLOTATO_DRY_RUN = '1';
  process.env.POSTDECK_WORKER = '0';
  process.env.POSTDECK_SYNC_ENABLED = '0';
}
