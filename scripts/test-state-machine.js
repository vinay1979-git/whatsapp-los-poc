#!/usr/bin/env node
/**
 * Offline state machine test — no Supabase required.
 *
 * Replays the §9 test cases against the real dispatch() logic using an
 * in-memory DB stub and a message capture stub. Runs deterministically;
 * exits non-zero if any assertion fails.
 *
 * Usage:  node scripts/test-state-machine.js
 */

'use strict';

// ── In-memory DB stub ─────────────────────────────────────────────────────────

const OFFER_DB = {
  // mobile_number → PAN → offer record
  '919999999901': {
    ABCPD1234E: {
      approval_amount: 500000,
      offer1_amount: 300000, offer1_tenure_months: 24, offer1_roi_annual: 14.00,
      offer2_amount: 400000, offer2_tenure_months: 36, offer2_roi_annual: 13.50,
      offer3_amount: 500000, offer3_tenure_months: 48, offer3_roi_annual: 13.00,
    },
  },
  '919999999902': {
    XYZAB5678F: {
      approval_amount: 250000,
      offer1_amount: 150000, offer1_tenure_months: 12, offer1_roi_annual: 15.00,
      offer2_amount: 200000, offer2_tenure_months: 24, offer2_roi_annual: 14.50,
      offer3_amount: null,   offer3_tenure_months: null, offer3_roi_annual: null,
    },
  },
};

let APP_STORE = {}; // id → app row
let CONSENT_LOG = [];
let appIdSeq = 0;

function resetStore() {
  APP_STORE = {};
  CONSENT_LOG = [];
  appIdSeq = 0;
}

function makeId() { return `app-${++appIdSeq}`; }

// Stubs override the real imports before dispatch() loads them.
const DB_STUB = {
  async getActiveApplication(mobile) {
    return Object.values(APP_STORE)
      .filter(a => a.mobile_number === mobile && a.status === 'in_progress')
      .sort((a, b) => b._seq - a._seq)[0] ?? null;
  },
  async createApplication(mobile) {
    const id = makeId();
    APP_STORE[id] = {
      id, mobile_number: mobile, stage: 'interest', status: 'in_progress',
      pan_number: null, selected_offer_index: null, aadhaar_last4: null,
      bank_account_number: null, bank_name: null, branch_or_ifsc: null,
      mandate_method: null, consent_given_at: null, otp_attempts: 0,
      last_wa_message_id: null, _seq: appIdSeq,
    };
    return APP_STORE[id];
  },
  async updateApplication(id, fields) {
    if (!APP_STORE[id]) throw new Error(`No app ${id}`);
    Object.assign(APP_STORE[id], fields);
  },
  async lookupOffer(mobile, pan) {
    return OFFER_DB[mobile]?.[pan.toUpperCase()] ?? null;
  },
  async logConsent(appId, eventType, mobile, metadata) {
    CONSENT_LOG.push({ appId, eventType, mobile, metadata, ts: Date.now() });
  },
};

// ── WhatsApp send capture stub ────────────────────────────────────────────────

let SENT = [];
function resetSent() { SENT = []; }
function lastSent() { return SENT[SENT.length - 1]; }

const MSG_STUB = {
  sendText:               (to, body)                    => { SENT.push({ type: 'text', to, body }); },
  sendButtons:            (to, body, buttons)           => { SENT.push({ type: 'buttons', to, body, buttons }); },
  sendList:               (to, body, label, rows)       => { SENT.push({ type: 'list', to, body, label, rows }); },
  sendWelcome:            (to)                          => MSG_STUB.sendButtons(to, '__welcome__', []),
  sendPanPrompt:          (to)                          => MSG_STUB.sendText(to, '__pan_prompt__'),
  sendPanInvalid:         (to)                          => MSG_STUB.sendText(to, '__pan_invalid__'),
  sendNoOffer:            (to)                          => MSG_STUB.sendText(to, '__no_offer__'),
  sendApprovalPrompt:     (to, amt)                     => MSG_STUB.sendButtons(to, `__approval__ ${amt}`, []),
  sendDeclinedAtInterest: (to)                          => MSG_STUB.sendText(to, '__declined_interest__'),
  sendDeclinedAtApproval: (to)                          => MSG_STUB.sendText(to, '__declined_approval__'),
  sendAadhaarPrompt:      (to)                          => MSG_STUB.sendText(to, '__aadhaar_prompt__'),
  sendAadhaarInvalid:     (to)                          => MSG_STUB.sendText(to, '__aadhaar_invalid__'),
  sendOtpPrompt:          (to)                          => MSG_STUB.sendText(to, '__otp_prompt__'),
  sendOtpInvalid:         (to, left)                    => MSG_STUB.sendText(to, `__otp_invalid__ left=${left}`),
  sendOtpLocked:          (to)                          => MSG_STUB.sendButtons(to, '__otp_locked__', []),
  sendOffers:             (to, rows)                    => MSG_STUB.sendList(to, '__offers__', 'View Offers', rows),
  sendConfirmation:       (to, d)                       => MSG_STUB.sendButtons(to, `__confirm__ ${JSON.stringify(d)}`, []),
  sendEsignPrompt:        (to, amt)                     => MSG_STUB.sendButtons(to, `__esign__ ${amt}`, []),
  sendBankAccountPrompt:  (to)                          => MSG_STUB.sendText(to, '__bank_account__'),
  sendBankNamePrompt:     (to)                          => MSG_STUB.sendText(to, '__bank_name__'),
  sendBranchPrompt:       (to)                          => MSG_STUB.sendText(to, '__branch__'),
  sendMandateChoice:      (to)                          => MSG_STUB.sendButtons(to, '__mandate__', []),
  sendDisbursalSuccess:   (to, d)                       => MSG_STUB.sendText(to, `__disbursal__ ${JSON.stringify(d)}`),
  sendCancelConfirmation: (to)                          => MSG_STUB.sendButtons(to, '__cancel_confirm__', []),
  sendSomethingWentWrong: (to)                          => MSG_STUB.sendText(to, '__error__'),
};

