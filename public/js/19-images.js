// ---------------- Images / Codex handoff (B8) ----------------

// ---------------- Resize-for-platforms control (B14) ----------------
// Per generated variant: pick platform(s) -> POST /api/media/resize -> show
// the produced files, or a friendly note if sips (macOS-only, no dep) isn't
// available on this machine.
function imagePlatformsWithSpecs() {
  const specs = state.platformSpecs || {};
  return Object.keys(specs).filter((k) => specs[k] && specs[k].image);
}

function resizeControl(variant, request) {
  const wrap = el('div', { class: 'resize-box' });
  const toggleBtn = el('button', { class: 'button secondary sm', type: 'button', style: 'margin-top:6px;width:100%;' }, 'Resize for platforms');
  const panel = el('div', { class: 'resize-panel', hidden: true });
  wrap.appendChild(toggleBtn);
  wrap.appendChild(panel);

  const platforms = imagePlatformsWithSpecs();
  const checks = platforms.map((p) => {
    const cb = el('input', { type: 'checkbox', value: p });
    return { platform: p, cb, row: el('label', { class: 'resize-platform-check' }, [cb, ` ${p}`]) };
  });
  if (checks.length) {
    panel.appendChild(el('div', { class: 'resize-platform-list' }, checks.map((c) => c.row)));
  } else {
    panel.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;' }, 'No platform image specs loaded.'));
  }

  const resultHost = el('div');
  panel.appendChild(
    el('button', {
      class: 'button primary sm',
      type: 'button',
      style: 'margin-top:6px;width:100%;',
      onclick: async () => {
        resultHost.innerHTML = '';
        const chosen = checks.filter((c) => c.cb.checked).map((c) => c.platform);
        if (!chosen.length) {
          toast('Pick at least one platform.', 'error');
          return;
        }
        try {
          const res = await api('/api/media/resize', {
            method: 'POST',
            body: { source_path: variant.path, platforms: chosen, post_id: request.post_id || undefined },
          });
          const files = res.files || res.produced || [];
          if (files.length) {
            const list = el('ul', { class: 'history-list' });
            for (const f of files) {
              list.appendChild(el('li', {}, `${f.platform || ''}: ${f.path || f.url || ''}`));
            }
            resultHost.appendChild(list);
            toast('Resized.');
          } else {
            resultHost.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;' }, 'Resize ran - no files returned.'));
          }
        } catch (err) {
          if (err.data?.error === 'resize_unavailable') {
            resultHost.appendChild(inlineBanner('Resize needs macOS sips - not available here.', 'warn'));
          } else {
            toast(err.message, 'error');
          }
        }
      },
    }, 'Resize')
  );
  panel.appendChild(resultHost);

  toggleBtn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  return wrap;
}

