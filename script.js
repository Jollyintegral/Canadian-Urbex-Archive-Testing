// --- Firebase (Firestore for storing spots) ---
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { 
  getFirestore, collection, addDoc, getDocs, serverTimestamp, doc, updateDoc, getDoc, setDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { applyTheme, getCurrentTheme, saveThemePreference, loadUserTheme, hidePageLoading, clearThemeCache } from './theme.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { normalizeRole, roleLabel } from './role-utils.js';
import { initNotificationsUI, notifyNewSpot, notifyCommentDeleted } from './notifications.js';
import { initReportButton } from './reports.js';

const firebaseConfig = {
  apiKey: "AIzaSyBqUaNlFlKcyl86kaDDN196eRTGOJtlxkY",
  authDomain: "urbex-alberta-test.firebaseapp.com",
  projectId: "urbex-alberta-test",
  storageBucket: "urbex-alberta-test.firebasestorage.app",
  messagingSenderId: "324527243889",
  appId: "1:324527243889:web:9d506e8ecd4d00330791d0"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const supabase = createClient('https://xdomzbdjhghvmbrocjwv.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhkb216YmRqaGdodm1icm9jand2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMTIyODQsImV4cCI6MjA5NTU4ODI4NH0.lK6ZtBJqsGx7HYR7xCVmWbLX_IVE1hlrTT-Cz2OBVB4');
const googleProvider = new GoogleAuthProvider();
const SPOTS_COLLECTION = 'spots';
const ROLE_RANK = { visitor: 0, member: 1, editor: 2, admin: 3, owner: 4 };
const SPOTS_CACHE_KEY = 'spotsCacheV1';
const SPOTS_CACHE_TS_KEY = 'spotsCacheTsV1';
const SPOTS_CACHE_TTL_MS = 120000;
let guestMode = false;
let userRole = null;
let currentUser = null;
let map; // Global map variable
let spotClusterGroup;
const spotSearchIndex = [];
let activeLinkControlsCloser = null;
let spotMarkers = [];
let activeSpotMarker = null;
let activeFilters = { confirmed: true, risky: true, unsure: true, default: true };
let lastKnownUserLatLng = null;

function normalizeVisibilityRole(role) {
  const value = (role || '').toString().trim().toLowerCase();
  if (value === 'visitor' || value === 'member' || value === 'editor') return value;
  return 'visitor';
}

function roleAtLeast(role, minimum) {
  return (ROLE_RANK[normalizeRole(role)] ?? 0) >= (ROLE_RANK[normalizeRole(minimum)] ?? 0);
}

function isVisitorRole() {
  return normalizeRole(userRole) === 'visitor';
}

function isAdminRole() {
  const role = normalizeRole(userRole);
  return role === 'admin' || role === 'owner';
}

function canEditSpots() {
  return roleAtLeast(userRole, 'editor');
}

function canViewSpot(minRole) {
  return roleAtLeast(userRole, normalizeVisibilityRole(minRole || 'visitor'));
}

function upsertSpotSearchEntry(spotId, name, marker) {
  const normalizedName = (name || 'Unnamed spot').trim() || 'Unnamed spot';
  const existing = spotSearchIndex.find((entry) => entry.spotId === spotId);
  if (existing) {
    existing.name = normalizedName;
    existing.nameLower = normalizedName.toLowerCase();
    existing.marker = marker;
    return;
  }
  spotSearchIndex.push({ spotId, name: normalizedName, nameLower: normalizedName.toLowerCase(), marker });
}

function removeSpotSearchEntry(spotId) {
  const idx = spotSearchIndex.findIndex((entry) => entry.spotId === spotId);
  if (idx >= 0) spotSearchIndex.splice(idx, 1);
}

function getSpotSearchMatches(query, limit = 8) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];

  const startsWith = [];
  const includes = [];
  for (const entry of spotSearchIndex) {
    if (entry.nameLower.startsWith(q)) startsWith.push(entry);
    else if (entry.nameLower.includes(q)) includes.push(entry);
  }

  return [...startsWith, ...includes].slice(0, limit);
}

function focusSpotResult(match) {
  if (!match || !match.marker || !map) return;
  const markerAvailable = spotClusterGroup
    ? spotClusterGroup.hasLayer(match.marker)
    : map.hasLayer(match.marker);
  if (!markerAvailable) return;
  const latLng = match.marker.getLatLng();
  const zoom = Math.max(map.getZoom(), 16);
  if (spotClusterGroup && typeof spotClusterGroup.zoomToShowLayer === 'function') {
    map.flyTo([latLng.lat, latLng.lng], zoom, { duration: 1.5 });
    map.once('moveend', () => {
      spotClusterGroup.zoomToShowLayer(match.marker, () => {
        match.marker.openPopup();
      });
    });
    return;
  }

  map.flyTo([latLng.lat, latLng.lng], zoom, { duration: 1.5 });
  setTimeout(() => match.marker.openPopup(), 1550);
}

function parseCoordinateInput(input) {
  if (!input) return null;
  const cleaned = input.trim().replace(/[()]/g, '');
  if (!cleaned) return null;

  const parts = cleaned.includes(',')
    ? cleaned.split(',').map((p) => p.trim()).filter(Boolean)
    : cleaned.split(/\s+/).map((p) => p.trim()).filter(Boolean);

  if (parts.length !== 2) return null;

  const lat = Number(parts[0]);
  const lng = Number(parts[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

function addCoordinateSearchControl() {
  const coordControl = L.control({ position: 'topright' });

  coordControl.onAdd = function () {
    const container = L.DomUtil.create('div', 'coord-search-control');
    container.innerHTML = `
      <button type="button" class="coord-search-pill" aria-label="Open search" aria-expanded="false">
        <svg class="coord-search-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2.2" fill="none"/>
          <line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="coord-search-expanded" aria-hidden="true">
        <div class="coord-search-input-row">
          <svg class="coord-search-icon-sm" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2.2" fill="none"/>
            <line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
          <input type="text" class="coord-search-input" placeholder="Search places" aria-label="Search spots or coordinates" autocomplete="off" spellcheck="false">
          <button type="button" class="coord-search-go" aria-label="Search">➔</button>
          <button type="button" class="coord-search-clear" aria-label="Clear search">✕</button>
        </div>
        <div class="coord-search-error" aria-live="polite"></div>
        <ul class="coord-search-results" role="listbox" aria-label="Matching spots"></ul>
      </div>
    `;

    const pill     = container.querySelector('.coord-search-pill');
    const expanded = container.querySelector('.coord-search-expanded');
    const input    = container.querySelector('.coord-search-input');
    const error    = container.querySelector('.coord-search-error');
    const results  = container.querySelector('.coord-search-results');
    const clearBtn = container.querySelector('.coord-search-clear');
    const goBtn    = container.querySelector('.coord-search-go');

    let isOpen = false;

    function positionExpanded() {
      // CSS positioning via position:absolute and right:calc(100% + 8px) handles placement
      // No JS positioning needed
    }

    function openSearch() {
      try {
        isOpen = true;
        positionExpanded();
        container.classList.add('is-open');
        pill.setAttribute('aria-expanded', 'true');
        expanded.setAttribute('aria-hidden', 'false');
        setTimeout(() => input.focus(), 50);
      } catch (err) {
        console.error('[coord-search] openSearch error', err);
      }
    }

    function closeSearch() {
      isOpen = false;
      container.classList.remove('is-open');
      pill.setAttribute('aria-expanded', 'false');
      expanded.setAttribute('aria-hidden', 'true');
      input.value = '';
      error.textContent = '';
      clearResults();
    }

    function clearResults() {
      results.innerHTML = '';
      results.style.display = 'none';
    }

    function renderResults(matches) {
      results.innerHTML = '';
      if (!matches.length) { results.style.display = 'none'; return; }
      for (const match of matches) {
        const li  = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'coord-search-result-btn';
        btn.textContent = match.name;
        btn.onclick = () => {
          input.value = match.name;
          error.textContent = '';
          clearResults();
          focusSpotResult(match);
          closeSearch();
        };
        li.appendChild(btn);
        results.appendChild(li);
      }
      results.style.display = 'block';
    }

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    pill.addEventListener('click', (e) => { if (!isOpen) openSearch(); else closeSearch(); });

    clearBtn.addEventListener('click', () => {
      if (input.value) {
        input.value = '';
        error.textContent = '';
        clearResults();
        input.focus();
      } else {
        closeSearch();
      }
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (isOpen && !container.contains(e.target)) closeSearch();
    });

    function executeSearch() {
      const query = input.value.trim();
      if (!query) { clearResults(); error.textContent = ''; return; }

      const parsed = parseCoordinateInput(query);
      if (parsed) {
        clearResults();
        error.textContent = '';
        map.flyTo([parsed.lat, parsed.lng], Math.max(map.getZoom(), 15), { duration: 0.7 });
        closeSearch();
        return;
      }

      const matches = getSpotSearchMatches(query, 8);
      if (!matches.length) { clearResults(); error.textContent = 'No matching spots'; return; }
      error.textContent = '';
      renderResults(matches);
      focusSpotResult(matches[0]);
    }

    // Submit on Enter
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      executeSearch();
    });

    goBtn.addEventListener('click', executeSearch);

    // Live debounced search
    let searchDebounceTimer = null;
    input.addEventListener('input', () => {
      if (error.textContent) error.textContent = '';
      const query = input.value.trim();
      if (!query || parseCoordinateInput(query)) { clearResults(); return; }
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        renderResults(getSpotSearchMatches(query, 8));
      }, 180);
    });

    return container;
  };

  coordControl.addTo(map);
}

function formatLatLng(latlng) {
  if (!latlng) return '';
  return `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(ta);
  return copied;
}

function buildMapContextMenu(latlng) {
  const coordsText = formatLatLng(latlng);
  const mapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(coordsText)}`;
  const wrap = document.createElement('div');
  wrap.className = 'coord-context-menu';
  wrap.innerHTML = `
    <button type="button" class="coord-context-action" data-action="copy">Copy coordinates</button>
    <button type="button" class="coord-context-action" data-action="google">Open in Google Maps</button>
    <div class="coord-context-value">${escapeHtml(coordsText)}</div>
    <p class="coord-context-status" aria-live="polite"></p>
  `;

  const statusEl = wrap.querySelector('.coord-context-status');
  const copyBtn = wrap.querySelector('[data-action="copy"]');
  const googleBtn = wrap.querySelector('[data-action="google"]');

  copyBtn.onclick = async (e) => {
    e.preventDefault();
    try {
      const copied = await copyTextToClipboard(coordsText);
      statusEl.textContent = copied ? 'Coordinates copied.' : 'Could not copy coordinates.';
    } catch (err) {
      statusEl.textContent = 'Could not copy coordinates.';
    }
  };

  googleBtn.onclick = (e) => {
    e.preventDefault();
    window.open(mapsUrl, '_blank', 'noopener,noreferrer');
  };

  return wrap;
}

function normalizeSpotClass(value) {
  if (value === 'default' || value === 'confirmed' || value === 'risky' || value === 'unsure') return value;
  // Backward compatibility: old "abandoned" class now maps to "unsure" (yellow).
  if (value === 'abandoned') return 'unsure';
  return 'default';
}

function makeMinimalPinDataUrl(fillColor) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 40">
    <defs>
      <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1.6" stdDeviation="1.2" flood-color="#000" flood-opacity=".28"/>
      </filter>
    </defs>
    <path filter="url(#s)" d="M14 2C7.9 2 3 6.9 3 13c0 8.5 9.5 18.7 10 19.2a1.4 1.4 0 0 0 2 0C15.5 31.7 25 21.5 25 13c0-6.1-4.9-11-11-11z" fill="${fillColor}"/>
    <circle cx="14" cy="13" r="6.2" fill="#f4f8ff"/>
  </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

const MARKER_ICON_URLS = {
  default: makeMinimalPinDataUrl('#6f86bf'),
  confirmed: makeMinimalPinDataUrl('#33c06d'),
  risky: makeMinimalPinDataUrl('#ef4f76'),
  unsure: makeMinimalPinDataUrl('#e7c74b')
};

const MARKER_SHADOW_URL = '';
const spotIconCache = {};

// Marker icon factory using Leaflet default marker style with class colors.
function getSpotIcon(spotClass) {
  const normalized = normalizeSpotClass(spotClass);
  if (!spotIconCache[normalized]) {
    spotIconCache[normalized] = L.icon({
      iconUrl: MARKER_ICON_URLS[normalized],
      shadowUrl: MARKER_SHADOW_URL || undefined,
      iconSize: [28, 40],
      iconAnchor: [14, 36],
      popupAnchor: [1, -34]
    });
  }
  return spotIconCache[normalized];
}

function reapplyMarkerScale(marker) {
  if (marker._icon && marker.getPopup && marker.getPopup().isOpen()) {
    marker._icon.style.transition = '';
    marker._icon.style.width = '36px';
    marker._icon.style.height = '52px';
    marker._icon.style.marginLeft = '-18px';
    marker._icon.style.marginTop = '-47px';
    marker._icon.classList.add('spot-marker-active');
  }
}

function cacheSpotsForSession(spots) {
  try {
    sessionStorage.setItem(SPOTS_CACHE_KEY, JSON.stringify(spots));
    sessionStorage.setItem(SPOTS_CACHE_TS_KEY, String(Date.now()));
  } catch {}
}

