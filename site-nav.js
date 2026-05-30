(function () {
  const LOADING_KEY = 'uaPageLoading';
  const START_KEY = 'uaPageLoadingStartedAt';
  const DEFAULT_MIN_MS = 700;
  const MAP_MIN_MS = 1100;
  const EXIT_MS = 360;
  const MAP_FALLBACK_MS = 5000;
  let active = false;

  function isMapPage() {
    return /(^|\/)map\.html$/i.test(window.location.pathname);
  }

  function setLoading(activeState) {
    active = activeState;
    document.documentElement.classList.toggle('is-page-loading', activeState);
    if (activeState) document.documentElement.classList.remove('is-page-loading-exit');
  }

  function startLoading() {
    sessionStorage.setItem(LOADING_KEY, '1');
    sessionStorage.setItem(START_KEY, String(Date.now()));
    setLoading(true);
  }

  function startedAt() {
    const saved = Number(sessionStorage.getItem(START_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : Date.now();
  }

  function finishLoading(minMs) {
    if (!active && sessionStorage.getItem(LOADING_KEY) !== '1') return;
    const elapsed = Date.now() - startedAt();
    const wait = Math.max(0, minMs - elapsed);
    window.setTimeout(() => {
      sessionStorage.removeItem(LOADING_KEY);
      sessionStorage.removeItem(START_KEY);
      document.documentElement.classList.add('is-page-loading-exit');
      document.documentElement.classList.remove('is-page-loading');
      active = false;
      window.setTimeout(() => {
        document.documentElement.classList.remove('is-page-loading-exit');
      }, EXIT_MS);
    }, wait);
  }

  function shouldShowLoader(link, event) {
    if (!link || !link.href) return false;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (link.target && link.target !== '_self') return false;
    if (link.hasAttribute('download')) return false;
    if (link.getAttribute('aria-disabled') === 'true') return false;

    const rawHref = (link.getAttribute('href') || '').trim();
    if (!rawHref || rawHref === '#' || rawHref.startsWith('#')) return false;

    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') return false;
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return false;
    if (url.href === window.location.href) return false;
    return true;
  }

  function resetHeaderMenuState() {
    const header = document.querySelector('header');
    const toggle = document.querySelector('.mobile-menu-button');
    if (header) header.classList.remove('mobile-menu-open');
    if (toggle) {
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  window.UrbexLoader = {
    start: startLoading,
    finish: finishLoading,
    mapReady: () => finishLoading(MAP_MIN_MS)
  };

  if (sessionStorage.getItem(LOADING_KEY) === '1') {
    setLoading(true);
  }

  (function initLoaderOnPageLoad() {
    const navEntry = performance.getEntriesByType('navigation')[0];
    const isFreshLoad = !navEntry || navEntry.type === 'navigate' || navEntry.type === 'reload';
    if (isFreshLoad && sessionStorage.getItem(LOADING_KEY) !== '1') {
      startLoading();
      window.addEventListener('load', () => {
        if (!isMapPage()) finishLoading(DEFAULT_MIN_MS);
      }, { once: true });
    }
  })();

  window.addEventListener('pageshow', (e) => {
    resetHeaderMenuState();
    if (e.persisted) {
      setLoading(false);
      return;
    }
    if (sessionStorage.getItem(LOADING_KEY) !== '1') {
      setLoading(false);
      return;
    }
    if (!isMapPage()) finishLoading(DEFAULT_MIN_MS);
  });

  window.addEventListener('load', () => {
    resetHeaderMenuState();
    if (!isMapPage()) finishLoading(DEFAULT_MIN_MS);
  });

  window.addEventListener('urbex:map-ready', () => finishLoading(MAP_MIN_MS));

  if (isMapPage()) {
    window.setTimeout(() => finishLoading(MAP_MIN_MS), MAP_FALLBACK_MS);
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!shouldShowLoader(link, event)) return;
    startLoading();
  });
})();
