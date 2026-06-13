import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const CACHE_KEY = 'urbex_theme';
const SPINNER_HIDE_DELAY = 400;

export function showPageLoading() {
  document.documentElement.classList.add('is-page-loading');
}

export function hidePageLoading() {
  const el = document.documentElement;
  el.classList.remove('is-page-loading');
  el.classList.add('is-page-loading-exit');
  setTimeout(() => el.classList.remove('is-page-loading-exit'), SPINNER_HIDE_DELAY);
}

export function getStoredTheme() {
  try { return sessionStorage.getItem(CACHE_KEY) || localStorage.getItem(CACHE_KEY) || ''; } catch (e) { return ''; }
}

export function clearThemeCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch (e) {}
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

function cacheTheme(value) {
  try { sessionStorage.setItem(CACHE_KEY, value || ''); } catch (e) {}
  try { localStorage.setItem(CACHE_KEY, value || ''); } catch (e) {}
}

function getCachedTheme() {
  try { return sessionStorage.getItem(CACHE_KEY) || localStorage.getItem(CACHE_KEY) || ''; } catch (e) { return ''; }
}

export function applyTheme(themeValue) {
  const val = themeValue || '';
  if (!val) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', val);
  }
}

export function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || '';
}

export async function saveThemePreference(db, uid, themeValue) {
  if (!uid) return;
  const val = themeValue || '';
  cacheTheme(val);
  applyTheme(val);
  try {
    const ref = doc(db, 'users', uid);
    await setDoc(ref, { theme: val }, { merge: true });
  } catch (e) {
    console.warn('Could not save theme preference:', e);
  }
}

export async function loadUserTheme(db, uid) {
  if (!uid) {
    applyTheme('');
    return;
  }

  // 1. Apply cached theme instantly (no Firestore wait)
  const cached = getCachedTheme();
  if (cached) {
    applyTheme(cached);
  }

  // 2. Skip Firestore if already fetched once this session
  const fetchedFlag = 'cua_theme_fetched_' + uid;
  if (sessionStorage.getItem(fetchedFlag)) return;

  // 3. Fetch from Firestore in background
  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    let firestoreTheme = '';
    if (snap.exists()) {
      const data = snap.data();
      firestoreTheme = data.theme || '';
    }

    // 4. If Firestore value differs from cache, apply and cache it
    if (firestoreTheme !== cached) {
      cacheTheme(firestoreTheme);
      applyTheme(firestoreTheme);
    }

    sessionStorage.setItem(fetchedFlag, '1');
  } catch (e) {
    // Cache already applied — silently fall back
    if (!cached) {
      applyTheme('');
    }
  }
}
