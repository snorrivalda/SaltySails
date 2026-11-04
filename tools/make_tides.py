"""Build data/tides-<year>.json from the Icelandic Coast Guard tide tables PDF.

Source: Landhelgisgæsla Íslands, "Sjávarfallatöflur <year>" (www.lhg.is), e.g.
  https://www.lhg.is/wp-content/uploads/2025/11/Sjavarfallatoflur_2026_vefutgafa.pdf

Usage: python3 -I tools/make_tides.py <tables.pdf> <year> data/tides-<year>.json
Requires pdfplumber.

Table I  -> every high/low water (time GMT, height m above chart datum) for the
            five reference ports.
Table II -> time difference and spring/neap height differences for secondary
            ports, relative to a reference port.
The script stops with an error if anything looks wrong (missing days, events
not alternating high/low, implausible gaps), rather than writing bad data.
"""
import json, re, sys
from datetime import datetime, timedelta, timezone
import pdfplumber

PORTS = {  # header text in Table I -> id, display name
    'REYKJAVÍK': ('reykjavik', 'Reykjavík'),
    'ÍSAFJÖRÐUR': ('isafjordur', 'Ísafjörður'),
    'SIGLUFJÖRÐUR': ('siglufjordur', 'Siglufjörður'),
    'DJÚPIVOGUR': ('djupivogur', 'Djúpivogur'),
    'ÞORLÁKSHÖFN': ('thorlakshofn', 'Þorlákshöfn'),
}
TIME = re.compile(r'^\d{4}$')
HEIGHT = re.compile(r'^-?\d,\d$')
DM = re.compile(r"(\d+)°(\d+)'([NS]),\s*0?(\d+)°(\d+)'([VWE])")


def fail(msg):
    sys.exit('ERROR: ' + msg)


def parse_table1(pdf, year):
    ports = {}
    for page in pdf.pages:
        words = page.extract_words()
        text = ' '.join(w['text'] for w in words[:12])
        if not text.startswith('Tafla I '):
            continue
        port_key = next((k for k in PORTS if k in text), None)
        if not port_key:
            continue
        pid, name = PORTS[port_key]
        m = DM.search(page.extract_text())
        lat = int(m[1]) + int(m[2]) / 60
        lon = -(int(m[4]) + int(m[5]) / 60)
        port = ports.setdefault(pid, {'id': pid, 'name': name, 'lat': round(lat, 4), 'lon': round(lon, 4), 'events': []})

        months_on_page = [w for w in words if w['text'] in MONTHS]
        first_month = MONTHS.index(min(months_on_page, key=lambda w: w['x0'])['text']) + 1
        # Column anchors from the "Tími" headers (6 per page: 3 months x 2 halves).
        heads = sorted([w for w in words if w['text'] == 'Tími' and w['top'] > 85], key=lambda w: w['x0'])
        if len(heads) != 6:
            fail(f'{name} page {page.page_number}: expected 6 columns, got {len(heads)}')
        for ci, h in enumerate(heads):
            month = first_month + ci // 2
            tx = h['x0']
            left = heads[ci - 1]['x0'] + 45 if ci else 0
            times = sorted([w for w in words if TIME.match(w['text']) and abs(w['x0'] - tx) < 8 and w['top'] > 100],
                           key=lambda w: w['top'])
            hts = [w for w in words if HEIGHT.match(w['text']) and 20 < w['x0'] - tx < 45 and w['top'] > 100]
            days = sorted([w for w in words if re.fullmatch(r'\d{1,2}', w['text']) and left <= w['x0'] < tx - 5
                           and w['top'] > 100], key=lambda w: w['top'])
            if not days:
                fail(f'{name} {month}/{ci}: no day numbers')
            for t in times:
                hh = [x for x in hts if abs(x['top'] - t['top']) < 3]
                if len(hh) != 1:
                    fail(f'{name} {month} col {ci}: no height for time {t["text"]} at y={t["top"]:.0f}')
                # the day label sits level with the first event of that day (a few px lower)
                day = [d for d in days if d['top'] <= t['top'] + 6]
                if not day:
                    fail(f'{name} {month}: event {t["text"]} before first day label')
                d = int(day[-1]['text'])
                hhmm = t['text']
                when = datetime(year, month, d, int(hhmm[:2]), int(hhmm[2:]), tzinfo=timezone.utc)
                port['events'].append((when, float(hh[0]['text'].replace(',', '.'))))
    return ports


MONTHS = ['Janúar', 'Febrúar', 'Mars', 'Apríl', 'Maí', 'Júní', 'Júlí', 'Ágúst', 'September', 'Október',
          'Nóvember', 'Desember']


