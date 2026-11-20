// Retired in D3: replaced by 40-create.js. renderComposer stays as a thin wrapper (#/composer also redirects to #/create).
async function renderComposer(view, params) { return renderCreateRoute(view, params); }

// Still used by 05-post-actions.js (Fix and reschedule).
async function findToneProfileId(brandId, toneName) {
  const tp = await api(`/api/tone-profiles?brand_id=${brandId}&name=${toneName}`);
  return tp.id;
}
