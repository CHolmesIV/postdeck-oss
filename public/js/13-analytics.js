// ---------------- Analytics (B7) ----------------

const ARROW_GLYPH = { up: '▲', down: '▼', flat: '▬' };
const ARROW_COLOR = { up: '#4c9a5b', down: '#c0392b', flat: 'var(--muted)' };

function deltaBadge(direction) {
  return el('span', { style: `color:${ARROW_COLOR[direction] || 'var(--muted)'};font-weight:bold;` }, ` ${ARROW_GLYPH[direction] || ''}`);
}

// Hand-rolled inline SVG bar chart - no chart library (SPEC.md "Analytics
// portal" keeps the no-dependency rule). `bars` = [{label, value}].
// R6 fix: with many/long category labels (e.g. Ops "Posts by status", 8
// status names), horizontal centered labels collide with their neighbors.
// Past ~5 bars, or when any label is long, rotate the axis labels -40deg
// (anchor 'end') and truncate long ones with an SVG <title> tooltip carrying
// the full text - readable without overlap, full label still discoverable.
function svgBarChart(bars, { width = 420, height = 140, color = '#C8902A' } = {}) {
  const pad = 24;
  const maxLabelLen = Math.max(0, ...bars.map((b) => String(b.label).length));
  const rotateLabels = bars.length > 5 || maxLabelLen > 8;
  const bottomPad = rotateLabels ? 46 : pad;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const barWidth = bars.length ? (width - pad * 2) / bars.length : 0;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height + (rotateLabels ? bottomPad - pad : 0)}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height + (rotateLabels ? bottomPad - pad : 0));

  bars.forEach((b, i) => {
    const barH = ((height - pad * 2) * b.value) / max;
    const x = pad + i * barWidth + barWidth * 0.15;
    const w = barWidth * 0.7;
    const y = height - pad - barH;

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', Math.max(1, w));
    rect.setAttribute('height', Math.max(0, barH));
    rect.setAttribute('fill', color);
    rect.setAttribute('rx', '2');
    svg.appendChild(rect);

    const valueLabel = document.createElementNS(ns, 'text');
    valueLabel.setAttribute('x', x + w / 2);
    valueLabel.setAttribute('y', y - 4);
    valueLabel.setAttribute('text-anchor', 'middle');
    valueLabel.setAttribute('font-size', '10');
    valueLabel.setAttribute('fill', 'var(--text, #ccc)');
    valueLabel.textContent = String(b.value);
    svg.appendChild(valueLabel);

    const fullLabel = String(b.label);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', 'var(--muted, #888)');
    if (rotateLabels) {
      const shown = fullLabel.length > 12 ? fullLabel.slice(0, 11) + '…' : fullLabel;
      label.setAttribute('x', x + w / 2);
      label.setAttribute('y', height - pad + 10);
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('transform', `rotate(-40 ${x + w / 2} ${height - pad + 10})`);
      label.textContent = shown;
      if (shown !== fullLabel) {
        const title = document.createElementNS(ns, 'title');
        title.textContent = fullLabel;
        label.appendChild(title);
      }
    } else {
      label.setAttribute('x', x + w / 2);
      label.setAttribute('y', height - pad + 12);
      label.setAttribute('text-anchor', 'middle');
      label.textContent = fullLabel;
    }
    svg.appendChild(label);
  });

  return svg;
}

// Hand-rolled inline SVG line chart. `points` = [{label, value}], drawn in order.
function svgLineChart(points, { width = 420, height = 140, color = '#3d7ab8' } = {}) {
  const pad = 24;
  const max = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((height - pad * 2) * p.value) / max;
    return [x, y];
  });

  const path = document.createElementNS(ns, 'polyline');
  path.setAttribute('points', coords.map(([x, y]) => `${x},${y}`).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  coords.forEach(([x, y], i) => {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', height - pad + 12);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', 'var(--muted, #888)');
    label.textContent = points[i].label;
    svg.appendChild(label);
  });

  return svg;
}

