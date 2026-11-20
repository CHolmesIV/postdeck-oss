// ---------------- Research (B8) ----------------

const RESEARCH_SOURCES = ['google_trends', 'reddit', 'best_practice', 'web', 'manual'];

async function renderResearch(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  const stickyBrandInit = getStickyBrand();
  const brandFilter = el('select', {}, [
    el('option', { value: '', selected: stickyBrandInit ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: b.id, selected: String(b.id) === String(stickyBrandInit) ? 'selected' : undefined }, b.name)
    ),
  ]);
  // R1: title -> primary context control (brand, drives both the list filter
  // and the add-note form below - single source of truth, no duplicate picker).
  view.appendChild(pageHeader('Research', brandFilter));

  const listHost = el('div');
  view.appendChild(listHost);

  async function reload() {
    listHost.innerHTML = '';
    const qs = brandFilter.value ? `?brand_id=${encodeURIComponent(brandFilter.value)}` : '';
    let notes;
    try {
      notes = await api(`/api/research${qs}`);
    } catch (err) {
      listHost.appendChild(inlineBanner(`Could not load research notes: ${err.message}`, 'error'));
      return;
    }
    if (!notes.length) {
      listHost.appendChild(emptyState('No research notes yet - add one below.'));
      return;
    }
    for (const n of notes) {
      const card = el('div', { class: 'card' });
      card.appendChild(
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, [
          el('strong', {}, n.title || '(untitled)'),
          el('span', { class: 'pill source-pill' }, n.source),
          n.brand_id ? el('span', { style: 'color:var(--muted);font-size:12px;' }, brandName(n.brand_id)) : el('span', { style: 'color:var(--muted);font-size:12px;' }, 'no brand'),
        ])
      );
      if (n.tags && n.tags.length) {
        card.appendChild(
          el('div', { style: 'margin-top:4px;' }, n.tags.map((t) => el('span', { class: 'pill tag-pill' }, t)))
        );
      }
      if (n.body) {
        const truncated = n.body.length > 300 ? `${n.body.slice(0, 300)}…` : n.body;
        card.appendChild(el('div', { style: 'margin-top:6px;color:var(--muted);font-size:12px;white-space:pre-wrap;' }, truncated));
      }
      if (n.url) {
        card.appendChild(el('div', { style: 'margin-top:6px;' }, [el('a', { href: n.url, target: '_blank' }, n.url)]));
      }
      card.appendChild(
        el('div', { class: 'toolbar', style: 'margin-top:8px;' }, [
          el('button', {
            class: 'button destructive sm',
            type: 'button',
            onclick: async () => {
              try {
                await api(`/api/research/${n.id}`, { method: 'DELETE' });
                toast('Note deleted.');
                reload();
              } catch (err) {
                toast(`Could not delete: ${err.message}`, 'error');
              }
            },
          }, 'Delete'),
        ])
      );
      listHost.appendChild(card);
    }
  }
  brandFilter.onchange = () => { setStickyBrand(brandFilter.value); reload(); };
  await reload();

  // R1 fix: no second/duplicate brand picker here - the add-note form uses
  // the page-level brandFilter above as its brand context (falls back to
  // "no brand" when the filter is "All brands").
  const addSource = el('select', {}, RESEARCH_SOURCES.map((s) => el('option', { value: s }, s)));
  const addTitle = el('input', { placeholder: 'Title' });
  const addUrl = el('input', { placeholder: 'URL (optional)' });
  const addTags = el('input', { placeholder: 'tags, comma, separated' });
  const addBody = el('textarea', { rows: '5', placeholder: 'Body / notes' });
  const addMsg = el('div');
  const addBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      addMsg.innerHTML = '';
      try {
        await api('/api/research', {
          method: 'POST',
          body: {
            brand_id: brandFilter.value || null,
            source: addSource.value,
            title: addTitle.value || null,
            url: addUrl.value || null,
            tags: addTags.value.split(',').map((t) => t.trim()).filter(Boolean),
            body: addBody.value || null,
          },
        });
        addTitle.value = '';
        addUrl.value = '';
        addTags.value = '';
        addBody.value = '';
        toast('Note added.');
        reload();
      } catch (err) {
        addMsg.appendChild(inlineBanner(err.message, 'error'));
      }
    },
  }, '+ Add note');
  view.appendChild(
    formSection('Add note', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Source'), addSource]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Title'), addTitle]),
      el('div', { class: 'field-row' }, [el('label', {}, 'URL'), addUrl]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Tags'), addTags]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Body'), addBody]),
      addBtn,
      addMsg
    )
  );

  const importSource = el('select', {}, RESEARCH_SOURCES.map((s) => el('option', { value: s }, s)));
  const importFilename = el('input', { placeholder: 'filename (optional)' });
  const importContent = el('textarea', { rows: '6', placeholder: 'Paste CSV/text content here…' });
  const importMsg = el('div');
  const importBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      importMsg.innerHTML = '';
      if (!importContent.value.trim()) return;
      try {
        await api('/api/research/import', {
          method: 'POST',
          body: {
            brand_id: brandFilter.value || null,
            source: importSource.value,
            filename: importFilename.value || null,
            content: importContent.value,
          },
        });
        importContent.value = '';
        importFilename.value = '';
        toast('Imported.');
        reload();
      } catch (err) {
        importMsg.appendChild(inlineBanner(err.message, 'error'));
      }
    },
  }, 'Import');
  view.appendChild(
    formSection('Paste / import', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Source'), importSource]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Filename'), importFilename]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Content'), importContent]),
      importBtn,
      importMsg
    )
  );
}
