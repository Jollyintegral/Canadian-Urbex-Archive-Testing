import { doc, getDoc, setDoc, updateDoc, onSnapshot, collection, query, getDocs, limit as fsLimit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { normalizeRole } from './role-utils.js';

let notifUnsubscribe = null;
let notifData = [];
let listenersAttached = false;
let _db = null;
let _currentUser = null;

const MAX_NOTIFS = 50;
const EXPIRY_DAYS = 20;

function cacheKey(uid) { return 'cua_user_' + uid; }

function cacheUserData(uid, data) {
  try { sessionStorage.setItem(cacheKey(uid), JSON.stringify({ ...data, _cachedAt: Date.now() })); } catch(e) {}
}

function getCachedUserData(uid) {
  try {
    const raw = sessionStorage.getItem(cacheKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

export function initNotificationsUI(db, currentUser, userRole) {
  const role = normalizeRole(userRole);
  if (!currentUser || role === 'visitor') return;

  _db = db;
  _currentUser = currentUser;

  injectBellButton();
  injectBellMobileButton();

  const cached = getCachedUserData(currentUser.uid);
  if (cached && cached.notifications) {
    notifData = cached.notifications.slice().reverse();
    updateBadge();
  }

  const bellBtn = document.getElementById('notifBellBtn');
  const panel = document.getElementById('notifPanel');
  if (!bellBtn || !panel) return;

  if (!listenersAttached) {
    listenersAttached = true;

    bellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = panel.style.display === 'block';
      panel.style.display = open ? 'none' : 'block';
      if (!open) {
        if (!notifUnsubscribe) {
          startListener(db, currentUser.uid);
          cleanupExpiredNotifications(db, currentUser.uid);
        }
        renderNotificationsPanel(panel);
        markAllRead(db, currentUser.uid);
      }
    });

    document.addEventListener('click', (e) => {
      if (panel.style.display === 'block' && !panel.contains(e.target) && e.target !== bellBtn && !bellBtn.contains(e.target)) {
        panel.style.display = 'none';
      }
    });

    const mobileBtn = document.querySelector('.notif-mobile-btn');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const open = panel.style.display === 'block';
        if (open) {
          panel.style.display = 'none';
          return;
        }
        // Close the mobile drawer first
        const toggle = document.querySelector('.mobile-menu-button');
        if (toggle && toggle.classList.contains('is-active')) toggle.click();
        // Show notifications panel (same as desktop bell)
        panel.style.display = 'block';
        if (!notifUnsubscribe) {
          startListener(db, currentUser.uid);
          cleanupExpiredNotifications(db, currentUser.uid);
        }
        renderNotificationsPanel(panel);
        markAllRead(db, currentUser.uid);
      });
    }
  }
}

function injectBellButton() {
  if (document.getElementById('notifBellBtn')) return;
  const wrap = document.getElementById('accountMenuWrap') || document.getElementById('settingsAccountWrap') || document.getElementById('homeAccountMenuWrap');
  if (!wrap) return;
  const container = document.createElement('div');
  container.className = 'notif-bell-container';
  const btn = document.createElement('button');
  btn.id = 'notifBellBtn';
  btn.className = 'notif-bell-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Notifications');
  btn.innerHTML = '<svg class="notif-bell-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg><span class="notif-badge" id="notifBadge" style="display:none"></span>';
  const panel = document.createElement('div');
  panel.id = 'notifPanel';
  panel.className = 'notif-panel';
  container.appendChild(btn);
  container.appendChild(panel);
  wrap.parentNode.insertBefore(container, wrap);
}

function injectBellMobileButton() {
  if (document.querySelector('.notif-mobile-btn')) return;
  const drawerHeader = document.querySelector('.mobile-drawer-header');
  if (!drawerHeader) return;
  const btn = document.createElement('button');
  btn.className = 'notif-mobile-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Notifications');
  btn.innerHTML = '<svg class="notif-bell-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
  drawerHeader.insertBefore(btn, drawerHeader.querySelector('.drawer-close-button'));
}

function startListener(db, uid) {
  if (notifUnsubscribe) notifUnsubscribe();
  const ref = doc(db, 'users', uid);
  notifUnsubscribe = onSnapshot(ref, (snap) => {
    const data = snap.data() || {};
    const arr = data.notifications || [];
    notifData = arr.slice().reverse();
    cacheUserData(uid, { notifications: arr, role: data.role || '', displayName: data.displayName || '' });
    updateBadge();
    const panel = document.getElementById('notifPanel');
    if (panel && panel.style.display === 'block') renderNotificationsPanel(panel);
    const mobilePage = document.getElementById('notifMobilePage');
    if (mobilePage && mobilePage.style.display === 'block') renderMobileNotifications(mobilePage);
  });
}

function updateBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const unread = notifData.filter((n) => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
  const mobileBtn = document.querySelector('.notif-mobile-btn');
  if (mobileBtn) {
    mobileBtn.style.position = 'relative';
    let dot = mobileBtn.querySelector('.notif-mobile-dot');
    if (unread > 0) {
      if (!dot) { dot = document.createElement('span'); dot.className = 'notif-mobile-dot'; mobileBtn.appendChild(dot); }
    } else if (dot) {
      dot.remove();
    }
  }
}

function renderNotificationsPanel(panel) {
  const important = notifData.filter((n) => n.section === 'important');
  const other = notifData.filter((n) => n.section !== 'important');
  const hasAny = important.length > 0 || other.length > 0;
  let html = '<div class="notif-panel-header">Notifications</div><div class="notif-scroll">';
  if (!hasAny) {
    html += '<div class="notif-empty">No New Notifications</div>';
  } else {
    if (important.length > 0) {
      html += '<div class="notif-section-label">Important</div>';
      important.forEach((n) => { html += renderNotifItem(n); });
    }
    if (other.length > 0) {
      html += '<div class="notif-section-label">Other</div>';
      other.forEach((n) => { html += renderNotifItem(n); });
    }
  }
  html += '</div>';
  panel.innerHTML = html;
}

function renderNotifItem(n) {
  const time = n.createdAt ? formatNotifTime(n.createdAt) : '';
  const unreadDot = n.read ? '' : '<span class="notif-unread-dot"></span>';
  const expiryDays = n.expiresAt ? getDaysRemaining(n.expiresAt) : EXPIRY_DAYS;
  const expiryIcon = `<span class="notif-item-expiry" title="Auto-deletes in ${expiryDays} day${expiryDays === 1 ? '' : 's'}" data-expiry-days="${expiryDays}">!</span>`;
  const dismissBtn = `<button type="button" class="notif-item-dismiss" data-notif-id="${escapeHtml(n.id)}" aria-label="Dismiss notification">×</button>`;
  const viewDetails = n.reportId ? `<button type="button" class="notif-item-details-btn" data-report-id="${escapeHtml(n.reportId)}">[View Details]</button>` : '';
  return `<div class="notif-item${n.read ? '' : ' notif-unread'}" data-notif-id="${escapeHtml(n.id)}">
    ${unreadDot}
    ${expiryIcon}
    <div class="notif-item-content">
      <div class="notif-item-title">${escapeHtml(n.title || '')}</div>
      <div class="notif-item-body">${escapeHtml(n.body || '')}</div>
      <div class="notif-item-time">${escapeHtml(time)}</div>
      ${viewDetails}
    </div>
    ${dismissBtn}
  </div>`;
}

function getDaysRemaining(expiresAt) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / (1000 * 60 * 60 * 24));
}

function formatNotifTime(ts) {
  if (!ts) return '';
  if (typeof ts === 'number') return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  if (typeof ts === 'string') return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  if (ts.seconds) return new Date(ts.seconds * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  return '';
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function markAllRead(db, uid) {
  const unread = notifData.filter((n) => !n.read);
  if (!unread.length) return;
  const ref = doc(db, 'users', uid);
  try {
    const snap = await getDoc(ref);
    const all = snap.data()?.notifications || [];
    const updated = all.map((n) => (n.read ? n : { ...n, read: true }));
    await updateDoc(ref, { notifications: updated });
    notifData.forEach((n) => { n.read = true; });
    updateBadge();
  } catch (err) {
    console.warn('markAllRead failed:', err);
  }
}

function showMobileNotifications(db, uid) {
  const header = document.querySelector('header');
  if (!header) return;
  if (!header.classList.contains('mobile-menu-open')) {
    const toggle = document.querySelector('.mobile-menu-button');
    if (toggle) toggle.click();
  }
  let page = document.getElementById('notifMobilePage');
  if (!page) {
    page = document.createElement('div');
    page.id = 'notifMobilePage';
    page.className = 'notif-mobile-page';
    const center = document.querySelector('.header-center');
    if (center) center.appendChild(page);
  }
  const links = document.querySelectorAll('.header-center > .top-nav-link');
  links.forEach((l) => l.style.display = 'none');
  page.style.display = 'block';
  renderMobileNotifications(page);
  markAllRead(db, uid);
}

function renderMobileNotifications(container) {
  const important = notifData.filter((n) => n.section === 'important');
  const other = notifData.filter((n) => n.section !== 'important');
  const hasAny = important.length > 0 || other.length > 0;
  let html = '<div class="notif-mobile-header"><button class="notif-mobile-back" id="notifMobileBack" type="button">← Back</button><span>Notifications</span></div>';
  if (!hasAny) {
    html += '<div class="notif-empty">No New Notifications</div>';
  } else {
    if (important.length > 0) {
      html += '<div class="notif-section-label">Important</div>';
      important.forEach((n) => { html += renderNotifItem(n); });
    }
    if (other.length > 0) {
      html += '<div class="notif-section-label">Other</div>';
      other.forEach((n) => { html += renderNotifItem(n); });
    }
  }
  container.innerHTML = html;
  const backBtn = container.querySelector('#notifMobileBack');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      container.style.display = 'none';
      const links = document.querySelectorAll('.header-center > .top-nav-link');
      links.forEach((l) => l.style.display = '');
    });
  }
}