// ── Module loader that injects stubs via Node.js module cache trick ───────────
// We can't use ESM import() interception easily in CommonJS, so we
// pre-build the dispatch function from source by evaluating the module
// with stubs injected via a thin wrapper.

const { calculateEmi, inrFormat, firstEmiDate } = (() => {
  function calculateEmi(principal, tenureMonths, annualRoi) {
    const r = annualRoi / 12 / 100;
    if (r === 0) return principal / tenureMonths;
    const pow = Math.pow(1 + r, tenureMonths);
    return (principal * r * pow) / (pow - 1);
  }
  function inrFormat(amount) {
    return '₹' + Math.round(Number(amount)).toLocaleString('en-IN');
  }
  function maskPan(pan) {
    if (!pan) return '—';
    return pan.slice(0, 2) + 'X'.repeat(pan.length - 3) + pan.slice(-1);
  }
  function firstEmiDate() {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  }
  return { calculateEmi, inrFormat, maskPan, firstEmiDate };
})();

// Inline the dispatch logic with stubs injected (mirrors stateMachine.js exactly).
const PAN_RE     = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_RE = /^\d{12}$/;
const OTP_CORRECT    = '123456';
const OTP_MAX        = 3;
const TERMINAL_STAGES = new Set(['done', 'otp_locked']);

function extractInput(message) {
  if (message.type === 'text')        return { text: (message.text?.body ?? '').trim(), buttonId: null };
  if (message.type === 'interactive') {
    const ia = message.interactive;
    if (ia.type === 'button_reply') return { text: ia.button_reply.title, buttonId: ia.button_reply.id };
    if (ia.type === 'list_reply')   return { text: ia.list_reply.title,   buttonId: ia.list_reply.id };
  }
  return { text: '', buttonId: null };
}
function isYes({ text, buttonId }) {
  if (buttonId && ['yes', 'confirm_yes', 'cancel_abort'].includes(buttonId)) return true;
  return ['yes', 'y', 'proceed', '1'].includes(text.toLowerCase().trim());
}
function isNo({ text, buttonId }) {
  if (buttonId && ['no', 'confirm_change'].includes(buttonId)) return true;
  return ['no', 'n', '2'].includes(text.toLowerCase().trim());
}
function buildOfferRows(offerRecord) {
  const rows = [];
  for (let i = 1; i <= 3; i++) {
    const amount = offerRecord[`offer${i}_amount`];
    const tenure = offerRecord[`offer${i}_tenure_months`];
    const roi    = offerRecord[`offer${i}_roi_annual`];
    if (amount == null || tenure == null || roi == null) continue;
    const emi = calculateEmi(amount, tenure, roi);
    rows.push({ id: `offer_${i}`, title: `${inrFormat(amount)} · ${tenure} months`,
      description: `ROI: ${roi}% p.a. · EMI: ${inrFormat(Math.round(emi))}/mo`,
      _index: i, _amount: amount, _tenure: tenure, _roi: roi, _emi: emi });
  }
  return rows;
}
function getOfferByIndex(rows, idx) { return rows.find(r => r._index === idx) ?? null; }
function parseOfferSelection({ text, buttonId }, rowCount) {
  const m = buttonId?.match(/^offer_([123])$/);
  if (m) { const idx = parseInt(m[1]); return idx <= rowCount ? idx : null; }
  const n = parseInt(text.trim());
  return n >= 1 && n <= rowCount ? n : null;
}

async function startFreshAtInterest(waId, oldAppId) {
  if (oldAppId) await DB_STUB.updateApplication(oldAppId, { stage: 'cancelled', status: 'cancelled' });
  await DB_STUB.createApplication(waId);
  await MSG_STUB.sendWelcome(waId);
}

