import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, doc, getDoc, getDocFromServer, setDoc, serverTimestamp, collection, getDocs, addDoc, query, orderBy, limit, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signOut, updateProfile } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
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
let currentUser = null;
let currentRole = 'visitor';
let currentUserDoc = null;
let roleDashboardLoaded = false;
let roleUsersCache = null;
let roleAuditCache = null;
let roleCacheTs = 0;
const ROLE_CACHE_TTL_MS = 120000;
const DEFAULT_SETTINGS_RETURN_URL = 'map.html';

function getSettingsReturnUrl() {
  const ref = (document.referrer || '').trim();
  if (!ref) return DEFAULT_SETTINGS_RETURN_URL;
  try {
    const refUrl = new URL(ref);
    if (refUrl.origin !== window.location.origin) return DEFAULT_SETTINGS_RETURN_URL;
    if (/\/settings\.html$/i.test(refUrl.pathname)) return DEFAULT_SETTINGS_RETURN_URL;
    const next = `${refUrl.pathname}${refUrl.search}${refUrl.hash}`;
    return next || DEFAULT_SETTINGS_RETURN_URL;
  } catch {
    return DEFAULT_SETTINGS_RETURN_URL;
  }
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 700px)').matches;
}

function setStatus(text, isError = false) {
  const el = document.getElementById('settingsStatusText');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ffb6c3' : '#d9e5ff';
}

function setAccountUi(user, role) {
  const wrap = document.getElementById('settingsAccountWrap');
  const name = document.getElementById('settingsAccountName');
  const avatar = document.getElementById('settingsAccountAvatar');
  const profileName = document.getElementById('settingsProfileName');
  const profileMeta = document.getElementById('settingsProfileMeta');
  const profileJoined = document.getElementById('settingsProfileJoined');
  const profileAvatar = document.getElementById('settingsProfileAvatar');
  const displayName = (user.displayName || '').trim() || (user.email ? user.email.split('@')[0] : 'Account');
  const first = (displayName[0] || 'U').toUpperCase();
  if (wrap) wrap.style.display = 'block';
  if (name) name.textContent = `${displayName} (${roleLabel(role)})`;
  if (avatar) avatar.textContent = first;
  if (profileName) profileName.textContent = displayName;
  if (profileMeta) profileMeta.textContent = `Role: ${roleLabel(role)}`;
  const joinedDate = currentUserDoc && currentUserDoc.createdAt && typeof currentUserDoc.createdAt.toDate === 'function'
    ? currentUserDoc.createdAt.toDate()
    : (user.metadata && user.metadata.creationTime ? new Date(user.metadata.creationTime) : null);
  if (profileJoined) profileJoined.textContent = joinedDate ? `Joined: ${joinedDate.toLocaleDateString()}` : 'Joined: -';
  if (profileAvatar) profileAvatar.textContent = first;
}

function wireMenu() {
  const btn = document.getElementById('settingsAccountBtn');
  const dropdown = document.getElementById('settingsAccountDropdown');
  const signOutBtn = document.getElementById('settingsSignOutBtn');
  if (btn && dropdown) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = dropdown.classList.contains('is-visible');
      dropdown.classList.toggle('is-visible');
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    };
    document.addEventListener('click', () => {
      dropdown.classList.remove('is-visible');
      btn.setAttribute('aria-expanded', 'false');
    });
  }
  if (signOutBtn) signOutBtn.onclick = async () => {
    if (window.UrbexLoader) window.UrbexLoader.start();
    await signOut(auth);
    window.location.reload();
  };
}

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

async function loadRole(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  currentUserDoc = snap.data() || null;
  const rawRole = (currentUserDoc || {}).role || 'visitor';
  return normalizeRole(rawRole);
}

function exitMobileDrillIn() {
  const sidebar = document.querySelector('.settings-sidebar');
  const panelMain = document.querySelector('.settings-panel-main');
  const mobileBack = document.querySelector('.settings-mobile-back');
  if (sidebar) sidebar.classList.remove('mobile-hidden');
  if (panelMain) panelMain.classList.remove('mobile-full');
  if (mobileBack) mobileBack.classList.remove('is-visible');
}

function enterMobileDrillIn() {
  const sidebar = document.querySelector('.settings-sidebar');
  const panelMain = document.querySelector('.settings-panel-main');
  const mobileBack = document.querySelector('.settings-mobile-back');
  if (sidebar) sidebar.classList.add('mobile-hidden');
  if (panelMain) panelMain.classList.add('mobile-full');
  if (mobileBack) mobileBack.classList.add('is-visible');
}

