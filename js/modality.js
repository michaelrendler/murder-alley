/**
 * Natural Learning Modality Scoring Engine
 *
 * Computes a learning-modality profile from NAEP cross-subject data.
 *
 * Phase 1 uses state-level NAEP composite scores in Mathematics, Reading,
 * and Science (where available) to derive four modality dimensions:
 *
 *   1. Logical-Mathematical — relative strength in quantitative reasoning
 *   2. Linguistic           — relative strength in verbal comprehension
 *   3. Analytical-Scientific — scientific inquiry / empirical reasoning
 *   4. Balanced/Multimodal  — evenness across modalities
 *
 * The engine normalises each jurisdiction's scores against the national
 * average and converts them into a percentage-based profile.
 */

const ModalityEngine = (function () {
  'use strict';

  // NAEP national reference values (Grade 8, 2024 where available)
  const NATIONAL_REF = {
    math_mean: 273.83,
    reading_mean: 258.05,
    science_mean: 153.75, // 2019 — last year with state data
    math_below_basic: 39.38,
    math_at_above_prof: 28.03,
    reading_below_basic: 32.92,
    reading_at_above_prof: 29.84,
  };

  const MODALITY_COLORS = {
    logical: '#4285f4',
    linguistic: '#ea4335',
    scientific: '#34a853',
    balanced: '#fbbc04',
  };

  const MODALITY_LABELS = {
    logical: 'Logical-Mathematical',
    linguistic: 'Linguistic',
    scientific: 'Analytical-Scientific',
    balanced: 'Balanced / Multimodal',
  };

  /**
   * Compute a modality profile for a jurisdiction.
   *
   * @param {Object} d — NAEP data object for the jurisdiction
   *   Expected keys: math_8_2024_mean, reading_8_2024_mean,
   *   science_8_2019_mean (optional), and achievement-level fields.
   * @returns {Object} { logical, linguistic, scientific, balanced, dominant }
   *   Each value is 0–100; dominant is the key with the highest score.
   */
  function computeProfile(d) {
    const mathMean = d.math_8_2024_mean || d.math_4_2024_mean;
    const readMean = d.reading_8_2024_mean || d.reading_4_2024_mean;
    const sciMean = d.science_8_2019_mean;

    if (!mathMean && !readMean) {
      return null;
    }

    // Compute relative strengths against national averages
    const mathRel = mathMean ? (mathMean / NATIONAL_REF.math_mean) : 1.0;
    const readRel = readMean ? (readMean / NATIONAL_REF.reading_mean) : 1.0;
    const sciRel = sciMean ? (sciMean / NATIONAL_REF.science_mean) : null;

    // Math-reading differential: positive = math-leaning, negative = reading-leaning
    const mathReadDiff = mathMean && readMean
      ? (mathMean - NATIONAL_REF.math_mean) - (readMean - NATIONAL_REF.reading_mean)
      : 0;

    // Achievement-level spread (how concentrated vs spread the distribution is)
    const mathBB = d.math_8_2024_below_basic || d.math_4_2024_below_basic || NATIONAL_REF.math_below_basic;
    const mathAP = d.math_8_2024_at_above_prof || d.math_4_2024_at_above_prof || NATIONAL_REF.math_at_above_prof;
    const readBB = d.reading_8_2024_below_basic || d.reading_4_2024_below_basic || NATIONAL_REF.reading_below_basic;
    const readAP = d.reading_8_2024_at_above_prof || d.reading_4_2024_at_above_prof || NATIONAL_REF.reading_at_above_prof;

    // Raw modality scores (unbounded)
    let logical = 50;
    let linguistic = 50;
    let scientific = 50;

    // Math relative strength boosts logical
    logical += (mathRel - 1) * 200;
    logical += Math.max(0, mathReadDiff) * 1.5;

    // Reading relative strength boosts linguistic
    linguistic += (readRel - 1) * 200;
    linguistic += Math.max(0, -mathReadDiff) * 1.5;

    // Science relative strength boosts scientific
    if (sciRel !== null) {
      scientific += (sciRel - 1) * 200;
    } else {
      // Without science data, estimate from math/reading blend
      scientific += ((mathRel + readRel) / 2 - 1) * 150;
    }

    // Proficiency rates further shape the profile
    const mathProfDiff = mathAP - NATIONAL_REF.math_at_above_prof;
    const readProfDiff = readAP - NATIONAL_REF.reading_at_above_prof;
    logical += mathProfDiff * 0.5;
    linguistic += readProfDiff * 0.5;

    // Clamp to 10–95
    logical = clamp(logical, 10, 95);
    linguistic = clamp(linguistic, 10, 95);
    scientific = clamp(scientific, 10, 95);

    // Balanced = inverse of the coefficient of variation across the three modalities
    const vals = [logical, linguistic, scientific];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const stddev = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
    const cv = mean > 0 ? stddev / mean : 0;
    let balanced = clamp(100 * (1 - cv * 3), 10, 95);

    // Normalise so the four modalities sum to 100
    const total = logical + linguistic + scientific + balanced;
    const profile = {
      logical: round2(logical / total * 100),
      linguistic: round2(linguistic / total * 100),
      scientific: round2(scientific / total * 100),
      balanced: round2(balanced / total * 100),
    };

    // Determine dominant modality
    const modalities = ['logical', 'linguistic', 'scientific', 'balanced'];
    profile.dominant = modalities.reduce((a, b) => profile[a] >= profile[b] ? a : b);

    return profile;
  }

  /**
   * Assign a colour to a district based on its dominant modality.
   */
  function getColor(profile) {
    if (!profile) return '#555';
    return MODALITY_COLORS[profile.dominant] || '#555';
  }

  /**
   * Render a modality bar chart as HTML.
   */
  function renderBars(profile) {
    if (!profile) return '<p style="color:#666666">No data available</p>';

    const modalities = ['logical', 'linguistic', 'scientific', 'balanced'];
    let html = '<div class="modality-bars"><h3>Learning Modality Profile</h3>';

    for (const key of modalities) {
      const pct = profile[key];
      const color = MODALITY_COLORS[key];
      const label = MODALITY_LABELS[key];
      const isDominant = key === profile.dominant;

      html += `
        <div class="bar-row">
          <span class="bar-label">${label}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${color};
                 ${isDominant ? 'box-shadow:0 0 8px ' + color : ''}">
              <span class="bar-value">${pct}%</span>
            </div>
          </div>
        </div>`;
    }

    html += '</div>';
    return html;
  }

  /**
   * Render NAEP stat cards for the detail panel.
   */
  function renderStats(d) {
    const mathMean = d.math_8_2024_mean || d.math_4_2024_mean;
    const readMean = d.reading_8_2024_mean || d.reading_4_2024_mean;
    const mathGrade = d.math_8_2024_mean ? '8' : '4';
    const readGrade = d.reading_8_2024_mean ? '8' : '4';

    let html = '<div class="naep-stats">';

    if (mathMean) {
      const diff = mathMean - NATIONAL_REF.math_mean;
      const cls = diff > 0 ? 'above' : diff < 0 ? 'below' : 'neutral';
      const sign = diff > 0 ? '+' : '';
      html += `
        <div class="stat-card">
          <div class="stat-label">Math (Gr. ${mathGrade})</div>
          <div class="stat-value">${mathMean.toFixed(1)}</div>
          <div class="stat-comparison ${cls}">${sign}${diff.toFixed(1)} vs national</div>
        </div>`;
    }

    if (readMean) {
      const diff = readMean - NATIONAL_REF.reading_mean;
      const cls = diff > 0 ? 'above' : diff < 0 ? 'below' : 'neutral';
      const sign = diff > 0 ? '+' : '';
      html += `
        <div class="stat-card">
          <div class="stat-label">Reading (Gr. ${readGrade})</div>
          <div class="stat-value">${readMean.toFixed(1)}</div>
          <div class="stat-comparison ${cls}">${sign}${diff.toFixed(1)} vs national</div>
        </div>`;
    }

    const mathAP = d.math_8_2024_at_above_prof || d.math_4_2024_at_above_prof;
    if (mathAP) {
      html += `
        <div class="stat-card">
          <div class="stat-label">Math Proficient+</div>
          <div class="stat-value">${mathAP.toFixed(1)}%</div>
          <div class="stat-comparison neutral">at or above proficient</div>
        </div>`;
    }

    const readAP = d.reading_8_2024_at_above_prof || d.reading_4_2024_at_above_prof;
    if (readAP) {
      html += `
        <div class="stat-card">
          <div class="stat-label">Reading Proficient+</div>
          <div class="stat-value">${readAP.toFixed(1)}%</div>
          <div class="stat-comparison neutral">at or above proficient</div>
        </div>`;
    }

    html += '</div>';
    return html;
  }

  /**
   * Map a school district name to its NAEP jurisdiction.
   * NAEP data is at state (CA) or TUDA district level (XL = Los Angeles).
   */
  function mapDistrictToNAEP(districtName, naepData) {
    const name = (districtName || '').toLowerCase();

    // Direct TUDA mapping for LA-area districts
    if (name.includes('los angeles unified')) {
      return naepData['XL'] || naepData['CA'];
    }

    // Other districts in the SD2 area fall back to California state data
    return naepData['CA'];
  }

  // Utilities
  function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
  function round2(val) { return Math.round(val * 100) / 100; }

  return {
    computeProfile,
    getColor,
    renderBars,
    renderStats,
    mapDistrictToNAEP,
    MODALITY_COLORS,
    MODALITY_LABELS,
  };
})();
