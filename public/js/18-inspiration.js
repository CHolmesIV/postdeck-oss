// ---------------- Inspiration board (B8) ----------------

async function renderInspiration(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  const stickyBrandInit = getStickyBrand();
  const brandFilter = el('select', {}, [
    el('option', { value: '', selected: stickyBrandInit ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: b.id, selected: String(b.id) === String(stickyBrandInit) ? 'selected' : undefined }, b.name)
    ),
  ]);
  view.appendChild(pageHeader('Inspiration', brandFilter));

  const gridHost = el('div');
  view.appendChild(gridHost);

  function profileCard(p, { onDelete, onAdd } = {}) {
    const card = el('div', { class: 'inspiration-card' });
    card.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
        el('strong', {}, p.name || p.handle || '(unnamed)'),
        el('span', { class: 'pill' }, p.platform || '?'),
      ])
    );
    if (p.handle) card.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;margin-top:2px;' }, `@${p.handle}`));
    if (p.niche) card.appendChild(el('div', { style: 'margin-top:6px;font-size:12px;' }, [el('strong', {}, 'Niche: '), p.niche]));
    if (p.why_relevant) card.appendChild(el('div', { style: 'margin-top:4px;font-size:12px;color:var(--muted);' }, p.why_relevant));
    if (p.url) card.appendChild(el('div', { style: 'margin-top:6px;' }, [el('a', { href: p.url, target: '_blank' }, p.url)]));
    card.appendChild(el('div', { style: 'margin-top:6px;' }, [el('span', { class: 'pill source-pill' }, p.source || 'manual')]));
    const actions = el('div', { class: 'toolbar', style: 'margin-top:8px;' });
    if (onAdd) actions.appendChild(el('button', { class: 'button primary sm', type: 'button', onclick: onAdd }, '+ Add to board'));
    if (onDelete) actions.appendChild(el('button', { class: 'button destructive sm', type: 'button', onclick: onDelete }, 'Delete'));
    card.appendChild(actions);
    return card;
  }

  async function reload() {
    gridHost.innerHTML = '';
    const qs = brandFilter.value ? `?brand_id=${encodeURIComponent(brandFilter.value)}` : '';
    let profiles;
    try {
      profiles = await api(`/api/inspiration${qs}`);
    } catch (err) {
      gridHost.appendChild(inlineBanner(`Could not load inspiration board: ${err.message}`, 'error'));
      return;
    }
    if (!profiles.length) {
      gridHost.appendChild(emptyState('No profiles yet - add one below, or ask AI to suggest some.'));
      return;
    }
    const grid = el('div', { class: 'inspiration-grid' });
    for (const p of profiles) {
      grid.appendChild(
        profileCard(p, {
          onDelete: async () => {
            try {
              await api(`/api/inspiration/${p.id}`, { method: 'DELETE' });
              toast('Profile deleted.');
              reload();
            } catch (err) {
              toast(`Could not delete: ${err.message}`, 'error');
            }
          },
        })
      );
    }
    gridHost.appendChild(grid);
  }
  brandFilter.onchange = () => { setStickyBrand(brandFilter.value); reload(); };
  await reload();

  // R1 fix: no second/duplicate brand picker here - both forms below use the
  // page-level brandFilter as their brand context (same fix as Research).
  const addPlatform = el('select', {}, ['twitter', 'linkedin', 'facebook', 'instagram', 'tiktok', 'reddit', 'blog', 'other'].map((p) => el('option', { value: p }, p)));
  const addName = el('input', { placeholder: 'Name' });
  const addHandle = el('input', { placeholder: 'Handle (no @)' });
  const addUrl = el('input', { placeholder: 'URL' });
  const addNiche = el('input', { placeholder: 'Niche' });
  const addWhy = el('textarea', { rows: '2', placeholder: 'Why relevant' });
  const addTags = el('input', { placeholder: 'tags, comma, separated' });
  const addMsg = el('div');
  const addBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      addMsg.innerHTML = '';
      try {
        await api('/api/inspiration', {
          method: 'POST',
          body: {
            brand_id: brandFilter.value || null,
            platform: addPlatform.value,
            name: addName.value || null,
            handle: addHandle.value || null,
            url: addUrl.value || null,
            niche: addNiche.value || null,
            why_relevant: addWhy.value || null,
            tags: addTags.value.split(',').map((t) => t.trim()).filter(Boolean),
            source: 'manual',
          },
        });
        addName.value = '';
        addHandle.value = '';
        addUrl.value = '';
        addNiche.value = '';
        addWhy.value = '';
        addTags.value = '';
        toast('Profile added.');
        reload();
      } catch (err) {
        addMsg.appendChild(inlineBanner(err.message, 'error'));
      }
    },
  }, '+ Add profile');
  view.appendChild(
    formSection('Add profile', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Platform'), addPlatform]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Name'), addName]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Handle'), addHandle]),
      el('div', { class: 'field-row' }, [el('label', {}, 'URL'), addUrl]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Niche'), addNiche]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Why relevant'), addWhy]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Tags'), addTags]),
      addBtn,
      addMsg
    )
  );

  const suggestNiche = el('input', { placeholder: 'Niche (optional)' });
  const suggestPlatforms = el('input', { placeholder: 'Platforms, comma separated (optional)' });
  const suggestResults = el('div');
  const suggestMsg = el('div');
  const suggestBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      suggestMsg.innerHTML = '';
      suggestResults.innerHTML = '';
      try {
        const brand = brandFilter.value ? brandName(Number(brandFilter.value)) : undefined;
        const platforms = suggestPlatforms.value.split(',').map((p) => p.trim()).filter(Boolean);
        const res = await api('/api/inspiration/suggest', {
          method: 'POST',
          body: { brand_id: brandFilter.value || null, brand, niche: suggestNiche.value || undefined, platforms },
        });
        if (!res.suggestions || !res.suggestions.length) {
          suggestResults.appendChild(emptyState('No suggestions returned.'));
          return;
        }
        const grid = el('div', { class: 'inspiration-grid' });
        for (const s of res.suggestions) {
          grid.appendChild(
            profileCard(
              { ...s, source: 'ai_suggested' },
              {
                onAdd: async () => {
                  try {
                    await api('/api/inspiration', {
                      method: 'POST',
                      body: {
                        brand_id: brandFilter.value || null,
                        platform: s.platform || null,
                        name: s.name || null,
                        handle: s.handle || null,
                        url: s.url || null,
                        niche: suggestNiche.value || null,
                        why_relevant: s.why_relevant || null,
                        source: 'ai_suggested',
                      },
                    });
                    toast('Added to board.');
                    reload();
                  } catch (err) {
                    toast(`Could not add: ${err.message}`, 'error');
                  }
                },
              }
            )
          );
        }
        suggestResults.appendChild(grid);
      } catch (err) {
        if (err.status === 503) {
          suggestMsg.appendChild(inlineBanner('AI unavailable (claude CLI not found). Add profiles manually above.', 'error'));
        } else {
          suggestMsg.appendChild(inlineBanner(err.message, 'error'));
        }
      }
    },
  }, 'Suggest profiles');
  view.appendChild(
    formSection('Suggest profiles (AI)', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Niche'), suggestNiche]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Platforms'), suggestPlatforms]),
      suggestBtn,
      suggestMsg,
      suggestResults
    )
  );
}
