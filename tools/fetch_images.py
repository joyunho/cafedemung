#!/usr/bin/env python3
"""카페드명 재고체크 — 제품 사진 수집기.

img/sources.json 에 적힌 항목별 출처(무료 라이선스 우선)를 찾아 내려받고,
320px 정사각형 WebP 썸네일로 줄여 img/items/ 에 저장한다.
img/manifest.json (앱이 읽는 목록)과 img/CREDITS.md (출처 표기)도 함께 만든다.

출처 종류 (항목마다 하나, 실패하면 "alt" 목록을 차례로 시도):
  {"off": "바코드"}                 Open Food Facts 제품 사진 (CC BY-SA 3.0)
  {"off_search": "검색어"}          Open Food Facts 검색 결과 중 pick 번째
  {"commons": "검색어"}             위키미디어 커먼즈 검색 결과 중 pick 번째
  {"commons_file": "File:이름.jpg"} 위키미디어 커먼즈 특정 파일
  {"openverse": "검색어"}           Openverse(CC 사진 모음) 검색 결과 중 pick 번째
  {"url": "...", "credit": "...", "license": "...", "page": "..."}  직접 지정
  {"same": "다른 항목 id"}          다른 항목과 같은 사진
공통 옵션: "pick"(기본 1), "fit"("cover" 꽉 채우기 / "contain" 여백 두기), "focus"([x, y] 0~1, cover일 때 중심), "crop"([좌, 위, 우, 아래] 0~1)

사용: python tools/fetch_images.py [--force] [--only id ...] [--review]
      python tools/fetch_images.py --candidates img/review/candidates.json   (후보 비교표만 만들기)
"""
import argparse
import hashlib
import html
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / 'img'
ITEMS = IMG / 'items'
SOURCES = IMG / 'sources.json'
MANIFEST = IMG / 'manifest.json'
CREDITS = IMG / 'CREDITS.md'
REVIEW = IMG / 'review'
UA = 'cafedemung-inventory/1.0 (https://github.com/joyunho/cafedemung; product thumbnails for a cafe inventory app)'
SIZE = 320
OFF = 'https://world.openfoodfacts.org'
COMMONS_API = 'https://commons.wikimedia.org/w/api.php'


# ---------- 네트워크 ----------
def http_get(url, accept=None, tries=4):
    headers = {'User-Agent': UA}
    if accept:
        headers['Accept'] = accept
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(6 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            if attempt < tries - 1:
                time.sleep(6 * (attempt + 1))
                continue
            raise
    raise last


def get_json(url):
    return json.loads(http_get(url, 'application/json'))


def strip_html(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s or ''))).strip()


# ---------- 출처별 찾기 ----------
def commons_query(params):
    base = {
        'action': 'query', 'format': 'json', 'formatversion': '2',
        'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata', 'iiurlwidth': '800',
        'iiextmetadatafilter': 'LicenseShortName|Artist',
    }
    base.update(params)
    data = get_json(COMMONS_API + '?' + urllib.parse.urlencode(base))
    return (data.get('query') or {}).get('pages') or []


def commons_result(page, ii):
    meta = ii.get('extmetadata') or {}
    artist = strip_html((meta.get('Artist') or {}).get('value', '')) or 'Wikimedia Commons'
    lic = strip_html((meta.get('LicenseShortName') or {}).get('value', ''))
    page_url = ii.get('descriptionurl') or ('https://commons.wikimedia.org/wiki/' + urllib.parse.quote(page['title'].replace(' ', '_')))
    return {'url': ii.get('thumburl') or ii['url'], 'title': page['title'], 'credit': artist[:120],
            'license': lic or 'Wikimedia Commons', 'page': page_url}


def usable_commons(pages):
    out = []
    for p in sorted(pages, key=lambda p: p.get('index', 0)):
        ii = (p.get('imageinfo') or [{}])[0]
        if ii.get('mime') not in ('image/jpeg', 'image/png', 'image/webp'):
            continue
        if (ii.get('width') or 0) < 300 or (ii.get('height') or 0) < 300:
            continue
        out.append((p, ii))
    return out


def from_commons(q, pick):
    pages = commons_query({'generator': 'search', 'gsrsearch': q + ' filetype:bitmap', 'gsrnamespace': '6', 'gsrlimit': '25'})
    cands = usable_commons(pages)
    if len(cands) < pick:
        raise LookupError(f'commons "{q}": 쓸 수 있는 결과 {len(cands)}개')
    return commons_result(*cands[pick - 1])