// Analytics redesign (2026-07-20 feedback): a tight, scannable stat strip -
// small-to-medium numbers with clear labels in a row. Deliberately NOT the
// giant-number/gradient "hero metric" template used elsewhere (that pattern
// is banned for this view per the redesign brief) - this is plain, compact
// text so 6 stats + the charts below fit without a wall of whitespace.
function statRow(totals) {
  return el('div', { class: 'analytics-stat-strip' }, [
    ['Posts', totals.posts_published],
    ['Impressions', totals.impressions],
    ['Engagement', totals.engagement],
    ['Follows', totals.follows],
    ['DMs', totals.dms],
    ['Leads', totals.leads],
  ].map(([label, value]) =>
    el('div', { class: 'analytics-stat-tile' }, [
      el('div', { class: 'analytics-stat-value' }, String(value)),
      el('div', { class: 'analytics-stat-label' }, label),
    ])
  ));
}

async function renderAnalytics(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  // B17a: campaign selector - re-fetches the whole rollup scoped to a single
  // campaign tag via ?tag_id=, so every section below (totals, WoW, top10)
  // reads as "this campaign's numbers" rather than the account-wide ones.
  await loadAllTags();
  const campaigns = allTagsCache.filter((t) => t.kind === 'campaign');
  const campaignSelect = el('select', {}, [
    el('option', { value: '' }, 'All (no campaign filter)'),
    ...campaigns.map((c) => el('option', { value: c.id }, c.name)),
  ]);
  const importBtn = el('button', { class: 'button secondary sm', type: 'button', onclick: () => openMetricsImportModal(() => renderAnalyticsBody(campaignSelect.value)) }, 'Import analytics');
  const analyticsBody = el('div');
  // R1: title -> actions; export/import next, campaign filter (the only
  // narrowing filter on this view) rightmost.
  view.appendChild(pageHeader('Analytics', importBtn, el('span', {}, 'Campaign:'), campaignSelect));
  view.appendChild(
    inlineBanner(
      'Blotato now shows analytics in its web app, but its documented public API does not currently expose engagement metrics. PostDeck keeps CSV import as the reliable bridge until Blotato publishes an analytics endpoint or export contract.',
      'info'
    )
  );
  view.appendChild(analyticsBody);
  campaignSelect.onchange = () => renderAnalyticsBody(campaignSelect.value);
  await renderAnalyticsBody('');

  async function renderAnalyticsBody(tagId) {
    analyticsBody.innerHTML = '';
    const qs = tagId ? `?tag_id=${encodeURIComponent(tagId)}` : '';
    const data = await api(`/api/analytics${qs}`);
    if (tagId) {
      const campaign = tagById(tagId);
      const banner = inlineBanner([el('strong', {}, 'Campaign performance'), `: only posts tagged "${campaign?.name || tagId}"`], 'info');
      banner.style.borderLeft = `4px solid ${campaign?.color || 'var(--gold)'}`;
      analyticsBody.appendChild(banner);
    }
    renderAnalyticsSections(analyticsBody, data);
  }
}

// ---- Redraft-the-winner (B18b) ----
// Stashes the original post's copy + brand/platform in sessionStorage and
// hands off to the Composer (same sessionStorage-handoff pattern as B9's
// Home quick-create bar), which auto-runs Draft with AI with a "fresh take
// on this proven post" framing prompt through the existing /api/draft path.
function redraftButton(p) {
  return el('button', {
    class: 'button ghost sm redraft-btn',
    type: 'button',
    title: 'Draft a fresh take on this proven post',
    onclick: () => {
      sessionStorage.setItem(
        'pd_composer_redraft',
        JSON.stringify({ brand_id: p.brand_id, platform: p.platform, copy: p.copy || '' })
      );
      setStickyBrand(String(p.brand_id));
      location.hash = '#/composer';
    },
  }, 'Redraft');
}

