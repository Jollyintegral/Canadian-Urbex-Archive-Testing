import { doc, getDoc, getDocs, setDoc, collection, addDoc, query, where, limit as fsLimit, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { createNotification } from './notifications.js';

const REPORT_TYPES = [
  'Bug Report',
  'Information Change',
  'Incorrect Location Data',
  'Duplicate Location',
  'Broken Link',
  'Missing Information',
  'Feature Suggestion',
  'Content Issue',
  'Other'
];

let dropdownActive = null;
let modalEl = null;
let detailModalEl = null;

function getOwnerUid(db) {
  return getDocs(query(collection(db, 'users'), where('role', '==', 'owner'), fsLimit(1)))
    .then(snap => snap.empty ? null : snap.docs[0].id);
}

function closeWithAnimation(el, cb) {
  if (!el) return;
  el.classList.add('is-closing');
  setTimeout(() => {
    cb();
    el.classList.remove('is-closing');
  }, 250);
}

function buildDropdown(opts, selected, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'report-dropdown-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'report-dropdown-trigger';
  trigger.textContent = selected || 'Select a report type...';
  trigger.dataset.value = selected || '';

  const menu = document.createElement('div');
  menu.className = 'report-dropdown-menu';
  menu.style.display = 'none';

  opts.forEach(o => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = o;
    item.className = o === selected ? 'is-active' : '';
    item.addEventListener('click', () => {
      trigger.textContent = o;
      trigger.dataset.value = o;
      onChange(o);
      menu.style.display = 'none';
      menu.classList.remove('is-open');
      wrap.classList.remove('is-open');
      dropdownActive = null;
      menu.querySelectorAll('button').forEach(b => b.classList.remove('is-active'));
      item.classList.add('is-active');
    });
    menu.appendChild(item);
  });

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dropdownActive && dropdownActive !== menu) {
      dropdownActive.style.display = 'none';
      dropdownActive.classList.remove('is-open');
      if (dropdownActive.closest('.report-dropdown-wrap')) dropdownActive.closest('.report-dropdown-wrap').classList.remove('is-open');
    }
    const open = menu.style.display === 'block';
    menu.style.display = open ? 'none' : 'block';
    menu.classList.toggle('is-open', !open);
    wrap.classList.toggle('is-open', !open);
    dropdownActive = open ? null : menu;
  });

  wrap.appendChild(trigger);
  wrap.appendChild(menu);
  return wrap;
}

function closeDropdowns(e) {
  if (dropdownActive && !dropdownActive.contains(e.target) && !dropdownActive.previousElementSibling.contains(e.target)) {
    dropdownActive.style.display = 'none';
    dropdownActive.classList.remove('is-open');
    if (dropdownActive.closest('.report-dropdown-wrap')) dropdownActive.closest('.report-dropdown-wrap').classList.remove('is-open');
    dropdownActive = null;
  }
}

