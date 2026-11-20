// ---------------- Ideas board ----------------

const IDEA_STATUSES = ['idea', 'clustered', 'drafted', 'done'];

async function renderIdeas(view) {
  view.innerHTML = '';
  view.classList.add('view-default');
  view.appendChild(pageHeader('Ideas Board'));

  const titleInput = el('input', { placeholder: 'New idea title…', style: 'width:260px' });
  const brandSelect = el('select', {}, [
    el('option', { value: '' }, '(no brand)'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const pillarInput = el('input', { placeholder: 'pillar (optional)' });
  const addBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      if (!titleInput.value.trim()) return;
      await api('/api/ideas', {
        method: 'POST',
        body: { title: titleInput.value.trim(), brand_id: brandSelect.value || null, pillar: pillarInput.value || null },
      });
      toast('Idea added.');
      renderIdeas(view);
    },
  }, '+ Add idea');
  view.appendChild(
    formSection('Add idea', null,
      el('div', { class: 'form-section-row', style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, [
        titleInput, brandSelect, pillarInput, addBtn,
      ])
    )
  );

  const ideas = await api('/api/ideas');
  const board = el('div', { class: 'kanban' });
  const statusLabels = { idea: 'Idea', clustered: 'Clustered', drafted: 'Drafted', done: 'Done' };
  for (const status of IDEA_STATUSES) {
    const col = el('div', { class: 'kanban-col' });
    col.appendChild(el('h3', {}, statusLabels[status] || status));
    const colIdeas = ideas.filter((i) => i.status === status);
    if (!colIdeas.length) {
      col.appendChild(emptyState('No ideas here yet.'));
    } else {
      colIdeas.forEach((idea) => col.appendChild(ideaCard(idea)));
    }
    board.appendChild(col);
  }
  view.appendChild(board);

  function ideaCard(idea) {
    const select = el(
      'select',
      {
        onchange: async (e) => {
          await api(`/api/ideas/${idea.id}`, { method: 'PATCH', body: { status: e.target.value } });
          toast('Idea updated.');
          renderIdeas(view);
        },
      },
      [...IDEA_STATUSES, 'killed'].map((s) => el('option', { value: s, selected: s === idea.status ? 'selected' : undefined }, s))
    );
    // F3: drag this idea onto a calendar day to open Quick Compose prefilled
    // (see composeFromIdea) - "Use in post" is the same prefill without
    // needing a drag (touch/small screens, or just faster than aiming a
    // drag at the right day).
    const useBtn = el(
      'button',
      { class: 'button ghost sm', type: 'button', onclick: () => composeFromIdea(idea) },
      'Use in post'
    );
    const card = el('div', { class: 'idea-card', draggable: 'true' }, [
      el('div', {}, idea.title),
      el('div', { class: 'meta' }, `${idea.brand_id ? brandName(idea.brand_id) : 'no brand'}${idea.pillar ? ' · ' + idea.pillar : ''}`),
      select,
      useBtn,
    ]);
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(IDEA_DRAG_MIME, JSON.stringify({ id: idea.id, title: idea.title, brand_id: idea.brand_id }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    return card;
  }
}

// ---------------- Library ----------------

async function renderLibrary(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  const fileInput = el('input', { type: 'file', class: 'button secondary sm' });
  const uploadBtn = el('button', {
    class: 'button primary sm',
    type: 'button',
    onclick: async () => {
      if (!fileInput.files.length) return;
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      try {
        await api('/api/media', { method: 'POST', body: fd });
        toast('Uploaded.');
        renderLibrary(view);
      } catch (err) {
        toast(`Could not upload: ${err.message}`, 'error');
      }
    },
  }, 'Upload');
  // R1: title -> primary context control -> actions. Library has no brand
  // context, so the upload control is the sole action row.
  view.appendChild(pageHeader('Library', fileInput, uploadBtn));

  const files = await api('/api/media');
  if (!files.length) {
    view.appendChild(emptyState('No media yet - upload your first file above.'));
    return;
  }
  const grid = el('div', { class: 'media-grid' });
  for (const f of files) {
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.filename);
    grid.appendChild(
      el('div', { class: 'media-card' }, [
        isImage ? el('img', { src: f.url, alt: f.filename, loading: 'lazy', decoding: 'async' }) : el('div', { style: 'height:100px;display:flex;align-items:center;justify-content:center;color:var(--muted);' }, 'file'),
        el('div', { class: 'meta' }, f.filename),
      ])
    );
  }
  view.appendChild(grid);
}