function getCachedSpots() {
  try {
    const ts = Number(sessionStorage.getItem(SPOTS_CACHE_TS_KEY) || '0');
    if (!ts || (Date.now() - ts) > SPOTS_CACHE_TTL_MS) return null;
    const raw = sessionStorage.getItem(SPOTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clearSpotsCache() {
  try {
    sessionStorage.removeItem(SPOTS_CACHE_KEY);
    sessionStorage.removeItem(SPOTS_CACHE_TS_KEY);
  } catch {}
}

function renderSpotData(spotId, d) {
  const lat = d.lat ?? d.latitude;
  const lng = d.lng ?? d.longitude;
  if (lat == null || lng == null) return;
  const spotClass = normalizeSpotClass(d.spotClass);
  const spotComments = Array.isArray(d.comments) ? d.comments : [];
  const spotName = d.name || 'Unnamed spot';
  const minRole = normalizeVisibilityRole(d.minRole || 'visitor');
  if (!canViewSpot(minRole)) return;
  const m = L.marker([lat, lng], { draggable: false, icon: getSpotIcon(spotClass) }).addTo(spotClusterGroup || map);
  m._spotId = spotId;
  m._spotClass = spotClass;
  m._spotComments = spotComments;
  m._spotName = spotName;
  m._spotDesc = d.description || '';
  m._spotImages = [d.imageUrl, ...(d.images || [])].filter(Boolean);
  m._spotMinRole = minRole;
  m._spotAddedBy = d.addedBy || null;
  m._spotCreatedAt = d.createdAt || null;
  m.bindPopup('<div class="spot-popup-loading">Loading...</div>', { minWidth: 220 });
  const scaleIcon = (el, on) => {
    if (on) {
      el.style.transition = 'width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), height 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), margin-left 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), margin-top 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.35s ease';
      el.style.width = '36px'; el.style.height = '52px';
      el.style.marginLeft = '-18px'; el.style.marginTop = '-47px';
      el.classList.add('spot-marker-active');
    } else {
      el.style.transition = 'width 0.25s ease, height 0.25s ease, margin-left 0.25s ease, margin-top 0.25s ease, filter 0.25s ease';
      el.style.width = '28px'; el.style.height = '40px';
      el.style.marginLeft = '-14px'; el.style.marginTop = '-36px';
      el.classList.remove('spot-marker-active');
    }
    const onEnd = () => { el.style.transition = ''; el.removeEventListener('transitionend', onEnd); };
    el.addEventListener('transitionend', onEnd);
  };
  m.on('popupopen', () => {
    if (activeSpotMarker && activeSpotMarker._icon) {
      scaleIcon(activeSpotMarker._icon, false);
    }
    if (m._icon) {
      scaleIcon(m._icon, true);
    }
    activeSpotMarker = m;
    m.getPopup().setContent(createSpotPopup({
      marker: m,
      spotId: m._spotId,
      name: m._spotName || 'Unnamed spot',
      desc: m._spotDesc || '',
      images: m._spotImages || [],
      spotClass: m._spotClass || 'default',
      minRole: m._spotMinRole || 'visitor',
      comments: m._spotComments || [],
      editMode: false,
      addedBy: m._spotAddedBy || null,
      createdAt: m._spotCreatedAt || null
    }));
  });
  m.on('popupclose', () => {
    if (m._icon) {
      scaleIcon(m._icon, false);
    }
    if (activeSpotMarker === m) activeSpotMarker = null;
  });
  upsertSpotSearchEntry(spotId, spotName, m);
  spotMarkers.push(m);
  if (activeFilters[spotClass] === false) {
    if (spotClusterGroup && typeof spotClusterGroup.removeLayer === 'function') {
      spotClusterGroup.removeLayer(m);
    }
  }
}

async function loadSpots() {
  const cached = getCachedSpots();
  if (cached) {
    cached.forEach((entry) => renderSpotData(entry.id, entry.data));
    window.dispatchEvent(new CustomEvent('urbex:spots-loaded'));
    return;
  }
  try {
    const snapshot = await getDocs(collection(db, SPOTS_COLLECTION));
    const cacheRows = [];
    snapshot.forEach((docSnap) => {
      const d = docSnap.data();
      cacheRows.push({ id: docSnap.id, data: d });
      renderSpotData(docSnap.id, d);
    });
    cacheSpotsForSession(cacheRows);
  } catch (err) {
    console.warn('Could not load spots from Firestore:', err);
  } finally {
    window.dispatchEvent(new CustomEvent('urbex:spots-loaded'));
  }
}

function clearRenderedSpots() {
  if (spotClusterGroup && typeof spotClusterGroup.clearLayers === 'function') {
    spotClusterGroup.clearLayers();
  } else if (map) {
    map.eachLayer((layer) => {
      if (layer && typeof layer.getLatLng === 'function') map.removeLayer(layer);
    });
  }
  spotSearchIndex.length = 0;
  spotMarkers = [];
}

let addMode = false;
let addSpotProcessing = false;

async function ensureUserRoleDoc(user) {
  const fetchedFlag = 'cua_user_fetched_' + user.uid;
  const cachedRole = sessionStorage.getItem('userRole');
  if (cachedRole && normalizeRole(cachedRole) !== 'visitor' && cachedRole !== '' && sessionStorage.getItem(fetchedFlag)) {
    return normalizeRole(cachedRole);
  }
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email || '',
      displayName: user.displayName || '',
      role: 'member',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    sessionStorage.setItem(fetchedFlag, '1');
    return 'member';
  }
  const data = snap.data() || {};
  await setDoc(ref, {
    email: user.email || data.email || '',
    displayName: user.displayName || data.displayName || '',
    updatedAt: serverTimestamp()
  }, { merge: true });
  sessionStorage.setItem(fetchedFlag, '1');
  return normalizeRole(data.role || 'member');
}

function setAuthStatus(message, isError = false) {
  const authStatus = document.getElementById('authStatus');
  if (!authStatus) return;
  authStatus.textContent = message || '';
  authStatus.style.display = message ? 'block' : 'none';
  authStatus.style.color = isError ? '#ffb6c3' : '#d9e5ff';
}

function setSignedInUserUi(user, role) {
  const userEl = document.getElementById('signedInUser');
  if (!userEl) return;
  if (!user) {
    userEl.textContent = '';
    userEl.style.display = 'none';
    return;
  }
  const email = user.email || 'Signed in user';
  userEl.textContent = `${email} (${roleLabel(role || 'visitor')})`;
  userEl.style.display = 'block';
}

function getUserDisplayLabel(user) {
  if (!user) return 'Account';
  if (user.displayName && user.displayName.trim()) return user.displayName.trim();
  if (user.email && user.email.includes('@')) return user.email.split('@')[0];
  return 'Account';
}

function updateAccountMenuUi(user, role) {
  const wrap = document.getElementById('accountMenuWrap');
  const nameEl = document.getElementById('accountMenuName');
  const avatarEl = document.getElementById('accountMenuAvatar');
  const headerSignInBtn = document.getElementById('headerSignInBtn');
  const isGuestUser = !!(user && user.isAnonymous);
  if (headerSignInBtn) headerSignInBtn.style.display = ((!user && guestMode) || isGuestUser) ? 'inline-flex' : 'none';
  if (!wrap || !nameEl || !avatarEl) return;
  if (!user || isGuestUser) {
    wrap.style.display = 'none';
    return;
  }
  const label = getUserDisplayLabel(user);
  const roleSuffix = role ? ` (${roleLabel(role)})` : '';
  nameEl.textContent = `${label}${roleSuffix}`;
  avatarEl.textContent = (label[0] || 'U').toUpperCase();
  wrap.style.display = 'block';
  if (headerSignInBtn) headerSignInBtn.style.display = 'none';
}

function closeAccountDropdown() {
  const dropdown = document.getElementById('accountDropdown');
  const btn = document.getElementById('accountMenuBtn');
  if (dropdown) dropdown.classList.remove('is-visible');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleAccountDropdown() {
  const dropdown = document.getElementById('accountDropdown');
  const btn = document.getElementById('accountMenuBtn');
  if (!dropdown || !btn) return;
  const open = dropdown.classList.contains('is-visible');
  dropdown.classList.toggle('is-visible');
  btn.setAttribute('aria-expanded', open ? 'false' : 'true');
}

function wireAccountMenu() {
  const menuBtn = document.getElementById('accountMenuBtn');
  const settingsBtn = document.getElementById('accountSettingsBtn');
  const signOutBtn = document.getElementById('accountSignOutBtn');
  if (menuBtn) menuBtn.onclick = (e) => { e.stopPropagation(); toggleAccountDropdown(); };
  if (settingsBtn) settingsBtn.onclick = () => {
    closeAccountDropdown();
    if (window.UrbexLoader) window.UrbexLoader.start();
    window.location.href = 'settings.html';
  };
  if (signOutBtn) signOutBtn.onclick = async () => {
    if (window.UrbexLoader) window.UrbexLoader.start();
    closeAccountDropdown();
    addMode = false;
    const addSpotBtn = document.getElementById('addSpotBtn');
    if (addSpotBtn) addSpotBtn.style.display = 'none';
    clearThemeCache();
    await signOut(auth);
    window.location.reload();
  };
  document.addEventListener('click', () => closeAccountDropdown());
}

function wireAuthButtons() {
  const signInBtn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');
  const continueGuestBtn = document.getElementById('continueGuestBtn');
  const headerSignInBtn = document.getElementById('headerSignInBtn');
  if (signInBtn) {
    signInBtn.onclick = async () => {
      setAuthStatus('');
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        setAuthStatus('Google sign-in failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
  if (signOutBtn) {
    signOutBtn.onclick = async () => {
      try {
        clearThemeCache();
        await signOut(auth);
      } catch (error) {
        setAuthStatus('Sign out failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
  if (continueGuestBtn) {
    continueGuestBtn.onclick = async () => {
      guestMode = true;
      userRole = 'visitor';
      sessionStorage.setItem('guestMode', '1');
      setAuthStatus('');
      try {
        await signInAnonymously(auth);
        const gateEl = document.getElementById('gate');
        if (gateEl) gateEl.style.display = 'none';
        if (!map) runMapApp();
      } catch (error) {
        const code = error && error.code ? String(error.code) : '';
        if (code === 'auth/admin-restricted-operation') {
          // Fallback: still allow local visitor mode if anonymous auth is disabled in Firebase.
          const gateEl = document.getElementById('gate');
          if (gateEl) gateEl.style.display = 'none';
          if (!map) runMapApp();
          setAuthStatus('Guest mode started (local visitor). Enable Anonymous auth in Firebase for full guest auth.', false);
          return;
        }
        setAuthStatus('Guest mode failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
  if (headerSignInBtn) {
    headerSignInBtn.onclick = async () => {
      setAuthStatus('');
      try {
        guestMode = false;
        sessionStorage.removeItem('guestMode');
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        setAuthStatus('Google sign-in failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
}

function initAuthGate() {
  const gateEl = document.getElementById('gate');
  const signInBtn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');
  wireAuthButtons();
  guestMode = sessionStorage.getItem('guestMode') === '1';
  if (guestMode) {
    userRole = 'visitor';
    updateAccountMenuUi(null, null);
    if (gateEl) gateEl.style.display = 'none';
    if (!map) runMapApp();
  } else if (sessionStorage.getItem('authSignedIn') !== '1') {
    // Default: allow browsing the map as visitor without a blocking gate.
    guestMode = true;
    userRole = 'visitor';
    sessionStorage.setItem('guestMode', '1');
    updateAccountMenuUi(null, null);
    if (gateEl) gateEl.style.display = 'none';
    if (!map) runMapApp();
  } else if (gateEl) {
    gateEl.style.display = 'none';
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUser = null;
      guestMode = sessionStorage.getItem('guestMode') === '1';
      userRole = guestMode ? 'visitor' : 'visitor';
      sessionStorage.removeItem('authSignedIn');
      if (!guestMode) {
        guestMode = true;
        sessionStorage.setItem('guestMode', '1');
      }
      setSignedInUserUi(null, null);
      updateAccountMenuUi(null, null);
      addMode = false;
      const addSpotBtn = document.getElementById('addSpotBtn');
      if (addSpotBtn) addSpotBtn.style.display = 'none';
      applyTheme('');
      if (signInBtn) signInBtn.style.display = 'inline-flex';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) { runMapApp(); refreshAddSpotControl(); }
      hidePageLoading();
      return;
    }

      currentUser = user;
      guestMode = false;
      sessionStorage.setItem('authSignedIn', '1');
      sessionStorage.removeItem('guestMode');
      setAuthStatus('');
    try {
      if (user.isAnonymous || guestMode) {
        userRole = 'visitor';
      } else {
        userRole = await ensureUserRoleDoc(user);
      }
      await loadUserTheme(db, user?.uid);
      sessionStorage.setItem('userRole', normalizeRole(userRole));
      setSignedInUserUi(user, userRole);
      updateAccountMenuUi(user, userRole);
      initNotificationsUI(db, user, userRole);
      initReportButton(db, user);
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) { runMapApp(); refreshAddSpotControl(); }
      else {
        clearRenderedSpots();
        loadSpots();
        refreshAddSpotControl();
      }
      backfillSpotAddedBy();
      hidePageLoading();
    } catch (error) {
      userRole = 'visitor';
      await loadUserTheme(db, user?.uid);
      setSignedInUserUi(user, userRole);
      updateAccountMenuUi(user, userRole);
      initNotificationsUI(db, user, userRole);
      initReportButton(db, user);
      setAuthStatus('Could not load your role. Defaulting to visitor.', true);
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) { runMapApp(); refreshAddSpotControl(); }
      backfillSpotAddedBy();
      hidePageLoading();
    }
  });
}

function addLocationControl() {
  const locationControl = L.control({ position: 'bottomright' });

  locationControl.onAdd = function () {
    const btn = L.DomUtil.create('button', 'locate-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Show my location');
    btn.title = 'My location';

    // Desktop: bold target/crosshair (image 1 style). Mobile: compass needle (image 2 style).
    btn.innerHTML = `
      <svg class="locate-icon locate-icon-desktop" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <!-- Outer ring -->
        <circle cx="20" cy="20" r="11" stroke="currentColor" stroke-width="4" fill="none"/>
        <!-- Inner filled dot -->
        <circle cx="20" cy="20" r="4" fill="currentColor"/>
        <!-- Cross arms — thick, blunt-ended like the reference image -->
        <line x1="20" y1="1"  x2="20" y2="7"  stroke="currentColor" stroke-width="4" stroke-linecap="butt"/>
        <line x1="20" y1="33" x2="20" y2="39" stroke="currentColor" stroke-width="4" stroke-linecap="butt"/>
        <line x1="1"  y1="20" x2="7"  y2="20" stroke="currentColor" stroke-width="4" stroke-linecap="butt"/>
        <line x1="33" y1="20" x2="39" y2="20" stroke="currentColor" stroke-width="4" stroke-linecap="butt"/>
      </svg>
      <svg class="locate-icon locate-icon-mobile" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <!-- Compass needle shape matching the grey button screenshot -->
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.35"/>
        <!-- Compass dial ring -->
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.2" fill="none" opacity="0.55"/>
        <!-- North needle (filled) -->
        <polygon points="12,3 14.2,12 12,10.5 9.8,12" fill="currentColor"/>
        <!-- South needle (hollow / dimmed) -->
        <polygon points="12,21 14.2,12 12,13.5 9.8,12" fill="currentColor" opacity="0.38"/>
        <!-- Centre dot -->
        <circle cx="12" cy="12" r="1.4" fill="currentColor"/>
      </svg>
    `;

    let watching = false;
    let watchId = null;
    let locationMarker = null;
    let locationCircle = null;
    let lastUpdateTime = 0;
    let hasZoomed = false;
    let positionAcquired = false;
    const THROTTLE_MS = 2000;

    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => {
      if (!navigator.geolocation) {
        btn.classList.add('locate-btn--error');
        setTimeout(() => btn.classList.remove('locate-btn--error'), 1000);
        return;
      }

      if (watching) {
        if (!positionAcquired) {
          // First position not yet acquired - don't allow toggle-off
          return;
        }
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        watching = false;
        positionAcquired = false;
        hasZoomed = false;
        if (locationMarker) { locationMarker.remove(); locationMarker = null; }
        if (locationCircle) { locationCircle.remove(); locationCircle = null; }
        return;
      }

      positionAcquired = false;
      watching = true;

      function flashGreen() {
        btn.classList.add('locate-btn--tracking');
        setTimeout(() => btn.classList.remove('locate-btn--tracking'), 1000);
      }

      function updateLocation(pos) {
        const now = Date.now();
        if (now - lastUpdateTime < THROTTLE_MS) return;
        lastUpdateTime = now;
        if (!positionAcquired) positionAcquired = true;

        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        lastKnownUserLatLng = { lat, lng };

        if (locationMarker) { locationMarker.remove(); locationMarker = null; }
        if (locationCircle) { locationCircle.remove(); locationCircle = null; }

        locationCircle = L.circle([lat, lng], {
          radius: accuracy,
          color: '#8fa3ff',
          fillColor: '#8fa3ff',
          fillOpacity: 0.12,
          weight: 1.5
        }).addTo(map);

        const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">
          <circle cx="10" cy="10" r="7" fill="#8fa3ff" stroke="#fff" stroke-width="2.5"/>
          <circle cx="10" cy="10" r="3" fill="#fff"/>
        </svg>`;
        const dotIcon = L.divIcon({
          className: '',
          html: dotSvg,
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        });
        locationMarker = L.marker([lat, lng], { icon: dotIcon, interactive: false }).addTo(map);

        if (!hasZoomed) {
          hasZoomed = true;
          map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 1 });
          flashGreen();
        }
      }

      watchId = navigator.geolocation.watchPosition(
        updateLocation,
        (err) => {
          navigator.geolocation.clearWatch(watchId);
          watchId = null;
          watching = false;
          positionAcquired = false;
          hasZoomed = false;
          btn.classList.add('locate-btn--error');
          setTimeout(() => btn.classList.remove('locate-btn--error'), 1000);
          console.warn('Geolocation error:', err.message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    return btn;
  };

  locationControl.addTo(map);
}

function addSettingsControl() {
  const settingsModal = document.getElementById('settingsModal');
  const privacyPolicyModal = document.getElementById('privacyPolicyModal');
  const privacyPolicyLink = document.getElementById('privacyPolicyLink');
  const clusteringToggle = document.getElementById('clusteringToggle');
  const analyticsToggle = document.getElementById('analyticsToggle');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctrl-btn settings-control-btn';
  btn.title = 'Settings';
  btn.setAttribute('aria-label', 'Open settings');
  btn.innerHTML = `
    <svg class="settings-control-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.25"></circle>
      <path d="M19.4 15a7.8 7.8 0 0 0 .05-5.9l1.75-1.35-2-3.45-2.18.88a7.9 7.9 0 0 0-2.52-1.46L14.2 1.4h-4.4l-.3 2.32a7.9 7.9 0 0 0-2.52 1.46L4.8 4.3l-2 3.45L4.55 9.1a7.8 7.8 0 0 0 0 5.8L2.8 16.25l2 3.45 2.18-.88a7.9 7.9 0 0 0 2.52 1.46l.3 2.32h4.4l.3-2.32a7.9 7.9 0 0 0 2.52-1.46l2.18.88 2-3.45L19.4 15Z"></path>
    </svg>
  `;

  btn.addEventListener('click', () => {
    if (typeof closeBottomTools === 'function') closeBottomTools();
    settingsModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  });

  window.__settingsBtn = btn;

  // Modal close handlers
  const closeModal = () => {
    // Add closing animation class
    settingsModal.classList.add('is-closing');
    // Wait for animation to complete before hiding
    setTimeout(() => {
      settingsModal.style.display = 'none';
      settingsModal.classList.remove('is-closing');
      document.body.style.overflow = '';
    }, 250);
  };

  const closePrivacyPolicyModal = () => {
    privacyPolicyModal.classList.add('is-closing');
    setTimeout(() => {
      privacyPolicyModal.style.display = 'none';
      privacyPolicyModal.classList.remove('is-closing');
      document.body.style.overflow = '';
    }, 250);
  };

  const openPrivacyPolicyModal = (e) => {
    e.preventDefault();
    settingsModal.style.display = 'none';
    settingsModal.classList.remove('is-closing');
    privacyPolicyModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  };

  const backToSettingsModal = () => {
    privacyPolicyModal.style.display = 'none';
    privacyPolicyModal.classList.remove('is-closing');
    settingsModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  };

  // Close on backdrop click
  document.querySelector('.settings-modal-backdrop').addEventListener('click', closeModal);
  document.querySelector('.settings-modal-close').addEventListener('click', closeModal);
  privacyPolicyLink.addEventListener('click', openPrivacyPolicyModal);
  document.querySelector('.privacy-policy-back').addEventListener('click', backToSettingsModal);
  document.querySelector('.privacy-policy-backdrop').addEventListener('click', closePrivacyPolicyModal);
  document.querySelector('.privacy-policy-close').addEventListener('click', closePrivacyPolicyModal);

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && privacyPolicyModal.style.display === 'flex') {
      closePrivacyPolicyModal();
    } else if (e.key === 'Escape' && settingsModal.style.display === 'flex') {
      closeModal();
    }
  });

  // Clustering toggle handler
  clusteringToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    localStorage.setItem('clusteringEnabled', enabled ? 'true' : 'false');

    if (enabled) {
      // Enable clustering - recreate the marker cluster group
      if (!spotClusterGroup || !(spotClusterGroup instanceof L.MarkerClusterGroup)) {
        // Clear existing layer
        if (spotClusterGroup) map.removeLayer(spotClusterGroup);

        // Create cluster group
        spotClusterGroup = L.markerClusterGroup({
          showCoverageOnHover: false,
          spiderfyOnMaxZoom: true,
          disableClusteringAtZoom: 15,
          maxClusterRadius: 55
        });

        map.addLayer(spotClusterGroup);

        // Re-add all markers
        loadSpots();
      }
    } else {
      // Disable clustering - switch to regular layer group
      if (spotClusterGroup) {
        const layerGroup = L.layerGroup();

        // Transfer all markers
        spotClusterGroup.eachLayer((marker) => {
          layerGroup.addLayer(marker);
        });

        map.removeLayer(spotClusterGroup);
        spotClusterGroup = layerGroup;
        map.addLayer(spotClusterGroup);
      }
    }
  });

  // Analytics toggle handler
  analyticsToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    localStorage.setItem('analyticsEnabled', enabled ? 'true' : 'false');
    console.log('Analytics:', enabled ? 'enabled' : 'disabled');
  });

  // Load saved preferences
  const clusteringSaved = localStorage.getItem('clusteringEnabled');
  if (clusteringSaved !== null) {
    clusteringToggle.checked = clusteringSaved === 'true';
  }

  const analyticsSaved = localStorage.getItem('analyticsEnabled');
  if (analyticsSaved !== null) {
    analyticsToggle.checked = analyticsSaved === 'true';
  }

}

function refreshAddSpotControl() {
  const btn = document.getElementById('addSpotBtn');
  if (!btn) return;
  if (canEditSpots()) {
    btn.style.display = 'flex';
    const panel = document.getElementById('ctrl-panel');
    if (panel && btn.parentNode !== panel) panel.appendChild(btn);
    btn.onclick = (e) => { e.stopPropagation(); addMode = true; };
  } else {
    btn.style.display = 'none';
    addMode = false;
  }
}

// ── Bottom-Right Tools (Filter + Export) ──
const bottomToolsWrap = document.createElement('div');
bottomToolsWrap.className = 'bottom-tools-wrap';

const bottomToolsBtn = document.createElement('button');
bottomToolsBtn.type = 'button';
bottomToolsBtn.className = 'ctrl-btn bottom-tools-btn';
bottomToolsBtn.title = 'Tools';
bottomToolsBtn.setAttribute('aria-label', 'Tools');
bottomToolsBtn.innerHTML = '<svg class="ctrl-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>';

const bottomToolsBubble = document.createElement('div');
bottomToolsBubble.className = 'bottom-tools-bubble';
bottomToolsBubble.style.display = 'none';

const bubbleFilterBtn = document.createElement('button');
bubbleFilterBtn.type = 'button';
bubbleFilterBtn.className = 'ctrl-btn';
bubbleFilterBtn.title = 'Filter spots';
bubbleFilterBtn.setAttribute('aria-label', 'Filter spots');
bubbleFilterBtn.innerHTML = '<svg class="ctrl-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/><line x1="11" y1="10" x2="15" y2="10"/></svg>';

const bubbleExportBtn = document.createElement('button');
bubbleExportBtn.type = 'button';
bubbleExportBtn.className = 'ctrl-btn';
bubbleExportBtn.title = 'Export data';
bubbleExportBtn.setAttribute('aria-label', 'Export data');
bubbleExportBtn.innerHTML = '<svg class="ctrl-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

bottomToolsBubble.appendChild(bubbleExportBtn);

// ── Abandonment Scanner ──


// ── Radar Mode ──
let radarModeEnabled = false;
let radarModeInterval = null;
let radarModeResults = [];
let radarPulseCircles = [];
let radarPriorityBubble = null;
let radarScanRing = null;
let radarScanRingPhase = 0;
let radarScanRingInterval = null;
let radarPanel = null;
let radarSlideout = null;
let radarSlideoutOpen = false;
let radarMoveTimeout = null;
let radarOriginMode = 'freeroam';
let radarRadiusKm = 10;
let radarUserLatLng = null;
let radarWatchId = null;
let radarGpsInterval = null;
let radarGpsAvailable = false;
let radarDenied = false;

const radarModeToggleBtn = document.createElement('button');
radarModeToggleBtn.type = 'button';
radarModeToggleBtn.className = 'ctrl-btn radar-mode-toggle-btn';
radarModeToggleBtn.title = 'Radar Mode';
radarModeToggleBtn.setAttribute('aria-label', 'Radar Mode');
radarModeToggleBtn.innerHTML = '<svg class="ctrl-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M12 12l6-6"/><path d="M17 6h1v1"/></svg>';

radarSlideout = document.createElement('div');
radarSlideout.className = 'radar-slideout';
radarSlideout.style.display = 'none';
radarSlideout.innerHTML =
  '<div class="radar-slideout-body">' +
  '<label class="radar-slideout-toggle"><span class="radar-slideout-toggle-text">Enable Radar Mode</span><div class="radar-slideout-switch"><input type="checkbox" id="radarEnableCheck" class="radar-slideout-checkbox"><span class="radar-slideout-slider"></span></div></label>' +
  '</div>';
document.body.appendChild(radarSlideout);

radarPanel = document.createElement('div');
radarPanel.className = 'radar-panel';
radarPanel.style.display = 'none';
radarPanel.innerHTML =
  '<div class="radar-panel-header">' +
  '<span class="radar-panel-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M12 12l6-6"/></svg></span>' +
  '<div class="radar-panel-title-group">' +
  '<span class="radar-panel-title">Radar Nearby</span>' +
  '<div class="radar-mode-wrap"><button type="button" class="radar-mode-trigger">Freeroam</button><div class="radar-mode-menu" style="display:none"><button type="button" data-value="freeroam">Freeroam</button><button type="button" data-value="location">My Location</button></div></div>' +
  '<div class="radar-radius-wrap"><button type="button" class="radar-radius-trigger">10 km</button><div class="radar-radius-menu" style="display:none"><button type="button" data-value="1">1 km</button><button type="button" data-value="5">5 km</button><button type="button" data-value="10">10 km</button><button type="button" data-value="15">15 km</button><button type="button" data-value="30">30 km</button></div></div>' +
  '<span class="radar-count-badge"></span></div>' +
  '<button type="button" class="radar-panel-close" aria-label="Close radar" title="Close Radar">&times;</button></div>' +
  '<div class="radar-panel-body"><div class="radar-panel-results"></div></div>';
document.body.appendChild(radarPanel);
initRadarRadiusDropdown();
initRadarModeDropdown();

radarPanel.querySelector('.radar-panel-close').addEventListener('click', function() {
  if (radarModeEnabled) toggleRadarMode();
});

function getRadarOrigin() {
  if (radarOriginMode === 'location' && radarGpsAvailable && radarUserLatLng) return radarUserLatLng;
  if (!map) return L.latLng(0, 0);
  var c = map.getCenter();
  return L.latLng(c.lat, c.lng);
}

function toggleRadarMode() {
  radarModeEnabled = !radarModeEnabled;
  var checkbox = document.getElementById('radarEnableCheck');
  if (checkbox) checkbox.checked = radarModeEnabled;
  radarModeToggleBtn.classList.toggle('is-active', radarModeEnabled);
  if (radarModeEnabled) enableRadarMode(); else disableRadarMode();
}

function enableRadarMode() {
  radarPanel.style.display = '';
  if (radarOriginMode === 'location') startGpsWatch();
  clearRadarPulseEffects();
  showRadarLoading();
  syncRadarControls();
  updateRadarResults();
  radarModeInterval = setInterval(updateRadarResults, 2000);
  radarScanRingPhase = 0;
  radarScanRingInterval = setInterval(animateScanRing, 80);
  map.on('moveend', onRadarMapMove);
  if (window.innerWidth <= 700) {
    bottomToolsWrap.style.display = 'none';
  }
}

function disableRadarMode() {
  radarPanel.style.display = 'none';
  if (radarModeInterval) { clearInterval(radarModeInterval); radarModeInterval = null; }
  if (radarScanRingInterval) { clearInterval(radarScanRingInterval); radarScanRingInterval = null; }
  if (radarMoveTimeout) { clearTimeout(radarMoveTimeout); radarMoveTimeout = null; }
  map.off('moveend', onRadarMapMove);
  stopGpsWatch();
  clearRadarPulseEffects();
  radarModeResults = [];
  if (window.innerWidth <= 700) {
    bottomToolsWrap.style.display = '';
  }
}

function startGpsWatch() {
  radarDenied = false; radarGpsAvailable = false;
  if (!navigator.geolocation) { radarDenied = true; return; }
  function fetchPos() {
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        radarUserLatLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
        radarGpsAvailable = true; radarDenied = false;
        if (map && radarOriginMode === 'location') map.panTo(radarUserLatLng);
      },
      function() { radarDenied = true; radarGpsAvailable = false; },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 3000 }
    );
  }
  fetchPos();
  radarGpsInterval = setInterval(fetchPos, 5000);
}

function stopGpsWatch() {
  if (radarGpsInterval !== null) { clearInterval(radarGpsInterval); radarGpsInterval = null; }
  radarUserLatLng = null; radarGpsAvailable = false; radarDenied = false;
}

function syncRadarControls() {
  var modeTrigger = radarPanel.querySelector('.radar-mode-trigger');
  if (modeTrigger) modeTrigger.textContent = radarOriginMode === 'freeroam' ? 'Freeroam' : 'My Location';
  var radiusTrigger = radarPanel.querySelector('.radar-radius-trigger');
  if (radiusTrigger) radiusTrigger.textContent = radarRadiusKm + ' km';
}

// ── Radar Dropdowns ──

function initRadarModeDropdown() {
  var wrap = radarPanel.querySelector('.radar-mode-wrap');
  if (!wrap) return;
  var trigger = wrap.querySelector('.radar-mode-trigger');
  var menu = wrap.querySelector('.radar-mode-menu');
  if (!trigger || !menu) return;
  function close() { menu.style.display = 'none'; }
  var radiusMenu = radarPanel.querySelector('.radar-radius-menu');
  trigger.addEventListener('click', function(e) {
    e.stopPropagation();
    if (menu.style.display !== 'none') { close(); return; }
    if (radiusMenu) radiusMenu.style.display = 'none';
    menu.style.display = '';
    menu.querySelectorAll('button').forEach(function(b) {
      b.classList.toggle('is-active', b.getAttribute('data-value') === radarOriginMode);
    });
  });
  menu.querySelectorAll('button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var v = this.getAttribute('data-value');
      if (v !== radarOriginMode) {
        radarOriginMode = v;
        trigger.textContent = v === 'freeroam' ? 'Freeroam' : 'My Location';
        clearRadarPulseEffects();
        showRadarLoading();
        if (v === 'location') startGpsWatch(); else stopGpsWatch();
        updateRadarResults();
      }
      close();
    });
  });
  document.addEventListener('click', function(e) {
    if (!wrap.contains(e.target)) close();
  });
}

function initRadarRadiusDropdown() {
  var wrap = radarPanel.querySelector('.radar-radius-wrap');
  if (!wrap) return;
  var trigger = wrap.querySelector('.radar-radius-trigger');
  var menu = wrap.querySelector('.radar-radius-menu');
  if (!trigger || !menu) return;
  function close() { menu.style.display = 'none'; }
  var modeMenu = radarPanel.querySelector('.radar-mode-menu');
  trigger.addEventListener('click', function(e) {
    e.stopPropagation();
    if (menu.style.display !== 'none') { close(); return; }
    if (modeMenu) modeMenu.style.display = 'none';
    menu.style.display = '';
    menu.querySelectorAll('button').forEach(function(b) {
      b.classList.toggle('is-active', Number(b.getAttribute('data-value')) === radarRadiusKm);
    });
  });
  menu.querySelectorAll('button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var v = Number(this.getAttribute('data-value'));
      if (v !== radarRadiusKm) {
        radarRadiusKm = v;
        trigger.textContent = v + ' km';
        clearRadarPulseEffects();
        showRadarLoading();
        updateRadarResults();
      }
      close();
    });
  });
  document.addEventListener('click', function(e) {
    if (!wrap.contains(e.target)) close();
  });
}

function onRadarMapMove() {
  if (radarOriginMode !== 'freeroam') return;
  if (radarMoveTimeout) clearTimeout(radarMoveTimeout);
  radarMoveTimeout = setTimeout(showRadarLoading, 50);
}

function showRadarLoading() {
  var el = radarPanel.querySelector('.radar-panel-results');
  if (el) el.innerHTML = '<div class="radar-loading"><div class="radar-sweep-mini"></div></div>';
}

function calculateNearestMarkers() {
  if (!map || !spotMarkers.length) return [];
  var origin = getRadarOrigin();
  var visible = getVisibleMarkers();
  var results = visible.map(function(m) {
    return { marker: m, distanceKm: origin.distanceTo(m.getLatLng()) / 1000 };
  }).sort(function(a, b) { return a.distanceKm - b.distanceKm; });
  if (radarRadiusKm > 0) results = results.filter(function(r) { return r.distanceKm <= radarRadiusKm; });
  return results;
}

function updateRadarResults() {
  if (radarDenied && radarOriginMode === 'location') {
    renderRadarPanel([]);
    clearRadarPulseEffects();
    return;
  }
  var results = calculateNearestMarkers();
  radarModeResults = results;
  renderRadarPanel(results);
  updatePulseEffects(results.slice(0, 20));
}

function renderRadarPanel(results) {
  var resultsEl = radarPanel.querySelector('.radar-panel-results');
  var badgeEl = radarPanel.querySelector('.radar-count-badge');
  if (!resultsEl) return;
  if (radarDenied && radarOriginMode === 'location') {
    if (badgeEl) badgeEl.textContent = '';
    resultsEl.innerHTML = '<div class="radar-denied">Enable location access for My Location mode.</div>';
    return;
  }
  if (badgeEl) badgeEl.textContent = results.length ? String(results.length) : '';
  if (!results.length) { resultsEl.innerHTML = '<div class="radar-empty">No locations found</div>'; return; }
  var html = '<div class="radar-list">';
  var toShow = results.slice(0, 20);
  for (var i = 0; i < toShow.length; i++) {
    var r = toShow[i];
    var name = escapeHtml(r.marker._spotName || 'Unnamed spot');
    var dist = r.distanceKm < 1 ? (r.distanceKm * 1000).toFixed(0) + ' m' : r.distanceKm.toFixed(1) + ' km';
    var ll = r.marker.getLatLng();
    var mapsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + ll.lat + ',' + ll.lng;
    var dotColor = { confirmed: '#33c06d', risky: '#ef4f76', unsure: '#e7c74b' }[r.marker._spotClass] || '#a78bfa';
    html += '<div class="radar-result' + (i === 0 ? ' is-nearest' : '') + '">' +
      '<div class="radar-result-rank">' + (i + 1) + '</div>' +
      '<div class="radar-result-info"><div class="radar-result-name"><span class="radar-spot-dot" style="background:' + dotColor + '"></span>' + name + '</div><div class="radar-result-dist">' + dist + '</div></div>' +
      '<div class="radar-result-actions">' +
      '<button type="button" class="radar-action-btn radar-dir-btn" data-url="' + escapeHtml(mapsUrl) + '" title="Directions"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11L11 5M7 5h4v4"/></svg></button>' +
      '<button type="button" class="radar-action-btn radar-view-btn" data-index="' + i + '" title="View"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/><path d="M11 7v8M7 11h8"/></svg></button>' +
      '</div></div>';
  }
  html += '</div>';
  resultsEl.innerHTML = html;
  resultsEl.querySelectorAll('.radar-view-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var rr = results[Number(btn.getAttribute('data-index'))];
      if (rr && rr.marker) flyToMarker(rr.marker);
    });
  });
  resultsEl.querySelectorAll('.radar-dir-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var url = btn.getAttribute('data-url');
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });
  });
}

function flyToMarker(marker) {
  if (!marker || !map) return;
  var ll = marker.getLatLng();
  map.flyTo([ll.lat, ll.lng], 14, { duration: 0.8 });
}

function updatePulseEffects(results) {
  clearRadarPulseEffects();
  if (!results.length) return;
  var origin = getRadarOrigin();
  var maxDist = results[results.length - 1].distanceKm || 1;
  if (radarRadiusKm > 0 && radarRadiusKm < maxDist) maxDist = radarRadiusKm;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var ll = r.marker.getLatLng();
    var ratio = 1 - Math.min(r.distanceKm / maxDist, 1);
    var radius = 30 + ratio * 120;
    var fillOp = 0.1 + ratio * 0.18;
    var strokeOp = 0.15 + ratio * 0.25;
    radarPulseCircles.push(L.circle([ll.lat, ll.lng], {
      radius: radius, color: i === 0 ? '#b0c4ff' : '#8fa3ff',
      fillColor: i === 0 ? '#a0b8ff' : '#8fa3ff',
      fillOpacity: fillOp, weight: i === 0 ? 1.5 : 1, opacity: strokeOp,
      interactive: false, className: 'radar-pulse-ring'
    }).addTo(map));
  }
  var nearest = results[0];
  var nll = nearest.marker.getLatLng();
  var nRatio = 1 - Math.min(nearest.distanceKm / maxDist, 1);
  radarPriorityBubble = L.circle([nll.lat, nll.lng], {
    radius: 40 + nRatio * 100, color: '#a8b7ff', fillColor: '#8fa3ff',
    fillOpacity: 0.05, weight: 1.5, opacity: 0.35,
    className: 'radar-priority-bubble', interactive: false
  }).addTo(map);
  radarScanRing = L.circle([origin.lat, origin.lng], {
    radius: 2000, color: 'rgba(143,163,255,0.15)', fillColor: 'transparent',
    fillOpacity: 0, weight: 1, opacity: 0.15,
    interactive: false
  }).addTo(map);
}

function clearRadarPulseEffects() {
  radarPulseCircles.forEach(function(c) { if (map) map.removeLayer(c); });
  radarPulseCircles = [];
  if (radarPriorityBubble && map) { map.removeLayer(radarPriorityBubble); radarPriorityBubble = null; }
  if (radarScanRing && map) { map.removeLayer(radarScanRing); radarScanRing = null; }
  radarScanRingPhase = 0;
}

function animateScanRing() {
  if (!radarScanRing || !map) return;
  radarScanRingPhase += 0.025;
  if (radarScanRingPhase > 1) radarScanRingPhase -= 1;
  var t = (Math.sin(radarScanRingPhase * Math.PI * 2) + 1) / 2;
  radarScanRing.setRadius(600 + t * 1600);
  radarScanRing.setStyle({ opacity: 0.15 - t * 0.1 });
}

function positionRadarSlideout() {
  var wrapRect = bottomToolsWrap.getBoundingClientRect();
  var btnRect = radarModeToggleBtn.getBoundingClientRect();
  radarSlideout.style.right = (window.innerWidth - wrapRect.left + 8) + 'px';
  radarSlideout.style.top = Math.max(8, btnRect.top) + 'px';
  radarSlideout.style.left = 'auto';
}

function closeRadarSlideout() {
  if (!radarSlideoutOpen) return;
  radarSlideoutOpen = false;
  radarSlideout.classList.add('radar-slideout-closing');
  radarSlideout.addEventListener('animationend', function handler() {
    radarSlideout.removeEventListener('animationend', handler);
    radarSlideout.style.display = 'none';
    radarSlideout.classList.remove('radar-slideout-closing');
  }, { once: true });
}

function openRadarSlideout() {
  radarSlideoutOpen = true;
  positionRadarSlideout();
  radarSlideout.style.display = '';
  radarSlideout.classList.remove('radar-slideout-closing');
  var checkbox = document.getElementById('radarEnableCheck');
  if (checkbox) checkbox.checked = radarModeEnabled;
}

radarModeToggleBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  if (radarSlideoutOpen) closeRadarSlideout();
  toggleRadarMode();
});

document.addEventListener('click', function(e) {
  if (radarSlideoutOpen && !radarSlideout.contains(e.target) && !radarModeToggleBtn.contains(e.target)) closeRadarSlideout();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && radarSlideoutOpen) closeRadarSlideout();
});

document.addEventListener('change', function(e) {
  if (e.target.id === 'radarEnableCheck') {
    if (!radarModeEnabled && e.target.checked) toggleRadarMode();
    else if (radarModeEnabled && !e.target.checked) toggleRadarMode();
  }
});

window.addEventListener('beforeunload', function() { if (radarModeEnabled) disableRadarMode(); });

const bottomToolsGroup = document.createElement('div');
bottomToolsGroup.className = 'bottom-tools-group';
bottomToolsGroup.appendChild(bottomToolsBubble);
bottomToolsGroup.appendChild(bottomToolsBtn);

const filterPopover = document.createElement('div');
filterPopover.className = 'ctrl-popover bottom-filter-popover';
filterPopover.style.display = 'none';
filterPopover.innerHTML =
  '<div class="ctrl-popover-header">Filter by type</div>' +
  '<label class="filter-row" data-class="confirmed"><span class="filter-swatch" style="background:#33c06d"></span><span>Confirmed</span><input type="checkbox" checked></label>' +
  '<label class="filter-row" data-class="risky"><span class="filter-swatch" style="background:#ef4f76"></span><span>Risky</span><input type="checkbox" checked></label>' +
  '<label class="filter-row" data-class="unsure"><span class="filter-swatch" style="background:#e7c74b"></span><span>Unsure</span><input type="checkbox" checked></label>' +
  '<label class="filter-row" data-class="default"><span class="filter-swatch" style="background:#a78bfa"></span><span>No Class</span><input type="checkbox" checked></label>' +
  '<button class="ctrl-popover-action filter-show-all">Show All</button>';

bottomToolsWrap.appendChild(bottomToolsGroup);
bottomToolsWrap.appendChild(filterPopover);
document.body.appendChild(bottomToolsWrap);

let bottomToolsOpen = false;
let bottomToolsClosing = false;
let filterPopoverOpen = false;

function applyFilters() {
  const checks = filterPopover.querySelectorAll('.filter-row input[type="checkbox"]');
  checks.forEach(cb => {
    const row = cb.closest('.filter-row');
    const cls = row.getAttribute('data-class');
    activeFilters[cls] = cb.checked;
  });
  const allHidden = Object.values(activeFilters).every(v => v === false);
  spotMarkers.forEach(m => {
    const cls = m._spotClass || 'default';
    const visible = activeFilters[cls] && !allHidden;
    if (visible) {
      if (!spotClusterGroup.hasLayer(m)) spotClusterGroup.addLayer(m);
    } else {
      if (spotClusterGroup.hasLayer(m)) spotClusterGroup.removeLayer(m);
    }
  });
}

function getVisibleMarkers() {
  return spotMarkers.filter(m => spotClusterGroup && spotClusterGroup.hasLayer(m));
}

async function exportData(format = 'json') {
  const modal = document.getElementById('exportModal');
  const checks = modal.querySelectorAll('.export-row input[type="checkbox"]');
  const selected = {};
  checks.forEach(cb => {
    const key = cb.closest('.export-row').getAttribute('data-key');
    selected[key] = cb.checked;
  });
  const anySelected = Object.values(selected).some(v => v);
  if (!anySelected) { alert('Select at least one data field to export.'); return; }

  const data = { exportedAt: new Date().toISOString(), profile: null, spots: [] };

  if (selected.profile) {
    if (currentUser && !guestMode) {
      try {
        const snap = await getDoc(doc(db, 'users', currentUser.uid));
        if (snap.exists()) {
          const u = snap.data();
          data.profile = {
            displayName: u.displayName || '',
            email: u.email || '',
            role: u.role || 'visitor',
            bio: u.bio || '',
            joinedAt: u.createdAt ? (u.createdAt.toDate ? u.createdAt.toDate().toISOString() : u.createdAt) : ''
          };
        }
      } catch (e) {
        data.profile = { displayName: currentUser.displayName || '', email: currentUser.email || '', role: userRole || 'visitor' };
      }
    } else {
      data.profile = null;
    }
  }

  const visibleSpots = getVisibleMarkers();
  visibleSpots.forEach(m => {
    const entry = {};
    if (selected.spotName) entry.name = m._spotName || 'Unnamed spot';
    if (selected.spotCoords) { entry.coordinates = [m.getLatLng().lat, m.getLatLng().lng]; }
    if (selected.spotDesc) entry.description = m._spotDesc || '';
    if (Object.keys(entry).length) data.spots.push(entry);
  });

  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === 'txt') {
    let text = `Export Date: ${dateStr}\n`;
    if (data.profile) {
      text += `Profile: ${data.profile.displayName || ''} (${data.profile.email || ''})\n`;
      if (data.profile.role) text += `Role: ${data.profile.role}\n`;
    }
    text += `---\n`;
    data.spots.forEach((s, i) => {
      text += `\nSpot: ${s.name || 'Unnamed'}\n`;
      if (s.coordinates) text += `  Coordinates: ${s.coordinates[0]}, ${s.coordinates[1]}\n`;
      if (s.description) text += `  Description: ${s.description}\n`;
    });
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cua-export-' + dateStr + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } else {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cua-export-' + dateStr + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  closeBottomTools();
}

function animateCloseBubble() {
  bottomToolsClosing = true;
  bottomToolsBubble.classList.add('bottom-tools-bubble--closing');
  bottomToolsBubble.addEventListener('animationend', function handler() {
    bottomToolsBubble.removeEventListener('animationend', handler);
    bottomToolsBubble.style.display = 'none';
    bottomToolsBubble.classList.remove('bottom-tools-bubble--closing');
    bottomToolsClosing = false;
  });
}

function toggleBottomToolsBubble() {
  if (bottomToolsClosing) return;
  bottomToolsOpen = !bottomToolsOpen;
  if (bottomToolsOpen) {
    bottomToolsBubble.style.display = '';
    bottomToolsBubble.classList.remove('bottom-tools-bubble--closing');
  } else {
    animateCloseBubble();
    if (filterPopoverOpen) { hidePopover(filterPopover); filterPopoverOpen = false; }
  }
}

function closeBottomTools() {
  if (bottomToolsClosing) return;
  bottomToolsOpen = false;
  animateCloseBubble();
  if (filterPopoverOpen) { hidePopover(filterPopover); filterPopoverOpen = false; }
}

// Wire filter popover
filterPopover.querySelectorAll('.filter-row input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', applyFilters);
});
filterPopover.querySelector('.filter-show-all').addEventListener('click', () => {
  filterPopover.querySelectorAll('.filter-row input[type="checkbox"]').forEach(cb => { cb.checked = true; });
  applyFilters();
});



// Wire export modal
const exportModal = document.getElementById('exportModal');
if (exportModal) {
const exportToggleBtn = exportModal.querySelector('.export-modal-toggle');
const exportFormatBtn = exportModal.querySelector('.export-modal-download');
const exportFormatDropup = document.createElement('div');
exportFormatDropup.className = 'export-format-dropup';
exportFormatDropup.style.display = 'none';
exportFormatDropup.innerHTML =
  '<button class="export-format-option" data-format="json">Export as JSON (.json)</button>' +
  '<button class="export-format-option" data-format="txt">Export as TXT (.txt)</button>';
const exportDownloadWrap = document.createElement('div');
exportDownloadWrap.className = 'export-download-wrap';
exportFormatBtn.parentNode.insertBefore(exportDownloadWrap, exportFormatBtn);
exportDownloadWrap.appendChild(exportFormatBtn);
exportDownloadWrap.appendChild(exportFormatDropup);

const exportArrow = exportFormatBtn.querySelector('.export-arrow');

const exportModalBody = document.querySelector('.export-modal-body');
const openExportFormatDropup = () => {
  exportFormatDropup.classList.remove('export-format-dropup--closing');
  exportFormatDropup.style.display = '';
  if (exportArrow) exportArrow.classList.add('is-open');
  if (exportModalBody) exportModalBody.classList.add('export-dropup-open');
};
const closeExportFormatDropup = (cb) => {
  if (exportFormatDropup.style.display === 'none') { if (cb) cb(); return; }
  exportFormatDropup.classList.add('export-format-dropup--closing');
  if (exportModalBody) exportModalBody.classList.remove('export-dropup-open');
  const onEnd = () => {
    exportFormatDropup.removeEventListener('animationend', onEnd);
    exportFormatDropup.style.display = 'none';
    exportFormatDropup.classList.remove('export-format-dropup--closing');
    if (exportArrow) exportArrow.classList.remove('is-open');
    if (cb) cb();
  };
  exportFormatDropup.addEventListener('animationend', onEnd);
};

const closeExportModal = () => {
  closeExportFormatDropup();
  exportModal.classList.add('is-closing');
  setTimeout(() => {
    exportModal.style.display = 'none';
    exportModal.classList.remove('is-closing');
    document.body.style.overflow = '';
  }, 250);
};
document.querySelector('.export-modal-backdrop').addEventListener('click', closeExportModal);
document.querySelector('.export-modal-close').addEventListener('click', closeExportModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && exportModal.style.display === 'flex') closeExportModal();
});
document.addEventListener('click', (e) => {
  if (e.target === exportModal) closeExportModal();
});

exportToggleBtn.addEventListener('click', () => {
  const checks = exportModal.querySelectorAll('.export-row input[type="checkbox"]');
  const allChecked = Array.from(checks).every(cb => cb.checked);
  checks.forEach(cb => { cb.checked = !allChecked; });
  exportToggleBtn.textContent = allChecked ? 'Select All' : 'Deselect';
});

exportFormatBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = exportFormatDropup.style.display !== 'none';
  if (isOpen) {
    closeExportFormatDropup();
  } else {
    openExportFormatDropup();
  }
});

exportFormatDropup.querySelectorAll('.export-format-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    e.stopPropagation();
    const format = opt.getAttribute('data-format');
    closeExportFormatDropup(() => exportData(format));
  });
});

bubbleExportBtn.addEventListener('click', () => {
  if (filterPopoverOpen) { hidePopover(filterPopover); filterPopoverOpen = false; }
  closeBottomTools();
  exportModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  const checks = exportModal.querySelectorAll('.export-row input[type="checkbox"]');
  const allChecked = Array.from(checks).every(cb => cb.checked);
  exportToggleBtn.textContent = allChecked ? 'Deselect' : 'Select All';
});
}

function showPopover(popover) {
  popover.classList.remove('popover-closing');
  popover.style.display = '';
}

function hidePopover(popover) {
  if (!popover || popover.style.display === 'none') return;
  popover.classList.add('popover-closing');
  popover.addEventListener('animationend', function handler() {
    popover.removeEventListener('animationend', handler);
    popover.style.display = 'none';
    popover.classList.remove('popover-closing');
  });
}

function positionPopoverAbove(popover, button) {
  const wrapRect = bottomToolsWrap.getBoundingClientRect();
  const btnRect = button.getBoundingClientRect();
  popover.style.right = (wrapRect.right - btnRect.right) + 'px';
}

// Wire bubble buttons
bubbleFilterBtn.addEventListener('click', () => {
  filterPopoverOpen = !filterPopoverOpen;
  if (filterPopoverOpen) {
    positionPopoverAbove(filterPopover, bubbleFilterBtn);
    showPopover(filterPopover);
  } else {
    hidePopover(filterPopover);
  }
});

bottomToolsBtn.addEventListener('click', toggleBottomToolsBubble);

document.addEventListener('click', (e) => {
  if (!bottomToolsWrap.contains(e.target)) {
    if (bottomToolsOpen) closeBottomTools();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && bottomToolsOpen) closeBottomTools();
});

// ── Custom Layers Control ──
const layersBtn = document.createElement('button');
layersBtn.type = 'button';
layersBtn.className = 'ctrl-btn layers-btn';
layersBtn.title = 'Map style';
layersBtn.setAttribute('aria-label', 'Map style');
layersBtn.innerHTML = '<svg class="ctrl-btn-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l10 5 10-5-10-5Z"/><path d="M4 14l10 5 10-5-10-5Z"/><path d="M4 20l10 5 10-5-10-5Z"/></svg>';

const layersPopover = document.createElement('div');
layersPopover.className = 'ctrl-popover layers-popover';
layersPopover.style.display = 'none';
layersPopover.innerHTML =
  '<div class="ctrl-popover-header">Map Layers</div>' +
  '<label class="layer-row" data-layer="street"><span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/><path d="M1.5 5h13M1.5 10.5h13M5.5 1.5v13M10.5 1.5v13"/></svg></span><span>Street Map</span><span class="layer-radio"></span></label>' +
  '<label class="layer-row" data-layer="satellite"><span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="3"/><path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M3.7 3.7l1.7 1.7M10.6 10.6l1.7 1.7M3.7 12.3l1.7-1.7M10.6 5.4l1.7-1.7"/></svg></span><span>Satellite</span><span class="layer-radio"></span></label>' +
  '<label class="layer-row" data-layer="hybrid"><span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8.5l6.5 4 6.5-4M1.5 5.5l6.5 4 6.5-4M8 1.5L14.5 5.5 8 9.5 1.5 5.5z"/></svg></span><span>Hybrid<span class="layer-info-trigger" data-tooltip="⚠️ Mode not performance friendly">ⓘ</span></span><span class="layer-radio"></span></label>';

let layersPopoverOpen = false;
let currentLayerName = null;
const layerMap = {};

function toggleLayersPopover() {
  layersPopoverOpen = !layersPopoverOpen;
  if (layersPopoverOpen) {
    layersPopover.style.display = '';
    layersPopover.classList.remove('ctrl-popover-closing');
    layersPopover.querySelectorAll('.layer-row').forEach(row => {
      row.classList.toggle('is-active', row.getAttribute('data-layer') === currentLayerName);
    });
  } else {
    layersPopover.classList.add('ctrl-popover-closing');
    layersPopover.addEventListener('animationend', () => {
      layersPopover.style.display = 'none';
      layersPopover.classList.remove('ctrl-popover-closing');
    }, { once: true });
  }
}

function switchLayer(name) {
  if (currentLayerName === name || !layerMap[name]) return;
  if (map && currentLayerName && layerMap[currentLayerName]) { map.removeLayer(layerMap[currentLayerName]); }
  if (map) { map.addLayer(layerMap[name]); }
  currentLayerName = name;
  layersPopover.querySelectorAll('.layer-row').forEach(row => {
    row.classList.toggle('is-active', row.getAttribute('data-layer') === currentLayerName);
  });
}

layersPopover.querySelectorAll('.layer-row').forEach(row => {
  row.addEventListener('click', () => {
    switchLayer(row.getAttribute('data-layer'));
  });
});
layersBtn.addEventListener('click', toggleLayersPopover);

// Layer info tooltip toggle (mobile + desktop)
document.addEventListener('click', function(e) {
  var trigger = e.target.closest('.layer-info-trigger');
  var openTrigger = document.querySelector('.layer-info-trigger.is-open');
  if (trigger) {
    e.stopPropagation();
    e.preventDefault();
    if (openTrigger && openTrigger !== trigger) openTrigger.classList.remove('is-open');
    trigger.classList.toggle('is-open');
  } else if (openTrigger && !openTrigger.contains(e.target)) {
    openTrigger.classList.remove('is-open');
  }
});
document.addEventListener('click', (e) => {
  if (layersPopoverOpen && !layersPopover.contains(e.target) && e.target !== layersBtn && !layersBtn.contains(e.target)) {
    layersPopoverOpen = false;
    layersPopover.style.display = 'none';
  }
});

function runMapApp() {
  if (!window.L) throw new Error('Leaflet failed to load. Check internet or blocked unpkg.com');

  // Create the map
  let initLat = 53.5444, initLng = -113.4909, initZoom = 12;
  const savedPos = localStorage.getItem('cua_map_pos');
  if (savedPos) {
    try {
      const p = JSON.parse(savedPos);
      if (Array.isArray(p) && p.length === 3) { initLat = p[0]; initLng = p[1]; initZoom = p[2]; }
    } catch {}
  }
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView([initLat, initLng], initZoom);
  map.on('moveend', () => {
    const c = map.getCenter();
    localStorage.setItem('cua_map_pos', JSON.stringify([c.lat, c.lng, map.getZoom()]));
  });
  map.on('movestart', () => {
    const drawer = document.getElementById('global-more-drawer');
    if (drawer && drawer.style.display !== 'none') {
      drawer.classList.add('is-closing');
      drawer.addEventListener('animationend', function onEnd() {
        drawer.removeEventListener('animationend', onEnd);
        drawer.style.display = 'none';
        drawer.classList.remove('is-closing');
      }, { once: true });
    }
  });

   // Street
  const street = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: 'Â© OpenStreetMap contributors' }
  );

  // Satellite
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles Â© Esri' }
  );

  // Roads overlay
  const roads = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Roads © Esri', opacity: 0.8 }
  );
  // Hybrid = satellite + major roads (cleaner labels)
  const hybrid = L.layerGroup([satellite, roads]);

  // Default view
  satellite.addTo(map);
  if (typeof L.markerClusterGroup === 'function') {
    spotClusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 15,
      maxClusterRadius: 55
    });
  } else {
    console.warn('Leaflet marker clustering plugin not available. Falling back to regular markers.');
    spotClusterGroup = L.layerGroup();
  }
  map.addLayer(spotClusterGroup);

  // Layer switcher (custom)
  layerMap.street = street;
  layerMap.satellite = satellite;
  layerMap.hybrid = hybrid;
  currentLayerName = 'satellite';

  addCoordinateSearchControl();
  addLocationControl();
  addSettingsControl();

  // Add spot Leaflet control (editor+ only)
  if (canEditSpots()) {
    const addSpotEl = document.getElementById('addSpotBtn');
    addSpotEl.style.display = 'flex';
    const addSpotControl = L.control({ position: 'topright' });
    addSpotControl.onAdd = function () {
      L.DomEvent.disableClickPropagation(addSpotEl);
      return addSpotEl;
    };
    addSpotControl.addTo(map);
  } else {
    document.getElementById('addSpotBtn').style.display = 'none';
  }

  // After all controls are added, move the main tools into one custom right-center panel
  setTimeout(() => {
    const mapEl = document.getElementById('map');

    const panel = document.createElement('div');
    panel.id = 'ctrl-panel';

    const locateEl   = document.querySelector('.locate-btn');
    const addSpotEl  = document.getElementById('addSpotBtn');

    // Layers
    panel.appendChild(layersBtn);
    panel.appendChild(layersPopover);

    // Locate
    if (locateEl && locateEl.parentNode) {
      locateEl.parentNode.removeChild(locateEl);
      panel.appendChild(locateEl);
    }

    // Radar toggle
    if (radarModeToggleBtn) {
      panel.appendChild(radarModeToggleBtn);
    }

    // Settings gear lives inside the bottom-right tools drawer.
    if (window.__settingsBtn) {
      const sBtn = window.__settingsBtn;
      if (sBtn.parentNode) sBtn.parentNode.removeChild(sBtn);
      bottomToolsBubble.appendChild(sBtn);
      bottomToolsBubble.appendChild(bubbleFilterBtn);
    }

    // Add spot
    if (addSpotEl && addSpotEl.style.display !== 'none') {
      addSpotEl.parentNode && addSpotEl.parentNode.removeChild(addSpotEl);
      panel.appendChild(addSpotEl);
    }

    mapEl.appendChild(panel);
  }, 100);

  map.on('contextmenu', (e) => {
    const popupContent = buildMapContextMenu(e.latlng);
    L.popup({
      minWidth: 260,
      maxWidth: 280,
      className: 'coord-context-popup',
      closeButton: false
    })
      .setLatLng(e.latlng)
      .setContent(popupContent)
      .openOn(map);
  });

  // Add Street View control to map (plugin)
  if (window.L && typeof L.control.streetView === 'function') {
    setTimeout(() => {
      L.control.streetView().addTo(map);
    }, 500);
  }

  // Load spots
  loadSpots().finally(() => {
    window.dispatchEvent(new CustomEvent('urbex:map-ready'));
  });

  // Map click handler
  map.on("click", async function (e) {
    if (!canEditSpots() || !addMode || addSpotProcessing) return;
    addSpotProcessing = true;
    addMode = false;
    const newMarker = L.marker(e.latlng, { draggable: true, icon: getSpotIcon('default') }).addTo(spotClusterGroup || map);
    newMarker._spotClass = 'default';
    newMarker._spotComments = [];
    const wrap = document.createElement('div');
    wrap.className = 'location-card is-creating';
    wrap.innerHTML = `<div class="location-card-body">
      <div class="edit-section-main">
        <div class="edit-nav-btn-row">
          <button type="button" class="edit-nav-btn" data-section="info">Info</button>
          <button type="button" class="edit-nav-btn" data-section="desc">Desc</button>
        </div>
        <div class="location-card-edit-actions">
          <button type="button" id="saveSpotBtn" class="location-card-edit-save">Save to cloud</button>
          <button type="button" id="cancelSpotBtn" class="location-card-edit-delete">Cancel</button>
        </div>
        <p id="saveStatus" class="location-card-edit-status"></p>
      </div>
      <div class="edit-section-info">
        <input type="text" id="spotName" class="location-card-edit-name" placeholder="Name">
        <div class="edit-dropdown-wrap">
          <button type="button" class="edit-dropdown-trigger" data-type="class">No Class</button>
          <div class="edit-dropdown-menu" style="display:none">
            <button type="button" data-value="default">No Class</button>
            <button type="button" data-value="confirmed">✅ Confirmed</button>
            <button type="button" data-value="risky">🔴 Risky</button>
            <button type="button" data-value="unsure">🟡 Unsure</button>
          </div>
          <select id="spotClass" class="location-card-edit-class" style="display:none">
            <option value="default">No Class</option>
            <option value="confirmed">Confirmed</option>
            <option value="risky">Risky</option>
            <option value="unsure">Unsure</option>
          </select>
        </div>
        <div class="edit-dropdown-wrap">
          <button type="button" class="edit-dropdown-trigger" data-type="visibility">Visitor+</button>
          <div class="edit-dropdown-menu" style="display:none">
            <button type="button" data-value="visitor">Visitor+</button>
            <button type="button" data-value="member">Member+</button>
            <button type="button" data-value="editor">Editor+</button>
          </div>
          <select id="spotMinRole" class="location-card-edit-class" style="display:none">
            <option value="visitor">Visitor+</option>
            <option value="member">Member+</option>
            <option value="editor">Editor+</option>
          </select>
        </div>
        <button type="button" class="edit-back-btn">← Back</button>
      </div>
      <div class="edit-section-desc">
        <div class="edit-section-title">Description</div>
        <div id="spotDesc" class="location-card-edit-desc" contenteditable></div>
        <button type="button" class="edit-back-btn">← Back</button>
      </div>
      <input type="file" id="spotImage" accept="image/*" multiple style="display:none">
    </div>
    <div class="spot-edit-loading-overlay" style="display:none"><div class="spot-edit-loading-spinner"></div></div>`;
    addDescToolbar(wrap.querySelector('#spotDesc'), wrap.querySelector('#spotImage'));
    initEditDropdown(wrap);
    wrap.classList.add('edit-main-visible');
    wrap.querySelectorAll('.edit-nav-btn').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        wrap.classList.remove('edit-main-visible', 'edit-info-visible', 'edit-desc-visible');
        wrap.classList.add('edit-' + btn.dataset.section + '-visible');
        if (newMarker && newMarker.getPopup) newMarker.getPopup().update();
      };
    });
    wrap.querySelectorAll('.edit-back-btn').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        wrap.classList.remove('edit-main-visible', 'edit-info-visible', 'edit-desc-visible');
        wrap.classList.add('edit-main-visible');
        if (newMarker && newMarker.getPopup) newMarker.getPopup().update();
      };
    });
    newMarker.bindPopup(wrap, { minWidth: 240 }).openPopup();
    wrap.querySelector('#spotClass').onchange = function() {
      const selectedClass = normalizeSpotClass(this.value);
      newMarker._spotClass = selectedClass;
      newMarker.setIcon(getSpotIcon(selectedClass));
      reapplyMarkerScale(newMarker);
    };
    wrap.querySelector('#cancelSpotBtn').onclick = () => {
      if (newMarker) {
        if (spotClusterGroup && spotClusterGroup.hasLayer(newMarker)) {
          spotClusterGroup.removeLayer(newMarker);
        } else if (map && map.hasLayer(newMarker)) {
          map.removeLayer(newMarker);
        }
      }
      addSpotProcessing = false;
    };
    wrap.querySelector('#saveSpotBtn').onclick = async () => {
      const name = (wrap.querySelector('#spotName').value.trim()) || 'Unnamed spot';
      const desc = wrap.querySelector('#spotDesc').innerHTML;
      const pos = newMarker.getLatLng();
      const fileInput = wrap.querySelector('#spotImage');
      const spotClass = normalizeSpotClass(wrap.querySelector('#spotClass').value);
      const minRole = normalizeVisibilityRole(wrap.querySelector('#spotMinRole').value);
      try {
        const loadingOverlay = wrap.querySelector('.spot-edit-loading-overlay');
        loadingOverlay.style.display = 'flex';
        void loadingOverlay.offsetHeight;
        const ref = await addDoc(collection(db, SPOTS_COLLECTION), { lat: pos.lat, lng: pos.lng, name, description: desc, spotClass, minRole, images: [], comments: [], createdAt: serverTimestamp(), addedBy: { uid: currentUser ? currentUser.uid : '', displayName: currentUser ? (currentUser.displayName || getUserDisplayLabel(currentUser)) : 'Unknown', role: userRole || 'visitor' } });
        const imageUrls = [];
        for (const file of fileInput.files) {
          const result = await uploadSpotImage(ref.id, file);
          imageUrls.push(result.publicUrl);
        }
        if (imageUrls.length) {
          await updateDoc(doc(db, SPOTS_COLLECTION, ref.id), { images: imageUrls });
        }
        newMarker._spotId = ref.id;
        newMarker._spotClass = spotClass;
        newMarker._spotComments = [];
        newMarker._spotName = name;
        newMarker._spotDesc = desc;
        newMarker._spotImages = imageUrls;
        newMarker._spotMinRole = minRole;
        newMarker._spotAddedBy = { uid: currentUser ? currentUser.uid : '', displayName: currentUser ? (currentUser.displayName || getUserDisplayLabel(currentUser)) : 'Unknown', role: userRole || 'visitor' };
        newMarker._spotCreatedAt = Date.now();
        newMarker.dragging.disable();
        newMarker.setIcon(getSpotIcon(spotClass));
        reapplyMarkerScale(newMarker);
        newMarker.getPopup().setContent(createSpotPopup({ marker: newMarker, spotId: ref.id, name, desc, images: imageUrls, spotClass, minRole, comments: newMarker._spotComments, editMode: false, addedBy: newMarker._spotAddedBy, createdAt: newMarker._spotCreatedAt }));
        const pop = newMarker.getPopup();
        const cb = pop._closeButton;
        if (cb) cb.style.cssText = '';
        const w = pop._wrapper;
        if (w) w.classList.remove('is-editing');
        pop.update();
        const ll = pop.getLatLng();
        if (ll) pop.setLatLng(ll);
        loadingOverlay.style.display = 'none';
        clearSpotsCache();
        upsertSpotSearchEntry(ref.id, name, newMarker);
        notifyNewSpot(db, ref.id, name, currentUser ? currentUser.uid : '', currentUser ? getUserDisplayLabel(currentUser) : '').catch(() => {});
        wrap.querySelector('#saveStatus').textContent = 'Saved!';
        wrap.querySelector('#saveStatus').style.color = '#8ec5ff';
      } catch (err) {
        loadingOverlay.style.display = 'none';
        wrap.querySelector('#saveStatus').textContent = 'Error: ' + (err.code || err.message || String(err));
        wrap.querySelector('#saveStatus').style.color = '#ffb6c3';
      }
    };
    addSpotProcessing = false;
    addMode = false;
  });
}

function compressImage(file, maxBytes) {
  return new Promise((resolve) => {
    if (file.size <= maxBytes || !file.type.startsWith('image/')) { resolve(file); return; }
    const img = new Image();
    img.onload = () => {
      const MAX_DIM = 1920;
      let { width, height } = img;
      if (width > MAX_DIM || height > MAX_DIM) {
        if (width > height) { height *= MAX_DIM / width; width = MAX_DIM; }
        else { width *= MAX_DIM / height; height = MAX_DIM; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      let quality = 0.85;
      const tryCompress = () => {
        canvas.toBlob((blob) => {
          if (!blob) { resolve(file); return; }
          if (blob.size <= maxBytes || quality <= 0.2) { resolve(blob); return; }
          quality -= 0.1;
          tryCompress();
        }, 'image/jpeg', quality);
      };
      tryCompress();
    };
    img.onerror = () => resolve(file);
    const url = URL.createObjectURL(file);
    const origOnload = img.onload;
    img.src = url;
    img.onload = () => { URL.revokeObjectURL(url); origOnload(); };
  });
}

async function uploadSpotImage(spotId, file) {
  const compressed = await compressImage(file, 512000);
  const ext = (file.name.split('.').pop()) || 'jpg';
  const safeName = `${spotId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const { error } = await supabase.storage.from('spot-images').upload(safeName, compressed, { upsert: true });
  if (error) throw error;
  const { data: { publicUrl } } = supabase.storage.from('spot-images').getPublicUrl(safeName);
  return { publicUrl, path: safeName };
}

async function deleteSpotImage(path) {
  const { error } = await supabase.storage.from('spot-images').remove([path]);
  if (error) console.warn('Failed to delete image:', error.message);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function normalizeLinkUrl(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function showInlineToast(rootEl, message) {
  if (!rootEl) return;
  const existing = rootEl.querySelector('.spot-inline-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'spot-inline-toast';
  toast.textContent = message;
  rootEl.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 1500);
}

function unlinkAnchor(anchor) {
  if (!anchor || !anchor.parentNode) return;
  const textNode = document.createTextNode(anchor.textContent || '');
  anchor.parentNode.replaceChild(textNode, anchor);
}

function getLinkActionButtonsHtml(includeEdit) {
  return `
    ${includeEdit ? `<button type="button" class="spot-link-control-btn spot-link-control-icon-btn" data-action="edit" title="Edit link" aria-label="Edit link">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4zm14.7-11.3c.4-.4.4-1 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.6 1.6 4 4 1-1.2z"/></svg>
    </button>` : ''}
    <button type="button" class="spot-link-control-btn spot-link-control-icon-btn" data-action="copy" title="Copy link" aria-label="Copy link">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16h-9V7h9v14z"/></svg>
    </button>
    <button type="button" class="spot-link-control-btn spot-link-control-icon-btn" data-action="open" title="Open in new tab" aria-label="Open in new tab">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7zM5 5h6V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2v6H5V5z"/></svg>
    </button>
  `;
}

function addEditableLinkSupport(editableEl) {
  if (!editableEl || editableEl.dataset.linkSupportBound === '1') return;
  editableEl.dataset.linkSupportBound = '1';

  const positionParent = editableEl.closest('.location-card') || editableEl.parentNode;

  let controls = null;
  let editor = null;
  let activeAnchor = null;

  function closeControls() {
    if (controls) controls.remove();
    controls = null;
    activeAnchor = null;
  }

  function closeEditor() {
    if (editor) editor.remove();
    editor = null;
  }

  function getRangeRect(range) {
    if (!range) return null;
    const rects = range.getClientRects();
    if (rects && rects.length) return rects[0];
    if (!range.collapsed) return range.getBoundingClientRect();
    const clone = range.cloneRange();
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    clone.insertNode(marker);
    const rect = marker.getBoundingClientRect();
    marker.remove();
    return rect;
  }

  function placeFloatingBox(box, targetEl, sourceRange = null) {
    const parentRect = positionParent.getBoundingClientRect();
    const anchorRect = getRangeRect(sourceRange) || targetEl.getBoundingClientRect();
    const gap = 8;
    const minLeft = 6;
    const maxLeft = Math.max(minLeft, parentRect.width - box.offsetWidth - 6);
    const left = Math.min(maxLeft, Math.max(minLeft, anchorRect.left - parentRect.left));
    const preferredTop = anchorRect.top - parentRect.top - box.offsetHeight - gap;
    const fallbackTop = anchorRect.bottom - parentRect.top + gap;
    const maxTop = Math.max(0, parentRect.height - box.offsetHeight - 6);
    const top = preferredTop >= 0 ? preferredTop : fallbackTop;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(0, Math.min(maxTop, top))}px`;
  }

  function openLinkEditor({ targetAnchor = null, sourceRange = null }) {
    closeEditor();
    if (targetAnchor) closeControls();
    const selectedText = targetAnchor
      ? (targetAnchor.textContent || '')
      : (window.getSelection() ? window.getSelection().toString().trim() : '');
    const selectedHref = targetAnchor
      ? (targetAnchor.getAttribute('href') || '')
      : '';

    editor = document.createElement('div');
    editor.className = 'spot-link-editor';
    editor.innerHTML = `
      <label class="spot-link-editor-label">Text</label>
      <input type="text" class="spot-link-editor-input" data-field="text" placeholder="Link text">
      <label class="spot-link-editor-label">URL</label>
      <input type="text" class="spot-link-editor-input" data-field="url" placeholder="https://example.com">
      <div class="spot-link-editor-actions">
        <button type="button" class="spot-link-editor-btn" data-action="apply">Apply</button>
        <button type="button" class="spot-link-editor-btn" data-action="cancel">Cancel</button>
        ${targetAnchor ? '<button type="button" class="spot-link-editor-btn spot-link-editor-unlink" data-action="unlink">Unlink</button>' : ''}
      </div>
    `;
    positionParent.appendChild(editor);

    const textInput = editor.querySelector('[data-field="text"]');
    const urlInput = editor.querySelector('[data-field="url"]');
    textInput.value = selectedText;
    urlInput.value = selectedHref || 'https://';
    placeFloatingBox(editor, targetAnchor || editableEl, sourceRange);
    textInput.focus();

    editor.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'cancel') {
        closeEditor();
        return;
      }
      if (action === 'unlink' && targetAnchor) {
        unlinkAnchor(targetAnchor);
        closeEditor();
        return;
      }
      if (action !== 'apply') return;

      const nextText = (textInput.value || '').trim();
      const nextHref = normalizeLinkUrl(urlInput.value || '');
      if (!nextHref) return;

      if (targetAnchor) {
        targetAnchor.textContent = nextText || nextHref;
        targetAnchor.href = nextHref;
        targetAnchor.target = '_blank';
        targetAnchor.rel = 'noopener noreferrer';
        closeEditor();
        return;
      }

      editableEl.focus();
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      if (sourceRange) sel.addRange(sourceRange);
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);

      const anchor = document.createElement('a');
      anchor.href = nextHref;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = nextText || nextHref;

      if (!range.collapsed) range.deleteContents();
      range.insertNode(anchor);
      range.setStartAfter(anchor);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      closeEditor();
    });
  }

  function openControls(anchor) {
    closeControls();
    closeEditor();
    activeAnchor = anchor;
    controls = document.createElement('div');
    controls.className = 'spot-link-controls';
    controls.innerHTML = getLinkActionButtonsHtml(true);
    positionParent.appendChild(controls);
    placeFloatingBox(controls, anchor);
  }

  editableEl.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !editableEl.contains(a)) {
      closeControls();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    openControls(a);
  });

  if (!activeLinkControlsCloser) {
    activeLinkControlsCloser = (evt) => {
      const t = evt && evt.target;
      if (t && typeof t.closest === 'function') {
        if (t.closest('.spot-link-editor')) return;
        if (t.closest('.spot-link-controls')) return;
        if (t.closest('.spot-desc-toolbar')) return;
      }
      document.querySelectorAll('.spot-link-controls').forEach((el) => el.remove());
      document.querySelectorAll('.spot-link-editor').forEach((el) => el.remove());
    };
    document.addEventListener('click', activeLinkControlsCloser);
  }

  positionParent.addEventListener('click', (e) => {
    if (!controls || !controls.contains(e.target)) return;
    const actionEl = e.target.closest('[data-action]');
    const action = actionEl ? actionEl.getAttribute('data-action') : null;
    if (!action || !activeAnchor) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'edit') {
      openLinkEditor({ targetAnchor: activeAnchor });
      closeControls();
      return;
    }
    if (action === 'copy') {
      const href = activeAnchor.href || activeAnchor.getAttribute('href') || '';
      if (!href) return;
      copyTextToClipboard(href).then((copied) => {
        showInlineToast(positionParent, copied ? 'Copied link to clipboard' : 'Could not copy link');
      }).catch(() => {
        showInlineToast(positionParent, 'Could not copy link');
      });
      return;
    }
    if (action === 'open') {
      const href = activeAnchor.href || activeAnchor.getAttribute('href') || '';
      if (!href) return;
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });

  return {
    openNewLinkEditor() {
      editableEl.focus();
      const sel = window.getSelection();
      let savedRange = null;
      if (sel && sel.rangeCount) {
        const candidate = sel.getRangeAt(0);
        if (editableEl.contains(candidate.commonAncestorContainer)) {
          savedRange = candidate.cloneRange();
        }
      }
      if (!savedRange) {
        savedRange = document.createRange();
        savedRange.selectNodeContents(editableEl);
        savedRange.collapse(false);
      }
      openLinkEditor({ sourceRange: savedRange });
    }
  };
}

function addViewOnlyLinkSupport(rootEl, options = {}) {
  if (!rootEl) return;
  const descEl = rootEl.querySelector('.location-card-full-desc, .location-card-desc-full, .spot-desc');
  if (!descEl || descEl.dataset.viewLinkBound === '1') return;
  descEl.dataset.viewLinkBound = '1';
  let controls = null;
  let activeAnchor = null;
  const onEditLink = typeof options.onEditLink === 'function' ? options.onEditLink : null;

  function closeControls() {
    if (controls) controls.remove();
    controls = null;
    activeAnchor = null;
  }

  function placeViewControls(anchor) {
    if (!controls || !anchor) return;
    const parentRect = rootEl.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const gap = 8;
    const minLeft = 6;
    const maxLeft = Math.max(minLeft, parentRect.width - controls.offsetWidth - 6);
    const left = Math.min(maxLeft, Math.max(minLeft, anchorRect.left - parentRect.left));
    const preferredTop = anchorRect.top - parentRect.top - controls.offsetHeight - gap;
    const fallbackTop = anchorRect.bottom - parentRect.top + gap;
    controls.style.left = `${left}px`;
    controls.style.top = `${preferredTop >= 0 ? preferredTop : fallbackTop}px`;
  }

  function openControls(anchor) {
    closeControls();
    activeAnchor = anchor;
    controls = document.createElement('div');
    controls.className = 'spot-link-controls';
    controls.innerHTML = getLinkActionButtonsHtml(!!onEditLink);
    rootEl.appendChild(controls);
    placeViewControls(anchor);
  }

  descEl.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (!anchor || !descEl.contains(anchor)) {
      closeControls();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    openControls(anchor);
  });

  rootEl.addEventListener('click', (e) => {
    if (!controls || !controls.contains(e.target)) return;
    const actionEl = e.target.closest('[data-action]');
    const action = actionEl ? actionEl.getAttribute('data-action') : null;
    if (!action || !activeAnchor) return;
    e.preventDefault();
    e.stopPropagation();
    const href = activeAnchor.href || activeAnchor.getAttribute('href') || '';
    if (action === 'edit' && onEditLink) {
      onEditLink();
      return;
    }
    if (action === 'copy') {
      if (!href) return;
      copyTextToClipboard(href).then((copied) => {
        showInlineToast(rootEl, copied ? 'Copied link to clipboard' : 'Could not copy link');
      }).catch(() => {
        showInlineToast(rootEl, 'Could not copy link');
      });
      return;
    }
    if (action === 'open') {
      if (!href) return;
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });

  if (!activeLinkControlsCloser) {
    activeLinkControlsCloser = (evt) => {
      const t = evt && evt.target;
      if (t && typeof t.closest === 'function') {
        if (t.closest('.spot-link-editor')) return;
        if (t.closest('.spot-link-controls')) return;
        if (t.closest('.spot-desc-toolbar')) return;
      }
      document.querySelectorAll('.spot-link-controls').forEach((el) => el.remove());
      document.querySelectorAll('.spot-link-editor').forEach((el) => el.remove());
    };
    document.addEventListener('click', activeLinkControlsCloser);
  };
}

// Toolbar: B, U, Link, Img. Img = upload to Supabase and insert into description. el = contenteditable
function addDescToolbar(el, spotImageInput, spotId) {
  const bar = document.createElement('div');
  bar.className = 'spot-desc-toolbar';
  bar.innerHTML = '<button type="button" class="spot-desc-tool-btn">B</button> <button type="button" class="spot-desc-tool-btn">U</button> <button type="button" class="spot-desc-tool-btn">Link</button> <button type="button" class="spot-desc-tool-btn">Img</button>';
  const linkSupport = addEditableLinkSupport(el);
  bar.querySelectorAll('button')[0].onclick = () => { el.focus(); document.execCommand('bold'); };
  bar.querySelectorAll('button')[1].onclick = () => { el.focus(); document.execCommand('underline'); };
  bar.querySelectorAll('button')[2].onclick = () => { if (linkSupport) linkSupport.openNewLinkEditor(); };
  bar.querySelectorAll('button')[3].onclick = () => {
    const imgInput = document.createElement('input');
    imgInput.type = 'file';
    imgInput.accept = 'image/*';
    imgInput.multiple = true;
    imgInput.style.display = 'none';
    document.body.appendChild(imgInput);
    imgInput.addEventListener('change', async () => {
      const files = imgInput.files;
      imgInput.remove();
      if (!files.length) return;
      const btn = bar.querySelectorAll('button')[3];
      btn.disabled = true;
      const loadingOverlay = btn.closest('.location-card, .spot-popup-view')?.querySelector('.spot-edit-loading-overlay');
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      try {
        for (const file of files) {
          const compressed = await Promise.race([
            compressImage(file, 512000),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Image compression timed out')), 60000))
          ]);
          const tempId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const ext = (file.name.split('.').pop()) || 'jpg';
          const safeName = `${spotId || tempId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
          const { error } = await Promise.race([
            supabase.storage.from('spot-images').upload(safeName, compressed, { upsert: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Upload timed out after 60s')), 60000))
          ]);
          if (error) { alert('Image upload failed: ' + (error.message || String(error))); continue; }
          const { data: { publicUrl } } = supabase.storage.from('spot-images').getPublicUrl(safeName);
          let attachContainer = el.parentNode.querySelector('.spot-edit-attachments');
          if (!attachContainer) {
            attachContainer = document.createElement('div');
            attachContainer.className = 'spot-edit-attachments';
            el.after(attachContainer);
          }
          setupAttachContainer(attachContainer);
          const attachRow = document.createElement('div');
          attachRow.className = 'spot-edit-attachment';
          attachRow.innerHTML = '<img class="spot-edit-attach-thumb" src="' + publicUrl + '"><span class="spot-edit-attach-name">' + escapeHtml(file.name) + '</span><button type="button" class="spot-edit-attach-remove">✕</button>';
          attachRow.dataset.path = safeName;
          attachRow.dataset.url = publicUrl;
          attachRow.querySelector('.spot-edit-attach-remove').onclick = e => {
            e.stopPropagation();
            const wrap = attachRow.closest('.location-card, .spot-popup-view');
            if (!wrap._removedImagePaths) wrap._removedImagePaths = [];
            if (attachRow.dataset.path) wrap._removedImagePaths.push(attachRow.dataset.path);
            attachRow.remove();
            if (attachContainer) {
              updateAttachCount(attachContainer);
              if (!attachContainer.querySelector('.spot-edit-attachment')) attachContainer.remove();
            }
          };
          const list = attachContainer.querySelector('.spot-edit-attachments-list');
          if (list) list.appendChild(attachRow);
          updateAttachCount(attachContainer);
        }
      } catch (err) {
        alert('Upload error: ' + (err.message || String(err)));
      } finally {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        btn.disabled = false;
      }
    });
    imgInput.click();
  };
  el.before(bar);
}

function closeDropdownAnimated(menu) {
  if (!menu || menu.style.display === 'none') return;
  if (menu.classList.contains('is-closing')) return;
  menu.classList.add('is-closing');
  menu.addEventListener('animationend', function onEnd() {
    menu.removeEventListener('animationend', onEnd);
    menu.style.display = 'none';
    menu.classList.remove('is-closing');
  });
}

function initEditDropdown(container) {
  container.querySelectorAll('.edit-dropdown-wrap').forEach(dw => {
    const trigger = dw.querySelector('.edit-dropdown-trigger');
    const menu = dw.querySelector('.edit-dropdown-menu');
    const select = dw.querySelector('select');
    if (!trigger || !menu || !select) return;

    trigger.textContent = select.options[select.selectedIndex].textContent;

    trigger.onclick = e => {
      e.stopPropagation();
      container.querySelectorAll('.edit-dropdown-menu').forEach(m => {
        if (m !== menu) closeDropdownAnimated(m);
      });
      if (menu.style.display === 'none' || menu.classList.contains('is-closing')) {
        menu.style.display = '';
        menu.classList.remove('is-closing');
      } else {
        closeDropdownAnimated(menu);
      }
    };

    menu.querySelectorAll('button').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        select.value = btn.dataset.value;
        trigger.textContent = btn.textContent;
        closeDropdownAnimated(menu);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
    });

    document.addEventListener('click', function closeDD(e) {
      if (!dw.contains(e.target)) closeDropdownAnimated(menu);
    });
  });
}

function showImageOverlay(url) {
  const el = document.getElementById('imageOverlay');
  el.querySelector('img').src = url;
  el.style.display = 'flex';
  el.onclick = () => { el.style.display = 'none'; el.onclick = null; };
}

function setupAttachContainer(container) {
  if (!container || container.dataset.attachSetup) return;
  container.dataset.attachSetup = '1';
  const existing = [...container.querySelectorAll(':scope > .spot-edit-attachment')];
  container.innerHTML = '';
  const summary = document.createElement('div');
  summary.className = 'spot-edit-attachments-summary';
  const countSpan = document.createElement('span');
  countSpan.className = 'spot-edit-attachments-count';
  summary.appendChild(countSpan);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'spot-edit-attachments-toggle';
  toggle.innerHTML = '&#9660;';
  toggle.onclick = () => {
    const list = container.querySelector('.spot-edit-attachments-list');
    const hide = list.classList.toggle('is-collapsed');
    toggle.innerHTML = hide ? '&#9660;' : '&#9650;';
  };
  summary.appendChild(toggle);
  container.appendChild(summary);
  const list = document.createElement('div');
  list.className = 'spot-edit-attachments-list is-collapsed';
  existing.forEach(r => list.appendChild(r));
  container.appendChild(list);
  updateAttachCount(container);
}

function updateAttachCount(container) {
  const countSpan = container.querySelector('.spot-edit-attachments-count');
  if (!countSpan) return;
  const total = container.querySelectorAll('.spot-edit-attachment').length;
  countSpan.textContent = total + ' attachment' + (total !== 1 ? 's' : '');
}

function formatCommentTime(value) {
  let ms = null;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  } else if (value && typeof value.toMillis === 'function') ms = value.toMillis();
  else if (value && typeof value.seconds === 'number') ms = value.seconds * 1000;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}


function createSpotPopup({ marker, spotId, name, desc, images = [], spotClass, minRole = 'visitor', comments = [], editMode, activePane = 'details', addedBy = null, createdAt = null }) {
  const wrap = document.createElement('div');
  wrap.className = 'location-card';

  if (!editMode) {
    const spotLatLng = marker && typeof marker.getLatLng === 'function' ? marker.getLatLng() : null;
    const googleMapsUrl = spotLatLng
      ? `https://www.google.com/maps/dir/?api=1&destination=${spotLatLng.lat},${spotLatLng.lng}`
      : '';
    const currentComments = Array.isArray(comments) ? comments : [];
    const commentsCount = currentComments.length;

    // Labels
    const statusLabels = { confirmed: 'Confirmed', risky: 'Risky', unsure: 'Unsure', default: 'No Class' };
    const statusLabel = statusLabels[spotClass] || 'No Class';
    const visibilityLabels = { visitor: 'Visitor+', member: 'Member+', editor: 'Editor+' };
    const visibilityLabel = visibilityLabels[minRole] || 'Visitor+';
    const coordsStr = spotLatLng ? `${spotLatLng.lat.toFixed(4)}, ${spotLatLng.lng.toFixed(4)}` : '';
    const subtitle = [coordsStr, statusLabel].filter(Boolean).join(' · ');
    const addedDateStr = createdAt ? formatCommentTime(createdAt) : '';
    const addedByStr = addedBy && addedBy.displayName ? escapeHtml(addedBy.displayName) : (currentUser && currentUser.displayName ? escapeHtml(currentUser.displayName) : '');

    // Description preview (sanitized HTML, no truncation)
    let descPreview = '';
    if (desc) {
      descPreview = desc
        .replace(/&nbsp;/gi, ' ')
        .replace(/<\/?(?:div|p|h[1-6]|li)[^>]*>/gi, '<br>')
        .replace(/<(?!\/?(?:b|i|u|em|strong|br|span)\b)[^>]*>/gi, '')
        .replace(/(<br>\s*){2,}/g, '<br>')
        .trim();
    }

    // Edit button for header
    const editBtnHtml = canEditSpots() ? `<button class="location-card-action-btn" data-action="edit" title="Edit spot" aria-label="Edit spot">
      <svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4zm14.7-11.3c.4-.4.4-1 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.6 1.6 4 4 1-1.2z"/></svg>
    </button>` : '';

    // Comments for expandable
    const commentsHtml = currentComments.length
      ? currentComments.map((comment, idx) => {
          const commentText = escapeHtml((comment && comment.text) || '');
          const displayName = (comment && (comment.authorDisplay || comment.author)) || 'User';
          const commentAuthor = escapeHtml(displayName);
          const commentInitial = (comment && comment.authorInitial) || displayName.charAt(0).toUpperCase() || 'U';
          const commentTime = formatCommentTime(comment && comment.createdAt);
          const timeStr = commentTime ? escapeHtml(commentTime) : '';
          const deleteButton = isAdminRole()
            ? `<button type="button" class="location-card-comment-delete" data-comment-index="${idx}" aria-label="Delete comment">✕</button>`
            : '';
          return `<div class="comment-item">
            <div class="comment-avatar">${escapeHtml(commentInitial)}</div>
            <div class="comment-body">
              <div class="comment-header">
                <span class="comment-author">${commentAuthor}</span>
                <span class="comment-time">${timeStr}</span>
                ${deleteButton}
              </div>
              <div class="comment-text">${commentText}</div>
            </div>
          </div>`;
        }).join('')
      : '<div class="comment-empty"><span class="comment-empty-icon">💬</span> No comments yet</div>';

    // Full card assembly
    wrap.innerHTML = `<div class="location-card-header">
      <div class="location-card-title-row">
        <div class="location-card-status-dot is-${spotClass}"></div>
        <div class="location-card-name-wrap">
          <h3 class="location-card-name">${escapeHtml(name)}</h3>
          <p class="location-card-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <div class="location-card-actions">
        <button class="location-card-action-btn location-card-more-btn" data-action="more" title="More options" aria-label="More options">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>
        </button>
        ${editBtnHtml}
      </div>
      ${descPreview ? `<p class="location-card-desc-preview">${descPreview}</p>` : ''}
      <div class="location-card-content">
        <div class="location-card-details-content" style="display:none">
          <div class="location-card-full-meta">
            <div class="location-card-meta-item">
              <span class="location-card-meta-label">STATUS</span>
              <span class="location-card-meta-value">${statusLabel}</span>
            </div>
            <div class="location-card-meta-item">
              <span class="location-card-meta-label">VISIBILITY</span>
              <span class="location-card-meta-value">${visibilityLabel}</span>
            </div>
            <div class="location-card-meta-item">
              <span class="location-card-meta-label">DATE ADDED</span>
              <span class="location-card-meta-value">${addedDateStr || '—'}</span>
            </div>
            <div class="location-card-meta-item">
              <span class="location-card-meta-label">ADDED BY</span>
              <span class="location-card-meta-value">${addedByStr || '—'}</span>
            </div>
          </div>
          <button type="button" class="location-card-collapse-btn" data-action="collapse">← Back</button>
        </div>
        <div class="location-card-comments-content" style="display:none">
          <h4 class="location-card-section-title">Comments</h4>
          <div class="location-card-comments-list">${commentsHtml}</div>
          <div class="location-card-comment-form">
            <textarea class="location-card-comment-input" rows="2" maxlength="300" placeholder="Add a comment..."></textarea>
            <button type="button" class="location-card-comment-btn">Post</button>
          </div>
          <p class="location-card-edit-status" style="display:none"></p>
          <button type="button" class="location-card-collapse-btn" data-action="collapse">← Back</button>
        </div>
        <div class="location-card-photos-content" style="display:none">
          <div class="location-card-photos-viewer">
            <div class="photos-nav-btn photos-prev" data-photos-action="prev">◀</div>
            <img class="photos-main-img" src="" alt="">
            <div class="photos-nav-btn photos-next" data-photos-action="next">▶</div>
          </div>
          <div class="photos-counter"></div>
          <button type="button" class="location-card-collapse-btn" data-action="collapse">← Back</button>
        </div>
      </div>
    </div>
    <div class="location-card-body">
      <div class="location-card-actions-bar">
        <div class="location-card-action-btn-inline" data-action="photos">
          <span class="action-icon">📷</span> Photos
        </div>
        <div class="location-card-action-btn-inline" data-action="comments">
          <span class="action-icon">💬</span> Comments <span class="location-card-comment-count">${commentsCount}</span>
        </div>
        <div class="location-card-action-btn-inline location-card-expand-trigger" data-action="expand">
          Details
        </div>
      </div>
    </div>`;

    // ── Edit button (top-right) ──
    const editBtn = wrap.querySelector('[data-action="edit"]');
    if (editBtn) {
      editBtn.onclick = e => {
        e.preventDefault(); e.stopPropagation();
        const editWrap = createSpotPopup({ marker, spotId, name, desc, images: marker._spotImages || [], spotClass, minRole: marker._spotMinRole || minRole, comments: currentComments, editMode: true, addedBy: marker._spotAddedBy, createdAt: marker._spotCreatedAt });
        marker.getPopup().setContent(editWrap);
        marker.getPopup().openPopup();
        marker.dragging.enable();
        marker.once('dragstart', () => marker.getPopup().closePopup());
      };
    }

    // ── More button (top-right "+" drawer, body-level) ──
    const moreBtn = wrap.querySelector('[data-action="more"]');
    // Create shared drawer once
    if (!document.querySelector('#global-more-drawer')) {
      const drawer = document.createElement('div');
      drawer.id = 'global-more-drawer';
      drawer.className = 'more-drawer';
      drawer.style.display = 'none';
      drawer.innerHTML = `
        <button type="button" class="more-drawer-item" data-action="directions">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11L11 5M7 5h4v4"/></svg>
          <span>Directions</span>
        </button>
        <button type="button" class="more-drawer-item" data-action="maps-pin">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1C5.2 1 3 3.2 3 6c0 3.5 5 9 5 9s5-5.5 5-9c0-2.8-2.2-5-5-5z"/><circle cx="8" cy="6" r="1.5"/></svg>
          <span>Open in Google Maps</span>
        </button>
      `;
      document.body.appendChild(drawer);

      drawer.querySelectorAll('.more-drawer-item').forEach(item => {
        item.addEventListener('click', e => {
          e.stopPropagation();
          const action = item.getAttribute('data-action');
          const ctx = drawer._ctx;
          if (action === 'directions' && ctx) {
            window.open(ctx.googleMapsUrl, '_blank', 'noopener,noreferrer');
          } else if (action === 'maps-pin' && ctx && ctx.spotLatLng) {
            window.open(`https://www.google.com/maps?q=${ctx.spotLatLng.lat},${ctx.spotLatLng.lng}`, '_blank', 'noopener,noreferrer');
          }
          closeMoreDrawer();
        });
      });

      document.addEventListener('click', e => {
        if (!drawer || drawer.style.display === 'none') return;
        if (!drawer.contains(e.target) && !e.target.closest('[data-action="more"]')) {
          closeMoreDrawer();
        }
      });
    }

    function closeMoreDrawer() {
      const d = document.getElementById('global-more-drawer');
      if (!d || d.style.display === 'none') return;
      d.classList.add('is-closing');
      d.addEventListener('animationend', function onEnd() {
        d.removeEventListener('animationend', onEnd);
        d.style.display = 'none';
        d.classList.remove('is-closing');
      });
    }

    if (moreBtn) {
      moreBtn.onclick = e => {
        e.stopPropagation();
        const d = document.getElementById('global-more-drawer');
        if (!d) return;
        if (d.style.display === 'none' || d.classList.contains('is-closing')) {
          const rect = e.currentTarget.getBoundingClientRect();
          d.style.left = rect.left + 'px';
          d.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
          d._ctx = { googleMapsUrl, spotLatLng };
          d.classList.remove('is-closing');
          d.style.display = '';
        } else {
          closeMoreDrawer();
        }
      };
    }

    // ── Content panel toggling ──
    const content = wrap.querySelector('.location-card-content');
    const descPreviewEl = wrap.querySelector('.location-card-desc-preview');
    const detailsContent = content ? content.querySelector('.location-card-details-content') : null;
    const commentsContent = content ? content.querySelector('.location-card-comments-content') : null;
    const photosContent = content ? content.querySelector('.location-card-photos-content') : null;
    const expandTrigger = wrap.querySelector('[data-action="expand"]');
    const collapseBtns = wrap.querySelectorAll('[data-action="collapse"]');

    function showDetails() {
      if (descPreviewEl) descPreviewEl.style.display = 'none';
      if (detailsContent) detailsContent.style.display = 'block';
      if (commentsContent) commentsContent.style.display = 'none';
      if (photosContent) photosContent.style.display = 'none';
      wrap.classList.add('is-expanded');
      if (marker && marker.getPopup) marker.getPopup().update();
    }

    function showComments() {
      if (descPreviewEl) descPreviewEl.style.display = 'none';
      if (detailsContent) detailsContent.style.display = 'none';
      if (commentsContent) commentsContent.style.display = 'block';
      if (photosContent) photosContent.style.display = 'none';
      wrap.classList.add('is-expanded');
      if (marker && marker.getPopup) marker.getPopup().update();
    }

    function showPhotos() {
      if (descPreviewEl) descPreviewEl.style.display = 'none';
      if (detailsContent) detailsContent.style.display = 'none';
      if (commentsContent) commentsContent.style.display = 'none';
      if (photosContent) {
        const allPhotos = (Array.isArray(images) ? images : []).filter(Boolean);
        const imgEl = photosContent.querySelector('.photos-main-img');
        const counterEl = photosContent.querySelector('.photos-counter');
        const prevBtn = photosContent.querySelector('.photos-prev');
        const nextBtn = photosContent.querySelector('.photos-next');
        let idx = parseInt(photosContent.dataset.photoIndex || '0', 10);
        if (idx >= allPhotos.length) idx = 0;
        if (idx < 0) idx = 0;
        if (!allPhotos.length) {
          const viewerEl = photosContent.querySelector('.location-card-photos-viewer');
          if (viewerEl) viewerEl.style.minHeight = '0';
          imgEl.style.display = 'none';
          counterEl.textContent = 'No Images Attached';
          counterEl.style.color = '#ff4444';
          prevBtn.style.display = 'none';
          nextBtn.style.display = 'none';
        } else {
          imgEl.style.display = '';
          counterEl.style.color = 'var(--text-muted)';
          imgEl.src = allPhotos[idx];
          counterEl.textContent = `${idx + 1} / ${allPhotos.length}`;
          prevBtn.style.display = idx > 0 ? '' : 'none';
          nextBtn.style.display = idx < allPhotos.length - 1 ? '' : 'none';
        }
          photosContent.dataset.photos = JSON.stringify(allPhotos);
        photosContent.style.display = 'block';
        photosContent.dataset.photoIndex = idx;
      }
      wrap.classList.add('is-expanded');
      if (marker && marker.getPopup) marker.getPopup().update();
    }

    function doCollapse() {
      if (descPreviewEl) descPreviewEl.style.display = '';
      if (detailsContent) detailsContent.style.display = 'none';
      if (commentsContent) commentsContent.style.display = 'none';
      if (photosContent) photosContent.style.display = 'none';
      wrap.classList.remove('is-expanded');
      if (marker && marker.getPopup) marker.getPopup().update();
    }

    if (expandTrigger) expandTrigger.onclick = e => { e.stopPropagation(); showDetails(); };
    collapseBtns.forEach(btn => btn.onclick = e => { e.stopPropagation(); doCollapse(); });

    // ── Photos prev/next navigation ──
    if (photosContent) {
      photosContent.addEventListener('click', e => {
        const actionEl = e.target.closest('[data-photos-action]');
        if (!actionEl) return;
        e.stopPropagation();
        const allPhotos = JSON.parse(photosContent.dataset.photos || '[]');
        if (!allPhotos.length) return;
        let idx = parseInt(photosContent.dataset.photoIndex || '0', 10);
        const imgEl = photosContent.querySelector('.photos-main-img');
        const counterEl = photosContent.querySelector('.photos-counter');
        const prevBtn = photosContent.querySelector('.photos-prev');
        const nextBtn = photosContent.querySelector('.photos-next');
        if (actionEl.dataset.photosAction === 'prev' && idx > 0) idx--;
        if (actionEl.dataset.photosAction === 'next' && idx < allPhotos.length - 1) idx++;
        imgEl.src = allPhotos[idx];
        counterEl.textContent = `${idx + 1} / ${allPhotos.length}`;
        prevBtn.style.display = idx > 0 ? '' : 'none';
        nextBtn.style.display = idx < allPhotos.length - 1 ? '' : 'none';
        photosContent.dataset.photoIndex = idx;
        if (marker && marker.getPopup) marker.getPopup().update();
      });
      // Fullscreen on image click
      photosContent.querySelector('.photos-main-img').onclick = e => {
        e.stopPropagation();
        if (photosContent.querySelector('.photos-main-img').src) {
          showImageOverlay(photosContent.querySelector('.photos-main-img').src);
        }
      };
    }

    // ── Comments button opens comments panel ──
    const commentsTrigger = wrap.querySelector('.location-card-actions-bar [data-action="comments"]');
    const photosTrigger2 = wrap.querySelector('.location-card-actions-bar [data-action="photos"]');
    if (commentsTrigger) {
      commentsTrigger.onclick = e => {
        e.stopPropagation();
        showComments();
      };
    }

    // ── Photos button opens photos panel ──
    const photosTrigger = wrap.querySelector('.location-card-actions-bar [data-action="photos"]');
    if (photosTrigger) {
      photosTrigger.onclick = e => {
        e.stopPropagation();
        showPhotos();
      };
    }

    // ── Auto-expand to activePane if 'comments' ──
    if (activePane === 'comments') {
      requestAnimationFrame(() => showComments());
    }

    // ── Link controls on description anchors ──
    addViewOnlyLinkSupport(wrap, {
      onEditLink: canEditSpots() ? () => {
        const editWrap = createSpotPopup({ marker, spotId, name, desc, images: marker._spotImages || [], spotClass, minRole: marker._spotMinRole || minRole, comments: currentComments, editMode: true, addedBy: marker._spotAddedBy, createdAt: marker._spotCreatedAt });
        marker.getPopup().setContent(editWrap);
        marker.getPopup().openPopup();
        marker.dragging.enable();
        marker.once('dragstart', () => marker.getPopup().closePopup());
      } : null
    });

    // ── Comment posting ──
    const commentInput = wrap.querySelector('.location-card-comment-input');
    const commentBtn = wrap.querySelector('.location-card-comment-btn');
    const commentStatus = wrap.querySelector('.location-card-edit-status');
    if (commentBtn && commentInput) {
      commentBtn.onclick = async () => {
        if (isVisitorRole()) {
          if (commentStatus) { commentStatus.textContent = 'You must be signed in to comment.'; commentStatus.style.color = '#b00020'; commentStatus.style.display = 'block'; }
          return;
        }
        const text = commentInput.value.trim();
        if (!text) {
          if (commentStatus) { commentStatus.textContent = 'Write a comment first.'; commentStatus.style.color = '#b00020'; commentStatus.style.display = 'block'; }
          return;
        }
        if (!isAdminRole() && currentComments.filter(c => c.authorUid === currentUser.uid).length >= 3) {
          if (commentStatus) { commentStatus.textContent = 'You have reached the maximum of 3 comments on this spot.'; commentStatus.style.color = '#b00020'; commentStatus.style.display = 'block'; }
          return;
        }
        const userDisplay = currentUser ? getUserDisplayLabel(currentUser) : (userRole || 'User');
        const newComment = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          author: userDisplay,
          authorDisplay: userDisplay,
          authorInitial: userDisplay.charAt(0).toUpperCase() || 'U',
          authorUid: currentUser ? currentUser.uid : '',
          createdAt: Date.now()
        };
        const nextComments = [...currentComments, newComment];
        commentBtn.disabled = true;
        if (commentStatus) { commentStatus.textContent = 'Saving...'; commentStatus.style.color = '#333'; commentStatus.style.display = 'block'; }
        try {
          await updateDoc(doc(db, SPOTS_COLLECTION, spotId), {
            comments: nextComments,
            updatedAt: serverTimestamp()
          });
          marker._spotComments = nextComments;
          clearSpotsCache();
          marker.getPopup().setContent(createSpotPopup({
            marker, spotId, name, desc,
            images: marker._spotImages || [], spotClass,
            minRole: marker._spotMinRole || minRole,
            comments: marker._spotComments,
            editMode: false, activePane: 'comments',
            addedBy: marker._spotAddedBy,
            createdAt: marker._spotCreatedAt
          }));
          marker.getPopup().openPopup();
        } catch (err) {
          if (commentStatus) { commentStatus.textContent = 'Error: ' + (err.code || err.message || String(err)); commentStatus.style.color = '#b00020'; commentStatus.style.display = 'block'; }
        } finally {
          commentBtn.disabled = false;
        }
      };
    }

    // ── Admin comment deletion ──
    if (isAdminRole()) {
      wrap.querySelectorAll('.location-card-comment-delete').forEach(btn => {
        btn.onclick = async () => {
          const index = Number(btn.getAttribute('data-comment-index'));
          if (!Number.isInteger(index) || index < 0 || index >= currentComments.length) return;
          const deletedComment = currentComments[index];
          const nextComments = currentComments.filter((_, i) => i !== index);
          btn.disabled = true;
          try {
            await updateDoc(doc(db, SPOTS_COLLECTION, spotId), {
              comments: nextComments,
              updatedAt: serverTimestamp()
            });
            marker._spotComments = nextComments;
            clearSpotsCache();
            marker.getPopup().setContent(createSpotPopup({
              marker, spotId, name, desc,
              images: marker._spotImages || [], spotClass,
              minRole: marker._spotMinRole || minRole,
              comments: marker._spotComments,
              editMode: false, activePane: 'comments',
              addedBy: marker._spotAddedBy,
              createdAt: marker._spotCreatedAt
            }));
            marker.getPopup().openPopup();
            if (deletedComment && deletedComment.authorUid && deletedComment.authorUid !== (currentUser ? currentUser.uid : '')) {
              notifyCommentDeleted(db, deletedComment.authorUid, name, currentUser ? currentUser.uid : '').catch(() => {});
            }
          } catch (err) {
            const status = wrap.querySelector('.location-card-edit-status');
            if (status) { status.textContent = 'Failed to delete comment: ' + (err.code || err.message || String(err)); status.style.color = '#b00020'; status.style.display = 'block'; }
          } finally {
            btn.disabled = false;
          }
        };
      });
    }

    // ── Extra action buttons ──
    const dirBtn = wrap.querySelector('[data-action="directions"]');
    if (dirBtn) dirBtn.onclick = e => { e.stopPropagation(); window.open(googleMapsUrl, '_blank', 'noopener,noreferrer'); };

    const editFullBtn = wrap.querySelector('[data-action="edit-full"]');
    if (editFullBtn) {
      editFullBtn.onclick = e => {
        e.stopPropagation();
        const editWrap = createSpotPopup({ marker, spotId, name, desc, images: marker._spotImages || [], spotClass, minRole: marker._spotMinRole || minRole, comments: currentComments, editMode: true, addedBy: marker._spotAddedBy, createdAt: marker._spotCreatedAt });
        marker.getPopup().setContent(editWrap);
        marker.getPopup().openPopup();
        marker.dragging.enable();
        marker.once('dragstart', () => marker.getPopup().closePopup());
      };
    }

  } else {
    // ═══════ EDIT MODE ═══════
    wrap.classList.add('is-editing');
    wrap.innerHTML = `<div class="location-card-body">
      <div class="edit-section-main">
        <div class="spot-edit-attachments"></div>
        <div class="edit-nav-btn-row">
          <button type="button" class="edit-nav-btn" data-section="info">Info</button>
          <button type="button" class="edit-nav-btn" data-section="desc">Desc</button>
        </div>
        <div class="location-card-edit-actions">
          <button type="button" class="location-card-edit-save">Save</button>
          ${isAdminRole() ? '<button type="button" class="location-card-edit-delete">Delete</button>' : ''}
        </div>
        <p class="location-card-edit-status"></p>
      </div>
      <div class="edit-section-info">
        <input class="location-card-edit-name" value="${escapeHtml(name)}" type="text">
        <div class="edit-dropdown-wrap">
          <button type="button" class="edit-dropdown-trigger" data-type="class">No Class</button>
          <div class="edit-dropdown-menu" style="display:none">
            <button type="button" data-value="default">No Class</button>
            <button type="button" data-value="confirmed">✅ Confirmed</button>
            <button type="button" data-value="risky">🔴 Risky</button>
            <button type="button" data-value="unsure">🟡 Unsure</button>
          </div>
          <select class="location-card-edit-class" style="display:none">
            <option value="default">No Class</option>
            <option value="confirmed">Confirmed</option>
            <option value="risky">Risky</option>
            <option value="unsure">Unsure</option>
          </select>
        </div>
        <div class="edit-dropdown-wrap">
          <button type="button" class="edit-dropdown-trigger" data-type="visibility">Visitor+</button>
          <div class="edit-dropdown-menu" style="display:none">
            <button type="button" data-value="visitor">Visitor+</button>
            <button type="button" data-value="member">Member+</button>
            <button type="button" data-value="editor">Editor+</button>
          </div>
          <select class="location-card-edit-min-role" style="display:none">
            <option value="visitor">Visitor+</option>
            <option value="member">Member+</option>
            <option value="editor">Editor+</option>
          </select>
        </div>
        <button type="button" class="edit-back-btn">← Back</button>
      </div>
      <div class="edit-section-desc">
        <div class="edit-section-title">Description</div>
        <div class="location-card-edit-desc" contenteditable>${desc || ''}</div>
        <button type="button" class="edit-back-btn">← Back</button>
      </div>
      <input type="file" class="spot-edit-image" accept="image/*" multiple style="display:none">
    </div>
    <div class="spot-edit-loading-overlay" style="display:none"><div class="spot-edit-loading-spinner"></div></div>`;

    // Set current values
    const classSel = wrap.querySelector('.location-card-edit-class');
    classSel.value = normalizeSpotClass(spotClass || marker._spotClass);
    const minRoleSel = wrap.querySelector('.location-card-edit-min-role');
    minRoleSel.value = normalizeVisibilityRole(minRole || marker._spotMinRole || 'visitor');
    initEditDropdown(wrap);
    const descEl = wrap.querySelector('.location-card-edit-desc');
    addDescToolbar(descEl, wrap.querySelector('.spot-edit-image'), spotId);

    // ── Mobile tab switching ──
    wrap.classList.add('edit-main-visible');
    wrap.querySelectorAll('.edit-nav-btn').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        wrap.classList.remove('edit-main-visible', 'edit-info-visible', 'edit-desc-visible');
        wrap.classList.add('edit-' + btn.dataset.section + '-visible');
        if (marker && marker.getPopup) marker.getPopup().update();
      };
    });
    wrap.querySelectorAll('.edit-back-btn').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        wrap.classList.remove('edit-main-visible', 'edit-info-visible', 'edit-desc-visible');
        wrap.classList.add('edit-main-visible');
        if (marker && marker.getPopup) marker.getPopup().update();
      };
    });

    // Attachment list from existing images
    const attachContainer = wrap.querySelector('.spot-edit-attachments');
    const existingUrls = Array.isArray(images) ? images.filter(Boolean) : [];
    if (desc) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = desc;
      tempDiv.querySelectorAll('img').forEach(img => { if (img.src) existingUrls.push(img.src); });
    }
    const seen = new Set();
    existingUrls.forEach(url => {
      if (seen.has(url)) return;
      seen.add(url);
      const pathMatch = url.match(/\/spot-images\/([^?#]+)/);
      const path = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
      const fileName = url.split('/').pop() || 'image';
      const row = document.createElement('div');
      row.className = 'spot-edit-attachment';
      row.innerHTML = '<img class="spot-edit-attach-thumb" src="' + url + '"><span class="spot-edit-attach-name">' + escapeHtml(fileName) + '</span><button type="button" class="spot-edit-attach-remove">✕</button>';
      row.dataset.url = url;
      if (path) row.dataset.path = path;
      row.querySelector('.spot-edit-attach-remove').onclick = e => {
        e.stopPropagation();
        if (!wrap._removedImagePaths) wrap._removedImagePaths = [];
        if (row.dataset.path) wrap._removedImagePaths.push(row.dataset.path);
        row.remove();
        if (attachContainer) {
          updateAttachCount(attachContainer);
          if (!attachContainer.querySelector('.spot-edit-attachment')) attachContainer.remove();
        }
      };
      attachContainer.appendChild(row);
    });
    setupAttachContainer(attachContainer);

    // Save
    wrap.querySelector('.location-card-edit-save').onclick = async () => {
      const newName = (wrap.querySelector('.location-card-edit-name').value.trim()) || 'Unnamed spot';
      const newClass = normalizeSpotClass(classSel.value);
      const newMinRole = normalizeVisibilityRole(minRoleSel.value);
      const fileInput = wrap.querySelector('.spot-edit-image');
      const loadingOverlay = wrap.querySelector('.spot-edit-loading-overlay');
      try {
        loadingOverlay.style.display = 'flex';
        void loadingOverlay.offsetHeight;
        const newUploadedUrls = [];
        if (fileInput.files.length) {
          for (const file of fileInput.files) {
            const result = await uploadSpotImage(spotId, file);
            newUploadedUrls.push(result.publicUrl);
          }
        }
        const attachRows = wrap.querySelectorAll('.spot-edit-attachment');
        const remainingUrls = [];
        attachRows.forEach(row => { const u = row.dataset.url; if (u) remainingUrls.push(u); });
        const finalImages = [...remainingUrls, ...newUploadedUrls].filter(Boolean);
        let finalDesc = descEl.innerHTML.replace(/<img[^>]*>/gi, '').replace(/<p>\s*<\/p>/gi, '');
        await updateDoc(doc(db, SPOTS_COLLECTION, spotId), { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng, name: newName, description: finalDesc, images: finalImages, spotClass: newClass, minRole: newMinRole, updatedAt: serverTimestamp() });
        if (wrap._removedImagePaths && wrap._removedImagePaths.length) {
          await Promise.allSettled(wrap._removedImagePaths.map(p => supabase.storage.from('spot-images').remove([p])));
        }
        marker.dragging.disable();
        marker._spotClass = newClass;
        marker._spotName = newName;
        marker._spotDesc = finalDesc;
        marker._spotImages = finalImages;
        marker._spotMinRole = newMinRole;
        marker.setIcon(getSpotIcon(newClass));
        reapplyMarkerScale(marker);
        clearSpotsCache();
        upsertSpotSearchEntry(spotId, newName, marker);
        marker.getPopup().setContent(createSpotPopup({ marker, spotId, name: newName, desc: finalDesc, images: finalImages, spotClass: newClass, minRole: newMinRole, comments: marker._spotComments || [], editMode: false, addedBy: marker._spotAddedBy, createdAt: marker._spotCreatedAt }));
        const pop = marker.getPopup();
        const w = pop._wrapper;
        if (w) w.classList.remove('is-editing');
        pop.update();
        loadingOverlay.style.display = 'none';
      } catch (err) {
        loadingOverlay.style.display = 'none';
        const status = wrap.querySelector('.location-card-edit-status');
        if (status) { status.textContent = 'Error: ' + (err.code || err.message || String(err)); status.style.color = 'red'; }
      }
    };

    // Delete
    const deleteBtn = wrap.querySelector('.location-card-edit-delete');
    if (deleteBtn) deleteBtn.onclick = async () => {
      if (!confirm('Are you sure you want to delete this spot?')) return;
      try {
        const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        await deleteDoc(doc(db, SPOTS_COLLECTION, spotId));
        clearSpotsCache();
        removeSpotSearchEntry(spotId);
        if (spotClusterGroup && spotClusterGroup.hasLayer(marker)) {
          spotClusterGroup.removeLayer(marker);
        } else {
          map.removeLayer(marker);
        }
      } catch (err) {
        alert('Failed to delete spot: ' + (err.code || err.message || String(err)));
      }
    };
  }
  return wrap;
}

async function backfillSpotAddedBy() {
  if (localStorage.getItem('cua_addedByBackfilled') === '1') return;
  if (!currentUser || !currentUser.uid) return;
  try {
    const snap = await getDocs(collection(db, SPOTS_COLLECTION));
    const batch = writeBatch(db);
    let count = 0;
    snap.forEach(d => {
      if (!d.data().addedBy) {
        batch.update(doc(db, SPOTS_COLLECTION, d.id), {
          addedBy: {
            uid: currentUser.uid,
            displayName: currentUser.displayName || getUserDisplayLabel(currentUser),
            role: userRole || 'visitor'
          }
        });
        count++;
      }
    });
    if (count > 0) {
      await batch.commit();
      console.log('Backfilled addedBy for ' + count + ' spot(s)');
    }
    localStorage.setItem('cua_addedByBackfilled', '1');
  } catch (err) {
    console.warn('Failed to backfill addedBy:', err);
  }
}

wireAccountMenu();
function wireMobileMenu() {
  const toggle = document.querySelector('.mobile-menu-button');
  const header = document.querySelector('header');
  if (!toggle || !header) return;

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = header.classList.toggle('mobile-menu-open');
    toggle.classList.toggle('is-active', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const drawerClose = document.querySelector('.drawer-close-button');
  if (drawerClose) {
    drawerClose.addEventListener('click', (event) => {
      event.stopPropagation();
      header.classList.remove('mobile-menu-open');
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', (event) => {
    if (header.classList.contains('mobile-menu-open') && !header.contains(event.target)) {
      header.classList.remove('mobile-menu-open');
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

wireMobileMenu();
initAuthGate();