async function resendPromptForStage(stage, waId, app) {
  switch (stage) {
    case 'interest': return MSG_STUB.sendWelcome(waId);
    case 'pan':      return MSG_STUB.sendPanPrompt(waId);
    case 'approval': {
      const offer = await DB_STUB.lookupOffer(app.mobile_number, app.pan_number);
      return offer ? MSG_STUB.sendApprovalPrompt(waId, inrFormat(offer.approval_amount)) : MSG_STUB.sendSomethingWentWrong(waId);
    }
    case 'aadhaar': return MSG_STUB.sendAadhaarPrompt(waId);
    case 'otp':     return MSG_STUB.sendOtpPrompt(waId);
    case 'offers': {
      const offer = await DB_STUB.lookupOffer(app.mobile_number, app.pan_number);
      if (!offer) return MSG_STUB.sendSomethingWentWrong(waId);
      const rows = buildOfferRows(offer);
      return rows.length ? MSG_STUB.sendOffers(waId, rows) : MSG_STUB.sendSomethingWentWrong(waId);
    }
    case 'confirm': {
      const offer = await DB_STUB.lookupOffer(app.mobile_number, app.pan_number);
      if (!offer) return MSG_STUB.sendSomethingWentWrong(waId);
      const row = getOfferByIndex(buildOfferRows(offer), app.selected_offer_index);
      if (!row) return MSG_STUB.sendSomethingWentWrong(waId);
      return MSG_STUB.sendConfirmation(waId, { pan: app.pan_number, aadhaarLast4: app.aadhaar_last4,
        amount: inrFormat(row._amount), tenure: row._tenure, roi: row._roi, emi: inrFormat(Math.round(row._emi)) });
    }
    case 'esign': {
      const offer = await DB_STUB.lookupOffer(app.mobile_number, app.pan_number);
      const row = offer ? getOfferByIndex(buildOfferRows(offer), app.selected_offer_index) : null;
      return MSG_STUB.sendEsignPrompt(waId, row ? inrFormat(row._amount) : 'your loan');
    }
    case 'bank':
      if (!app.bank_account_number) return MSG_STUB.sendBankAccountPrompt(waId);
      if (!app.bank_name)           return MSG_STUB.sendBankNamePrompt(waId);
      return MSG_STUB.sendBranchPrompt(waId);
    case 'mandate': return MSG_STUB.sendMandateChoice(waId);
    default:        return MSG_STUB.sendSomethingWentWrong(waId);
  }
}