// Item 6 (2026-07-19 feedback), reworked 2026-07-20 into a dense table row -
// impressions/comments/shares mirror the 3 most prominent fields on the
// full manual metrics form (renderPostDetail's `fields` list starts with
// impressions/comments/shares; saves/profile_visits/follows/dms/leads stay
// full-form-only). Enter in any field or the checkmark button both save via
// the SAME POST /api/posts/:id/metrics route the full form uses - no new
// endpoint. On success the row is removed from the due list in place and a
// toast confirms, matching the rest of the app's save feedback pattern.
// The column labels live in the table's <th> header (see metrics-due-table
// below), not in per-input placeholders, so the inputs stay compact without
// truncating any label text - that was the original complaint (2. "impressi…
// comme… share").
function metricsDueRow(p) {
  const impressionsInput = el('input', { type: 'number', class: 'sm', placeholder: '0', 'aria-label': 'Impressions', min: '0' });
  const commentsInput = el('input', { type: 'number', class: 'sm', placeholder: '0', 'aria-label': 'Comments', min: '0' });
  const sharesInput = el('input', { type: 'number', class: 'sm', placeholder: '0', 'aria-label': 'Shares', min: '0' });
  const rowMsg = el('div', { class: 'metrics-due-row-msg' });
  const saveBtn = el('button', { class: 'button primary sm', type: 'button', title: 'Save metrics' }, '✓');

  async function save() {
    const body = {};
    if (impressionsInput.value !== '') body.impressions = Number(impressionsInput.value);
    if (commentsInput.value !== '') body.comments = Number(commentsInput.value);
    if (sharesInput.value !== '') body.shares = Number(sharesInput.value);
    if (!Object.keys(body).length) {
      rowMsg.innerHTML = '';
      rowMsg.appendChild(inlineBanner('Enter at least one value first.', 'error'));
      return;
    }
    saveBtn.disabled = true;
    try {
      await api(`/api/posts/${p.id}/metrics`, { method: 'POST', body });
      toast(`Metrics saved for #${p.id}.`);
      row.remove();
    } catch (err) {
      saveBtn.disabled = false;
      rowMsg.innerHTML = '';
      rowMsg.appendChild(inlineBanner(`Could not save: ${err.message}`, 'error'));
    }
  }
  saveBtn.onclick = save;
  for (const input of [impressionsInput, commentsInput, sharesInput]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }

  const row = el('tr', {}, [
    el('td', {}, [
      el('div', { class: 'metrics-due-post-cell' }, [
        el('a', { href: `#/post/${p.id}` }, [platformIcon(p.platform, { size: 12 }), ` #${p.id} - ${brandName(p.brand_id)} - ${p.platform}`]),
      ]),
    ]),
    el('td', { class: 'metrics-due-date' }, fmtDate(p.updated_at)),
    el('td', {}, impressionsInput),
    el('td', {}, commentsInput),
    el('td', {}, sharesInput),
    el('td', {}, [saveBtn, rowMsg]),
  ]);
  return row;
}

// Analytics redesign (2026-07-20 feedback): rollups now lead the view -
// per-brand totals/charts render first so "Analytics" shows analytics
// first, not a chore list. "Metrics due" is demoted to a compact,
// collapsed-by-default panel appended at the end (see metricsDuePanel).
function renderAnalyticsSections(view, data) {
  if (data.brands.length) {
    const stack = el('div', { class: 'analytics-brand-stack' });
    for (const brand of data.brands) {
      stack.appendChild(brandRollupCard(brand));
    }
    view.appendChild(stack);
  } else if (!data.metrics_due.length) {
    view.appendChild(emptyState('No analytics yet - publish some posts and add metrics to see rollups here.'));
  }

  if (data.metrics_due.length) {
    view.appendChild(metricsDuePanel(data.metrics_due));
  }
}

