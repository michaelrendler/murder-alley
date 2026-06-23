/**
 * Neighborhood Learning Modality Map — Main Application
 *
 * Layers:
 *   1. LA County Supervisory District 2 boundary
 *   2. Unified school district boundaries (from Census TIGER)
 *   3. School point features (from OpenStreetMap Overpass)
 *   4. Census block group boundaries (from Census TIGERweb, on-demand)
 *   5. NAEP data overlay with Natural Learning Modality scoring
 */

(function () {
  'use strict';

  // SD2 center and bounds
  const SD2_CENTER = [33.9365, -118.324];
  const SD2_BOUNDS = [[33.7926, -118.468], [34.0803, -118.180]];

  // Layer references
  let sd2Layer = null;
  let districtsLayer = null;
  let schoolsLayer = null;
  let blockGroupsLayer = null;

  // State
  let naepData = {};
  let districtProfiles = {};
  let schoolsInView = [];

  // Census API key (free, public rate-limiting key)
  const CENSUS_API_KEY = 'df79b49d140257c59ef005e66ef5554040bee49b';
  const ACS_YEAR = '2022';
  const ACS_ENDPOINT = 'https://api.census.gov/data/' + ACS_YEAR + '/acs/acs5';
  const acsCache = new Map();

  // Block group selection state
  const selectionState = {
    blockGroups: new Map(),
    windowSelecting: false,
    windowStart: null,
    windowRect: null,
    windowAdditive: false,
  };

  // ─── Map initialisation ──────────────────────────────────────
  const map = L.map('map', {
    center: SD2_CENTER,
    zoom: 12,
    zoomControl: true,
    maxBounds: [[33.5, -118.8], [34.3, -117.8]],
  });

  // Standard OpenStreetMap tile layer
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  // Selection highlight layer
  const selectedBgHighlight = L.geoJSON(null, {
    style: function () { return { color: '#6a3d9a', weight: 4, fillOpacity: 0.12 }; },
  }).addTo(map);

  // ─── Loading indicator ──────────────────────────────────────
  function showLoading(msg) {
    let el = document.getElementById('loading');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loading';
      el.className = 'loading-indicator';
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="spinner"></div><p>' + msg + '</p>';
    el.style.display = 'block';
  }

  function hideLoading() {
    const el = document.getElementById('loading');
    if (el) el.style.display = 'none';
  }

  // ─── Data loading ───────────────────────────────────────────
  async function loadJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Failed to load ' + url);
    return resp.json();
  }

  async function init() {
    showLoading('Loading map data…');

    try {
      // Load all data in parallel
      const [sd2Data, districtsData, naepRaw] = await Promise.all([
        loadJSON('data/sd2_boundary.json'),
        loadJSON('data/school_districts.json'),
        loadJSON('data/naep_states.json'),
      ]);

      naepData = naepRaw.states || {};

      // Render layers
      renderSD2(sd2Data);
      renderDistricts(districtsData);

      // Load block groups at init (visible by default)
      loadBlockGroups();

      // Load schools from OSM (async, non-blocking)
      loadSchoolsFromOSM();

      // Set up layer toggles
      setupLayerControls();

      hideLoading();
    } catch (err) {
      console.error('Init error:', err);
      hideLoading();
      alert('Error loading map data: ' + err.message);
    }
  }

  // ─── SD2 Boundary ──────────────────────────────────────────
  function renderSD2(data) {
    sd2Layer = L.geoJSON(data, {
      style: {
        color: '#e94560',
        weight: 3,
        opacity: 0.9,
        fillColor: '#e94560',
        fillOpacity: 0.03,
        dashArray: '8 4',
      },
    }).addTo(map);

    sd2Layer.bindTooltip('LA County Supervisory District 2', {
      className: 'district-tooltip',
      sticky: true,
    });
  }

  // ─── School Districts ──────────────────────────────────────
  function renderDistricts(data) {
    // Compute modality profiles for each district
    for (const feat of data.features) {
      const name = feat.properties.BASENAME || feat.properties.NAME;
      const naep = ModalityEngine.mapDistrictToNAEP(name, naepData);
      if (naep) {
        const profile = ModalityEngine.computeProfile(naep);
        districtProfiles[name] = { naep, profile };
      }
    }

    districtsLayer = L.geoJSON(data, {
      style: function (feature) {
        const name = feature.properties.BASENAME || feature.properties.NAME;
        const entry = districtProfiles[name];
        const color = entry ? ModalityEngine.getColor(entry.profile) : '#555';
        return {
          color: color,
          weight: 2,
          opacity: 0.85,
          fillColor: color,
          fillOpacity: 0.20,
        };
      },
      onEachFeature: function (feature, layer) {
        const name = feature.properties.BASENAME || feature.properties.NAME;
        const entry = districtProfiles[name];

        // Tooltip
        let tip = '<strong>' + name + '</strong>';
        if (entry && entry.profile) {
          tip += '<br>Dominant: ' + ModalityEngine.MODALITY_LABELS[entry.profile.dominant];
        }
        layer.bindTooltip(tip, { className: 'district-tooltip', sticky: true });

        // Click handler
        layer.on('click', function () {
          showDistrictDetail(name, entry);
          highlightDistrict(layer);
        });

        // Hover effects
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.4, weight: 3 });
        });
        layer.on('mouseout', function () {
          districtsLayer.resetStyle(layer);
        });
      },
    }).addTo(map);
  }

  let highlightedDistrict = null;

  function highlightDistrict(layer) {
    if (highlightedDistrict) {
      districtsLayer.resetStyle(highlightedDistrict);
    }
    highlightedDistrict = layer;
    layer.setStyle({ fillOpacity: 0.45, weight: 4 });
    layer.bringToFront();
    if (sd2Layer) sd2Layer.bringToFront();
  }

  // ─── Schools from OSM ─────────────────────────────────────
  const schoolIcon = L.divIcon({
    html: '<div style="background:#fff;border:2px solid #e94560;width:10px;height:10px;border-radius:50%;"></div>',
    className: 'school-marker',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  async function loadSchoolsFromOSM() {
    // Query Overpass for schools within SD2 bounds
    // Split into smaller bounding boxes to avoid rate limits
    const quads = [
      [33.79, -118.47, 33.935, -118.325],
      [33.79, -118.325, 33.935, -118.18],
      [33.935, -118.47, 34.08, -118.325],
      [33.935, -118.325, 34.08, -118.18],
    ];

    const allFeatures = [];
    const seenIds = new Set();

    for (const [s, w, n, e] of quads) {
      try {
        const query = `[out:json][timeout:30];(node["amenity"="school"](${s},${w},${n},${e});way["amenity"="school"](${s},${w},${n},${e}););out center;`;
        const resp = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        if (!resp.ok) {
          console.warn('Overpass returned', resp.status, 'for quadrant');
          continue;
        }

        const data = await resp.json();
        for (const el of (data.elements || [])) {
          if (seenIds.has(el.id)) continue;
          seenIds.add(el.id);

          const lat = el.lat || (el.center && el.center.lat);
          const lon = el.lon || (el.center && el.center.lon);
          if (!lat || !lon) continue;

          allFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
              name: (el.tags && el.tags.name) || 'Unknown School',
              operator: (el.tags && el.tags.operator) || '',
              grades: (el.tags && el.tags.grades) || '',
              isced_level: (el.tags && (el.tags['isced:level'] || '')) || '',
              addr_city: (el.tags && (el.tags['addr:city'] || '')) || '',
              osm_id: el.id,
            },
          });
        }

        // Small delay between requests
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        console.warn('Overpass error for quadrant:', err);
      }
    }

    schoolsInView = allFeatures;

    if (allFeatures.length > 0) {
      renderSchools({ type: 'FeatureCollection', features: allFeatures });
    } else {
      // Fallback: try loading from pre-fetched file
      try {
        const data = await loadJSON('data/schools_sd2.json');
        schoolsInView = data.features || [];
        renderSchools(data);
      } catch (e) {
        console.warn('No school data available');
      }
    }
  }

  function renderSchools(geojson) {
    if (schoolsLayer) {
      map.removeLayer(schoolsLayer);
    }

    schoolsLayer = L.geoJSON(geojson, {
      pointToLayer: function (feature, latlng) {
        return L.marker(latlng, { icon: schoolIcon });
      },
      onEachFeature: function (feature, layer) {
        const props = feature.properties;
        layer.bindPopup(
          '<strong>' + props.name + '</strong>' +
          (props.operator ? '<br>Operator: ' + props.operator : '') +
          (props.addr_city ? '<br>City: ' + props.addr_city : '')
        );

        layer.on('click', function () {
          showSchoolDetail(props);
        });
      },
    }).addTo(map);
  }

  // ─── ACS data fetching ────────────────────────────────────
  function num(x) {
    var n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  function fmtInt(n) {
    if (!Number.isFinite(n)) return 'n/a';
    return Math.round(n).toLocaleString();
  }

  function getBgIds(feature) {
    var p = feature && feature.properties ? feature.properties : {};
    var geoid = p.GEOID != null ? String(p.GEOID) : null;
    if (geoid && geoid.length >= 12) {
      var s = geoid.length > 12 ? geoid.slice(geoid.length - 12) : geoid;
      return {
        state: s.slice(0, 2),
        county: s.slice(2, 5),
        tract: s.slice(5, 11),
        blkgrp: s.slice(11, 12),
        geoid: s,
      };
    }
    return null;
  }

  async function fetchAcsForBlockGroup(ids) {
    var cacheKey = ids.state + ids.county + ids.tract + ids.blkgrp;
    if (acsCache.has(cacheKey)) return acsCache.get(cacheKey);

    var vars = 'NAME,B01001_003E,B01001_027E,B01001_001E';
    var url = ACS_ENDPOINT
      + '?get=' + vars
      + '&for=block%20group:' + ids.blkgrp
      + '&in=state:' + ids.state + '+county:' + ids.county + '+tract:' + ids.tract
      + '&key=' + CENSUS_API_KEY;

    var res = await fetch(url);
    var text = await res.text();
    if (!res.ok || /Missing Key/i.test(text)) {
      throw new Error('Census API error: ' + text.slice(0, 200));
    }

    var json = JSON.parse(text);
    var header = json[0];
    var row = json[1];
    if (!header || !row) throw new Error('Census API: no data returned.');

    var idx = {};
    header.forEach(function (h, i) { idx[h] = i; });

    var out = {
      name: row[idx.NAME],
      malesUnder5: num(row[idx.B01001_003E]),
      femalesUnder5: num(row[idx.B01001_027E]),
      totalPop: num(row[idx.B01001_001E]),
    };

    acsCache.set(cacheKey, out);
    return out;
  }

  // ─── Block group selection helpers ─────────────────────────
  function refreshSelectionHighlights() {
    selectedBgHighlight.clearLayers();
    selectionState.blockGroups.forEach(function (v) {
      selectedBgHighlight.addData(v.feature);
    });
  }

  function updateSelectionSummary() {
    var count = selectionState.blockGroups.size;
    var el = document.getElementById('selection-summary');
    if (!el) return;

    if (count === 0) {
      el.innerHTML = '<p style="color:#666;font-size:0.82rem">Click a block group to select it. Ctrl+Click to add more. Use the window select tool to drag-select multiple.</p>';
      return;
    }

    var totalMales = 0, totalFemales = 0, totalPop = 0;
    selectionState.blockGroups.forEach(function (item) {
      if (Number.isFinite(item.data.malesUnder5)) totalMales += item.data.malesUnder5;
      if (Number.isFinite(item.data.femalesUnder5)) totalFemales += item.data.femalesUnder5;
      if (Number.isFinite(item.data.totalPop)) totalPop += item.data.totalPop;
    });

    var html = '<h3 style="font-size:0.9rem;color:#333;margin-bottom:8px">' + count + ' block group' + (count === 1 ? '' : 's') + ' selected</h3>';
    html += '<div class="naep-stats" style="grid-template-columns:1fr 1fr 1fr">';
    html += '<div class="stat-card"><div class="stat-label">Males &lt; 5</div><div class="stat-value">' + fmtInt(totalMales) + '</div></div>';
    html += '<div class="stat-card"><div class="stat-label">Females &lt; 5</div><div class="stat-value">' + fmtInt(totalFemales) + '</div></div>';
    html += '<div class="stat-card"><div class="stat-label">Total Pop</div><div class="stat-value">' + fmtInt(totalPop) + '</div></div>';
    html += '</div>';

    html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;margin-top:8px">';
    html += '<thead><tr>';
    html += '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #dde1e6;color:#666">GEOID</th>';
    html += '<th style="text-align:right;padding:4px 6px;border-bottom:1px solid #dde1e6;color:#666">Males &lt; 5</th>';
    html += '<th style="text-align:right;padding:4px 6px;border-bottom:1px solid #dde1e6;color:#666">Females &lt; 5</th>';
    html += '</tr></thead><tbody>';

    var items = Array.from(selectionState.blockGroups.values()).slice(0, 50);
    items.forEach(function (item) {
      html += '<tr>';
      html += '<td style="padding:4px 6px;border-bottom:1px solid #f0f2f5;font-family:monospace;color:#333">' + (item.ids.geoid || '') + '</td>';
      html += '<td style="padding:4px 6px;border-bottom:1px solid #f0f2f5;text-align:right;color:#333">' + fmtInt(item.data.malesUnder5) + '</td>';
      html += '<td style="padding:4px 6px;border-bottom:1px solid #f0f2f5;text-align:right;color:#333">' + fmtInt(item.data.femalesUnder5) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<p style="font-size:0.7rem;color:#999;margin-top:6px">Source: ACS ' + ACS_YEAR + ' 5-year (Census API)</p>';

    el.innerHTML = html;
  }

  function clearSelection() {
    selectionState.blockGroups.clear();
    refreshSelectionHighlights();
    updateSelectionSummary();
  }

  // ─── Block Groups (loaded at init from TIGERweb) ──────────
  async function loadBlockGroups() {
    if (blockGroupsLayer) return;

    showLoading('Loading Census block groups…');

    try {
      var url = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2023/MapServer/10/query'
        + '?where=STATE=%2706%27+AND+COUNTY=%27037%27'
        + '&geometry=-118.47,33.79,-118.18,34.08'
        + '&geometryType=esriGeometryEnvelope'
        + '&inSR=4326'
        + '&spatialRel=esriSpatialRelIntersects'
        + '&outFields=GEOID,NAME'
        + '&returnGeometry=true'
        + '&outSR=4326'
        + '&f=geojson'
        + '&resultRecordCount=2000';

      var data = await loadJSON(url);

      blockGroupsLayer = L.geoJSON(data, {
        style: {
          color: '#000000',
          weight: 1,
          opacity: 0.7,
          fillColor: '#000000',
          fillOpacity: 0.0,
        },
        onEachFeature: function (feature, layer) {
          layer.bindTooltip('Block Group: ' + feature.properties.GEOID, {
            className: 'district-tooltip',
          });

          // Click handler for selection + ACS data popup
          layer.on('click', async function (e) {
            try {
              var ids = getBgIds(feature);
              if (!ids) return;

              var additive = e.originalEvent && e.originalEvent.ctrlKey;
              var key = ids.geoid;

              if (!additive) selectionState.blockGroups.clear();

              if (selectionState.blockGroups.has(key)) {
                selectionState.blockGroups.delete(key);
                refreshSelectionHighlights();
                updateSelectionSummary();
                return;
              }

              showLoading('Fetching demographics…');
              var acsData = await fetchAcsForBlockGroup(ids);
              hideLoading();

              selectionState.blockGroups.set(key, {
                key: key,
                label: acsData.name || 'Block Group ' + key,
                ids: ids,
                data: acsData,
                feature: feature,
              });

              refreshSelectionHighlights();
              updateSelectionSummary();
              showPanel('selection-panel');

              // Show popup with ACS data
              var html = '<div style="min-width:220px">';
              html += '<div style="font-weight:800;margin-bottom:6px">' + (acsData.name || 'Block Group') + '</div>';
              html += '<div style="font-size:12px;color:#444;margin-bottom:8px">GEOID ' + key + '</div>';
              html += '<div style="font-size:12px;line-height:1.4">';
              html += '<div><b>Males under 5</b>: ' + fmtInt(acsData.malesUnder5) + '</div>';
              html += '<div><b>Females under 5</b>: ' + fmtInt(acsData.femalesUnder5) + '</div>';
              html += '<div><b>Total population</b>: ' + fmtInt(acsData.totalPop) + '</div>';
              html += '</div>';
              html += '<div style="font-size:11px;color:#666;margin-top:6px">Source: ACS ' + ACS_YEAR + ' 5-year</div>';
              html += '</div>';

              L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
            } catch (err) {
              hideLoading();
              console.error('ACS fetch error:', err);
            }
          });
        },
      });

      // Add to map (block groups on by default now)
      blockGroupsLayer.addTo(map);

      hideLoading();
    } catch (err) {
      console.error('Block group load error:', err);
      hideLoading();
    }
  }

  // ─── Window select (drag rectangle) ───────────────────────
  function enableWindowSelect(enabled) {
    selectionState.windowSelecting = enabled;
    var btn = document.getElementById('window-select-btn');
    if (btn) btn.textContent = enabled ? 'Cancel Window' : 'Window Select';
    if (btn) btn.classList.toggle('active', enabled);

    if (enabled) {
      map.dragging.disable();
    } else {
      map.dragging.enable();
      if (selectionState.windowRect) {
        map.removeLayer(selectionState.windowRect);
        selectionState.windowRect = null;
      }
      selectionState.windowStart = null;
    }
  }

  map.on('mousedown', function (e) {
    if (!selectionState.windowSelecting) return;
    selectionState.windowStart = e.latlng;
    selectionState.windowAdditive = e.originalEvent && e.originalEvent.ctrlKey;
    if (selectionState.windowRect) map.removeLayer(selectionState.windowRect);
    selectionState.windowRect = L.rectangle([e.latlng, e.latlng], {
      color: '#111',
      weight: 1,
      fillOpacity: 0.03,
      dashArray: '4,4',
    }).addTo(map);
  });

  map.on('mousemove', function (e) {
    if (!selectionState.windowSelecting || !selectionState.windowStart || !selectionState.windowRect) return;
    selectionState.windowRect.setBounds(L.latLngBounds(selectionState.windowStart, e.latlng));
  });

  map.on('mouseup', async function (e) {
    if (!selectionState.windowSelecting || !selectionState.windowStart || !selectionState.windowRect) return;

    try {
      var bounds = selectionState.windowRect.getBounds();
      if (!selectionState.windowAdditive) {
        selectionState.blockGroups.clear();
      }

      if (blockGroupsLayer) {
        showLoading('Selecting block groups…');
        var count = 0;
        blockGroupsLayer.eachLayer(async function (layer) {
          var feat = layer.feature;
          if (!feat) return;
          var layerBounds = layer.getBounds();
          if (!bounds.intersects(layerBounds)) return;

          var ids = getBgIds(feat);
          if (!ids) return;
          var key = ids.geoid;
          if (selectionState.blockGroups.has(key)) return;

          count++;
        });

        // Collect intersecting features and fetch ACS data
        var layers = [];
        blockGroupsLayer.eachLayer(function (layer) {
          var feat = layer.feature;
          if (!feat) return;
          var layerBounds = layer.getBounds();
          if (!bounds.intersects(layerBounds)) return;
          layers.push(layer);
        });

        for (var i = 0; i < layers.length; i++) {
          var layer = layers[i];
          var feat = layer.feature;
          var ids = getBgIds(feat);
          if (!ids) continue;
          var key = ids.geoid;
          if (selectionState.blockGroups.has(key)) continue;

          try {
            var acsData = await fetchAcsForBlockGroup(ids);
            selectionState.blockGroups.set(key, {
              key: key,
              label: acsData.name || 'Block Group ' + key,
              ids: ids,
              data: acsData,
              feature: feat,
            });
          } catch (err) {
            console.warn('ACS fetch failed for', key, err);
          }
        }
      }

      hideLoading();
      refreshSelectionHighlights();
      updateSelectionSummary();
      if (selectionState.blockGroups.size > 0) {
        showPanel('selection-panel');
      }
    } catch (err) {
      hideLoading();
      console.error('Window select error:', err);
    } finally {
      selectionState.windowStart = null;
      if (selectionState.windowRect) {
        map.removeLayer(selectionState.windowRect);
        selectionState.windowRect = null;
      }
      enableWindowSelect(false);
    }
  });

  // ─── Sidebar panels ──────────────────────────────────────
  function showPanel(panelId) {
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(panelId).classList.remove('hidden');
  }

  function showDistrictDetail(name, entry) {
    showPanel('district-panel');
    document.getElementById('district-name').textContent = name;

    const naepContainer = document.getElementById('district-naep-data');
    const chartContainer = document.getElementById('modality-chart');
    const schoolsContainer = document.getElementById('district-schools');

    if (entry && entry.naep) {
      naepContainer.innerHTML = ModalityEngine.renderStats(entry.naep);
      chartContainer.innerHTML = ModalityEngine.renderBars(entry.profile);
    } else {
      naepContainer.innerHTML = '<p style="color:#666666">No NAEP data available for this district</p>';
      chartContainer.innerHTML = '';
    }

    // Find schools within this district
    // (simplified: show all schools in view for now)
    renderSchoolList(schoolsContainer, name);
  }

  function renderSchoolList(container, districtName) {
    let html = '<div class="school-list"><h3>Schools in Area</h3>';

    const schools = schoolsInView.slice(0, 50); // Limit display
    if (schools.length === 0) {
      html += '<p style="color:#666666;font-size:0.82rem">Loading schools from OpenStreetMap…</p>';
    }

    for (const feat of schools) {
      const props = feat.properties;
      const name = props.name || 'Unknown School';
      html += `
        <div class="school-item" data-osm-id="${props.osm_id}">
          <div class="school-icon">🏫</div>
          <div>
            <div class="school-item-name">${name}</div>
            ${props.operator ? '<div class="school-item-type">' + props.operator + '</div>' : ''}
          </div>
        </div>`;
    }

    html += '</div>';
    container.innerHTML = html;

    // Attach click handlers
    container.querySelectorAll('.school-item').forEach(el => {
      el.addEventListener('click', function () {
        const osmId = this.dataset.osmId;
        const school = schoolsInView.find(s => String(s.properties.osm_id) === osmId);
        if (school) {
          showSchoolDetail(school.properties);
          const coords = school.geometry.coordinates;
          map.setView([coords[1], coords[0]], 16);
        }
      });
    });
  }

  function showSchoolDetail(props) {
    showPanel('school-panel');
    document.getElementById('school-name').textContent = props.name || 'Unknown School';

    const detailContainer = document.getElementById('school-details');
    let html = '<div class="school-info">';

    const fields = [
      ['Operator', props.operator],
      ['Grades', props.grades],
      ['ISCED Level', props.isced_level],
      ['City', props.addr_city],
      ['OSM ID', props.osm_id],
    ];

    for (const [label, value] of fields) {
      if (value) {
        html += `
          <div class="school-info-row">
            <span class="school-info-label">${label}</span>
            <span class="school-info-value">${value}</span>
          </div>`;
      }
    }

    html += '</div>';

    // Show the NAEP context (the state/district-level data that applies)
    html += '<div style="margin-top:16px">';
    html += '<h3 style="font-size:0.9rem;color:#333333;margin-bottom:8px">NAEP Context (District/State Level)</h3>';
    html += '<p style="font-size:0.78rem;color:#666666;line-height:1.5">';
    html += 'NAEP scores are reported at the state and large-district level. ';
    html += 'For schools within LAUSD, the NAEP TUDA (Trial Urban District Assessment) ';
    html += 'data for Los Angeles is used. For other districts, California state data applies.';
    html += '</p>';

    const naep = naepData['XL'] || naepData['CA'];
    if (naep) {
      const profile = ModalityEngine.computeProfile(naep);
      html += ModalityEngine.renderBars(profile);
    }

    html += '</div>';

    detailContainer.innerHTML = html;
  }

  // ─── Layer controls ──────────────────────────────────────
  function setupLayerControls() {
    document.getElementById('toggle-sd2').addEventListener('change', function () {
      if (this.checked) {
        if (sd2Layer) sd2Layer.addTo(map);
      } else {
        if (sd2Layer) map.removeLayer(sd2Layer);
      }
    });

    document.getElementById('toggle-districts').addEventListener('change', function () {
      if (this.checked) {
        if (districtsLayer) districtsLayer.addTo(map);
      } else {
        if (districtsLayer) map.removeLayer(districtsLayer);
      }
    });

    document.getElementById('toggle-schools').addEventListener('change', function () {
      if (this.checked) {
        if (schoolsLayer) schoolsLayer.addTo(map);
      } else {
        if (schoolsLayer) map.removeLayer(schoolsLayer);
      }
    });

    document.getElementById('toggle-blockgroups').addEventListener('change', function () {
      if (this.checked) {
        if (!blockGroupsLayer) {
          loadBlockGroups();
        } else {
          blockGroupsLayer.addTo(map);
        }
      } else {
        if (blockGroupsLayer) map.removeLayer(blockGroupsLayer);
      }
    });

    // Window select button
    var wsBtn = document.getElementById('window-select-btn');
    if (wsBtn) {
      wsBtn.addEventListener('click', function () {
        enableWindowSelect(!selectionState.windowSelecting);
      });
    }

    // Clear selection button
    var csBtn = document.getElementById('clear-selection-btn');
    if (csBtn) {
      csBtn.addEventListener('click', function () {
        clearSelection();
        showPanel('overview-panel');
      });
    }
  }

  // ─── Navigation ──────────────────────────────────────────
  document.getElementById('back-btn').addEventListener('click', function () {
    showPanel('overview-panel');
    if (highlightedDistrict) {
      districtsLayer.resetStyle(highlightedDistrict);
      highlightedDistrict = null;
    }
  });

  document.getElementById('school-back-btn').addEventListener('click', function () {
    showPanel('district-panel');
  });

  document.getElementById('selection-back-btn').addEventListener('click', function () {
    showPanel('overview-panel');
  });

  // ─── Start ───────────────────────────────────────────────
  init();
})();