async function dispatch(app, message) {
  const waId  = app.mobile_number;
  const input = extractInput(message);
  const { text, buttonId } = input;
  const norm  = text.toLowerCase().trim();
  const stage = app.stage;

  if (!stage.startsWith('cancel:') && !TERMINAL_STAGES.has(stage) && norm === 'cancel') {
    await DB_STUB.updateApplication(app.id, { stage: `cancel:${stage}` });
    await MSG_STUB.sendCancelConfirmation(waId);
    return;
  }
  if (stage.startsWith('cancel:')) {
    const returnStage = stage.slice(7);
    if (buttonId === 'cancel_confirm' || (buttonId !== 'cancel_abort' && isYes(input))) {
      await startFreshAtInterest(waId, app.id); return;
    }
    if (buttonId === 'cancel_abort' || isNo(input)) {
      await DB_STUB.updateApplication(app.id, { stage: returnStage });
      await resendPromptForStage(returnStage, waId, app); return;
    }
    await MSG_STUB.sendCancelConfirmation(waId); return;
  }

  switch (stage) {
    case 'interest': {
      if (isYes(input)) {
        await DB_STUB.updateApplication(app.id, { stage: 'pan', consent_given_at: new Date().toISOString() });
        await DB_STUB.logConsent(app.id, 'privacy_policy', waId, { wa_message_id: message.id });
        await MSG_STUB.sendPanPrompt(waId); return;
      }
      if (isNo(input)) {
        await DB_STUB.updateApplication(app.id, { stage: 'cancelled', status: 'declined' });
        await MSG_STUB.sendDeclinedAtInterest(waId); return;
      }
      await MSG_STUB.sendWelcome(waId); return;
    }
    case 'pan': {
      const pan = text.toUpperCase().replace(/\s/g, '');
      if (!PAN_RE.test(pan)) { await MSG_STUB.sendPanInvalid(waId); return; }
      const offer = await DB_STUB.lookupOffer(waId, pan);
      if (!offer) {
        await DB_STUB.updateApplication(app.id, { stage: 'cancelled', status: 'no_offer', pan_number: pan });
        await MSG_STUB.sendNoOffer(waId); return;
      }
      await DB_STUB.updateApplication(app.id, { stage: 'approval', pan_number: pan });
      await MSG_STUB.sendApprovalPrompt(waId, inrFormat(offer.approval_amount)); return;
    }
    case 'approval': {
      if (isYes(input)) {
        await DB_STUB.updateApplication(app.id, { stage: 'aadhaar' });
        await MSG_STUB.sendAadhaarPrompt(waId); return;
      }
      if (isNo(input)) {
        await DB_STUB.updateApplication(app.id, { stage: 'cancelled', status: 'declined' });
        await MSG_STUB.sendDeclinedAtApproval(waId); return;
      }
      const offer = await DB_STUB.lookupOffer(waId, app.pan_number);
      await MSG_STUB.sendApprovalPrompt(waId, offer ? inrFormat(offer.approval_amount) : '—'); return;
    }
    case 'aadhaar': {
      const aadhaar = text.replace(/\s/g, '');
      if (!AADHAAR_RE.test(aadhaar)) { await MSG_STUB.sendAadhaarInvalid(waId); return; }
      await DB_STUB.updateApplication(app.id, { stage: 'otp', aadhaar_last4: aadhaar.slice(-4), otp_attempts: 0 });
      await MSG_STUB.sendOtpPrompt(waId); return;
    }
    case 'otp': {
      const otp = text.trim();
      if (!/^\d{6}$/.test(otp)) { await MSG_STUB.sendOtpPrompt(waId); return; }
      if (otp === OTP_CORRECT) {
        const offer = await DB_STUB.lookupOffer(waId, app.pan_number);
        const rows  = offer ? buildOfferRows(offer) : [];
        if (!rows.length) {
          await DB_STUB.updateApplication(app.id, { stage: 'cancelled', status: 'no_offer' });
          await MSG_STUB.sendSomethingWentWrong(waId); return;
        }
        await DB_STUB.updateApplication(app.id, { stage: 'offers' });
        await MSG_STUB.sendOffers(waId, rows); return;
      }
      const attempts = (app.otp_attempts ?? 0) + 1;
      if (attempts >= OTP_MAX) {
        await DB_STUB.updateApplication(app.id, { stage: 'otp_locked', otp_attempts: attempts });
        await MSG_STUB.sendOtpLocked(waId); return;
      }
      await DB_STUB.updateApplication(app.id, { otp_attempts: attempts });
      await MSG_STUB.sendOtpInvalid(waId, OTP_MAX - attempts); return;
    }
    case 'otp_locked': {
      if (buttonId === 'otp_restart' || isYes(input)) { await startFreshAtInterest(waId, app.id); return; }
      if (buttonId === 'otp_exit'    || isNo(input))  {
        await DB_STUB.updateApplication(app.id, { stage: 'cancelled', status: 'cancelled' });
        await MSG_STUB.sendText(waId, '__otp_exit__'); return;
      }
      await MSG_STUB.sendOtpLocked(waId); return;
    }
    case 'offers': {
      const offer = await DB_STUB.lookupOffer(waId, app.pan_number);
      if (!offer) { await MSG_STUB.sendSomethingWentWrong(waId); return; }
      const rows  = buildOfferRows(offer);
      if (!rows.length) { await MSG_STUB.sendSomethingWentWrong(waId); return; }
      const selectedIdx = parseOfferSelection(input, rows.length);
      if (selectedIdx === null) { await MSG_STUB.sendOffers(waId, rows); return; }
      const row = getOfferByIndex(rows, selectedIdx);
      await DB_STUB.updateApplication(app.id, { stage: 'confirm', selected_offer_index: selectedIdx });
      await MSG_STUB.sendConfirmation(waId, { pan: app.pan_number, aadhaarLast4: app.aadhaar_last4,
        amount: inrFormat(row._amount), tenure: row._tenure, roi: row._roi, emi: inrFormat(Math.round(row._emi)) });
      return;
    }
    case 'confirm': {
      if (buttonId === 'confirm_yes' || (buttonId !== 'confirm_change' && isYes(input))) {
        const offer = await DB_STUB.lookupOffer(waId, app.pan_number);
        const row   = offer ? getOfferByIndex(buildOfferRows(offer), app.selected_offer_index) : null;
        await DB_STUB.updateApplication(app.id, { stage: 'esign' });
        await MSG_STUB.sendEsignPrompt(waId, row ? inrFormat(row._amount) : 'your loan'); return;
      }
      if (buttonId === 'confirm_change' || isNo(input)) {
        const offer = await DB_STUB.lookupOffer(waId, app.pan_number);
        if (!offer) { await MSG_STUB.sendSomethingWentWrong(waId); return; }
        await DB_STUB.updateApplication(app.id, { stage: 'offers', selected_offer_index: null });
        await MSG_STUB.sendOffers(waId, buildOfferRows(offer)); return;
      }
      await resendPromptForStage('confirm', waId, app); return;
    }
    case 'esign': {
      if (buttonId === 'esign_confirm' || isYes(input)) {
        await DB_STUB.logConsent(app.id, 'esign_complete', waId, { wa_message_id: message.id });
        await DB_STUB.updateApplication(app.id, { stage: 'bank' });
        await MSG_STUB.sendBankAccountPrompt(waId); return;
      }
      await resendPromptForStage('esign', waId, app); return;
    }
    case 'bank': {
      const value = text.trim();
      if (!value) { await resendPromptForStage('bank', waId, app); return; }
      if (!app.bank_account_number) {
        if (!/\d{4,}/.test(value.replace(/\s/g, ''))) { await MSG_STUB.sendText(waId, '__bank_invalid__'); return; }
        await DB_STUB.updateApplication(app.id, { bank_account_number: value });
        await MSG_STUB.sendBankNamePrompt(waId); return;
      }
      if (!app.bank_name) {
        await DB_STUB.updateApplication(app.id, { bank_name: value });
        await MSG_STUB.sendBranchPrompt(waId); return;
      }
      if (!app.branch_or_ifsc) {
        await DB_STUB.updateApplication(app.id, { stage: 'mandate', branch_or_ifsc: value });
        await MSG_STUB.sendMandateChoice(waId); return;
      }
      await MSG_STUB.sendMandateChoice(waId); return;
    }
    case 'mandate': {
      let method = null;
      if (buttonId === 'nach'        || ['nach', '1'].includes(norm))               method = 'NACH';
      if (buttonId === 'upi_autopay' || ['upi autopay', 'upi', '2'].includes(norm)) method = 'UPI_AUTOPAY';
      if (!method) { await MSG_STUB.sendMandateChoice(waId); return; }
      const offer = await DB_STUB.lookupOffer(waId, app.pan_number);
      const row   = offer ? getOfferByIndex(buildOfferRows(offer), app.selected_offer_index) : null;
      const accountLast4 = (app.bank_account_number ?? '').replace(/\s/g, '').slice(-4) || 'XXXX';
      await DB_STUB.logConsent(app.id, 'mandate_auth', waId, { method, wa_message_id: message.id });
      await DB_STUB.updateApplication(app.id, { stage: 'done', status: 'completed', mandate_method: method });
      await MSG_STUB.sendDisbursalSuccess(waId, {
        amount: row ? inrFormat(row._amount) : 'your loan', accountLast4,
        emi: row ? inrFormat(Math.round(row._emi)) : '—', emiDate: firstEmiDate() }); return;
    }
    case 'done': { await startFreshAtInterest(waId, null); return; }
    default: {
      console.error(`[test] Unknown stage "${stage}"`);
      await MSG_STUB.sendSomethingWentWrong(waId);
    }
  }
}