// One brand's rollup: totals strip + week-over-week + charts + top10 lists.
// Uses `.home-panel` (less padding, no bottom margin - spacing comes from
// the `.analytics-brand-stack` gap instead) so more than one brand's
// summary is visible without heavy scrolling, matching Home's density.
function brandRollupCard(brand) {
  const card = el('div', { class: 'card home-panel' });
  card.appendChild(
    el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
      el('h2', { style: `border-left:4px solid ${brandColor(brand.brand_id)};padding-left:8px;` }, brand.name),
    ])
  );

  const tabs = ['7d', '30d', '90d', 'all_time'];
  const tabsRow = el('div', { class: 'tabs' });
  const bodyHost = el('div');
  card.appendChild(tabsRow);
  card.appendChild(bodyHost);

  let activeTab = '7d';
  function renderTab() {
    tabsRow.innerHTML = '';
    bodyHost.innerHTML = '';
    for (const t of tabs) {
      tabsRow.appendChild(
        el('button', { class: t === activeTab ? 'active' : '', onclick: () => { activeTab = t; renderTab(); } },
          t === 'all_time' ? 'All-time' : t)
      );
    }
    bodyHost.appendChild(statRow(brand.totals[activeTab]));

    const wow = brand.week_over_week;
    bodyHost.appendChild(
      el('div', { style: 'margin-top:8px;font-size:12.5px;' }, [
        el('strong', {}, 'Week over week: '),
        'Impressions', deltaBadge(wow.impressions),
        '  Engagement', deltaBadge(wow.engagement),
        '  Leads', deltaBadge(wow.leads),
      ])
    );

    const platforms = Object.entries(brand.by_platform).filter(([, v]) => v.impressions > 0 || v.engagement > 0);
    if (platforms.length) {
      bodyHost.appendChild(el('h3', { style: 'margin:12px 0 4px;font-size:13px;' }, 'Impressions by platform (30d)'));
      bodyHost.appendChild(svgBarChart(platforms.map(([p, v]) => ({ label: p, value: v.impressions }))));
    }

    bodyHost.appendChild(el('h3', { style: 'margin:12px 0 4px;font-size:13px;' }, 'Impressions trend (7d / 30d / 90d / all-time)'));
    bodyHost.appendChild(
      svgLineChart(
        ['7d', '30d', '90d', 'all_time'].map((t) => ({
          label: t === 'all_time' ? 'all' : t,
          value: brand.totals[t].impressions,
        }))
      )
    );

    const top10 = el('div', { class: 'analytics-top10-grid' });
    const impCol = el('div', {}, [el('h3', { style: 'margin:0 0 4px;font-size:13px;' }, 'Top 10 by impressions')]);
    for (const p of brand.top10_by_impressions) {
      impCol.appendChild(
        el('div', {}, [el('a', { href: `#/post/${p.id}` }, `#${p.id} ${p.platform}`), ` - ${p.total_impressions} impressions`, redraftButton(p)])
      );
    }
    const leadCol = el('div', {}, [el('h3', { style: 'margin:0 0 4px;font-size:13px;' }, 'Top 10 by leads')]);
    for (const p of brand.top10_by_leads) {
      leadCol.appendChild(
        el('div', {}, [el('a', { href: `#/post/${p.id}` }, `#${p.id} ${p.platform}`), ` - ${p.total_leads} leads`, redraftButton(p)])
      );
    }
    top10.append(impCol, leadCol);
    bodyHost.appendChild(top10);
  }
  renderTab();

  return card;
}

// Metrics-due (2026-07-20 feedback item 2): was a tall full-width list of
// big rows leading the page - now a compact, collapsed-by-default panel
// (localStorage-persisted like the composer's collapsible sections) below
// the rollups, with a dense table body so it's fast to tab through: one
// row per post, column headers carry the field labels (not per-input
// placeholders) so nothing truncates at a workable input width.
function metricsDuePanel(metricsDue) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', {}, `Metrics due (${metricsDue.length})`));
  card.appendChild(el('div', { class: 'metrics-due-hint' },
    'Published posts older than 48h with no metrics entered yet.'));

  const table = el('table', { class: 'metrics-due-table' });
  table.appendChild(
    el('tr', {}, [
      el('th', {}, 'Post'),
      el('th', {}, 'Published'),
      el('th', {}, 'Impressions'),
      el('th', {}, 'Comments'),
      el('th', {}, 'Shares'),
      el('th', {}, ''),
    ])
  );
  for (const p of metricsDue) {
    table.appendChild(metricsDueRow(p));
  }
  card.appendChild(el('div', { class: 'metrics-due-table-wrap' }, [table]));

  return makeCollapsible(card, { open: false, key: 'analytics-metrics-due' });
}