export function showReportForm(db, currentUser) {
  if (!currentUser) return;
  if (modalEl) { modalEl.classList.remove('is-closing'); modalEl.style.display = 'flex'; return; }

  modalEl = document.createElement('div');
  modalEl.id = 'reportModal';
  modalEl.className = 'settings-modal';
  modalEl.style.display = 'flex';

  const backdrop = document.createElement('div');
  backdrop.className = 'settings-modal-backdrop';
  backdrop.addEventListener('click', () => closeReportForm());

  const content = document.createElement('div');
  content.className = 'settings-modal-content';

  const header = document.createElement('div');
  header.className = 'settings-modal-header';
  header.innerHTML = '<h2>Submit a Report</h2>';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-modal-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close report form');
  closeBtn.textContent = 'x';
  closeBtn.addEventListener('click', () => closeReportForm());
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'settings-modal-body';

  const typeLabel = document.createElement('label');
  typeLabel.className = 'report-form-label';
  typeLabel.textContent = 'Report Type';

  let selectedType = '';
  const dropdownWrap = buildDropdown(REPORT_TYPES, '', (val) => { selectedType = val; });

  const infoLabelRow = document.createElement('div');
  infoLabelRow.className = 'report-form-label-row';
  const infoLabel = document.createElement('span');
  infoLabel.className = 'report-form-label';
  infoLabel.textContent = 'Information Here';
  const requiredBadge = document.createElement('span');
  requiredBadge.className = 'report-form-required';
  requiredBadge.textContent = '*Required';
  infoLabelRow.appendChild(infoLabel);
  infoLabelRow.appendChild(requiredBadge);

  const textarea = document.createElement('textarea');
  textarea.id = 'reportMessageInput';
  textarea.className = 'report-form-textarea';
  textarea.placeholder = 'Describe the issue in detail...';
  textarea.rows = 6;

  const statusEl = document.createElement('p');
  statusEl.id = 'reportFormStatus';
  statusEl.className = 'report-form-status';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'report-form-submit';
  submitBtn.textContent = 'Submit Report';
  submitBtn.addEventListener('click', () => {
    if (!selectedType) { showFormError('Please select a report type.'); return; }
    if (!textarea.value.trim()) { showFormError('Please provide information about the issue.'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    submitReport(db, currentUser, selectedType, textarea.value.trim()).then(() => {
      closeReportForm();
    }).catch(err => {
      showFormError(err.message || 'Failed to submit report.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
    });
  });

  body.appendChild(typeLabel);
  body.appendChild(dropdownWrap);
  body.appendChild(infoLabelRow);
  body.appendChild(textarea);
  body.appendChild(statusEl);
  body.appendChild(submitBtn);

  content.appendChild(header);
  content.appendChild(body);
  modalEl.appendChild(backdrop);
  modalEl.appendChild(content);
  document.body.appendChild(modalEl);

  function showFormError(msg) { if (statusEl) statusEl.textContent = msg; }
}

function closeReportForm() {
  if (!modalEl) return;
  closeWithAnimation(modalEl, () => { modalEl.style.display = 'none'; });
}

function closeDetailModal() {
  if (!detailModalEl) return;
  closeWithAnimation(detailModalEl, () => { detailModalEl.style.display = 'none'; });
}

async function submitReport(db, currentUser, type, message) {
  const reportRef = await addDoc(collection(db, 'reports'), {
    reporterUid: currentUser.uid,
    reporterName: (currentUser.displayName || '').trim() || currentUser.email || 'Unknown',
    reporterEmail: currentUser.email || '',
    type,
    message,
    status: 'open',
    ownerNote: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  const body = `${currentUser.displayName || currentUser.email || 'A user'} has submitted a new report`;

  const ownerUid = await getOwnerUid(db);
  if (ownerUid) {
    await createNotification(db, ownerUid, 'report', 'New Report', body, {
      section: 'important',
      reportId: reportRef.id
    });
  }

  await createNotification(db, currentUser.uid, 'report_submitted', 'Report Submitted', 'Your report has been received and is awaiting review.', {
    reportId: reportRef.id
  });
}

export function showReportDetail(db, reportId, currentUser) {
  getDoc(doc(db, 'reports', reportId)).then(snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    const isReporter = currentUser.uid === data.reporterUid;

    if (detailModalEl) { detailModalEl.remove(); detailModalEl = null; }

    detailModalEl = document.createElement('div');
    detailModalEl.className = 'settings-modal';
    detailModalEl.style.display = 'flex';

    const backdrop = document.createElement('div');
    backdrop.className = 'settings-modal-backdrop';
    backdrop.addEventListener('click', closeDetailModal);

    const content = document.createElement('div');
    content.className = 'settings-modal-content';

    const header = document.createElement('div');
    header.className = 'settings-modal-header';
    header.innerHTML = '<h2>Report Details</h2>';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-modal-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close report detail');
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', closeDetailModal);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'settings-modal-body';

    const dateStr = formatReportDate(data.createdAt);
    const statusLabel = formatStatus(data.status);

    if (!isReporter) {
      // Owner view
      body.innerHTML = `
        <div class="report-detail-grid">
          <div class="report-detail-field"><span class="report-detail-label">Report ID</span><span class="report-detail-value">${escapeHtml(reportId)}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Username</span><span class="report-detail-value">${escapeHtml(data.reporterName || '')}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">User ID</span><span class="report-detail-value">${escapeHtml(data.reporterUid || '')}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Report Type</span><span class="report-detail-value">${escapeHtml(data.type || '')}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Report Message</span><span class="report-detail-value report-detail-message">${escapeHtml(data.message || '')}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Date Submitted</span><span class="report-detail-value">${escapeHtml(dateStr)}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Current Status</span><span class="report-detail-value report-status report-status-${escapeHtml(data.status || 'open')}">${statusLabel}</span></div>
        </div>
        <div class="report-owner-actions" id="reportOwnerActions">
          <label class="report-form-label">Update Status</label>
          <div class="report-status-btns">
            ${data.status !== 'in_review' ? `<button type="button" class="report-status-btn is-review" data-status="in_review">Mark In Review</button>` : ''}
            ${data.status !== 'resolved' ? `<button type="button" class="report-status-btn is-resolved" data-status="resolved">Mark Resolved</button>` : ''}
            ${data.status !== 'closed' ? `<button type="button" class="report-status-btn is-closed" data-status="closed">Mark Closed</button>` : ''}
          </div>
          <label class="report-form-label" style="margin-top:16px;">Owner Note</label>
          <p class="report-form-hint">Optional. This note will be visible to the reporting user.</p>
          <textarea id="reportOwnerNoteInput" class="report-form-textarea" placeholder="e.g. Thank you for the report. This issue has now been corrected." rows="3">${escapeHtml(data.ownerNote || '')}</textarea>
          <button type="button" class="report-form-submit" id="reportSaveOwnerBtn">Save Changes</button>
          <p id="reportOwnerStatus" class="report-form-status"></p>
        </div>
      `;
    } else {
      // Reporter view (user who submitted)
      const ownerNoteHtml = data.ownerNote ? `<div class="report-detail-field"><span class="report-detail-label">Owner Note</span><span class="report-detail-value report-detail-note">${escapeHtml(data.ownerNote)}</span></div>` : '';
      body.innerHTML = `
        <div class="report-detail-grid">
          <div class="report-detail-field"><span class="report-detail-label">Report Type</span><span class="report-detail-value">${escapeHtml(data.type || '')}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Date Submitted</span><span class="report-detail-value">${escapeHtml(dateStr)}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Current Status</span><span class="report-detail-value report-status report-status-${escapeHtml(data.status || 'open')}">${statusLabel}</span></div>
          <div class="report-detail-field"><span class="report-detail-label">Original Report Message</span><span class="report-detail-value report-detail-message">${escapeHtml(data.message || '')}</span></div>
          ${ownerNoteHtml}
        </div>
      `;
    }

    content.appendChild(header);
    content.appendChild(body);
    detailModalEl.appendChild(backdrop);
    detailModalEl.appendChild(content);
    document.body.appendChild(detailModalEl);

    // Wire owner actions
    const actionsDiv = body.querySelector('#reportOwnerActions');
    if (actionsDiv) {
      actionsDiv.querySelectorAll('.report-status-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newStatus = btn.getAttribute('data-status');
          const note = body.querySelector('#reportOwnerNoteInput')?.value?.trim() || '';
          const statusEl = body.querySelector('#reportOwnerStatus');
          try {
            await updateReportStatus(db, reportId, newStatus, note, data.reporterUid);
            closeDetailModal();
          } catch (err) {
            if (statusEl) statusEl.textContent = 'Failed to update: ' + (err.message || String(err));
          }
        });
      });

      const saveBtn = body.querySelector('#reportSaveOwnerBtn');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const note = body.querySelector('#reportOwnerNoteInput')?.value?.trim() || '';
          const statusEl = body.querySelector('#reportOwnerStatus');
          try {
            const ref = doc(db, 'reports', reportId);
            await setDoc(ref, { ownerNote: note, updatedAt: serverTimestamp() }, { merge: true });
            if (statusEl) { statusEl.textContent = 'Changes saved.'; statusEl.style.color = 'var(--accent)'; }
          } catch (err) {
            if (statusEl) statusEl.textContent = 'Failed to save: ' + (err.message || String(err));
          }
        });
      }
    }
  });
}

