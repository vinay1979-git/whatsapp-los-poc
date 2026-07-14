/**
 * State machine for the pre-approved personal loan WhatsApp journey.
 *
 * Stage flow:
 *   interest → pan → approval → aadhaar → otp → offers → confirm → esign → bank → mandate → done
 *                                                              ↑ (confirm_change loops back here)
 *   any non-terminal stage → cancel:<stage> → yes: cancelled + restart interest
 *                                           → no:  restore <stage>
 *   otp (3rd wrong) → otp_locked → restart or exit
 */

import { updateApplication, lookupOffer, logConsent, createApplication } from './db.js';
import { calculateEmi, inrFormat, firstEmiDate } from './emi.js';
import * as msg from './messages.js';

const PAN_RE    = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_RE = /^\d{12}$/;
const OTP_CORRECT    = '123456';
const OTP_MAX        = 3;
const TERMINAL_STAGES = new Set(['done', 'otp_locked']);

// ── Input normalisation ───────────────────────────────────────────────────────

function extractInput(message) {
  if (message.type === 'text') {
    return { text: (message.text?.body ?? '').trim(), buttonId: null };
  }
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

// ── Offer helpers ─────────────────────────────────────────────────────────────

function buildOfferRows(offerRecord) {
  const rows = [];
  for (let i = 1; i <= 3; i++) {
    const amount = offerRecord[`offer${i}_amount`];
    const tenure = offerRecord[`offer${i}_tenure_months`];
    const roi    = offerRecord[`offer${i}_roi_annual`];
    if (amount == null || tenure == null || roi == null) continue;
    const emi = calculateEmi(amount, tenure, roi);
    rows.push({
      id: `offer_${i}`,
      title: `${inrFormat(amount)} · ${tenure} months`,       // max 24 chars
      description: `ROI: ${roi}% p.a. · EMI: ${inrFormat(Math.round(emi))}/mo`,
      _index: i, _amount: amount, _tenure: tenure, _roi: roi, _emi: emi,
    });
  }
  return rows;
}

function getOfferByIndex(rows, idx) {
  return rows.find(r => r._index === idx) ?? null;
}

function parseOfferSelection({ text, buttonId }, rowCount) {
  const m = buttonId?.match(/^offer_([123])$/);
  if (m) {
    const idx = parseInt(m[1]);
    return idx <= rowCount ? idx : null;
  }
  const n = parseInt(text.trim());
  return n >= 1 && n <= rowCount ? n : null;
}

// ── Cancel & restart helpers ──────────────────────────────────────────────────

async function startFreshAtInterest(waId, oldAppId) {
  if (oldAppId) await updateApplication(oldAppId, { stage: 'cancelled', status: 'cancelled' });
  await createApplication(waId);
  await msg.sendWelcome(waId);
}

async function resendPromptForStage(stage, waId, app) {
  switch (stage) {
    case 'interest': return msg.sendWelcome(waId);
    case 'pan':      return msg.sendPanPrompt(waId);
    case 'approval': {
      const offer = await lookupOffer(app.mobile_number, app.pan_number);
      return offer
        ? msg.sendApprovalPrompt(waId, inrFormat(offer.approval_amount))
        : msg.sendSomethingWentWrong(waId);
    }
    case 'aadhaar': return msg.sendAadhaarPrompt(waId);
    case 'otp':     return msg.sendOtpPrompt(waId);
    case 'offers': {
      const offer = await lookupOffer(app.mobile_number, app.pan_number);
      if (!offer) return msg.sendSomethingWentWrong(waId);
      const rows = buildOfferRows(offer);
      return rows.length ? msg.sendOffers(waId, rows) : msg.sendSomethingWentWrong(waId);
    }
    case 'confirm': {
      const offer = await lookupOffer(app.mobile_number, app.pan_number);
      if (!offer) return msg.sendSomethingWentWrong(waId);
      const row = getOfferByIndex(buildOfferRows(offer), app.selected_offer_index);
      if (!row) return msg.sendSomethingWentWrong(waId);
      return msg.sendConfirmation(waId, {
        pan: app.pan_number, aadhaarLast4: app.aadhaar_last4,
        amount: inrFormat(row._amount), tenure: row._tenure,
        roi: row._roi, emi: inrFormat(Math.round(row._emi)),
      });
    }
    case 'esign': {
      const offer = await lookupOffer(app.mobile_number, app.pan_number);
      const row = offer ? getOfferByIndex(buildOfferRows(offer), app.selected_offer_index) : null;
      return msg.sendEsignPrompt(waId, row ? inrFormat(row._amount) : 'your loan');
    }
    case 'bank':
      if (!app.bank_account_number) return msg.sendBankAccountPrompt(waId);
      if (!app.bank_name)           return msg.sendBankNamePrompt(waId);
      return msg.sendBranchPrompt(waId);
    case 'mandate': return msg.sendMandateChoice(waId);
    default:        return msg.sendSomethingWentWrong(waId);
  }
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

export async function dispatch(app, message) {
  const waId  = app.mobile_number;
  const input = extractInput(message);
  const { text, buttonId } = input;
  const norm  = text.toLowerCase().trim();
  const stage = app.stage;

  // Global "cancel" free-text command (except from terminal and pending-cancel stages)
  if (!stage.startsWith('cancel:') && !TERMINAL_STAGES.has(stage) && norm === 'cancel') {
    await updateApplication(app.id, { stage: `cancel:${stage}` });
    await msg.sendCancelConfirmation(waId);
    return;
  }

  // Pending cancel confirmation
  if (stage.startsWith('cancel:')) {
    const returnStage = stage.slice(7);
    if (buttonId === 'cancel_confirm' || (buttonId !== 'cancel_abort' && isYes(input))) {
      await startFreshAtInterest(waId, app.id);
      return;
    }
    if (buttonId === 'cancel_abort' || isNo(input)) {
      await updateApplication(app.id, { stage: returnStage });
      await resendPromptForStage(returnStage, waId, app);
      return;
    }
    await msg.sendCancelConfirmation(waId);
    return;
  }

  switch (stage) {

    // ── interest ──────────────────────────────────────────────────────────────
    case 'interest': {
      if (isYes(input)) {
        await updateApplication(app.id, {
          stage: 'pan',
          consent_given_at: new Date().toISOString(),
        });
        await logConsent(app.id, 'privacy_policy', waId, { wa_message_id: message.id });
        await msg.sendPanPrompt(waId);
        return;
      }
      if (isNo(input)) {
        await updateApplication(app.id, { stage: 'cancelled', status: 'declined' });
        await msg.sendDeclinedAtInterest(waId);
        return;
      }
      await msg.sendWelcome(waId);
      return;
    }

    // ── pan ───────────────────────────────────────────────────────────────────
    case 'pan': {
      const pan = text.toUpperCase().replace(/\s/g, '');
      if (!PAN_RE.test(pan)) {
        await msg.sendPanInvalid(waId);
        return;
      }
      const offer = await lookupOffer(waId, pan);
      if (!offer) {
        await updateApplication(app.id, { stage: 'cancelled', status: 'no_offer', pan_number: pan });
        await msg.sendNoOffer(waId);
        return;
      }
      await updateApplication(app.id, { stage: 'approval', pan_number: pan });
      await msg.sendApprovalPrompt(waId, inrFormat(offer.approval_amount));
      return;
    }

    // ── approval ──────────────────────────────────────────────────────────────
    case 'approval': {
      if (isYes(input)) {
        await updateApplication(app.id, { stage: 'aadhaar' });
        await msg.sendAadhaarPrompt(waId);
        return;
      }
      if (isNo(input)) {
        await updateApplication(app.id, { stage: 'cancelled', status: 'declined' });
        await msg.sendDeclinedAtApproval(waId);
        return;
      }
      const offer = await lookupOffer(waId, app.pan_number);
      await msg.sendApprovalPrompt(waId, offer ? inrFormat(offer.approval_amount) : 'your pre-approved amount');
      return;
    }

    // ── aadhaar ───────────────────────────────────────────────────────────────
    case 'aadhaar': {
      const aadhaar = text.replace(/\s/g, '');
      if (!AADHAAR_RE.test(aadhaar)) {
        await msg.sendAadhaarInvalid(waId);
        return;
      }
      // Full Aadhaar discarded here — only last 4 digits are persisted (§7.1).
      await updateApplication(app.id, {
        stage: 'otp',
        aadhaar_last4: aadhaar.slice(-4),
        otp_attempts: 0,
      });
      await msg.sendOtpPrompt(waId);
      return;
    }

    // ── otp ───────────────────────────────────────────────────────────────────
    case 'otp': {
      const otp = text.trim();
      if (!/^\d{6}$/.test(otp)) {
        // Non-6-digit input — re-prompt, don't count as an attempt
        await msg.sendOtpPrompt(waId);
        return;
      }
      if (otp === OTP_CORRECT) {
        const offer = await lookupOffer(waId, app.pan_number);
        const rows  = offer ? buildOfferRows(offer) : [];
        if (!rows.length) {
          await updateApplication(app.id, { stage: 'cancelled', status: 'no_offer' });
          await msg.sendSomethingWentWrong(waId);
          return;
        }
        await updateApplication(app.id, { stage: 'offers' });
        await msg.sendOffers(waId, rows);
        return;
      }
      const attempts = (app.otp_attempts ?? 0) + 1;
      if (attempts >= OTP_MAX) {
        await updateApplication(app.id, { stage: 'otp_locked', otp_attempts: attempts });
        await msg.sendOtpLocked(waId);
        return;
      }
      await updateApplication(app.id, { otp_attempts: attempts });
      await msg.sendOtpInvalid(waId, OTP_MAX - attempts);
      return;
    }

    // ── otp_locked ────────────────────────────────────────────────────────────
    case 'otp_locked': {
      if (buttonId === 'otp_restart' || isYes(input)) {
        await startFreshAtInterest(waId, app.id);
        return;
      }
      if (buttonId === 'otp_exit' || isNo(input)) {
        await updateApplication(app.id, { stage: 'cancelled', status: 'cancelled' });
        await msg.sendText(waId,
          'Application closed. You can message us anytime to start a new application. 👋'
        );
        return;
      }
      await msg.sendOtpLocked(waId);
      return;
    }

    // ── offers ────────────────────────────────────────────────────────────────
    case 'offers': {
      const offer = await lookupOffer(waId, app.pan_number);
      if (!offer) { await msg.sendSomethingWentWrong(waId); return; }
      const rows  = buildOfferRows(offer);
      if (!rows.length) { await msg.sendSomethingWentWrong(waId); return; }
      const selectedIdx = parseOfferSelection(input, rows.length);
      if (selectedIdx === null) { await msg.sendOffers(waId, rows); return; }
      const row = getOfferByIndex(rows, selectedIdx);
      await updateApplication(app.id, { stage: 'confirm', selected_offer_index: selectedIdx });
      await msg.sendConfirmation(waId, {
        pan: app.pan_number, aadhaarLast4: app.aadhaar_last4,
        amount: inrFormat(row._amount), tenure: row._tenure,
        roi: row._roi, emi: inrFormat(Math.round(row._emi)),
      });
      return;
    }

    // ── confirm ───────────────────────────────────────────────────────────────
    case 'confirm': {
      if (buttonId === 'confirm_yes' || (buttonId !== 'confirm_change' && isYes(input))) {
        const offer = await lookupOffer(waId, app.pan_number);
        const row   = offer ? getOfferByIndex(buildOfferRows(offer), app.selected_offer_index) : null;
        await updateApplication(app.id, { stage: 'esign' });
        await msg.sendEsignPrompt(waId, row ? inrFormat(row._amount) : 'your loan');
        return;
      }
      if (buttonId === 'confirm_change' || isNo(input)) {
        const offer = await lookupOffer(waId, app.pan_number);
        if (!offer) { await msg.sendSomethingWentWrong(waId); return; }
        const rows = buildOfferRows(offer);
        await updateApplication(app.id, { stage: 'offers', selected_offer_index: null });
        await msg.sendOffers(waId, rows);
        return;
      }
      await resendPromptForStage('confirm', waId, app);
      return;
    }

    // ── esign ─────────────────────────────────────────────────────────────────
    case 'esign': {
      if (buttonId === 'esign_confirm' || isYes(input)) {
        await logConsent(app.id, 'esign_complete', waId, { wa_message_id: message.id });
        await updateApplication(app.id, { stage: 'bank' });
        await msg.sendBankAccountPrompt(waId);
        return;
      }
      await resendPromptForStage('esign', waId, app);
      return;
    }

    // ── bank ──────────────────────────────────────────────────────────────────
    case 'bank': {
      const value = text.trim();
      if (!value) { await resendPromptForStage('bank', waId, app); return; }

      if (!app.bank_account_number) {
        if (!/\d{4,}/.test(value.replace(/\s/g, ''))) {
          await msg.sendText(waId, 'Please enter a valid bank account number (numbers only).');
          return;
        }
        await updateApplication(app.id, { bank_account_number: value });
        await msg.sendBankNamePrompt(waId);
        return;
      }
      if (!app.bank_name) {
        await updateApplication(app.id, { bank_name: value });
        await msg.sendBranchPrompt(waId);
        return;
      }
      if (!app.branch_or_ifsc) {
        await updateApplication(app.id, { stage: 'mandate', branch_or_ifsc: value });
        await msg.sendMandateChoice(waId);
        return;
      }
      await msg.sendMandateChoice(waId);
      return;
    }

    // ── mandate ───────────────────────────────────────────────────────────────
    case 'mandate': {
      let method = null;
      if (buttonId === 'nach'        || ['nach', '1'].includes(norm))         method = 'NACH';
      if (buttonId === 'upi_autopay' || ['upi autopay', 'upi', '2'].includes(norm)) method = 'UPI_AUTOPAY';
      if (!method) { await msg.sendMandateChoice(waId); return; }

      const offer = await lookupOffer(waId, app.pan_number);
      const row   = offer ? getOfferByIndex(buildOfferRows(offer), app.selected_offer_index) : null;
      const accountLast4 = (app.bank_account_number ?? '').replace(/\s/g, '').slice(-4) || 'XXXX';

      await logConsent(app.id, 'mandate_auth', waId, { method, wa_message_id: message.id });
      await updateApplication(app.id, { stage: 'done', status: 'completed', mandate_method: method });
      await msg.sendDisbursalSuccess(waId, {
        amount: row ? inrFormat(row._amount) : 'your loan',
        accountLast4,
        emi: row ? inrFormat(Math.round(row._emi)) : '—',
        emiDate: firstEmiDate(),
      });
      return;
    }

    // ── done (terminal) ───────────────────────────────────────────────────────
    case 'done': {
      // New message after completion → fresh session
      await startFreshAtInterest(waId, null);
      return;
    }

    default: {
      console.error(`[stateMachine] Unknown stage "${stage}" for app ${app.id}`);
      await msg.sendSomethingWentWrong(waId);
    }
  }
}