function wireTabs() {
  const navButtons = Array.from(document.querySelectorAll('.settings-nav-item[data-tab]'));
  const panels = Array.from(document.querySelectorAll('.settings-tab-panel[data-panel]'));
  const mobileBackBtn = document.getElementById('settingsMobileBackBtn');

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');

      navButtons.forEach((b) => b.classList.toggle('is-active', b === btn));

      const isMobile = isMobileViewport();

      if (isMobile) {
        const currentPanel = document.querySelector('.settings-tab-panel.is-active');
        const newPanel = document.querySelector(`.settings-tab-panel[data-panel="${tab}"]`);

        enterMobileDrillIn();

        if (currentPanel && newPanel && currentPanel !== newPanel) {
          currentPanel.classList.remove('is-active');
          currentPanel.classList.add('slide-out');
          setTimeout(() => {
            currentPanel.classList.remove('slide-out');
            newPanel.classList.add('is-active');
          }, 200);
        } else {
          panels.forEach((p) => {
            p.classList.toggle('is-active', p.getAttribute('data-panel') === tab);
          });
        }
      } else {
        panels.forEach((p) => {
          p.classList.toggle('is-active', p.getAttribute('data-panel') === tab);
        });
        exitMobileDrillIn();
      }

      if (tab === 'roles') {
        loadRoleDashboard();
      }
      setStatus('');
    });
  });

  if (mobileBackBtn) {
    mobileBackBtn.addEventListener('click', () => {
      exitMobileDrillIn();
      panels.forEach((p) => p.classList.remove('slide-out'));
    });
  }
}

function canManageRoles() {
  return currentRole === 'owner';
}

function syncRoleDashboardVisibility() {
  const ownerOnly = Array.from(document.querySelectorAll('[data-owner-only="true"]'));
  const isOwner = currentRole === 'owner';
  ownerOnly.forEach((el) => {
    el.style.display = isOwner ? '' : 'none';
  });
  const activeOwnerPanel = document.querySelector('.settings-tab-panel.is-active[data-owner-only="true"]');
  if (!isOwner && activeOwnerPanel) {
    const accountBtn = document.querySelector('.settings-nav-item[data-tab="account"]');
    if (accountBtn) accountBtn.click();
  }
}

function formatAuditTime(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toLocaleString();
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : '';
}

async function updateUserRole(targetUid, targetEmail, previousRole, nextRole) {
  if (!currentUser || !canManageRoles()) {
    throw new Error('You do not have permission to change roles.');
  }
  const cleanRole = normalizeRole(nextRole);
  if (cleanRole === 'owner' && currentRole !== 'owner') {
    throw new Error('Only Owner can assign Owner role.');
  }

  const userRef = doc(db, 'users', targetUid);
  await setDoc(userRef, {
    role: cleanRole,
    updatedAt: serverTimestamp()
  }, { merge: true });

  const serverSnap = await getDocFromServer(userRef);
  const persisted = normalizeRole((serverSnap.data() || {}).role);
  if (persisted !== cleanRole) {
    throw new Error('Role change was not saved on the server. Check Firestore rules and deploy firestore.rules.');
  }

  try {
    await addDoc(collection(db, 'role_audit'), {
      targetUid,
      targetEmail: targetEmail || '',
      previousRole: normalizeRole(previousRole || 'visitor'),
      newRole: cleanRole,
      changedByUid: currentUser.uid,
      changedByEmail: currentUser.email || '',
      createdAt: serverTimestamp()
    });
  } catch (auditErr) {
    console.warn('Role audit log failed:', auditErr);
  }
}

async function deleteAuditEntry(auditId) {
  if (!currentUser || !canManageRoles()) throw new Error('You do not have permission to change role audit.');
  if (!auditId) return;
  await deleteDoc(doc(db, 'role_audit', auditId));
}

async function revertRoleFromAudit(row) {
  if (!row) return;
  const targetUid = row.targetUid;
  const targetEmail = row.targetEmail || '';
  const previousRole = normalizeRole(row.previousRole || 'visitor');
  const newRole = normalizeRole(row.newRole || 'visitor');
  if (!targetUid) throw new Error('Missing target uid for revert.');
  if (!row.id) throw new Error('Missing audit id for revert.');

  // Revert role, then delete the audit row (Option A behavior).
  await updateUserRole(targetUid, targetEmail, newRole, previousRole);
  await deleteAuditEntry(row.id);
}