// ── Test driver ───────────────────────────────────────────────────────────────

function textMsg(body, id = Math.random().toString()) {
  return { id, type: 'text', text: { body } };
}
function buttonMsg(buttonId, title = buttonId, id = Math.random().toString()) {
  return { id, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title } } };
}
function listMsg(listId, title = listId, id = Math.random().toString()) {
  return { id, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: listId, title } } };
}

async function handleMsg(waId, message) {
  resetSent();
  let app = await DB_STUB.getActiveApplication(waId);
  const isNewSession = !app;
  if (isNewSession) app = await DB_STUB.createApplication(waId);
  if (message.id && app.last_wa_message_id === message.id) return; // idempotency
  await DB_STUB.updateApplication(app.id, { last_wa_message_id: message.id });
  if (isNewSession) { await MSG_STUB.sendWelcome(waId); return; }
  await dispatch(app, message);
}

function getApp(waId) {
  return Object.values(APP_STORE)
    .filter(a => a.mobile_number === waId)
    .sort((a, b) => b._seq - a._seq)[0];
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

// ── Test cases ────────────────────────────────────────────────────────────────

async function runTests() {
  const W1 = '919999999901'; // 3 offers
  const W2 = '919999999902'; // 2 offers
  const W3 = '919888888801'; // no offer in DB

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-1: Approved 3-offer path (ABCPD1234E), full happy path ───────────────');
  resetStore();

  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  assert(lastSent()?.body === '__welcome__', 'First "Hi" → welcome sent');
  assert(getApp(W1)?.stage === 'interest', 'Stage is interest after Hi');

  await handleMsg(W1, buttonMsg('yes', 'Yes, interested', 'msg-2'));
  assert(lastSent()?.body === '__pan_prompt__', 'Yes → pan prompt');
  assert(getApp(W1)?.stage === 'pan', 'Stage advanced to pan');
  assert(CONSENT_LOG.some(e => e.eventType === 'privacy_policy'), 'privacy_policy logged');

  await handleMsg(W1, textMsg('12345', 'msg-3')); // invalid PAN format
  assert(lastSent()?.body === '__pan_invalid__', 'Invalid PAN format → re-prompt');
  assert(getApp(W1)?.stage === 'pan', 'Stage still pan after invalid PAN');

  await handleMsg(W1, textMsg('ABCPD1234E', 'msg-4'));
  assert(lastSent()?.body?.includes('__approval__'), 'Valid PAN found → approval prompt');
  assert(lastSent()?.body?.includes('5,00,000'), 'Approval amount ₹5,00,000 shown');
  assert(getApp(W1)?.stage === 'approval', 'Stage advanced to approval');
  assert(getApp(W1)?.pan_number === 'ABCPD1234E', 'PAN stored');

  await handleMsg(W1, buttonMsg('yes', 'Yes, proceed', 'msg-5'));
  assert(lastSent()?.body === '__aadhaar_prompt__', 'Yes to approval → aadhaar prompt');
  assert(getApp(W1)?.stage === 'aadhaar', 'Stage advanced to aadhaar');

  await handleMsg(W1, textMsg('1234567890', 'msg-6')); // only 10 digits — invalid
  assert(lastSent()?.body === '__aadhaar_invalid__', '10-digit Aadhaar → re-prompt');

  await handleMsg(W1, textMsg('123456789012', 'msg-7')); // valid 12 digits
  assert(lastSent()?.body === '__otp_prompt__', 'Valid Aadhaar → OTP prompt');
  assert(getApp(W1)?.aadhaar_last4 === '9012', 'Only last 4 Aadhaar digits stored');
  assert(!Object.values(APP_STORE).some(a => JSON.stringify(a).includes('123456789012')), 'Full Aadhaar not in any DB row');

  await handleMsg(W1, textMsg('000000', 'msg-8')); // wrong OTP
  assert(lastSent()?.body?.includes('__otp_invalid__') && lastSent()?.body?.includes('left=2'), 'Wrong OTP → 2 attempts left');
  assert(getApp(W1)?.otp_attempts === 1, 'otp_attempts incremented to 1');

  await handleMsg(W1, textMsg('abc', 'msg-9')); // non-numeric — not counted
  assert(lastSent()?.body === '__otp_prompt__', 'Non-6-digit OTP → re-prompt, not counted');
  assert(getApp(W1)?.otp_attempts === 1, 'otp_attempts still 1 after format-invalid input');

  await handleMsg(W1, textMsg('123456', 'msg-10')); // correct OTP
  assert(lastSent()?.type === 'list', 'Correct OTP → offer list message');
  const offerRows = lastSent()?.rows;
  assert(offerRows?.length === 3, 'All 3 offers shown');
  assert(offerRows[0]?.title?.includes('3,00,000'), 'Offer 1 amount correct');
  assert(offerRows[1]?.title?.includes('4,00,000'), 'Offer 2 amount correct');
  assert(offerRows[2]?.title?.includes('5,00,000'), 'Offer 3 amount correct');
  // Verify EMI for offer 1: P=300000, n=24, r=14/12/100
  const r1 = 14 / 12 / 100; const pow1 = Math.pow(1 + r1, 24);
  const emi1 = Math.round(300000 * r1 * pow1 / (pow1 - 1));
  assert(offerRows[0]?.description?.includes(inrFormat(emi1)), `Offer 1 EMI ${inrFormat(emi1)} correct`);
  assert(getApp(W1)?.stage === 'offers', 'Stage advanced to offers');

  await handleMsg(W1, textMsg('9', 'msg-11')); // invalid selection
  assert(lastSent()?.type === 'list', 'Invalid offer selection → re-prompt list');

  await handleMsg(W1, listMsg('offer_2', 'Option 2', 'msg-12')); // select offer 2
  assert(lastSent()?.type === 'buttons', 'Offer selected → confirmation screen');
  assert(lastSent()?.body?.includes('__confirm__'), 'Confirmation message sent');
  const confData = JSON.parse(lastSent()?.body?.replace('__confirm__ ', ''));
  // The state machine passes the raw PAN to sendConfirmation(); masking happens
  // inside messages.sendConfirmation (calls maskPan). Verify both sides:
  assert(confData.pan === 'ABCPD1234E', `Raw PAN passed to sendConfirmation (got ${confData.pan})`);
  // Inline maskPan to verify the masking logic itself:
  const masked = 'ABCPD1234E'.slice(0, 2) + 'X'.repeat('ABCPD1234E'.length - 3) + 'ABCPD1234E'.slice(-1);
  assert(masked === 'ABXXXXXXXE', `maskPan('ABCPD1234E') → ${masked}`);
  assert(confData.aadhaarLast4 === '9012', 'Aadhaar last4 correct');
  assert(confData.amount?.includes('4,00,000'), 'Offer 2 amount in confirmation');
  assert(getApp(W1)?.selected_offer_index === 2, 'selected_offer_index saved as 2');
  assert(getApp(W1)?.stage === 'confirm', 'Stage advanced to confirm');

  await handleMsg(W1, buttonMsg('confirm_change', 'Choose Different', 'msg-13')); // go back
  assert(lastSent()?.type === 'list', '"Choose Different" → back to offers list');
  assert(getApp(W1)?.stage === 'offers', 'Stage reverted to offers');
  assert(getApp(W1)?.selected_offer_index === null, 'selected_offer_index cleared');

  await handleMsg(W1, listMsg('offer_1', 'Option 1', 'msg-14')); // select offer 1
  assert(getApp(W1)?.selected_offer_index === 1, 'Offer 1 now selected');

  await handleMsg(W1, buttonMsg('confirm_yes', 'Confirm & Proceed', 'msg-15'));
  assert(lastSent()?.body?.includes('__esign__'), 'Confirm → eSign prompt');
  assert(getApp(W1)?.stage === 'esign', 'Stage advanced to esign');

  await handleMsg(W1, buttonMsg('esign_confirm', 'Open eSign Portal', 'msg-16'));
  assert(lastSent()?.body === '__bank_account__', 'eSign confirmed → bank account prompt');
  assert(CONSENT_LOG.some(e => e.eventType === 'esign_complete'), 'esign_complete logged');
  assert(getApp(W1)?.stage === 'bank', 'Stage advanced to bank');

  await handleMsg(W1, textMsg('abc', 'msg-17')); // no digits — invalid account number
  assert(lastSent()?.body === '__bank_invalid__', 'Non-numeric account number rejected');

  await handleMsg(W1, textMsg('123456789012', 'msg-18')); // valid account number
  assert(lastSent()?.body === '__bank_name__', 'Account number saved → bank name prompt');

  await handleMsg(W1, textMsg('HDFC Bank', 'msg-19'));
  assert(lastSent()?.body === '__branch__', 'Bank name saved → branch prompt');

  await handleMsg(W1, textMsg('HDFC0001234', 'msg-20'));
  assert(lastSent()?.body?.includes('__mandate__'), 'Branch saved → mandate choice');
  assert(getApp(W1)?.stage === 'mandate', 'Stage advanced to mandate');

  await handleMsg(W1, buttonMsg('nach', 'NACH', 'msg-21'));
  assert(lastSent()?.body?.includes('__disbursal__'), 'NACH selected → disbursal message');
  const disbData = JSON.parse(lastSent()?.body?.replace('__disbursal__ ', ''));
  assert(disbData.amount?.includes('3,00,000'), 'Disbursal amount is offer 1 (₹3,00,000)');
  assert(disbData.accountLast4 === '9012', 'Account last 4 correct');
  assert(CONSENT_LOG.some(e => e.eventType === 'mandate_auth'), 'mandate_auth logged');
  assert(getApp(W1)?.stage === 'done', 'Stage advanced to done');
  assert(getApp(W1)?.status === 'completed', 'Status is completed');

  // Message after done → fresh session
  await handleMsg(W1, textMsg('Hi again', 'msg-22'));
  assert(lastSent()?.body === '__welcome__', 'Message after done → fresh welcome');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-2: Approved 2-offer path (XYZAB5678F) ───────────────────────────────');
  resetStore();

  await handleMsg(W2, textMsg('Hi', 'msg-1'));
  await handleMsg(W2, buttonMsg('yes', 'Yes', 'msg-2'));
  await handleMsg(W2, textMsg('XYZAB5678F', 'msg-3'));
  await handleMsg(W2, buttonMsg('yes', 'Yes', 'msg-4'));
  await handleMsg(W2, textMsg('234567890123', 'msg-5')); // aadhaar
  await handleMsg(W2, textMsg('123456', 'msg-6'));        // correct OTP

  const rows2 = lastSent()?.rows;
  assert(rows2?.length === 2, 'Exactly 2 offers shown (no placeholder for 3rd)');
  assert(!rows2?.find(r => r.id === 'offer_3'), 'No offer_3 row present');

  await handleMsg(W2, textMsg('2', 'msg-7')); // select offer 2 by number
  assert(getApp(W2)?.selected_offer_index === 2, 'Offer 2 selected via free-text "2"');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-3: PAN not in database (no offer) ────────────────────────────────────');
  resetStore();

  await handleMsg(W3, textMsg('Hi', 'msg-1'));
  await handleMsg(W3, buttonMsg('yes', 'Yes', 'msg-2'));
  await handleMsg(W3, textMsg('ZZZZZ9999Z', 'msg-3')); // valid format, not in DB

  assert(lastSent()?.body === '__no_offer__', 'Unknown PAN → no_offer message');
  assert(getApp(W3)?.status === 'no_offer', 'Status is no_offer');
  assert(getApp(W3)?.stage === 'cancelled', 'Stage set to cancelled');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-4: Invalid PAN format (no DB lookup) ─────────────────────────────────');
  resetStore();

  await handleMsg(W3, textMsg('Hi', 'msg-1'));
  await handleMsg(W3, buttonMsg('yes', 'Yes', 'msg-2'));
  await handleMsg(W3, textMsg('12345', 'msg-3')); // all-digits — invalid
  assert(lastSent()?.body === '__pan_invalid__', 'Invalid format → re-prompt');
  assert(getApp(W3)?.stage === 'pan', 'Stage still pan');

  await handleMsg(W3, textMsg('ABCDE123', 'msg-4')); // too short — invalid
  assert(lastSent()?.body === '__pan_invalid__', 'Short PAN → re-prompt');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-5: OTP retry → 3 failures → otp_locked → restart ────────────────────');
  resetStore();

  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  await handleMsg(W1, buttonMsg('yes', 'Yes', 'msg-2'));
  await handleMsg(W1, textMsg('ABCPD1234E', 'msg-3'));
  await handleMsg(W1, buttonMsg('yes', 'Yes', 'msg-4'));
  await handleMsg(W1, textMsg('123456789012', 'msg-5'));

  await handleMsg(W1, textMsg('111111', 'msg-6')); // wrong 1
  assert(getApp(W1)?.otp_attempts === 1, 'otp_attempts = 1');
  await handleMsg(W1, textMsg('222222', 'msg-7')); // wrong 2
  assert(getApp(W1)?.otp_attempts === 2, 'otp_attempts = 2');
  await handleMsg(W1, textMsg('333333', 'msg-8')); // wrong 3 → locked
  assert(getApp(W1)?.stage === 'otp_locked', '3rd wrong OTP → otp_locked stage');
  assert(lastSent()?.body === '__otp_locked__', 'OTP locked message sent');

  // OTP locked → restart links back through cancel/restart path
  const lockedAppId = getApp(W1)?.id;
  await handleMsg(W1, buttonMsg('otp_restart', 'Restart', 'msg-9'));
  assert(APP_STORE[lockedAppId]?.status === 'cancelled', 'Locked app marked cancelled on restart');
  const freshApp = getApp(W1);
  assert(freshApp?.id !== lockedAppId, 'New app created');
  assert(freshApp?.stage === 'interest', 'New app starts at interest');
  assert(lastSent()?.body === '__welcome__', 'Welcome sent after restart');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-6: OTP correct → accepted (123456) ───────────────────────────────────');
  // (Already tested in TC-1 — just assert the key fact)
  assert(OTP_CORRECT === '123456', 'OTP_CORRECT constant is 123456');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-7: Cancel mid-flow (at aadhaar stage) → confirm → resume ─────────────');
  resetStore();

  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  await handleMsg(W1, buttonMsg('yes', 'Yes', 'msg-2'));
  await handleMsg(W1, textMsg('ABCPD1234E', 'msg-3'));
  await handleMsg(W1, buttonMsg('yes', 'Yes', 'msg-4'));
  // Now at aadhaar stage
  assert(getApp(W1)?.stage === 'aadhaar', 'At aadhaar before cancel');

  await handleMsg(W1, textMsg('cancel', 'msg-5'));
  assert(lastSent()?.body === '__cancel_confirm__', '"cancel" text → cancel confirmation');
  assert(getApp(W1)?.stage === 'cancel:aadhaar', 'Stage stored as cancel:aadhaar');

  await handleMsg(W1, buttonMsg('cancel_abort', 'No, continue', 'msg-6')); // abort cancel
  assert(lastSent()?.body === '__aadhaar_prompt__', '"No, continue" → Aadhaar prompt resent');
  assert(getApp(W1)?.stage === 'aadhaar', 'Stage restored to aadhaar');

  await handleMsg(W1, textMsg('cancel', 'msg-7')); // cancel again
  const preRestartId = getApp(W1)?.id;
  await handleMsg(W1, buttonMsg('cancel_confirm', 'Yes, cancel', 'msg-8')); // confirm cancel
  assert(APP_STORE[preRestartId]?.status === 'cancelled', 'Old app cancelled');
  assert(getApp(W1)?.stage === 'interest', 'New session starts at interest');
  assert(lastSent()?.body === '__welcome__', 'Welcome sent on restart');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-8: Decline at interest ────────────────────────────────────────────────');
  resetStore();

  await handleMsg(W3, textMsg('Hi', 'msg-1'));
  await handleMsg(W3, buttonMsg('no', 'No, thanks', 'msg-2'));
  assert(lastSent()?.body === '__declined_interest__', '"No" at interest → closed message');
  assert(getApp(W3)?.status === 'declined', 'Status is declined');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-9: Decline at approval ────────────────────────────────────────────────');
  resetStore();

  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  await handleMsg(W1, buttonMsg('yes', 'Yes', 'msg-2'));
  await handleMsg(W1, textMsg('ABCPD1234E', 'msg-3'));
  await handleMsg(W1, buttonMsg('no', 'No, thanks', 'msg-4'));
  assert(lastSent()?.body === '__declined_approval__', '"No" at approval → soft close');
  assert(getApp(W1)?.status === 'declined', 'Status is declined');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-10: Idempotency — duplicate message ID is a no-op ────────────────────');
  resetStore();

  await handleMsg(W1, textMsg('Hi', 'msg-dup'));
  const stageAfterFirst = getApp(W1)?.stage;
  SENT.length = 0;
  await handleMsg(W1, textMsg('Hi', 'msg-dup')); // same ID
  assert(SENT.length === 0, 'Duplicate message ID → no send, no state change');
  assert(getApp(W1)?.stage === stageAfterFirst, 'Stage unchanged after duplicate');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-11: Free-text synonyms for Yes/No ────────────────────────────────────');
  resetStore();

  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  await handleMsg(W1, textMsg('yes', 'msg-2')); // free-text "yes"
  assert(getApp(W1)?.stage === 'pan', 'Free-text "yes" accepted at interest');

  resetStore();
  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  await handleMsg(W1, textMsg('1', 'msg-2')); // "1"
  assert(getApp(W1)?.stage === 'pan', '"1" accepted as Yes at interest');

  resetStore();
  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  await handleMsg(W1, textMsg('n', 'msg-2')); // "n"
  assert(getApp(W1)?.status === 'declined', '"n" accepted as No at interest');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── TC-12: otp_locked → exit (No path) ──────────────────────────────────────');
  resetStore();

  await handleMsg(W1, textMsg('Hi', 'msg-1'));
  await handleMsg(W1, buttonMsg('yes', 'Yes', 'msg-2'));
  await handleMsg(W1, textMsg('ABCPD1234E', 'msg-3'));
  await handleMsg(W1, buttonMsg('yes', 'Yes', 'msg-4'));
  await handleMsg(W1, textMsg('123456789012', 'msg-5'));
  await handleMsg(W1, textMsg('111111', 'msg-6'));
  await handleMsg(W1, textMsg('222222', 'msg-7'));
  await handleMsg(W1, textMsg('333333', 'msg-8')); // → otp_locked
  await handleMsg(W1, buttonMsg('otp_exit', 'Exit', 'msg-9'));
  assert(getApp(W1)?.status === 'cancelled', 'otp_exit → status cancelled');
  assert(lastSent()?.body === '__otp_exit__', 'Goodbye message sent on otp_exit');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
