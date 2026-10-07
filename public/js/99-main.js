// Entry point. Classic scripts share one global scope and run in the order
// index.html lists them, so this file must stay last: it starts the app only
// after every view's functions exist.
const routes = {
  '': renderHome,
  home: renderHome,
  calendar: renderCalendar,
  review: renderReview,
  ideas: renderIdeas,
  library: renderLibrary,
  composer: renderComposer,
  post: renderPostDetail,
  analytics: typeof renderAnalyticsHub === 'function' ? renderAnalyticsHub : renderAnalytics,
  ops: renderOps,
  research: renderResearch,
  inspiration: renderInspiration,
  images: renderImages,
  settings: renderSettings,
  profiles: renderProfiles,
  labs: renderLabs,
  // D3 views fall back to the legacy view until their build defines them.
  planner: typeof renderPlanner === 'function' ? renderPlanner : renderCalendar,
  create: typeof renderCreateRoute === 'function' ? renderCreateRoute : renderComposer,
  blog: typeof renderBlog === 'function' ? renderBlog : renderLabs,
};

bootstrap();