async function pushNotification(db, uid, notif) {
  if (!uid || !notif.title || !notif.body) return;
  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    const existing = snap.data()?.notifications || [];
    const trimmed = existing.slice(-(MAX_NOTIFS - 1));
    trimmed.push(notif);
    await setDoc(ref, { notifications: trimmed }, { merge: true });
  } catch (err) {
    console.warn('pushNotification failed:', err);
  }
}

export async function createNotification(db, uid, type, title, body, opts = {}) {
  const notif = {
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    type,
    title,
    body,
    section: opts.section || 'important',
    read: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000
  };
  if (opts.spotId) notif.spotId = opts.spotId;
  if (opts.actorUid) notif.actorUid = opts.actorUid;
  if (opts.reportId) notif.reportId = opts.reportId;
  await pushNotification(db, uid, notif);
}

export async function dismissNotification(db, uid, notifId) {
  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    const all = snap.data()?.notifications || [];
    const updated = all.filter((n) => n.id !== notifId);
    await setDoc(ref, { notifications: updated }, { merge: true });
  } catch (err) {
    console.warn('dismissNotification failed:', err);
  }
}

async function cleanupExpiredNotifications(db, uid) {
  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    const all = snap.data()?.notifications || [];
    const now = Date.now();
    const filtered = all.filter((n) => !n.expiresAt || n.expiresAt > now);
    if (filtered.length !== all.length) {
      await setDoc(ref, { notifications: filtered }, { merge: true });
    }
  } catch (err) {
    console.warn('cleanupExpiredNotifications failed:', err);
  }
}

export async function notifyNewSpot(db, spotId, spotName, creatorUid, creatorDisplay) {
  try {
    const userSnaps = await getDocs(query(collection(db, 'users'), fsLimit(250)));
    const admins = [];
    userSnaps.forEach((s) => {
      const d = s.data() || {};
      const r = normalizeRole(d.role);
      if ((r === 'admin' || r === 'owner') && s.id !== creatorUid) {
        admins.push(s.id);
      }
    });
    const now = new Date();
    const dateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const body = `${spotName} added on ${dateStr}` + (creatorDisplay ? ` by ${creatorDisplay}` : '');
    await Promise.all(admins.map((uid) =>
      createNotification(db, uid, 'new_spot', 'New Spot Added', body, { spotId, actorUid: creatorUid })
    ));
  } catch (err) {
    console.warn('notifyNewSpot failed:', err);
  }
}

export async function notifyRoleChange(db, targetUid, newRole, actorUid) {
  if (targetUid === actorUid) return;
  const label = newRole.charAt(0).toUpperCase() + newRole.slice(1);
  await createNotification(db, targetUid, 'role_change', 'Role Updated', `Your role has been changed to ${label}`, { actorUid });
}

export async function notifyCommentDeleted(db, targetUid, spotName, actorUid) {
  if (!targetUid || targetUid === actorUid) return;
  await createNotification(db, targetUid, 'comment_deleted', 'Comment Removed', `Your comment on "${spotName}" was removed by an admin`, { actorUid });
}

// Event delegation for notification panel interactions
document.addEventListener('click', (e) => {
  // Dismiss button
  const dismissBtn = e.target.closest('.notif-item-dismiss');
  if (dismissBtn && _db && _currentUser) {
    const notifId = dismissBtn.getAttribute('data-notif-id');
    if (notifId) dismissNotification(_db, _currentUser.uid, notifId);
    return;
  }

  // View Details button
  const detailsBtn = e.target.closest('.notif-item-details-btn');
  if (detailsBtn && _db && _currentUser) {
    const reportId = detailsBtn.getAttribute('data-report-id');
    if (reportId) {
      import('./reports.js').then(mod => mod.showReportDetail(_db, reportId, _currentUser));
    }
    return;
  }
});
