# SaltySails — SAR Navigator

An offline-capable navigation web app for **maritime search and rescue around Iceland**.
It runs in any modern phone, tablet or laptop browser and can be installed to the home
screen as an app (PWA). There is no build step and no server code.

> ⚠️ **Not a certified navigation system.** SaltySails is a support tool. It does not
> replace official ENC/paper charts, the vessel's chartplotter/ECDIS, radar, or the
> instructions of the Icelandic Coast Guard JRCC (Landhelgisgæslan). The base chart is
> OpenStreetMap/OpenSeaMap, which is crowd-sourced and not survey-grade.

## Features

| Tab | What it does |
| --- | --- |
| **Top bar** | Live GPS position (tap to switch between DDM / DMS / DD), SOG (kn), COG (°T), GPS accuracy, night-mode toggle |
| **MOB** | One tap marks the man-overboard position, logs it with the time, vibrates, and starts navigation back to it |
| **Nav** | Bearing, distance, ETA and cross-track error (XTE) to the active mark or search-pattern waypoint. Advances to the next waypoint automatically within ~90 m |
| **Marks** | Add marks at own position, by tapping the chart, or by typing coordinates (`64 08.50N 021 56.30W`, `64°08.5'N 21°56.3'W`, `64.1416, -21.9383`, `64,1416; -21,9383`; `V` for *vestur* is accepted). The newest mark becomes the default search datum / LKP |
| **Search** | IAMSAR patterns: **Expanding square (SS)**, **Sector search (VS)**, **Parallel track / creeping line (PS)**. Set first track, spacing, legs, radius, turn direction, and search speed. Shows total distance and time, previews the pattern on the chart, follows it leg by leg, and exports it as a GPX route for the chartplotter |
| **Drift** | Simple datum estimate from LKP + time + leeway (downwind) + total water current. Save the result as a mark, or start a search from it in one tap |
| **Log** | Track recording (GPX export, including marks) and an incident log. Each entry is stamped with the time and position; export it as `.txt` |
| **SOS** | 112 call button, VHF Ch 16 / DSC Ch 70, own position in large type, and a MAYDAY script filled in with vessel name, call sign/MMSI, POB and the current position |

Also included:
- **Night mode** (red on black) to keep dark adaptation on the bridge
- **Screen wake lock** while the app is open
- **Offline**: the app shell is precached, and every chart tile you view is cached (up to about 6,000 tiles). To prepare for a callout, pan and zoom over your area while you have signal
- A **nautical-mile scale bar** next to the metric one
- Base maps: **Sjókort (LHG)**, the official Icelandic nautical charts from Landhelgisgæslan; OSM; and Esri satellite
- Overlays: OpenSeaMap seamarks (lights, buoys, beacons), plus LHG open data: depth areas, depth contours, the 12 NM territorial sea, the 24 NM contiguous zone, the 200 NM EEZ, and the baseline. The app remembers your layer choice
- Everything (marks, track, log, settings) is stored only on the device

## Chart sources

| Layer | Service | Notes |
| --- | --- | --- |
| Sjókort (LHG) | `https://gis.natt.is/mapcache/sjokort/web-mercator/wmst`, layer `Sjomaelingar:Sjokort_Sjomaelinga` | The same tile cache the Coast Guard's viewer uses ([atlas.lmi.is/mapview/?application=LHG](https://atlas.lmi.is/mapview/?application=LHG)) |
| Depth / maritime limits | `https://gis.lmi.is/geoserver/LHG/wms`, layers `dyptarflakar`, `dypislinur`, `landhelgi_12_milur_lina`, `adlaekt_belti_24_milur_lina`, `efnahagslogsaga_lina`, `grunnlina` | Open data, no fees; terms at https://www.natt.is/en/resources/open-data |

The chart layer is a raster rendering of the paper charts. It is not an official ENC. Confirm
with Landhelgisgæslan (sjokort@lhg.is) that SaltySails may display and cache it before
relying on it operationally.

## Running

Any static file server works. Geolocation and service workers need **HTTPS** (or `localhost`).

```bash
npm start          # serves on http://localhost:8080
```

To deploy, put the folder on any static host: GitHub Pages, Vercel, Netlify, or a
web server on the rescue station. Then open it on the device and choose
*Add to Home Screen*.

## Tests

The navigation maths (`js/geo.js`) has no dependencies and is unit-tested with Node's
built-in test runner:

```bash
npm test
```

The tests cover great-circle distance and bearing, destination point, cross-track sign,
coordinate formatting and parsing, the geometry of all three search patterns, drift
vectors, and GPX escaping.

## Project layout

```
index.html            UI markup
css/app.css           styles (day + night themes)
js/geo.js             pure navigation maths, search patterns, drift, GPX
js/app.js             map, GPS, UI wiring, persistence
sw.js                 service worker (offline shell + tile cache)
manifest.webmanifest  PWA manifest
vendor/leaflet/       Leaflet 1.9.4 (BSD-2-Clause), vendored for offline use
test/geo.test.js      unit tests
```

## Ideas / roadmap

- AIS overlay (via a NMEA/Signal K gateway on board) to see other SAR units
- Shared incident: sync marks, datum and assigned search areas between units
- IAMSAR leeway tables by object type, and datum lines/areas with probability of
  containment
- NMEA 0183 / Signal K input for the vessel's own GPS and heading
- Icelandic UI translation