def from_commons_file(title):
    pages = commons_query({'titles': title})
    cands = usable_commons(pages)
    if not cands:
        raise LookupError(f'commons file "{title}" 없음')
    return commons_result(*cands[0])


def off_result(p):
    code = p.get('code') or ''
    name = ' '.join(x for x in [p.get('brands', ''), p.get('product_name', '')] if x).strip()
    return {'url': p['image_front_url'], 'title': name or code, 'credit': 'Open Food Facts contributors',
            'license': 'CC BY-SA 3.0', 'page': f'{OFF}/product/{code}'}


def from_off(code):
    d = get_json(f'{OFF}/api/v2/product/{urllib.parse.quote(str(code))}.json?fields=code,product_name,brands,image_front_url')
    p = d.get('product') or {}
    if not p.get('image_front_url'):
        raise LookupError(f'off {code}: 앞면 사진 없음')
    p.setdefault('code', str(code))
    return off_result(p)


_last_off_search = [0.0]


def from_off_search(q, pick):
    wait = 7.0 - (time.time() - _last_off_search[0])   # Open Food Facts 검색은 분당 10회 제한
    if wait > 0:
        time.sleep(wait)
    _last_off_search[0] = time.time()
    params = {'search_terms': q, 'search_simple': 1, 'action': 'process', 'json': 1, 'page_size': 24,
              'fields': 'code,product_name,brands,image_front_url'}
    d = get_json(f'{OFF}/cgi/search.pl?' + urllib.parse.urlencode(params))
    prods = [p for p in d.get('products', []) if p.get('image_front_url')]
    if len(prods) < pick:
        raise LookupError(f'off_search "{q}": 사진 있는 결과 {len(prods)}개')
    return off_result(prods[pick - 1])


def from_openverse(q, pick):
    d = get_json('https://api.openverse.org/v1/images/?' + urllib.parse.urlencode({'q': q, 'page_size': 20, 'mature': 'false'}))
    res = [r for r in d.get('results', []) if r.get('url')]
    if len(res) < pick:
        raise LookupError(f'openverse "{q}": 결과 {len(res)}개')
    r = res[pick - 1]
    lic = (r.get('license') or '').lower()
    if lic == 'cc0':
        lic_txt = 'CC0'
    elif lic == 'pdm':
        lic_txt = 'Public Domain'
    else:
        lic_txt = f"CC {lic.upper()} {r.get('license_version') or ''}".strip()
    return {'url': r['url'], 'title': r.get('title') or q, 'credit': (r.get('creator') or r.get('source') or 'Openverse')[:120],
            'license': lic_txt, 'page': r.get('foreign_landing_url') or r.get('detail_url') or ''}


def resolve_one(spec):
    pick = int(spec.get('pick', 1))
    if 'off' in spec:
        return from_off(spec['off'])
    if 'off_search' in spec:
        return from_off_search(spec['off_search'], pick)
    if 'commons_file' in spec:
        return from_commons_file(spec['commons_file'])
    if 'commons' in spec:
        return from_commons(spec['commons'], pick)
    if 'openverse' in spec:
        return from_openverse(spec['openverse'], pick)
    if 'url' in spec:
        return {'url': spec['url'], 'title': spec.get('title', spec['url']), 'credit': spec.get('credit', ''),
                'license': spec.get('license', ''), 'page': spec.get('page', spec['url'])}
    raise ValueError('출처 종류를 알 수 없음: ' + json.dumps(spec, ensure_ascii=False))


# ---------- 썸네일 ----------
def default_fit(spec):
    return 'contain' if ('off' in spec or 'off_search' in spec or 'url' in spec) else 'cover'


def make_thumb(data, fit, crop=None, focus=None):
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode in ('RGBA', 'LA', 'P', 'PA'):
        im = im.convert('RGBA')
        bg = Image.new('RGB', im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert('RGB')
    if crop:
        w, h = im.size
        im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
    if fit == 'cover':
        c = tuple(focus) if focus else (0.5, 0.5)
        im = ImageOps.fit(im, (SIZE, SIZE), Image.LANCZOS, centering=c)
    else:
        im.thumbnail((SIZE - 20, SIZE - 20), Image.LANCZOS)
        canvas = Image.new('RGB', (SIZE, SIZE), (255, 255, 255))
        canvas.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2))
        im = canvas
    out = io.BytesIO()
    im.save(out, 'WEBP', quality=80, method=6)
    return out.getvalue()