// ---------------- Metrics import (item 7, 2026-07-19 feedback) ----------------
// Analytics -> "Import analytics": platform/brand + a CSV export (LinkedIn or
// Meta/Facebook) -> POST /api/metrics-import/preview (no writes) -> operator
// confirms/corrects matches -> POST /api/metrics-import/apply (writes). Both
// routes already existed server-side (src/metrics-import.js) with no UI.
function openMetricsImportModal(onApplied) {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card modal-import' });
  overlay.appendChild(card);
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);

  card.appendChild(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Import analytics'),
      el('button', { class: 'modal-close', title: 'Close', type: 'button', onclick: close }, '✕'),
    ])
  );

  const platformSelect = el('select', {}, [
    el('option', { value: '' }, 'Select platform…'),
    ...['linkedin', 'facebook', 'twitter', 'instagram', 'reddit', 'tiktok', 'youtube', 'threads'].map((p) => el('option', { value: p }, p)),
  ]);
  const brandSelect = el('select', {}, [
    el('option', { value: '' }, 'All brands'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv' });
  const previewBtn = el('button', { class: 'button primary md', type: 'button' }, 'Preview');
  const formMsg = el('div');
  card.append(
    el('div', { class: 'field-row' }, [el('label', {}, 'Platform'), platformSelect]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Brand'), brandSelect]),
    el('div', { class: 'field-row' }, [el('label', {}, 'CSV export'), fileInput]),
    el('div', { style: 'color:var(--muted);font-size:11px;margin:-4px 0 8px;' }, 'Export as CSV from LinkedIn (Analytics -> Content) or Meta Business Suite (Insights -> Export). XLSX is not supported - export/save as CSV.'),
    el('div', { class: 'toolbar' }, [previewBtn]),
    formMsg
  );

  const previewHost = el('div');
  card.appendChild(previewHost);

  previewBtn.addEventListener('click', async () => {
    formMsg.innerHTML = '';
    previewHost.innerHTML = '';
    if (!platformSelect.value) { formMsg.appendChild(inlineBanner('Pick a platform first.', 'error')); return; }
    if (!fileInput.files.length) { formMsg.appendChild(inlineBanner('Choose a CSV file first.', 'error')); return; }
    previewBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      fd.append('platform', platformSelect.value);
      if (brandSelect.value) fd.append('brand_id', brandSelect.value);
      const res = await api('/api/metrics-import/preview', { method: 'POST', body: fd });
      renderImportPreview(res);
    } catch (err) {
      formMsg.appendChild(inlineBanner(`Could not parse file: ${err.message}`, 'error'));
    } finally {
      previewBtn.disabled = false;
    }
  });

  function renderImportPreview(res) {
    previewHost.innerHTML = '';
    previewHost.appendChild(
      el('div', { style: 'color:var(--muted);font-size:12px;margin:8px 0;' },
        `${res.total_rows} row(s) parsed, ${res.skipped_rows} skipped (no parseable date).`)
    );
    if (!res.matches.length) {
      previewHost.appendChild(emptyState('No rows to import.'));
      return;
    }
    const table = el('table', { class: 'metrics-import-table' });
    table.appendChild(
      el('tr', {}, [
        el('th', {}, ''),
        el('th', {}, 'Date'),
        el('th', {}, 'Metrics'),
        el('th', {}, 'Matched post'),
        el('th', {}, 'Confidence'),
      ])
    );
    // Per-row state: whether it's included in the apply, and (for ambiguous
    // rows) which candidate post the operator picked.
    const rowStates = res.matches.map((m) => ({
      match: m,
      included: m.confidence !== 'none',
      chosenPostId: m.confidence === 'ambiguous' ? null : m.post_id,
    }));

    function metricsSummary(row) {
      const parts = [];
      for (const f of ['impressions', 'clicks', 'likes', 'comments', 'shares', 'reach', 'results', 'engagement_rate']) {
        if (row[f] != null && row[f] !== '') parts.push(`${f}: ${row[f]}`);
      }
      return parts.join(', ') || '(no metrics parsed)';
    }

    for (const state_ of rowStates) {
      const m = state_.match;
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = state_.included;
      checkbox.disabled = m.confidence === 'none' && !m.post_id;
      checkbox.addEventListener('change', () => { state_.included = checkbox.checked; });

      let matchCell;
      if (m.confidence === 'ambiguous' && m.candidates?.length) {
        const candSelect = el('select', {}, [
          el('option', { value: '' }, 'Pick a post…'),
          ...m.candidates.map((c) => el('option', { value: c.post_id }, `#${c.post_id} - ${c.post_copy_snippet || '(no copy)'}`)),
        ]);
        candSelect.addEventListener('change', () => {
          state_.chosenPostId = candSelect.value ? Number(candSelect.value) : null;
          state_.included = !!state_.chosenPostId;
          checkbox.checked = state_.included;
        });
        matchCell = candSelect;
      } else if (m.post_id) {
        matchCell = el('span', {}, `#${m.post_id} - ${m.post_copy_snippet || '(no copy)'}`);
      } else {
        matchCell = el('span', { style: 'color:var(--muted);' }, m.reason === 'unparseable_date' ? 'no date' : 'no match');
      }

      const confBadge = el('span', { class: `pill confidence-${m.confidence}` }, m.confidence);

      table.appendChild(
        el('tr', {}, [
          el('td', {}, checkbox),
          el('td', {}, m.row.date || '-'),
          el('td', { style: 'font-size:12px;' }, metricsSummary(m.row)),
          el('td', { style: 'font-size:12px;' }, matchCell),
          el('td', {}, confBadge),
        ])
      );
    }
    previewHost.appendChild(table);

    const applyMsg = el('div');
    const applyBtn = el('button', { class: 'button primary md', type: 'button' }, `Apply ${rowStates.filter((s) => s.included).length} rows`);
    function refreshApplyCount() {
      applyBtn.textContent = `Apply ${rowStates.filter((s) => s.included && s.chosenPostId).length} rows`;
    }
    table.addEventListener('change', refreshApplyCount);
    refreshApplyCount();

    applyBtn.addEventListener('click', async () => {
      const decisions = rowStates
        .filter((s) => s.included && s.chosenPostId)
        .map((s) => {
          const row = s.match.row;
          const metrics = { notes: '' };
          for (const f of ['impressions', 'comments', 'shares']) {
            if (row[f] != null && row[f] !== '') metrics[f] = row[f];
          }
          const extra = {};
          for (const f of ['likes', 'clicks', 'reach', 'results', 'engagement_rate']) {
            if (row[f] != null && row[f] !== '') extra[f] = row[f];
          }
          if (Object.keys(extra).length) metrics.extra = extra;
          return { post_id: s.chosenPostId, metrics };
        });
      if (!decisions.length) {
        applyMsg.innerHTML = '';
        applyMsg.appendChild(inlineBanner('No confirmed rows to apply - check at least one matched row.', 'error'));
        return;
      }
      applyBtn.disabled = true;
      try {
        const res2 = await api('/api/metrics-import/apply', { method: 'POST', body: { decisions } });
        toast(`Imported ${res2.applied} row(s) of metrics.`);
        close();
        if (typeof onApplied === 'function') onApplied();
      } catch (err) {
        applyMsg.innerHTML = '';
        applyMsg.appendChild(inlineBanner(`Could not apply: ${err.message}`, 'error'));
        applyBtn.disabled = false;
      }
    });
    previewHost.append(el('div', { class: 'toolbar', style: 'margin-top:10px;' }, [applyBtn]), applyMsg);
  }
}

// ---------------- B8 shared helpers (image dims, usage recording is server-side) ----------------

// Client-side mirror of src/imagespec.js's parseDims - no import across the
// server/browser boundary, so this is intentionally duplicated in the same
// shape (SPEC.md B8 "Multi-size preview... reuse/add a small parser").
function parseDimsClient(raw) {
  if (typeof raw !== 'string') return { raw: raw ?? null };
  const m = raw.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!m) return { raw };
  const w = Number(m[1]);
  const h = Number(m[2]);
  const aspectMatch = raw.match(/\((\d+):(\d+)\)/);
  let aspect;
  if (aspectMatch) {
    aspect = `${aspectMatch[1]}:${aspectMatch[2]}`;
  } else {
    const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; };
    const d = gcd(w, h) || 1;
    aspect = `${w / d}:${h / d}`;
  }
  return { w, h, aspect, raw };
}

// Mirrors src/imagespec.js's pickImageDimsRaw - picks the most relevant raw
// dims string out of a platform's `image` spec (varies a lot per platform).
function platformImageDimsRaw(platform, contentType) {
  const spec = platformSpec(platform);
  const image = spec?.image;
  if (!image) return null;
  if (contentType === 'carousel' && typeof image.carousel === 'string') return image.carousel;
  if (typeof image.feed === 'string') return image.feed;
  if (typeof image.portrait === 'string') return image.portrait;
  if (typeof image.square === 'string') return image.square;
  if (typeof image.story === 'string') return image.story;
  if (Array.isArray(image.dims) && image.dims.length) return image.dims[0];
  if (typeof image.dims === 'string') return image.dims;
  return null;
}
