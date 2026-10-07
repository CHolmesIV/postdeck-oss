// ---------------- Image prompt system - shared editor + quick-edit modal ----------------
// The "system/negative/brand/layout" fields that feed every Codex image
// handoff (Settings originally owned this outright). `buildImagePromptEditor`
// is the ONE place that builds the grid + Save/Reload - Settings and the new
// Composer/Quick-Compose "Edit prompts" modal both call this instead of each
// keeping their own copy, so there's exactly one save path to the same
// `image_prompt_*` settings keys (item 4 of the 2026-07-19 feedback pass).
function buildImagePromptEditor(container, initialSettings = {}) {
  const promptFields = [
    ['image_prompt_system', 'System direction', 7],
    ['image_prompt_negative', 'Negative prompt', 5],
    ['image_prompt_brand', 'Brand rules', 5],
    ['image_prompt_layout', 'Layout rules', 5],
  ];
  const promptInputs = {};
  const promptGrid = el('div', { class: 'settings-prompt-grid' });
  for (const [key, label, rows] of promptFields) {
    const area = el('textarea', { rows: String(rows), placeholder: label });
    area.value = initialSettings[key] || '';
    promptInputs[key] = area;
    promptGrid.appendChild(el('div', { class: 'field-row' }, [el('label', {}, label), area]));
  }
  container.appendChild(promptGrid);
  const msg = el('div');
  container.appendChild(
    el('div', { class: 'toolbar settings-prompt-actions' }, [
      el('button', {
        class: 'primary',
        onclick: async () => {
          msg.innerHTML = '';
          try {
            await api('/api/settings', {
              method: 'PATCH',
              body: Object.fromEntries(Object.entries(promptInputs).map(([key, input]) => [key, input.value])),
            });
            toast('Image prompt system saved.');
          } catch (err) {
            msg.appendChild(inlineBanner(err.message, 'error'));
          }
        },
      }, 'Save image prompts'),
      el('button', {
        onclick: async () => {
          msg.innerHTML = '';
          try {
            const fresh = await api('/api/settings');
            for (const [key] of promptFields) promptInputs[key].value = fresh[key] || '';
            toast('Reloaded from Settings.');
          } catch (err) {
            msg.appendChild(inlineBanner(err.message, 'error'));
          }
        },
      }, 'Reload'),
    ])
  );
  container.appendChild(msg);
  return { promptFields, promptInputs };
}

// Quick-edit modal - same fields/save path as Settings' Image prompt system
// card, opened from the Create sheet's image row so a quick prompt tweak
// doesn't require leaving it. Registered as an overlay so a route change
// closes it, and Esc closes it without also closing the sheet underneath.
function openImagePromptModal() {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card' });
  overlay.appendChild(card);
  let unregister = () => {};
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    unregister();
  }
  function onKey(e) {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    e.stopPropagation();
    close();
  }
  unregister = registerOverlay(close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  card.appendChild(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Image prompt system'),
      el('button', { class: 'modal-close', title: 'Close', type: 'button', 'aria-label': 'Close', onclick: close }, '\u2715'),
    ])
  );
  card.appendChild(
    el('p', { class: 'hint' }, 'These instructions go into every Codex image handoff. Saving here saves to the same Settings fields.')
  );
  api('/api/settings')
    .then((settings) => buildImagePromptEditor(card, settings))
    .catch((err) => card.appendChild(inlineBanner(`Could not load settings: ${err.message}`, 'error')));
}
