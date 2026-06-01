// --- Firebase (Firestore for storing spots) ---
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { 
  getFirestore, collection, addDoc, getDocs, serverTimestamp, doc, updateDoc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
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
  if (spotClusterGroup && typeof spotClusterGroup.zoomToShowLayer === 'function') {
    map.flyTo([latLng.lat, latLng.lng], Math.max(map.getZoom(), 14), { duration: 0.7 });
    spotClusterGroup.zoomToShowLayer(match.marker, () => {
      match.marker.openPopup();
    });
    return;
  }

  map.flyTo([latLng.lat, latLng.lng], Math.max(map.getZoom(), 16), { duration: 0.7 });
  setTimeout(() => match.marker.openPopup(), 450);
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

      const parsed = parseCoordinateQuery(query);
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
  m._spotImageUrl = d.imageUrl || '';
  m._spotImages = d.images || [];
  m._spotMinRole = minRole;
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
      imageUrl: m._spotImageUrl || '',
      images: m._spotImages || [],
      spotClass: m._spotClass || 'default',
      minRole: m._spotMinRole || 'visitor',
      comments: m._spotComments || [],
      editMode: false
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

async function ensureUserRoleDoc(user) {
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
    return 'member';
  }
  const data = snap.data() || {};
  await setDoc(ref, {
    email: user.email || data.email || '',
    displayName: user.displayName || data.displayName || '',
    updatedAt: serverTimestamp()
  }, { merge: true });
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
      if (signInBtn) signInBtn.style.display = 'inline-flex';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) runMapApp();
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
      sessionStorage.setItem('userRole', normalizeRole(userRole));
      setSignedInUserUi(user, userRole);
      updateAccountMenuUi(user, userRole);
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) runMapApp();
      else {
        clearRenderedSpots();
        loadSpots();
        refreshAddSpotControl();
      }
    } catch (error) {
      userRole = 'visitor';
      setSignedInUserUi(user, userRole);
      updateAccountMenuUi(user, userRole);
      setAuthStatus('Could not load your role. Defaulting to visitor.', true);
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) runMapApp();
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
    const THROTTLE_MS = 2000;

    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => {
      if (!navigator.geolocation) {
        btn.classList.add('locate-btn--error');
        setTimeout(() => btn.classList.remove('locate-btn--error'), 1000);
        return;
      }

      if (watching) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        watching = false;
        hasZoomed = false;
        if (locationMarker) { locationMarker.remove(); locationMarker = null; }
        if (locationCircle) { locationCircle.remove(); locationCircle = null; }
        return;
      }

      watching = true;

      function flashGreen() {
        btn.classList.add('locate-btn--tracking');
        setTimeout(() => btn.classList.remove('locate-btn--tracking'), 1000);
      }

      function updateLocation(pos) {
        const now = Date.now();
        if (now - lastUpdateTime < THROTTLE_MS) return;
        lastUpdateTime = now;

        const { latitude: lat, longitude: lng, accuracy } = pos.coords;

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
    btn.onclick = () => { addMode = true; alert('Click on the map to add a spot'); };
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

bottomToolsBubble.appendChild(bubbleFilterBtn);
bottomToolsBubble.appendChild(bubbleExportBtn);

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

const exportPopover = document.createElement('div');
exportPopover.className = 'ctrl-popover bottom-export-popover';
exportPopover.style.display = 'none';
exportPopover.innerHTML =
  '<div class="ctrl-popover-header">Export Data</div>' +
  '<label class="export-row" data-key="profile"><span>Profile data</span><input type="checkbox" checked></label>' +
  '<label class="export-row" data-key="spotName"><span>Spot names</span><input type="checkbox" checked></label>' +
  '<label class="export-row" data-key="spotCoords"><span>Spot coordinates</span><input type="checkbox" checked></label>' +
  '<label class="export-row" data-key="spotDesc"><span>Spot descriptions</span><input type="checkbox" checked></label>' +
  '<div class="export-actions"><button class="ctrl-popover-action export-toggle">Select All</button><div class="export-download-wrap"><button class="ctrl-popover-action export-download">Download</button></div></div>';

bottomToolsWrap.appendChild(bottomToolsGroup);
bottomToolsWrap.appendChild(filterPopover);
bottomToolsWrap.appendChild(exportPopover);
document.body.appendChild(bottomToolsWrap);

let bottomToolsOpen = false;
let bottomToolsClosing = false;
let filterPopoverOpen = false;
let exportPopoverOpen = false;

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
  const checks = exportPopover.querySelectorAll('.export-row input[type="checkbox"]');
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
    if (exportPopoverOpen) { hidePopover(exportPopover); exportPopoverOpen = false; }
  }
}