def validate_and_classify(port, year):
    ev = sorted(port['events'])
    if len({e[0] for e in ev}) != len(ev):
        fail(f'{port["name"]}: duplicate times')
    days = {e[0].date() for e in ev}
    n_days = (datetime(year + 1, 1, 1) - datetime(year, 1, 1)).days
    if len(days) != n_days:
        fail(f'{port["name"]}: events on {len(days)} days, expected {n_days}')
    out = []
    for i, (t, h) in enumerate(ev):
        prev_h = ev[i - 1][1] if i else None
        next_h = ev[i + 1][1] if i + 1 < len(ev) else None
        ref = next_h if prev_h is None else prev_h
        kind = 'H' if h > ref else 'L'
        if prev_h is not None and next_h is not None and not ((h > prev_h and h > next_h) or (h < prev_h and h < next_h)):
            fail(f'{port["name"]} {t}: {h} m is not a turning point ({prev_h}, {next_h})')
        if i:
            gap = (t - ev[i - 1][0]).total_seconds() / 3600
            if not 2.5 <= gap <= 9:
                fail(f'{port["name"]} {t}: {gap:.1f} h since previous event')
        out.append([int(t.timestamp() // 60), round(h, 1), kind])
    for a, b in zip(out, out[1:]):
        if a[2] == b[2]:
            fail(f'{port["name"]}: two {a[2]} in a row at {a}')
    port['events'] = out
    return port


def parse_table2(pdf):
    page = next(p for p in pdf.pages if (p.extract_text() or '').startswith('Tafla II'))
    secondary, ref = [], None
    ref_ids = {v[1]: v[0] for v in PORTS.values()}
    for line in page.extract_text().splitlines():
        m = re.match(r'^(.+?)\s+(\d\d) (\d\d)\s+(\d\d) (\d\d)\s+(.*)$', line.strip())
        if not m:
            continue
        name, rest = m[1].strip(), m[6]
        lat = int(m[2]) + int(m[3]) / 60
        lon = -(int(m[4]) + int(m[5]) / 60)
        if rest.startswith('Aðalh'):
            ref = ref_ids[name]
            vals = [float(v.replace(',', '.')) for v in rest.split()[1:5]]
            secondary.append({'name': name, 'ref': ref, 'reference': True, 'lat': round(lat, 4), 'lon': round(lon, 4),
                              'mhws': vals[0], 'mhwn': vals[1], 'mlwn': vals[2], 'mlws': vals[3]})
            continue
        tm = re.match(r'^([-+])\s*(\d+) (\d\d)\s*(.*)$', rest)
        if not tm or not ref:
            fail(f'Table II: cannot read "{line}"')
        dt = (1 if tm[1] == '+' else -1) * (int(tm[2]) * 60 + int(tm[3]))
        hs = tm[4].split()
        diffs = None if hs[0] == '-' else [float(v.replace(',', '.')) for v in hs[:4]]
        name = name.replace('- utan Hvanneyjar', 'Höfn, utan Hvanneyjar')
        secondary.append({'name': name, 'ref': ref, 'lat': round(lat, 4), 'lon': round(lon, 4), 'dt': dt,
                          'dh': diffs})  # dh = [spring HW, neap HW, neap LW, spring LW] differences
    return secondary


def main():
    path, year, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    pdf = pdfplumber.open(path)
    ports = parse_table1(pdf, year)
    if set(ports) != {v[0] for v in PORTS.values()}:
        fail(f'found ports {sorted(ports)}')
    for p in ports.values():
        validate_and_classify(p, year)
    table2 = parse_table2(pdf)
    refs = {r['ref']: r for r in table2 if r.get('reference')}
    data = {
        'v': 1,
        'year': year,
        'source': f'Landhelgisgæsla Íslands, Sjávarfallatöflur {year} (Tafla I og II)',
        'datum': 'Chart datum (0 íslenskra sjókorta), near mean low water springs',
        'time': 'minutes since 1970-01-01 UTC (Icelandic time = GMT)',
        'ports': list(ports.values()),
        'ref_levels': {k: {x: v[x] for x in ('mhws', 'mhwn', 'mlwn', 'mlws')} for k, v in refs.items()},
        'secondary': [s for s in table2 if not s.get('reference')],
    }
    json.dump(data, open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    for p in data['ports']:
        hs = [e[1] for e in p['events']]
        print(f"{p['name']:14} {len(p['events'])} events, {min(hs)} .. {max(hs)} m, first {p['events'][0]}")
    print('secondary ports:', len(data['secondary']), '| ref levels:', data['ref_levels'])


if __name__ == '__main__':
    main()
