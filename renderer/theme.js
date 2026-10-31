// Applies the dark / light / system theme to the page (shared by both windows)
(function (root) {
  'use strict';
  const mq = root.matchMedia('(prefers-color-scheme: dark)');
  let pref = 'dark';
  const apply = () => {
    const t = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = t;
  };
  mq.addEventListener('change', apply);
  root.Theme = {
    set(p) {
      pref = ['dark', 'light', 'system'].includes(p) ? p : 'dark';
      apply();
    },
    get: () => pref,
    MODES: ['dark', 'light', 'system'],
  };
})(this);