function closeBottomTools() {
  if (bottomToolsClosing) return;
  bottomToolsOpen = false;
  animateCloseBubble();
  if (filterPopoverOpen) { hidePopover(filterPopover); filterPopoverOpen = false; }
  if (exportPopoverOpen) { hidePopover(exportPopover); exportPopoverOpen = false; }
}

// Wire filter popover
filterPopover.querySelectorAll('.filter-row input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', applyFilters);
});
filterPopover.querySelector('.filter-show-all').addEventListener('click', () => {
  filterPopover.querySelectorAll('.filter-row input[type="checkbox"]').forEach(cb => { cb.checked = true; });
  applyFilters();
});

// Wire export popover
const exportToggleBtn = exportPopover.querySelector('.export-toggle');
exportToggleBtn.addEventListener('click', () => {
  const checks = exportPopover.querySelectorAll('.export-row input[type="checkbox"]');
  const allChecked = Array.from(checks).every(cb => cb.checked);
  checks.forEach(cb => { cb.checked = !allChecked; });
  exportToggleBtn.textContent = allChecked ? 'Select All' : 'Deselect';
});
// Dropup for download format
const exportDownloadWrap = exportPopover.querySelector('.export-download-wrap');
const exportDownloadBtn = exportDownloadWrap.querySelector('.export-download');
const exportFormatDropup = document.createElement('div');
exportFormatDropup.className = 'export-format-dropup';
exportFormatDropup.style.display = 'none';
exportFormatDropup.innerHTML =
  '<button class="export-format-option" data-format="json">Export as JSON (.json)</button>' +
  '<button class="export-format-option" data-format="txt">Export as TXT (.txt)</button>';
exportDownloadWrap.appendChild(exportFormatDropup);

exportDownloadBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = exportFormatDropup.style.display !== 'none';
  exportFormatDropup.style.display = isOpen ? 'none' : '';
});

exportFormatDropup.querySelectorAll('.export-format-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    e.stopPropagation();
    const format = opt.getAttribute('data-format');
    exportFormatDropup.style.display = 'none';
    exportData(format);
  });
});

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
  if (exportPopoverOpen) { hidePopover(exportPopover); exportPopoverOpen = false; }
  filterPopoverOpen = !filterPopoverOpen;
  if (filterPopoverOpen) {
    positionPopoverAbove(filterPopover, bubbleFilterBtn);
    showPopover(filterPopover);
  } else {
    hidePopover(filterPopover);
  }
});