def spec_key(spec):
    core = {k: spec[k] for k in sorted(spec) if k not in ('name', 'note')}
    return hashlib.sha1(json.dumps(core, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


# ---------- 결과물 ----------
def write_credits(items, man):
    lines = ['# 사진 출처', '',
             '앱의 제품 사진은 실제 가게 제품이 아니라 **비슷한 제품의 예시 사진**입니다.',
             '모두 무료 라이선스 사진이며, 각 사진의 저작자와 라이선스는 아래와 같습니다.',
             '`img/sources.json`을 고치면 GitHub Actions가 사진을 다시 받아옵니다.', '',
             '| 항목 | 사진 | 저작자 | 라이선스 |', '| --- | --- | --- | --- |']
    for iid, spec in items.items():
        m = man['items'].get(iid)
        name = spec.get('name', iid)
        if not m:
            lines.append(f'| {name} | 없음 | | |')
            continue
        if 'same' in spec:
            ref = items.get(spec['same'], {}).get('name', spec['same'])
            lines.append(f'| {name} | {ref}와 같은 사진 | | |')
            continue
        title = (m.get('title') or '').replace('|', '/')
        lines.append(f"| {name} | [{title}]({m.get('page', '')}) | {(m.get('credit') or '').replace('|', '/')} | {m.get('license', '')} |")
    CREDITS.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def load_font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def write_review(items, man, picks):
    REVIEW.mkdir(parents=True, exist_ok=True)
    for f in REVIEW.glob('sheet-*.jpg'):
        f.unlink()
    ids = list(items.keys())
    tile, label_h, cols, per = 200, 26, 6, 36
    font = load_font(18)
    for n, start in enumerate(range(0, len(ids), per), 1):
        chunk = ids[start:start + per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * tile, rows * (tile + label_h)), (40, 40, 40))
        draw = ImageDraw.Draw(sheet)
        for i, iid in enumerate(chunk):
            x, y = (i % cols) * tile, (i // cols) * (tile + label_h)
            m = man['items'].get(iid)
            if m and (ITEMS / m['file']).exists():
                im = Image.open(ITEMS / m['file']).convert('RGB').resize((tile - 4, tile - 4), Image.LANCZOS)
                sheet.paste(im, (x + 2, y + 2))
            else:
                draw.rectangle((x + 2, y + 2, x + tile - 2, y + tile - 2), fill=(120, 20, 20))
                draw.text((x + 70, y + 85), 'NONE', fill=(255, 255, 255), font=font)
            draw.text((x + 6, y + tile + 2), iid, fill=(255, 255, 255), font=font)
        sheet.save(REVIEW / f'sheet-{n}.jpg', 'JPEG', quality=84)
    (REVIEW / 'picks.txt').write_text('\n'.join(picks) + '\n', encoding='utf-8')


def make_candidates(path):
    """후보 비교표: {"items": {"id": ["검색어", ...]}} 마다 커먼즈 후보 8장을 한 줄로 늘어놓는다.
    결과는 img/review/cand-N.jpg (줄마다 항목 id, 칸마다 번호) 와 cand.txt (id, 번호, 정확한 파일 이름)."""
    spec = json.loads(Path(path).read_text(encoding='utf-8'))
    rows, lines = [], []
    for iid, queries in spec.get('items', {}).items():
        seen, cands = set(), []
        for q in queries:
            try:
                pages = commons_query({'generator': 'search', 'gsrsearch': q + ' filetype:bitmap', 'gsrnamespace': '6',
                                       'gsrlimit': '12', 'iiurlwidth': '240'})
                for p, ii in usable_commons(pages):
                    if p['title'] in seen:
                        continue
                    seen.add(p['title'])
                    cands.append((p['title'], ii.get('thumburl') or ii['url']))
                    if len(cands) >= 8:
                        break
            except Exception as e:  # noqa: BLE001
                print(f'cand {iid} "{q}": {e}')
            if len(cands) >= 8:
                break
            time.sleep(0.3)
        imgs = []
        for i, (title, url) in enumerate(cands, 1):
            try:
                im = Image.open(io.BytesIO(http_get(url)))
                im = ImageOps.exif_transpose(im).convert('RGB')
                im = ImageOps.fit(im, (146, 146), Image.LANCZOS)
            except Exception as e:  # noqa: BLE001
                print(f'cand {iid} #{i}: {e}')
                im = None
            imgs.append(im)
            lines.append(f'{iid}\t{i}\t{title}')
        rows.append((iid, imgs))
        print(f'cand {iid}: {len(imgs)}개')
    REVIEW.mkdir(parents=True, exist_ok=True)
    for f in REVIEW.glob('cand-*.jpg'):
        f.unlink()
    tile, lab, per = 150, 110, 6
    font, big = load_font(18), load_font(22)
    for n, start in enumerate(range(0, len(rows), per), 1):
        chunk = rows[start:start + per]
        sheet = Image.new('RGB', (lab + 8 * tile, len(chunk) * (tile + 24)), (40, 40, 40))
        draw = ImageDraw.Draw(sheet)
        for r, (iid, imgs) in enumerate(chunk):
            y = r * (tile + 24)
            draw.text((6, y + 62), iid, fill=(255, 255, 255), font=big)
            for i, im in enumerate(imgs):
                x = lab + i * tile
                if im is not None:
                    sheet.paste(im, (x + 2, y + 2))
                else:
                    draw.rectangle((x + 2, y + 2, x + tile - 2, y + tile - 2), fill=(120, 20, 20))
                draw.text((x + 6, y + tile + 2), str(i + 1), fill=(255, 230, 0), font=font)
        sheet.save(REVIEW / f'cand-{n}.jpg', 'JPEG', quality=82)
    (REVIEW / 'cand.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='이미 받은 사진도 다시 받기')
    ap.add_argument('--only', nargs='*', default=[], help='이 항목만 다시 받기')
    ap.add_argument('--review', action='store_true', help='img/review/ 에 검토용 모음 사진 만들기')
    ap.add_argument('--candidates', metavar='JSON', help='후보 비교표만 만들기 (img/review/candidates.json 형식)')
    args = ap.parse_args()
    if args.candidates:
        make_candidates(args.candidates)
        return 0

    src = json.loads(SOURCES.read_text(encoding='utf-8'))
    items = src['items']
    old = json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else {'items': {}}
    man = {'version': 1, 'items': {}}
    ITEMS.mkdir(parents=True, exist_ok=True)
    picks, failed = [], []

    for iid, spec in items.items():
        if 'same' in spec:
            continue
        key = spec_key(spec)
        prev = old.get('items', {}).get(iid)
        fname = f'{iid}.webp'
        reuse = prev and prev.get('key') == key and (ITEMS / prev.get('file', '')).exists()
        if reuse and not args.force and iid not in args.only:
            man['items'][iid] = prev
            picks.append(f"{iid}\t{spec.get('name', '')}\tcached\t{prev.get('title', '')}\t{prev.get('page', '')}")
            continue
        chain = [spec] + list(spec.get('alt', []))
        done = False
        errors = []
        for k, s in enumerate(chain):
            try:
                info = resolve_one(s)
                data = http_get(info['url'])
                webp = make_thumb(data, s.get('fit') or default_fit(s), s.get('crop'), s.get('focus'))
                (ITEMS / fname).write_bytes(webp)
                man['items'][iid] = {'file': fname, 'key': key, 'v': hashlib.sha1(webp).hexdigest()[:8],
                                     'title': info['title'], 'credit': info['credit'], 'license': info['license'], 'page': info['page']}
                via = 'alt' + str(k) if k else 'main'
                picks.append(f"{iid}\t{spec.get('name', '')}\t{via}\t{info['title']}\t{info['page']}")
                print(f"ok   {iid} {spec.get('name', '')} <- [{via}] {info['title']}")
                done = True
                break
            except Exception as e:  # noqa: BLE001 - 출처 하나 실패해도 다음 후보로
                errors.append(f'{type(e).__name__}: {e}')
            finally:
                time.sleep(0.4)
        if not done:
            failed.append(iid)
            print(f"FAIL {iid} {spec.get('name', '')}: {' / '.join(errors)}")
            picks.append(f"{iid}\t{spec.get('name', '')}\tFAIL\t{' / '.join(errors)}\t")
            if prev and (ITEMS / prev.get('file', '')).exists():
                man['items'][iid] = prev

    for iid, spec in items.items():
        if 'same' in spec:
            ref = man['items'].get(spec['same'])
            if ref:
                man['items'][iid] = {**ref, 'key': 'same:' + spec['same']}
                picks.append(f"{iid}\t{spec.get('name', '')}\tsame\t{spec['same']}\t")

    used = {v['file'] for v in man['items'].values()}
    for f in ITEMS.glob('*.webp'):
        if f.name not in used:
            f.unlink()

    MANIFEST.write_text(json.dumps(man, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    write_credits(items, man)
    if args.review:
        write_review(items, man, picks)
    have = sum(1 for i in items if i in man['items'])
    print(f'\n사진 있음 {have}/{len(items)} · 실패 {len(failed)}' + (f": {' '.join(failed)}" if failed else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
