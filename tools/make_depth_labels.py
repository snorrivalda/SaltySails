"""Build compact depth-contour label points from LHG WFS GeoJSON pages.

Usage: python3 -I tools/make_depth_labels.py <dir with z*.json> data/depth-labels.json

Fetch the input one depth value at a time (paging with sortBy skips features):
  https://gis.lmi.is/geoserver/LHG/wfs?service=WFS&version=2.0.0&request=GetFeature
    &typeNames=LHG:dypislinur&outputFormat=application/json&srsName=EPSG:4326
    &propertyName=geom,minz,feature&CQL_FILTER=minz=<depth>   -> <dir>/z<depth>.json
Depths present (2026-11): 2 7 10 20 50 75 100 150 200 300 400 500 1000 1500 2000 2500 3000
Output: {"v":1, "src":..., "z":[tiers], "l":[[lat, lon, depth, angle_deg, minzoom], ...]}
"""
import json, glob, math, sys
from collections import Counter

R = 6378137.0
def merc(lon, lat):
    return (math.radians(lon) * R, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R)
def unmerc(x, y):
    return (math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2))

PX = 250                       # target label spacing in screen pixels
TIERS = [9, 10, 11, 12, 13, 14, 15]  # one density tier per zoom level (spacing halves each level)
RES = lambda z: 156543.03392804097 / 2 ** z   # metres (mercator) per pixel
base = PX * RES(TIERS[-1])     # spacing of the densest tier

def tier_for_index(i):
    # index i counts base steps; coarser tiers are every 2^k steps
    for k, z in enumerate(TIERS):
        step = 2 ** (len(TIERS) - 1 - k)
        if i % step == 0:
            return z
    return TIERS[-1]

src, out = sys.argv[1], sys.argv[2]
labels, kinds = [], Counter()
for f in sorted(glob.glob(src + '/z*.json')):
    for ft in json.load(open(f))['features']:
        kinds[ft['properties']['feature']] += 1
        if ft['properties']['feature'] == 'BO_NEATLINE' or not ft['geometry']:
            continue
        depth = ft['properties']['minz']
        for line in ft['geometry']['coordinates']:
            pts = [merc(lon, lat) for lon, lat in line]
            seg = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
            length = sum(seg)
            if length < 120 * RES(TIERS[-1]):      # too short to label even at the top tier
                continue
            # a line is labelled only from the zoom where it is at least 200 px long on screen
            line_minz = next((z for z in TIERS if length >= 200 * RES(z)), TIERS[-1])
            if length < base:                       # short line: one label in the middle
                positions = [(length / 2, line_minz)]
            else:
                n = int(length // base)
                off = (length - (n - 1) * base) / 2  # centre the run of labels on the line
                positions = [(off + i * base, max(tier_for_index(i), line_minz)) for i in range(n)]
            # walk the line once, emitting labels at the requested distances
            j, acc = 0, 0.0
            for d, minz in positions:
                while j < len(seg) - 1 and acc + seg[j] < d:
                    acc += seg[j]; j += 1
                t = (d - acc) / seg[j] if seg[j] else 0
                x = pts[j][0] + t * (pts[j + 1][0] - pts[j][0])
                y = pts[j][1] + t * (pts[j + 1][1] - pts[j][1])
                # direction over a short window for a stable angle
                a = pts[max(0, j - 2)]; b = pts[min(len(pts) - 1, j + 3)]
                ang = math.degrees(math.atan2(-(b[1] - a[1]), b[0] - a[0]))  # screen y is down
                if ang > 90: ang -= 180
                if ang < -90: ang += 180
                lon, lat = unmerc(x, y)
                labels.append([round(lat, 4), round(lon, 4), int(depth) if depth == int(depth) else depth, round(ang), minz])

labels.sort(key=lambda l: (l[4], l[0]))
json.dump({'v': 1, 'src': 'LHG:dypislinur (Landhelgisgæslan, open data)', 'z': TIERS, 'l': labels},
          open(out, 'w'), separators=(',', ':'))
print('features', dict(kinds))
print('labels', len(labels), 'by tier', dict(Counter(l[4] for l in labels)))
