import axios from 'axios';
import { inrFormat, maskPan } from './emi.js';

const BRAND = process.env.BRAND_NAME || 'Lentra';
const PRIVACY_URL = process.env.PRIVACY_URL || 'https://lentra.ai/privacy';

// ── WhatsApp Cloud API primitives ─────────────────────────────────────────────

function graphUrl() {
  const { GRAPH_API_VERSION = 'v25.0', PHONE_NUMBER_ID } = process.env;
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

async function sendRequest(payload) {
  try {
    await axios.post(graphUrl(), payload, {
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('WhatsApp API error:', err.response?.data || err.message);
  }
}

export function sendText(to, body) {
  return sendRequest({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
}

export function sendButtons(to, bodyText, buttons) {
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  });
}

export function sendList(to, bodyText, buttonLabel, rows) {
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonLabel, sections: [{ title: 'Options', rows }] },
    },
  });
}

// ── Journey-specific messages ─────────────────────────────────────────────────

export function sendWelcome(to) {
  return sendButtons(to,
    `Hi! 👋 Welcome to ${BRAND}'s loan service.\n\n` +
    `We may have a *pre-approved Personal Loan* offer ready for you.\n\n` +
    `By tapping *Yes*, you confirm that you have read and agree to our Privacy Policy:\n${PRIVACY_URL}\n\n` +
    `Reply 1 for Yes · 2 for No`,
    [
      { id: 'yes', title: 'Yes, interested' },
      { id: 'no', title: 'No, thanks' },
    ]
  );
}

export function sendPanPrompt(to) {
  return sendText(to,
    'Please enter your *PAN number* to check your offer.\n\n' +
    '_Format: ABCDE1234F (5 letters · 4 digits · 1 letter)_'
  );
}

export function sendPanInvalid(to) {
  return sendText(to,
    "That doesn't look like a valid PAN. Please re-enter your 10-character PAN.\n\n" +
    '_Example: ABCDE1234F_'
  );
}

export function sendNoOffer(to) {
  return sendText(to,
    "We don't have a pre-approved offer for this PAN at the moment.\n\n" +
    "Please check back later. Thank you for your interest! 🙏"
  );
}

export function sendApprovalPrompt(to, approvalAmountFmt) {
  return sendButtons(to,
    `Great news! 🎉 You are pre-approved for a *Personal Loan of ${approvalAmountFmt}*.\n\n` +
    `Would you like to proceed with your application?\n\n` +
    `Reply 1 for Yes · 2 for No`,
    [
      { id: 'yes', title: 'Yes, proceed' },
      { id: 'no', title: 'No, thanks' },
    ]
  );
}

export function sendDeclinedAtInterest(to) {
  return sendText(to,
    "No problem! Feel free to reach out whenever you need a loan. Have a great day! 👋"
  );
}

export function sendDeclinedAtApproval(to) {
  return sendText(to,
    "No worries! Your pre-approved offer will stay available — come back anytime. 😊"
  );
}

export function sendAadhaarPrompt(to) {
  return sendText(to,
    'Please enter your *12-digit Aadhaar number* for KYC verification.\n\n' +
    '_Only the last 4 digits will be retained — the full number is never stored._'
  );
}

export function sendAadhaarInvalid(to) {
  return sendText(to,
    'Please enter a valid *12-digit Aadhaar number* (digits only, no spaces).'
  );
}

export function sendOtpPrompt(to) {
  return sendText(to,
    'We have initiated an OTP to your Aadhaar-linked mobile number.\n\n' +
    'Please enter the *6-digit OTP* to continue.\n\n' +
    '_(Demo OTP: *123456*)_'
  );
}

export function sendOtpInvalid(to, attemptsLeft) {
  const s = attemptsLeft === 1 ? 'attempt' : 'attempts';
  return sendText(to, `Incorrect OTP. Please try again.\n\n_${attemptsLeft} ${s} remaining._`);
}

