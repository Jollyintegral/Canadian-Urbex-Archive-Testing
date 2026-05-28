/** Shared role normalization — import as module from settings.js, script.js, etc. */
export function normalizeRole(role) {
  const raw = (role || '').toString().trim().toLowerCase();
  if (!raw) return 'visitor';
  if (raw === 'owner' || raw.startsWith('owner ')) return 'owner';
  if (raw === 'admin' || raw.startsWith('admin ')) return 'admin';
  if (raw === 'editor' || raw.startsWith('editor ')) return 'editor';
  if (raw === 'member' || raw.startsWith('member ')) return 'member';
  if (raw === 'visitor' || raw.startsWith('visitor ')) return 'visitor';
  return 'visitor';
}

export function roleLabel(role) {
  const r = normalizeRole(role);
  return r.charAt(0).toUpperCase() + r.slice(1);
}
