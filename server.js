/**
 * WhatsApp LOS POC - self-serve loan onboarding journey
 * ------------------------------------------------
 * A minimal, fully self-serve loan-application journey over WhatsApp Cloud API.
 * The customer messages the test number first (e.g. "Hi"), which opens the
 * 24h customer service window, and the bot drives the rest of the journey
 * using interactive buttons/lists, text prompts, and document (image) capture.
 *
 * No message templates are required for this POC because the customer
 * always initiates - see README.md for the difference vs. business-initiated
 * (template-first) journeys you'll need in production.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const {
  GRAPH_API_VERSION = 'v25.0',
  PHONE_NUMBER_ID,
  ACCESS_TOKEN,
  VERIFY_TOKEN,
  PORT = 3000,
} = process.env;

if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || !VERIFY_TOKEN) {
  console.error('Missing required env vars. Check your .env file (see .env example).');
  process.exit(1);
}

const GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory session store: Map<waId, { state, data }>
// Swap this for Redis / a DB table keyed by phone number in production, and
// eventually for a call into the LOS backend to persist the
// application record instead of memory.
// ---------------------------------------------------------------------------
const sessions = new Map();

function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, { state: 'NEW', data: {} });
  }
  return sessions.get(waId);
}

// ---------------------------------------------------------------------------
// Outbound message helpers
// ---------------------------------------------------------------------------
async function sendRequest(payload) {
  try {
    await axios.post(GRAPH_URL, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('WhatsApp API error:', err.response?.data || err.message);
  }
}

function sendText(to, body) {
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

function sendButtons(to, bodyText, buttons) {
  // buttons: [{ id, title }] - max 3
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

function sendList(to, bodyText, buttonLabel, rows) {
  // rows: [{ id, title, description }]
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections: [{ title: 'Options', rows }],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Journey step definitions
// Each step sends the prompt for the state it is named after.
// ---------------------------------------------------------------------------
async function promptLoanType(to) {
  await sendList(to, 'Welcome to our loan onboarding assistant! What would you like to apply for?', 'Choose loan type', [
    { id: 'personal_loan', title: 'Personal Loan', description: 'Quick personal loans' },
    { id: 'business_loan', title: 'Business Loan', description: 'For business needs' },
    { id: 'gold_loan', title: 'Gold Loan', description: 'Loan against gold' },
  ]);
}

async function promptConsent(to) {
  await sendButtons(to, 'To proceed, we need your consent to collect and process your details for this application. Do you agree?', [
    { id: 'consent_yes', title: 'I Agree' },
    { id: 'consent_no', title: 'Cancel' },
  ]);
}

async function promptName(to) {
  await sendText(to, "Great! Let's start with your details.\n\nPlease enter your *full name* as per your PAN card.");
}

async function promptPan(to) {
  await sendText(to, 'Please enter your *PAN number* (e.g. ABCDE1234F).');
}

async function promptDob(to) {
  await sendText(to, 'Please enter your *date of birth* (DD-MM-YYYY).');
}

async function promptEmployment(to) {
  await sendList(to, 'What is your employment type?', 'Choose one', [
    { id: 'salaried', title: 'Salaried' },
    { id: 'self_employed', title: 'Self-employed' },
  ]);
}

async function promptIncome(to) {
  await sendText(to, 'Please enter your approximate *monthly income* in INR (numbers only).');
}

async function promptPanDoc(to) {
  await sendText(to, 'Thanks! Now please *upload a photo* of your PAN card.');
}

async function promptAddressDoc(to) {
  await sendText(to, 'Got it. Now please *upload a photo* of an address proof (Aadhaar / utility bill).');
}

async function promptBureauConsent(to) {
  await sendButtons(to, 'Last step: do you consent to a credit bureau (CIBIL) check for this application?', [
    { id: 'bureau_yes', title: 'Yes, proceed' },
    { id: 'bureau_no', title: 'Cancel' },
  ]);
}

async function sendSummary(to, data) {
  const refId = `LOS-${Date.now().toString().slice(-8)}`;
  data.refId = refId;
  await sendText(
    to,
    `Application submitted!\n\n` +
      `*Reference ID:* ${refId}\n` +
      `*Loan type:* ${data.loanType}\n` +
      `*Name:* ${data.name}\n` +
      `*Employment:* ${data.employment}\n\n` +
      `We'll message you here with status updates as your application moves through review. Thank you!`
  );
}

// ---------------------------------------------------------------------------
// State machine - handles one inbound message and advances the session
// ---------------------------------------------------------------------------
async function handleInboundMessage(waId, message) {
  const session = getSession(waId);
  const { state, data } = session;

  const text = message.type === 'text' ? message.text.body.trim() : null;
  const interactiveId =
    message.type === 'interactive'
      ? message.interactive.button_reply?.id || message.interactive.list_reply?.id
      : null;
  const isMedia = message.type === 'image' || message.type === 'document';

  switch (state) {
    case 'NEW': {
      await promptLoanType(waId);
      session.state = 'AWAITING_LOAN_TYPE';
      break;
    }

    case 'AWAITING_LOAN_TYPE': {
      if (!interactiveId) return sendText(waId, 'Please choose an option from the list above.');
      data.loanType = { personal_loan: 'Personal Loan', business_loan: 'Business Loan', gold_loan: 'Gold Loan' }[interactiveId];
      await promptConsent(waId);
      session.state = 'AWAITING_CONSENT';
      break;
    }

    case 'AWAITING_CONSENT': {
      if (interactiveId === 'consent_yes') {
        await promptName(waId);
        session.state = 'AWAITING_NAME';
      } else if (interactiveId === 'consent_no') {
        await sendText(waId, 'No problem - message us again whenever you\'re ready to apply.');
        sessions.delete(waId);
      } else {
        await sendText(waId, 'Please tap "I Agree" or "Cancel" above.');
      }
      break;
    }

    case 'AWAITING_NAME': {
      if (!text) return sendText(waId, 'Please type your full name as text.');
      data.name = text;
      await promptPan(waId);
      session.state = 'AWAITING_PAN';
      break;
    }

    case 'AWAITING_PAN': {
      if (!text || !/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(text)) {
        return sendText(waId, "That doesn't look like a valid PAN. Format: ABCDE1234F. Please re-enter.");
      }
      data.pan = text.toUpperCase();
      await promptDob(waId);
      session.state = 'AWAITING_DOB';
      break;
    }

    case 'AWAITING_DOB': {
      if (!text || !/^\d{2}-\d{2}-\d{4}$/.test(text)) {
        return sendText(waId, 'Please enter your DOB in DD-MM-YYYY format.');
      }
      data.dob = text;
      await promptEmployment(waId);
      session.state = 'AWAITING_EMPLOYMENT';
      break;
    }

    case 'AWAITING_EMPLOYMENT': {
      if (!interactiveId) return sendText(waId, 'Please choose an option from the list above.');
      data.employment = { salaried: 'Salaried', self_employed: 'Self-employed' }[interactiveId];
      await promptIncome(waId);
      session.state = 'AWAITING_INCOME';
      break;
    }

    case 'AWAITING_INCOME': {
      if (!text || !/^\d+$/.test(text)) return sendText(waId, 'Please enter a numeric monthly income.');
      data.income = text;
      await promptPanDoc(waId);
      session.state = 'AWAITING_PAN_DOC';
      break;
    }

    case 'AWAITING_PAN_DOC': {
      if (!isMedia) return sendText(waId, 'Please upload a photo of your PAN card to continue.');
      data.panDocMediaId = message[message.type].id;
      await sendText(waId, 'PAN card received.');
      await promptAddressDoc(waId);
      session.state = 'AWAITING_ADDRESS_DOC';
      break;
    }

    case 'AWAITING_ADDRESS_DOC': {
      if (!isMedia) return sendText(waId, 'Please upload a photo of your address proof to continue.');
      data.addressDocMediaId = message[message.type].id;
      await sendText(waId, 'Address proof received.');
      await promptBureauConsent(waId);
      session.state = 'AWAITING_BUREAU_CONSENT';
      break;
    }

    case 'AWAITING_BUREAU_CONSENT': {
      if (interactiveId === 'bureau_yes') {
        await sendSummary(waId, data);
        session.state = 'COMPLETE';
      } else if (interactiveId === 'bureau_no') {
        await sendText(waId, 'Understood - your application was not submitted. Message us again to restart.');
        sessions.delete(waId);
      } else {
        await sendText(waId, 'Please tap "Yes, proceed" or "Cancel" above.');
      }
      break;
    }

    case 'COMPLETE': {
      await sendText(
        waId,
        `Your application ${data.refId} is currently *under review*. We'll notify you here as soon as there's an update.`
      );
      break;
    }

    default: {
      session.state = 'NEW';
      await handleInboundMessage(waId, message);
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook: verification (GET) + inbound events (POST)
// ---------------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  // Always ack immediately - process async so Meta doesn't retry/timeout.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return; // status updates (delivered/read) land here too - ignore for POC

    const waId = message.from;
    console.log(`Inbound [${message.type}] from ${waId}`);
    await handleInboundMessage(waId, message);
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }
});

app.get('/', (_req, res) => res.send('WhatsApp LOS POC is running.'));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Webhook URL to expose via ngrok: http://localhost:${PORT}/webhook`);
});