async function updateReportStatus(db, reportId, newStatus, ownerNote, reporterUid) {
  const ref = doc(db, 'reports', reportId);
  await setDoc(ref, { status: newStatus, ownerNote: ownerNote || '', updatedAt: serverTimestamp() }, { merge: true });

  const statusMessages = {
    in_review: 'Your report is now being reviewed.',
    resolved: 'Your report has been resolved.',
    closed: 'Your report has been closed.'
  };
  const msg = statusMessages[newStatus];
  if (msg && reporterUid) {
    await createNotification(db, reporterUid, 'report_status', 'Report Status Updated', msg, { reportId });
  }
}

export function initReportButton(db, currentUser) {
  const bubble = document.querySelector('.bottom-tools-bubble');
  if (!bubble) return;
  if (bubble.querySelector('.report-tools-btn')) return;

  const reportBtn = document.createElement('button');
  reportBtn.type = 'button';
  reportBtn.className = 'ctrl-btn report-tools-btn';
  reportBtn.title = 'Report an issue';
  reportBtn.setAttribute('aria-label', 'Report an issue');
  reportBtn.innerHTML = '<svg class="ctrl-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 1 10 10c0 2.3-.8 4.5-2.2 6.2a10 10 0 0 1-8.3 3.6"/><path d="M12 6v6"/><path d="M12 16h.01"/><circle cx="12" cy="12" r="10"/></svg>';
  reportBtn.addEventListener('click', () => showReportForm(db, currentUser));

  bubble.appendChild(reportBtn);
}

function formatReportDate(ts) {
  if (!ts) return '';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : (ts.seconds ? new Date(ts.seconds * 1000) : (ts instanceof Date ? ts : new Date(ts)));
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatStatus(status) {
  const map = { open: 'Open', in_review: 'In Review', resolved: 'Resolved', closed: 'Closed' };
  return map[status] || status || 'Open';
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('click', closeDropdowns);