export function sendOtpLocked(to) {
  return sendButtons(to,
    'You have used all 3 OTP attempts.\n\n' +
    'Would you like to cancel and restart your application?\n\n' +
    'Reply 1 to restart · 2 to exit',
    [
      { id: 'otp_restart', title: 'Restart application' },
      { id: 'otp_exit',    title: 'Exit' },
    ]
  );
}

export function sendOffers(to, offerRows) {
  const lines = offerRows.map((r, i) => `${i + 1}. ${r.title}\n   ${r.description}`).join('\n\n');
  const body =
    `Here are your loan offer${offerRows.length !== 1 ? 's' : ''}:\n\n${lines}\n\n` +
    `Tap *View Offers* to select, or reply with the offer number (1–${offerRows.length}).`;
  return sendList(to, body, 'View Offers', offerRows.map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
  })));
}

export function sendConfirmation(to, { pan, aadhaarLast4, amount, tenure, roi, emi }) {
  return sendButtons(to,
    `Please confirm your loan details:\n\n` +
    `📋 *PAN:* ${maskPan(pan)}\n` +
    `🔒 *Aadhaar:* XXXX-XXXX-${aadhaarLast4}\n` +
    `💰 *Amount:* ${amount}\n` +
    `📅 *Tenure:* ${tenure} months\n` +
    `📈 *Rate:* ${roi}% p.a. (reducing balance)\n` +
    `💳 *EMI:* ${emi}/month\n\n` +
    `Reply 1 to confirm · 2 to choose a different offer`,
    [
      { id: 'confirm_yes',    title: 'Confirm & Proceed' },
      { id: 'confirm_change', title: 'Choose Different' },
    ]
  );
}

export function sendEsignPrompt(to, amountFmt) {
  return sendButtons(to,
    `Your Loan Agreement for *${amountFmt}* is ready.\n\n` +
    `📄 _Personal Loan Agreement_\n\n` +
    `Tap *Open eSign Portal* to digitally sign your agreement and proceed.\n\n` +
    `_(Demo: tapping the button simulates eSign completion.)_`,
    [{ id: 'esign_confirm', title: 'Open eSign Portal' }]
  );
}

export function sendBankAccountPrompt(to) {
  return sendText(to,
    `eSign completed successfully! ✅\n\n` +
    `Now let's set up disbursal. Please enter your *bank account number*:`
  );
}

export function sendBankNamePrompt(to) {
  return sendText(to,
    'Please enter your *bank name*:\n_(e.g. HDFC Bank, SBI, ICICI Bank, Axis Bank)_'
  );
}

export function sendBranchPrompt(to) {
  return sendText(to,
    'Please enter your *branch name or IFSC code*:\n_(e.g. HDFC0001234 or "Andheri West Branch")_'
  );
}

export function sendMandateChoice(to) {
  return sendButtons(to,
    'Almost done! Please choose your *e-Mandate method* for EMI auto-debit:\n\n' +
    'Reply 1 for NACH · 2 for UPI Autopay',
    [
      { id: 'nach',        title: 'NACH' },
      { id: 'upi_autopay', title: 'UPI Autopay' },
    ]
  );
}

export function sendDisbursalSuccess(to, { amount, accountLast4, emi, emiDate }) {
  return sendText(to,
    `🎉 *Congratulations!*\n\n` +
    `Your Personal Loan of *${amount}* has been disbursed to your account ending in *${accountLast4}*.\n\n` +
    `Your first EMI of *${emi}* will be debited on *${emiDate}*.\n\n` +
    `Thank you for choosing ${BRAND}! For any assistance, please contact our support team. 🙏`
  );
}

export function sendCancelConfirmation(to) {
  return sendButtons(to,
    'Are you sure you want to cancel? All details entered so far will be discarded.\n\n' +
    'Reply 1 to cancel · 2 to continue',
    [
      { id: 'cancel_confirm', title: 'Yes, cancel' },
      { id: 'cancel_abort',   title: 'No, continue' },
    ]
  );
}

export function sendSomethingWentWrong(to) {
  return sendText(to,
    'Something went wrong on our end. Please try again later or contact our support team. 🙏'
  );
}