bubbleExportBtn.addEventListener('click', () => {
  if (filterPopoverOpen) { hidePopover(filterPopover); filterPopoverOpen = false; }
  exportPopoverOpen = !exportPopoverOpen;
  if (exportPopoverOpen) {
    positionPopoverAbove(exportPopover, bubbleExportBtn);
    showPopover(exportPopover);
    const checks = exportPopover.querySelectorAll('.export-row input[type="checkbox"]');
    const allChecked = Array.from(checks).every(cb => cb.checked);
    exportToggleBtn.textContent = allChecked ? 'Deselect' : 'Select All';
  } else {
    hidePopover(exportPopover);
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
  '<label class="layer-row" data-layer="hybrid"><span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8.5l6.5 4 6.5-4M1.5 5.5l6.5 4 6.5-4M8 1.5L14.5 5.5 8 9.5 1.5 5.5z"/></svg></span><span>Hybrid</span><span class="layer-radio"></span></label>';

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
document.addEventListener('click', (e) => {
  if (layersPopoverOpen && !layersPopover.contains(e.target) && e.target !== layersBtn && !layersBtn.contains(e.target)) {
    layersPopoverOpen = false;
    layersPopover.style.display = 'none';
  }
});

function runMapApp() {
  if (!window.L) throw new Error('Leaflet failed to load. Check internet or blocked unpkg.com');

  // Create the map
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView([53.5444, -113.4909], 12);

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

    // Settings gear
    if (window.__settingsBtn) {
      const sBtn = window.__settingsBtn;
      if (sBtn.parentNode) sBtn.parentNode.removeChild(sBtn);
      panel.appendChild(sBtn);
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
    if (!canEditSpots() || !addMode) return;
    const newMarker = L.marker(e.latlng, { draggable: true, icon: getSpotIcon('default') }).addTo(spotClusterGroup || map);
    newMarker._spotClass = 'default';
    newMarker._spotComments = [];
    const wrap = document.createElement('div');
    wrap.className = 'spot-popup-view spot-create-form';
    wrap.innerHTML = `<div class="spot-popup-body is-editing">
      <div class="spot-create-title">New Spot</div>
      <select id="spotClass" class="spot-edit-class spot-create-class">
        <option value="default">No Class</option>
        <option value="confirmed">&#9989; Confirmed</option>
        <option value="risky">&#128308; Risky</option>
        <option value="unsure">&#128993; Unsure</option>
      </select>
      <select id="spotMinRole" class="spot-edit-class spot-create-class">
        <option value="visitor">Visitor+</option>
        <option value="member">Member+</option>
        <option value="editor">Editor+</option>
      </select>
      <input type="text" id="spotName" class="spot-edit-name spot-create-name" placeholder="Name">
      <input type="file" id="spotImage" accept="image/*" multiple style="display:none">
      <div id="spotDesc" class="spot-edit-desc spot-create-desc" contenteditable></div>
      <button type="button" id="saveSpotBtn" class="save-edit-spot-btn spot-create-save-btn">Save to cloud</button>
      <p id="saveStatus" class="edit-status spot-create-status"></p>
    </div>
    <div class="spot-edit-loading-overlay" style="display:none"><div class="spot-edit-loading-spinner"></div></div>`;
    addDescToolbar(wrap.querySelector('#spotDesc'), wrap.querySelector('#spotImage'));
    newMarker.bindPopup(wrap, { minWidth: 240 }).openPopup();
    wrap.querySelector('#spotClass').onchange = function() {
      const selectedClass = normalizeSpotClass(this.value);
      newMarker._spotClass = selectedClass;
      newMarker.setIcon(getSpotIcon(selectedClass));
      reapplyMarkerScale(newMarker);
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
        const ref = await addDoc(collection(db, SPOTS_COLLECTION), { lat: pos.lat, lng: pos.lng, name, description: desc, spotClass, minRole, images: [], comments: [], createdAt: serverTimestamp() });
        const imageUrls = [];
        for (const file of fileInput.files) {
          const result = await uploadSpotImage(ref.id, file);
          imageUrls.push(result.publicUrl);
        }
        const imageUrl = imageUrls[0] || '';
        const images = imageUrls.slice(1);
        if (imageUrl) {
          await updateDoc(doc(db, SPOTS_COLLECTION, ref.id), { imageUrl, images });
        }
        newMarker._spotId = ref.id;
        newMarker._spotClass = spotClass;
        newMarker._spotComments = [];
        newMarker._spotName = name;
        newMarker._spotDesc = desc;
        newMarker._spotImageUrl = imageUrl;
        newMarker._spotImages = images;
        newMarker._spotMinRole = minRole;
        newMarker.dragging.disable();
        newMarker.setIcon(getSpotIcon(spotClass));
        reapplyMarkerScale(newMarker);
        newMarker.getPopup().setContent(createSpotPopup({ marker: newMarker, spotId: ref.id, name, desc, imageUrl, images, spotClass, minRole, comments: newMarker._spotComments, editMode: false }));
        clearSpotsCache();
        upsertSpotSearchEntry(ref.id, name, newMarker);
        wrap.querySelector('#saveStatus').textContent = 'Saved!';
        wrap.querySelector('#saveStatus').style.color = '#8ec5ff';
      } catch (err) {
        loadingOverlay.style.display = 'none';
        wrap.querySelector('#saveStatus').textContent = 'Error: ' + (err.code || err.message || String(err));
        wrap.querySelector('#saveStatus').style.color = '#ffb6c3';
      }
    };
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
    const parentRect = editableEl.parentNode.getBoundingClientRect();
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
    editableEl.parentNode.appendChild(editor);

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
    editableEl.parentNode.appendChild(controls);
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

  editableEl.parentNode.addEventListener('click', (e) => {
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
        showInlineToast(editableEl.parentNode, copied ? 'Copied link to clipboard' : 'Could not copy link');
      }).catch(() => {
        showInlineToast(editableEl.parentNode, 'Could not copy link');
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
  const descEl = rootEl.querySelector('.spot-desc');
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
      const loadingOverlay = btn.closest('.spot-popup-view')?.querySelector('.spot-edit-loading-overlay');
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
            const wrap = attachRow.closest('.spot-popup-view');
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
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}


function createSpotPopup({ marker, spotId, name, desc, imageUrl, images = [], spotClass, minRole = 'visitor', comments = [], editMode, activePane = 'details' }) {
  const wrap = document.createElement('div');
  wrap.className = 'spot-popup-view';
  if (!editMode) {
    const spotLatLng = marker && typeof marker.getLatLng === 'function' ? marker.getLatLng() : null;
    const googleMapsUrl = spotLatLng
      ? `https://www.google.com/maps?q=${encodeURIComponent(`${spotLatLng.lat},${spotLatLng.lng}`)}`
      : '';
    const mapsLinkHtml = googleMapsUrl
      ? `<a class="spot-maps-link" href="${googleMapsUrl}" target="_blank" rel="noopener noreferrer">View on Google Maps</a>`
      : '';
    const currentComments = Array.isArray(comments) ? comments : [];
    const editButtonHtml = canEditSpots() ? '<button type="button" class="edit-spot-btn">Edit</button>' : '';
    const commentsCount = currentComments.length;
    const urlSet = new Set();
    if (imageUrl) urlSet.add(imageUrl);
    if (Array.isArray(images)) images.forEach(u => { if (u) urlSet.add(u); });
    if (desc) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = desc;
      tempDiv.querySelectorAll('img').forEach(img => { if (img.src) urlSet.add(img.src); });
    }
    const allImageUrls = [...urlSet];
    const galleryHtml = allImageUrls.length ? `<div class="spot-gallery-panel is-collapsed">
      <div class="spot-gallery-nav">
        ${allImageUrls.length > 1 ? '<button type="button" class="spot-gallery-nav-btn spot-gallery-prev">&#9664;</button>' : ''}
        <span class="spot-gallery-indicator">1 / ${allImageUrls.length}</span>
        ${allImageUrls.length > 1 ? '<button type="button" class="spot-gallery-nav-btn spot-gallery-next">&#9654;</button>' : ''}
        <button type="button" class="spot-gallery-nav-btn spot-gallery-close">&#9660;</button>
      </div>
      <img class="spot-gallery-main-img" src="${escapeHtml(allImageUrls[0])}" alt="${escapeHtml(name)}">
    </div>` : '';
    const reopenBtnHtml = allImageUrls.length ? '<button type="button" class="spot-gallery-reopen" title="Show images">&#9650;</button>' : '';
    const detailsActiveClass = activePane === 'comments' ? '' : 'is-active';
    const commentsActiveClass = activePane === 'comments' ? 'is-active' : '';
    const commentsHtml = currentComments.length
      ? currentComments.map((comment, idx) => {
          const commentText = escapeHtml((comment && comment.text) || '');
          const commentAuthor = escapeHtml((comment && comment.author) || 'User');
          const commentTime = formatCommentTime(comment && comment.createdAt);
          const timeSuffix = commentTime ? ` - ${escapeHtml(commentTime)}` : '';
          const deleteButton = isAdminRole()
            ? `<button type="button" class="spot-comment-delete-btn" data-comment-index="${idx}">Delete</button>`
            : '';
          return `<div class="spot-comment-item">
            <div class="spot-comment-meta-row">
              <div class="spot-comment-meta">${commentAuthor}${timeSuffix}</div>
              ${deleteButton}
            </div>
            <div class="spot-comment-text">${commentText}</div>
          </div>`;
        }).join('')
      : '<div class="spot-comment-empty">No comments yet.</div>';
        wrap.innerHTML = `<div class="spot-popup-body">
        ${galleryHtml}
        <div class="spot-name-row">
          <strong class="spot-popup-name">${escapeHtml(name)}</strong>
          ${reopenBtnHtml}
        </div>
        <div class="spot-pane spot-pane-details ${detailsActiveClass}">
          <div class="spot-desc">${desc || ''}</div>
        </div>
        <div class="spot-pane spot-pane-comments ${commentsActiveClass}">
          <div class="spot-comments-wrap">
            <div class="spot-comments-list">${commentsHtml}</div>
            <div class="spot-comment-form">
              <textarea class="spot-comment-input" rows="2" maxlength="300" placeholder="Add a comment"></textarea>
              <button type="button" class="spot-comment-save-btn">Post comment</button>
              <p class="spot-comment-status"></p>
            </div>
          </div>
        </div>
        <div class="spot-popup-tabs">
          <button type="button" class="spot-tab-btn ${detailsActiveClass}" data-pane="details">Details</button>
          <button type="button" class="spot-tab-btn ${commentsActiveClass}" data-pane="comments">Comments (${commentsCount})</button>
          ${editButtonHtml}

        </div>
        <div class="spot-maps-link-wrap">${mapsLinkHtml}</div>
      </div>`;

    if (canEditSpots()) {
      const editBtn = wrap.querySelector('.edit-spot-btn');
      if (editBtn) {
        editBtn.onclick = e => {
          e.preventDefault(); e.stopPropagation();
          const editWrap = createSpotPopup({ marker, spotId, name, desc, imageUrl, images: marker._spotImages || [], spotClass, minRole: marker._spotMinRole || minRole, comments: currentComments, editMode: true });
          marker.getPopup().setContent(editWrap);
          marker.getPopup().openPopup();
          styleEditCloseButton(marker);
          marker.dragging.enable();
          marker.once('dragstart', () => marker.getPopup().closePopup());
        };
      }
    }

    addViewOnlyLinkSupport(wrap, {
      onEditLink: canEditSpots() ? () => {
        const editWrap = createSpotPopup({ marker, spotId, name, desc, imageUrl, images: marker._spotImages || [], spotClass, minRole: marker._spotMinRole || minRole, comments: currentComments, editMode: true });
        marker.getPopup().setContent(editWrap);
        marker.getPopup().openPopup();
        styleEditCloseButton(marker);
        marker.dragging.enable();
        marker.once('dragstart', () => marker.getPopup().closePopup());
      } : null
    });

    const galleryPanel = wrap.querySelector('.spot-gallery-panel');
    const galleryImg = wrap.querySelector('.spot-gallery-main-img');
    const galleryPrev = wrap.querySelector('.spot-gallery-prev');
    const galleryNext = wrap.querySelector('.spot-gallery-next');
    const galleryClose = wrap.querySelector('.spot-gallery-close');
    const galleryIndicator = wrap.querySelector('.spot-gallery-indicator');
    const galleryReopen = wrap.querySelector('.spot-gallery-reopen');
    let currentIdx = 0;
    function updateGalleryIdx(idx) {
      currentIdx = idx;
      if (galleryImg) galleryImg.src = allImageUrls[idx];
      if (galleryIndicator) galleryIndicator.textContent = (idx + 1) + ' / ' + allImageUrls.length;
    }
    if (galleryClose && galleryPanel) {
      galleryClose.onclick = e => { e.stopPropagation(); galleryPanel.classList.add('is-collapsed'); if (galleryReopen) galleryReopen.classList.remove('is-hidden'); };
    }
    if (galleryPrev) galleryPrev.onclick = e => { e.stopPropagation(); updateGalleryIdx((currentIdx - 1 + allImageUrls.length) % allImageUrls.length); };
    if (galleryNext) galleryNext.onclick = e => { e.stopPropagation(); updateGalleryIdx((currentIdx + 1) % allImageUrls.length); };
    if (galleryReopen && galleryPanel) {
      galleryReopen.onclick = e => { e.stopPropagation(); galleryPanel.classList.remove('is-collapsed'); galleryReopen.classList.add('is-hidden'); updateGalleryIdx(0); };
    }

    const paneDetails = wrap.querySelector('.spot-pane-details');
    const paneComments = wrap.querySelector('.spot-pane-comments');
    const tabButtons = wrap.querySelectorAll('.spot-tab-btn');
    tabButtons.forEach((btn) => {
      btn.onclick = () => {
        const pane = btn.getAttribute('data-pane');
        const showComments = pane === 'comments';
        tabButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
        if (paneDetails) paneDetails.classList.toggle('is-active', !showComments);
        if (paneComments) paneComments.classList.toggle('is-active', showComments);
      };
    });

    const commentInput = wrap.querySelector('.spot-comment-input');
    const commentBtn = wrap.querySelector('.spot-comment-save-btn');
    const commentStatus = wrap.querySelector('.spot-comment-status');
    if (commentBtn && commentInput) {
      commentBtn.onclick = async () => {
        const text = commentInput.value.trim();
        if (!text) {
          commentStatus.textContent = 'Write a comment first.';
          commentStatus.style.color = '#b00020';
          return;
        }
        const newComment = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          author: userRole || 'User',
          createdAt: Date.now()
        };
        const nextComments = [...currentComments, newComment];
        commentBtn.disabled = true;
        commentStatus.textContent = 'Saving...';
        commentStatus.style.color = '#333';
        try {
          await updateDoc(doc(db, SPOTS_COLLECTION, spotId), {
            comments: nextComments,
            updatedAt: serverTimestamp()
          });
          marker._spotComments = nextComments;
          marker.getPopup().setContent(createSpotPopup({
            marker,
            spotId,
            name,
            desc,
            imageUrl,
            images: marker._spotImages || [],
            spotClass,
            minRole: marker._spotMinRole || minRole,
            comments: marker._spotComments,
            editMode: false,
            activePane: 'comments'
          }));
          marker.getPopup().openPopup();
        } catch (err) {
          commentStatus.textContent = 'Error: ' + (err.code || err.message || String(err));
          commentStatus.style.color = '#b00020';
        } finally {
          commentBtn.disabled = false;
        }
      };
    }

  if (isAdminRole()) {
    wrap.querySelectorAll('.spot-comment-delete-btn').forEach((btn) => {
      btn.onclick = async () => {
        const index = Number(btn.getAttribute('data-comment-index'));
        if (!Number.isInteger(index) || index < 0 || index >= currentComments.length) return;
        const nextComments = currentComments.filter((_, i) => i !== index);
        btn.disabled = true;
        try {
          await updateDoc(doc(db, SPOTS_COLLECTION, spotId), {
            comments: nextComments,
            updatedAt: serverTimestamp()
          });
          marker._spotComments = nextComments;
          marker.getPopup().setContent(createSpotPopup({
            marker,
            spotId,
            name,
            desc,
            imageUrl,
            images: marker._spotImages || [],
            spotClass,
              minRole: marker._spotMinRole || minRole,
              comments: marker._spotComments,
              editMode: false,
              activePane: 'comments'
            }));
            marker.getPopup().openPopup();
          } catch (err) {
            const msg = wrap.querySelector('.spot-comment-status');
            if (msg) {
              msg.textContent = 'Delete failed: ' + (err.code || err.message || String(err));
              msg.style.color = '#b00020';
            }
            btn.disabled = false;
          }
        };
      });
    }
  } else {
    wrap.classList.add('is-editing');
    wrap.innerHTML =
      `<div class="spot-popup-body is-editing">
        <input class="spot-edit-name" value="${escapeHtml(name)}" type="text">
        <select class="spot-edit-class">
          <option value="default">No Class</option>
          <option value="confirmed">&#9989; Confirmed</option>
          <option value="risky">&#128308; Risky</option>
          <option value="unsure">&#128993; Unsure</option>
        </select>
        <select class="spot-edit-min-role">
          <option value="visitor">Visitor+</option>
          <option value="member">Member+</option>
          <option value="editor">Editor+</option>
        </select>
        <input type="file" class="spot-edit-image" accept="image/*" multiple style="display:none">
        <div class="spot-edit-desc" contenteditable>${desc || ''}</div>
        <div class="spot-edit-attachments"></div>
        <button type="button" class="save-edit-spot-btn">Save</button>
        <button type="button" class="delete-edit-spot-btn">Delete</button>
        <p class="edit-status"></p>
      </div>
      <div class="spot-edit-loading-overlay" style="display:none"><div class="spot-edit-loading-spinner"></div></div>`;
    // Set current class from data, with backward compatibility for older values.
    const classSel = wrap.querySelector('.spot-edit-class');
    classSel.value = normalizeSpotClass(spotClass || marker._spotClass);
    const minRoleSel = wrap.querySelector('.spot-edit-min-role');
    minRoleSel.value = normalizeVisibilityRole(minRole || marker._spotMinRole || 'visitor');
    const descEl = wrap.querySelector('.spot-edit-desc');
    addDescToolbar(descEl, wrap.querySelector('.spot-edit-image'), spotId);
    const attachContainer = wrap.querySelector('.spot-edit-attachments');
    const urlSet = new Set();
    if (imageUrl) urlSet.add(imageUrl);
    if (Array.isArray(images)) images.forEach(u => { if (u) urlSet.add(u); });
    if (desc) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = desc;
      tempDiv.querySelectorAll('img').forEach(img => { if (img.src) urlSet.add(img.src); });
    }
    const existingUrls = [...urlSet];
    existingUrls.forEach(url => {
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
    wrap.querySelector('.save-edit-spot-btn').onclick = async () => {
      const newName = (wrap.querySelector('.spot-edit-name').value.trim()) || 'Unnamed spot';
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
        const finalImageUrl = remainingUrls[0] || newUploadedUrls[0] || '';
        const finalImages = [...remainingUrls.slice(1), ...newUploadedUrls.slice(remainingUrls.length ? 1 : 0)];
        let finalDesc = descEl.innerHTML.replace(/<img[^>]*>/gi, '').replace(/<p>\s*<\/p>/gi, '');
        await updateDoc(doc(db, SPOTS_COLLECTION, spotId), { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng, name: newName, description: finalDesc, imageUrl: finalImageUrl, images: finalImages, spotClass: newClass, minRole: newMinRole, updatedAt: serverTimestamp() });
        if (wrap._removedImagePaths && wrap._removedImagePaths.length) {
          await Promise.allSettled(wrap._removedImagePaths.map(p => supabase.storage.from('spot-images').remove([p])));
        }
        marker.dragging.disable();
        marker._spotClass = newClass;
        marker._spotName = newName;
        marker._spotDesc = finalDesc;
        marker._spotImageUrl = finalImageUrl;
        marker._spotImages = finalImages;
        marker._spotMinRole = newMinRole;
        marker.setIcon(getSpotIcon(newClass));
        reapplyMarkerScale(marker);
        clearSpotsCache();
        upsertSpotSearchEntry(spotId, newName, marker);
        marker.getPopup().setContent(createSpotPopup({ marker, spotId, name: newName, desc: finalDesc, imageUrl: finalImageUrl, images: finalImages, spotClass: newClass, minRole: newMinRole, comments: marker._spotComments || [], editMode: false }));
        const pop = marker.getPopup();
        const cb = pop._closeButton;
        if (cb) cb.style.cssText = '';
        const w = pop._wrapper;
        if (w) w.classList.remove('is-editing');
      } catch (err) {
        loadingOverlay.style.display = 'none';
        wrap.querySelector('.edit-status').textContent = 'Error: ' + (err.code || err.message || String(err));
        wrap.querySelector('.edit-status').style.color = 'red';
      }
    };
    wrap.querySelector('.delete-edit-spot-btn').onclick = async () => {
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

function styleEditCloseButton(marker) {
  const popup = marker.getPopup();
  const closeBtn = popup._closeButton;
  if (!closeBtn) return;
  closeBtn.style.cssText = 'top:auto!important;bottom:28px!important;left:auto!important;right:6px!important;color:#ff4d4d!important;font-size:20px!important;font-weight:700!important;padding:0!important;border:none!important;background:none!important';
  const wrapper = popup._wrapper;
  if (wrapper) wrapper.classList.add('is-editing');
  const map = popup._map;
  if (map) {
    map.once('popupclose', function resetCloseBtn() {
      const cb = marker.getPopup()._closeButton;
      if (cb) cb.style.cssText = '';
      const w = marker.getPopup()._wrapper;
      if (w) w.classList.remove('is-editing');
    });
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