async function renderImages(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  const statusFilter = el('select', {}, [
    el('option', { value: '' }, 'All statuses'),
    ...['requested', 'generated', 'picked', 'canceled'].map((s) => el('option', { value: s }, s)),
  ]);
  // R1: title -> actions; status filter rightmost (only filter on this view).
  view.appendChild(pageHeader('Images', el('span', {}, 'Status:'), statusFilter));
  view.appendChild(
    inlineBanner('Codex drops generated variants into image-requests/generated/ - see docs/CODEX_IMAGE_HANDOFF.md for the handoff contract.', 'info')
  );

  const listHost = el('div');
  view.appendChild(listHost);

  async function reload() {
    listHost.innerHTML = '';
    const qs = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : '';
    let reqs;
    try {
      reqs = await api(`/api/image-requests${qs}`);
    } catch (err) {
      listHost.appendChild(inlineBanner(`Could not load image requests: ${err.message}`, 'error'));
      return;
    }
    if (!reqs.length) {
      listHost.appendChild(emptyState('No image requests yet - use "Request image (Codex)" in the Composer.'));
      return;
    }
    for (const r of reqs) {
      const card = el('div', { class: 'card' });
      // Item 5 (2026-07-19 feedback): 'requested' is the state right after
      // firing a request from either composer, before Codex has picked it up
      // - the raw word "requested" reads as ambiguous/stuck, so it gets a
      // clearer label here (same wording used in the two composers' success
      // messages, so the phrase is consistent everywhere it appears).
      const statusLabel = r.status === 'requested' ? 'Waiting on Codex' : r.status;
      card.appendChild(
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, [
          el('strong', {}, `Request #${r.id}`),
          el('span', { class: `pill status-${r.status}` }, statusLabel),
          el('span', { style: 'color:var(--muted);font-size:12px;' }, (r.platforms || []).join(', ')),
          r.content_type ? el('span', { style: 'color:var(--muted);font-size:12px;' }, r.content_type) : null,
          r.post_id ? el('a', { href: `#/post/${r.post_id}`, style: 'font-size:12px;' }, `→ post #${r.post_id}`) : null,
        ])
      );
      card.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;margin-top:4px;' }, `Created: ${fmtDate(r.created_at)}`));
      if (r.status === 'requested') {
        card.appendChild(
          el('div', { style: 'color:var(--muted);font-size:12px;margin-top:4px;' },
            'Waiting on Codex - run the image handoff to generate variants for this request (see docs/CODEX_IMAGE_HANDOFF.md).')
        );
      }

      const brief = r.brief && typeof r.brief === 'object' ? r.brief : null;
      if (brief?.platforms?.length) {
        const briefList = el('ul', { class: 'history-list', style: 'margin-top:8px;' });
        for (const pb of brief.platforms) {
          const dimsStr = pb.dims?.raw || (pb.dims?.w ? `${pb.dims.w}x${pb.dims.h}` : '?');
          briefList.appendChild(el('li', {}, `${pb.platform}: ${dimsStr} (${pb.format || 'jpg'})${pb.max_mb ? `, max ${pb.max_mb}MB` : ''}`));
        }
        card.appendChild(briefList);
      }

      if (r.status === 'generated' && r.variants && r.variants.length) {
        const variantRow = el('div', { class: 'image-variant-row' });
        for (const v of r.variants) {
          const vCard = el('div', { class: 'image-variant' }, [
            el('img', { src: v.url, alt: v.notes || v.platform || 'variant', loading: 'lazy', decoding: 'async' }),
            el('div', { style: 'font-size:11px;color:var(--muted);margin-top:4px;' }, `${v.platform || ''} ${v.dims || ''}`),
            el('button', {
              class: 'button primary sm',
              type: 'button',
              style: 'margin-top:6px;width:100%;',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/pick`, { method: 'POST', body: { chosen_path: v.path } });
                  toast('Variant picked.');
                  reload();
                } catch (err) {
                  toast(`Could not pick: ${err.message}`, 'error');
                }
              },
            }, 'Pick'),
            resizeControl(v, r),
          ]);
          variantRow.appendChild(vCard);
        }
        card.appendChild(variantRow);
      }

      if (['generated', 'picked'].includes(r.status)) {
        card.appendChild(
          el('div', { class: 'toolbar', style: 'margin-top:8px;' }, [
            el('button', {
              class: 'button secondary sm',
              type: 'button',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/regenerate`, { method: 'POST' });
                  toast('Regenerating variants.');
                  reload();
                } catch (err) {
                  toast(`Could not regenerate: ${err.message}`, 'error');
                }
              },
            }, 'Regenerate / more variants'),
          ])
        );
      }

      if (r.status === 'picked' && r.chosen_path) {
        card.appendChild(el('div', { style: 'margin-top:8px;color:var(--green);font-size:12px;' }, `Chosen: ${r.chosen_path}`));
      }

      if (['requested', 'generated'].includes(r.status)) {
        card.appendChild(
          el('div', { class: 'toolbar', style: 'margin-top:8px;' }, [
            el('button', {
              class: 'button destructive sm',
              type: 'button',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/cancel`, { method: 'POST' });
                  toast('Request canceled.');
                  reload();
                } catch (err) {
                  toast(`Could not cancel: ${err.message}`, 'error');
                }
              },
            }, 'Cancel'),
          ])
        );
      }

      listHost.appendChild(card);
    }
  }
  statusFilter.onchange = reload;
  await reload();
}
