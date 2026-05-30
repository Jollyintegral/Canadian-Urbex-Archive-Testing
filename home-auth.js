import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
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
const googleProvider = new GoogleAuthProvider();
let guestMode = sessionStorage.getItem('guestMode') === '1';

async function loadRole(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  const userDoc = snap.data() || null;
  return normalizeRole((userDoc || {}).role || 'visitor');
}

function setAccountUi(user, role) {
  const wrap = document.getElementById('homeAccountMenuWrap');
  const name = document.getElementById('homeAccountMenuName');
  const avatar = document.getElementById('homeAccountMenuAvatar');
  const signInBtn = document.getElementById('homeHeaderSignInBtn');
  const isGuestUser = !!(user && user.isAnonymous);

  if (signInBtn) signInBtn.style.display = (!user || isGuestUser) ? 'inline-flex' : 'none';
  if (!wrap || !name || !avatar) return;
  if (!user || isGuestUser) {
    wrap.style.display = 'none';
    return;
  }
  const displayName = (user.displayName || '').trim() || (user.email ? user.email.split('@')[0] : 'Account');
  const first = (displayName[0] || 'U').toUpperCase();
  
  if (wrap) wrap.style.display = 'block';
  if (signInBtn) signInBtn.style.display = 'none';
  if (name) name.textContent = `${displayName} (${roleLabel(role)})`;
  if (avatar) avatar.textContent = first;
}

function wireMenu() {
  const btn = document.getElementById('homeAccountMenuBtn');
  const dropdown = document.getElementById('homeAccountDropdown');
  const settingsBtn = document.getElementById('homeAccountSettingsBtn');
  const signOutBtn = document.getElementById('homeAccountSignOutBtn');
  
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
  
  if (settingsBtn) {
    settingsBtn.onclick = () => {
      if (window.UrbexLoader) window.UrbexLoader.start();
      window.location.href = 'settings.html';
    };
  }
  
  if (signOutBtn) signOutBtn.onclick = async () => {
    if (window.UrbexLoader) window.UrbexLoader.start();
    guestMode = false;
    sessionStorage.removeItem('guestMode');
    sessionStorage.removeItem('authSignedIn');
    sessionStorage.removeItem('userRole');
    await signOut(auth);
    window.location.reload();
  };
}

const signInBtn = document.getElementById('homeHeaderSignInBtn');
if (signInBtn) {
  signInBtn.onclick = async () => {
    try {
      guestMode = false;
      sessionStorage.removeItem('guestMode');
      await signInWithPopup(auth, googleProvider);
      sessionStorage.setItem('authSignedIn', '1');
      window.location.reload();
    } catch (error) {
      console.warn('Home sign-in failed:', error);
    }
  };
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    const role = await loadRole(user.uid);
    setAccountUi(user, role);
  } else {
    const wrap = document.getElementById('homeAccountMenuWrap');
    const signInBtn = document.getElementById('homeHeaderSignInBtn');
    if (wrap) wrap.style.display = 'none';
    if (signInBtn) signInBtn.style.display = 'inline-flex';
  }
});

wireMenu();
