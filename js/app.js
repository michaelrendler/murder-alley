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

  // ─── Map initialisation ──────────────────────────────────────
  const map = L.map('map', {
    center: SD2_CENTER,
    zoom: 12,
    zoomControl: true,
    maxBounds: [[33.5, -118.8], [34.3, -117.8]],
  });

  // Light tile layer (CARTO Positron)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
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
          fillOpacity: 0.25,
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

  // ─── Block Groups (on-demand from TIGERweb) ───────────────
  async function loadBlockGroups() {
    if (blockGroupsLayer) return;

    showLoading('Loading Census block groups…');

    try {
      // Query TIGERweb for block groups in LA County (FIPS 06037)
      const url = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2023/MapServer/10/query'
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

      const data = await loadJSON(url);

      blockGroupsLayer = L.geoJSON(data, {
        style: {
          color: '#999999',
          weight: 0.5,
          opacity: 0.6,
          fillColor: '#999999',
          fillOpacity: 0.08,
        },
        onEachFeature: function (feature, layer) {
          layer.bindTooltip('Block Group: ' + feature.properties.GEOID, {
            className: 'district-tooltip',
          });
        },
      });

      // Only add if checkbox is checked
      if (document.getElementById('toggle-blockgroups').checked) {
        blockGroupsLayer.addTo(map);
      }

      hideLoading();
    } catch (err) {
      console.error('Block group load error:', err);
      hideLoading();
    }
  }

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

  // ─── Start ───────────────────────────────────────────────
  init();
})();
