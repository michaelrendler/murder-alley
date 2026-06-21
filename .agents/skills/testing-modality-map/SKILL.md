---
name: testing-modality-map
description: Test the Natural Learning Modality Map end-to-end. Use when verifying map UI, NAEP data display, district/school interactions, or layer toggle changes.
---

# Testing the Natural Learning Modality Map

## Prerequisites

- Local HTTP server running from the repo root: `python3 -m http.server 8080`
- Browser open to `http://localhost:8080`
- Playwright installed (`npm install playwright`) for programmatic checkbox/element verification

## Devin Secrets Needed

None required. The app is fully static with no authentication.

## Setup

1. `cd` to the repo root (`murder-alley/`)
2. Start server: `python3 -m http.server 8080 &`
3. Open `http://localhost:8080` in the browser
4. Maximize the browser window before recording

## Key Test Areas

### 1. Map Load
- Verify page title "Neighborhood Learning Modality Map"
- CARTO Positron light tiles render (not blank/dark) — tile URLs should contain `light_all`
- SD2 boundary (red dashed polygon), district polygons (yellow/colored), school markers (coral dots)
- Header/sidebar should have white background with dark readable text
- If testing a theme change, verify computed CSS: backgrounds (#fff/#f5f5f5), text (#333/#666), borders (#dde1e6)
- Sidebar with legend showing 4 modalities
- Layer controls panel in top-right with 4 checkboxes

### 2. LAUSD TUDA Data (Critical)
- Click the LAUSD polygon (the largest district, covers upper-right/center of map)
- **Expected values**: Math 259.7, Reading 248.7, Math Prof+ 18.4%, Reading Prof+ 21.5%
- These are TUDA (XL) values, NOT California state values
- Modality: Balanced dominant at ~34.63%
- The `mapDistrictToNAEP()` function in `js/modality.js` maps "Los Angeles Unified" to TUDA jurisdiction "XL"

### 3. Non-LAUSD District (CA State Data)
- Click any non-LAUSD district (e.g., Inglewood USD)
- **Expected values**: Math 268.8, Reading 254.4, Math Prof+ 25.3%, Reading Prof+ 28.0%
- These are California state (CA) values, proving the TUDA mapping differentiates correctly
- Key proof: Inglewood Math 268.8 vs LAUSD Math 259.7

### 4. School Detail Panel
- Click a school from the sidebar school list (or click a school marker on map)
- Verify: school name, city, OSM ID, "NAEP Context" explanation section, modality bars
- "Back to district" button should be functional

### 5. Layer Toggle Controls
- The checkboxes in the LAYERS panel are small and may be difficult to click at 1024x768 resolution
- **Recommended**: Use Playwright CDP (`chromium.connectOverCDP('http://localhost:29229')`) to programmatically click checkboxes by ID, then take screenshots for visual verification
- Checkbox IDs: `#toggle-sd2`, `#toggle-districts`, `#toggle-schools`, `#toggle-blockgroups`
- Toggle "School Districts" off/on: district polygons should disappear/reappear
- Toggle "SD2 Boundary" off/on: red boundary line should disappear/reappear
- Verify by counting SVG paths: 16 with all layers, 1 with only SD2, 15 without SD2

### 6. Block Groups On-Demand
- "Block Groups" checkbox is unchecked by default
- Checking it triggers a fetch from Census TIGERweb API
- Wait 3-5 seconds for loading; SVG paths should jump from ~16 to ~2000+
- Block groups appear as thin gray polygon outlines
- Best visible at zoom level 15-16

### 7. Popup Styling
- Click a school marker on the map (not from sidebar) to trigger a Leaflet popup
- School markers are div elements with class `.school-marker` — use Playwright to find visible ones and click
- Verify popup has white background, dark text, white tip/arrow
- School name should be in coral (#e94560) on white popup background
- Use computed styles to verify: `backgroundColor: rgb(255, 255, 255)`, `color: rgb(51, 51, 51)`

## Common Issues

- **Checkbox clicks not registering**: The layer control checkboxes are positioned with `position: fixed` in the top-right corner. At scaled resolutions, click coordinates might miss. Use Playwright CDP with `page.click('#toggle-districts')` as a workaround.
- **School markers hard to click**: School markers are small div elements (14x14px). Use Playwright to find visible `.school-marker` elements via `getBoundingClientRect()` and click programmatically.
- **District identification**: Districts are colored by modality (all currently "Balanced" = yellow). Hover over a district to see its name in a tooltip before clicking. LAUSD is the largest polygon covering most of the map. Use Playwright to click SVG path elements for reliable district selection.
- **Block groups loading time**: The Census TIGERweb API may take several seconds to respond. Allow 3-5 seconds after checking the checkbox before verifying.
- **School markers from OSM**: Schools are loaded live from OpenStreetMap Overpass API. If the API is slow or down, school markers might not appear immediately.
- **CSS cache**: When testing theme changes, users may need to hard-refresh (Ctrl+Shift+R) to bypass browser CSS cache. This is a common issue after merging theme PRs.
- **Map object access**: The Leaflet map object is not exposed as `window.map`. To interact with the map via Playwright, use DOM-based approaches (clicking SVG paths, div markers) rather than trying to access `window.map` or `window.mapInstance`.

## Data Reference

| Jurisdiction | Math (Gr. 8) | Reading (Gr. 8) | Math Prof+ | Reading Prof+ |
|---|---|---|---|---|
| LAUSD (TUDA XL) | 259.7 | 248.7 | 18.4% | 21.5% |
| California (CA) | 268.8 | 254.4 | 25.3% | 28.0% |
| National (NT) | 273.8 | 258.1 | — | — |

## Playwright CDP Pattern

```javascript
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP('http://localhost:29229');
const page = browser.contexts()[0].pages()[0];

// Click a checkbox
await page.click('#toggle-districts');

// Verify checkbox state
const checked = await page.evaluate(() => document.getElementById('toggle-districts').checked);

// Count SVG paths to verify layer visibility
const paths = await page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length);
```