function buildRoleSelectOptions(current) {
  const ownerOption = currentRole === 'owner'
    ? `<option value="owner" ${current === 'owner' ? 'selected' : ''}>Owner</option>`
    : '';
  return `
    <option value="visitor" ${current === 'visitor' ? 'selected' : ''}>Visitor</option>
    <option value="member" ${current === 'member' ? 'selected' : ''}>Member</option>
    <option value="editor" ${current === 'editor' ? 'selected' : ''}>Editor</option>
    <option value="admin" ${current === 'admin' ? 'selected' : ''}>Admin</option>
    ${ownerOption}`;
}

function wireRoleSaveButtons(users) {
  document.querySelectorAll('.settings-role-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('[data-uid]');
      if (!row) return;
      const uid = row.getAttribute('data-uid');
      const sel = row.querySelector('.settings-role-select');
      const user = users.find((u) => u.uid === uid);
      if (!uid || !sel || !user) return;
      btn.disabled = true;
      setStatus('Updating role...');
      try {
        await updateUserRole(uid, user.email || '', user.role || 'visitor', sel.value);
        roleUsersCache = null;
        roleAuditCache = null;
        setStatus('Role updated successfully.');
        await loadRoleDashboard();
      } catch (err) {
        setStatus('Role update failed: ' + (err.code || err.message || String(err)), true);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function loadRoleDashboard() {
  const block = document.getElementById('roleDashboardBlock');
  const tbody = document.getElementById('roleUsersTableBody');
  const cardsEl = document.getElementById('roleUsersCards');
  const auditList = document.getElementById('roleAuditList');
  if (!block || !tbody || !auditList) return;

  if (!canManageRoles()) {
    block.innerHTML = `<p class="settings-role-note">You do not have permission to use role management. Detected role: ${roleLabel(currentRole)}.</p>`;
    return;
  }

  if (!roleDashboardLoaded) {
    tbody.innerHTML = '<tr><td colspan="4">Loading users...</td></tr>';
    if (cardsEl) cardsEl.innerHTML = '<p class="settings-role-note">Loading users...</p>';
  }

  const now = Date.now();
  let users = roleUsersCache;
  let auditRows = roleAuditCache;

  if (!users || !auditRows || (now - roleCacheTs) > ROLE_CACHE_TTL_MS) {
    const userSnaps = await getDocs(query(collection(db, 'users'), limit(250)));
    users = [];
    userSnaps.forEach((snap) => users.push({ uid: snap.id, ...snap.data() }));
    try {
      const auditSnaps = await getDocs(query(collection(db, 'role_audit'), orderBy('createdAt', 'desc'), limit(20)));
      auditRows = [];
      auditSnaps.forEach((snap) => auditRows.push({ id: snap.id, ...snap.data() }));
    } catch (auditErr) {
      console.warn('Could not load role audit:', auditErr);
      auditRows = auditRows || [];
    }
    roleUsersCache = users;
    roleAuditCache = auditRows;
    roleCacheTs = now;
  }

  users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));

  tbody.innerHTML = users.map((u) => {
    const current = normalizeRole(u.role || 'visitor');
    const lockedOwner = current === 'owner' && currentRole !== 'owner';
    const disabledAttr = lockedOwner ? 'disabled' : '';
    const label = u.email || u.displayName || u.uid;
    return `<tr data-uid="${u.uid}">
      <td>${label}</td>
      <td>${roleLabel(current)}</td>
      <td>
        <select class="settings-role-select" ${disabledAttr}>${buildRoleSelectOptions(current)}</select>
      </td>
      <td><button type="button" class="settings-role-save-btn" ${disabledAttr}>Save</button></td>
    </tr>`;
  }).join('');



  wireRoleSaveButtons(users);

  auditList.innerHTML = auditRows.map((r) => {
    const when = formatAuditTime(r.createdAt);
    const target = r.targetEmail || r.targetUid || 'user';
    const changedBy = r.changedByEmail || 'unknown';
    const prev = roleLabel(r.previousRole || 'visitor');
    const next = roleLabel(r.newRole || 'visitor');
    const auditId = r.id || '';
    const revertTitle = 'Revert role (and remove this log)';
    const deleteTitle = 'Delete this log entry';
    return `<div class="settings-audit-item" data-audit-id="${auditId}" data-target-uid="${r.targetUid || ''}">
      <div class="settings-audit-item-main">
        <div class="settings-audit-item-text">
          ${changedBy} changed ${target} from <strong>${prev}</strong> to <strong>${next}</strong>
          <span>${when}</span>
        </div>
      </div>
      <div class="settings-audit-actions">
        <button type="button" class="settings-audit-btn settings-audit-btn-delete" data-action="delete" title="${deleteTitle}" aria-label="${deleteTitle}">×</button>
        <button type="button" class="settings-audit-btn settings-audit-btn-revert" data-action="revert" title="${revertTitle}" aria-label="${revertTitle}">⟲</button>
      </div>
    </div>`;
  }).join('') || '<div class="settings-audit-item">No role changes yet.</div>';

  auditList.querySelectorAll('.settings-audit-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const item = btn.closest('.settings-audit-item');
      const auditId = item ? item.getAttribute('data-audit-id') : '';
      const row = auditRows.find((r) => String(r.id || '') === String(auditId || ''));
      if (!auditId) return;
      btn.disabled = true;
      setStatus(action === 'revert' ? 'Reverting role...' : 'Deleting audit log...');
      try {
        if (action === 'delete') {
          await deleteAuditEntry(auditId);
        } else if (action === 'revert') {
          await revertRoleFromAudit(row);
        }
        roleAuditCache = null;
        setStatus(action === 'revert' ? 'Role reverted and log removed.' : 'Log entry deleted.');
        await loadRoleDashboard();
      } catch (err) {
        setStatus((action === 'revert' ? 'Revert failed: ' : 'Delete failed: ') + (err.code || err.message || String(err)), true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  roleDashboardLoaded = true;
}

async function saveSettings() {
  if (!currentUser) return;
  const saveBtn = document.getElementById('settingsSaveBtn');
  const displayNameInput = document.getElementById('settingsDisplayNameInput');
  const bioInput = document.getElementById('settingsProfileBioInput');
  if (!displayNameInput) return;
  const nextName = (displayNameInput.value || '').trim();
  const nextBio = bioInput ? (bioInput.value || '').trim() : '';
  setStatus('Saving...');
  try {
    if (saveBtn) saveBtn.disabled = true;
    await updateProfile(currentUser, { displayName: nextName });
    const selfRef = doc(db, 'users', currentUser.uid);
    await setDoc(selfRef, {
      displayName: nextName,
      bio: nextBio,
      updatedAt: serverTimestamp()
    }, { merge: true });
    const serverSnap = await getDocFromServer(selfRef);
    const persisted = serverSnap.data() || {};
    const persistedName = ((persisted.displayName || '') + '').trim();
    const persistedBio = ((persisted.bio || '') + '');
    if ((persistedName && persistedName !== nextName) || (persistedBio !== nextBio)) {
      console.warn('Settings save mismatch:', { nextName, persistedName, nextBio, persistedBio });
    }
    currentUser = auth.currentUser;
    setAccountUi(currentUser, currentRole);
    setStatus('Saved.');
  } catch (err) {
    setStatus('Save failed: ' + (err.code || err.message || String(err)), true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function wireForm() {
  const saveBtn = document.getElementById('settingsSaveBtn');
  const backBtn = document.getElementById('settingsBackBtn');
  const closeBtn = document.getElementById('settingsCloseBtn');
  const returnUrl = getSettingsReturnUrl();
  if (saveBtn) saveBtn.onclick = saveSettings;
  if (backBtn) backBtn.onclick = () => {
    if (window.UrbexLoader) window.UrbexLoader.start();
    window.location.href = returnUrl;
  };
  if (closeBtn) closeBtn.onclick = () => {
    if (window.UrbexLoader) window.UrbexLoader.start();
    window.location.href = returnUrl;
  };
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (window.UrbexLoader) window.UrbexLoader.start();
    window.location.href = 'map.html';
    return;
  }
  currentUser = user;
  currentRole = await loadRole(user.uid);
  syncRoleDashboardVisibility();
  const displayNameInput = document.getElementById('settingsDisplayNameInput');
  const emailInput = document.getElementById('settingsEmailInput');
  if (displayNameInput) displayNameInput.value = user.displayName || '';
  if (emailInput) emailInput.value = user.email || '';
  const bioInput = document.getElementById('settingsProfileBioInput');
  if (bioInput) bioInput.value = (currentUserDoc && currentUserDoc.bio) ? currentUserDoc.bio : '';
  setAccountUi(user, currentRole);
});

wireMenu();
wireMobileMenu();
wireForm();
wireTabs();
