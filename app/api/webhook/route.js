import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// Force every invocation to run fresh — no caching for a webhook handler.
export const dynamic = 'force-dynamic';

const {
  GRAPH_API_VERSION = 'v25.0',
  PHONE_NUMBER_ID,
  ACCESS_TOKEN,
  VERIFY_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Supabase session store
// ---------------------------------------------------------------------------
async function getSession(waId) {
  const { data, error } = await supabase
    .from('applications')
    .select('*')
    .eq('wa_id', waId)
    .maybeSingle();
  if (error) throw error;
  return (
    data || {
      wa_id: waId,
      state: 'NEW',
      loan_type: null,
      name: null,
      pan: null,
      dob: null,
      employment: null,
      income: null,
      pan_doc_media_id: null,
      address_doc_media_id: null,
      ref_id: null,
    }
  );
}

async function saveSession(session) {
  const { error } = await supabase.from('applications').upsert(session);
  if (error) throw error;
}

async function deleteSession(waId) {
  const { error } = await supabase.from('applications').delete().eq('wa_id', waId);
  if (error) throw error;
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
// Journey step prompts
// ---------------------------------------------------------------------------
function promptLoanType(to) {
  return sendList(
    to,
    'Welcome to our loan onboarding assistant! What would you like to apply for?',
    'Choose loan type',
    [
      { id: 'personal_loan', title: 'Personal Loan', description: 'Quick personal loans' },
      { id: 'business_loan', title: 'Business Loan', description: 'For business needs' },
      { id: 'gold_loan', title: 'Gold Loan', description: 'Loan against gold' },
    ]
  );
}

function promptConsent(to) {
  return sendButtons(
    to,
    'To proceed, we need your consent to collect and process your details for this application. Do you agree?',
    [
      { id: 'consent_yes', title: 'I Agree' },
      { id: 'consent_no', title: 'Cancel' },
    ]
  );
}

function promptName(to) {
  return sendText(to, "Great! Let's start with your details.\n\nPlease enter your *full name* as per your PAN card.");
}

function promptPan(to) {
  return sendText(to, 'Please enter your *PAN number* (e.g. ABCDE1234F).');
}

function promptDob(to) {
  return sendText(to, 'Please enter your *date of birth* (DD-MM-YYYY).');
}

function promptEmployment(to) {
  return sendList(to, 'What is your employment type?', 'Choose one', [
    { id: 'salaried', title: 'Salaried' },
    { id: 'self_employed', title: 'Self-employed' },
  ]);
}

function promptIncome(to) {
  return sendText(to, 'Please enter your approximate *monthly income* in INR (numbers only).');
}

function promptPanDoc(to) {
  return sendText(to, 'Thanks! Now please *upload a photo* of your PAN card.');
}

function promptAddressDoc(to) {
  return sendText(to, 'Got it. Now please *upload a photo* of an address proof (Aadhaar / utility bill).');
}

function promptBureauConsent(to) {
  return sendButtons(
    to,
    'Last step: do you consent to a credit bureau (CIBIL) check for this application?',
    [
      { id: 'bureau_yes', title: 'Yes, proceed' },
      { id: 'bureau_no', title: 'Cancel' },
    ]
  );
}

async function sendSummary(to, session) {
  const refId = `LOS-${Date.now().toString().slice(-8)}`;
  session.ref_id = refId;
  await sendText(
    to,
    `Application submitted!\n\n` +
      `*Reference ID:* ${refId}\n` +
      `*Loan type:* ${session.loan_type}\n` +
      `*Name:* ${session.name}\n` +
      `*Employment:* ${session.employment}\n\n` +
      `We'll message you here with status updates as your application moves through review. Thank you!`
  );
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
async function handleInboundMessage(waId, message) {
  const session = await getSession(waId);
  const { state } = session;

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
      if (!interactiveId) {
        return sendText(waId, 'Please choose an option from the list above.');
      }
      session.loan_type = {
        personal_loan: 'Personal Loan',
        business_loan: 'Business Loan',
        gold_loan: 'Gold Loan',
      }[interactiveId];
      await promptConsent(waId);
      session.state = 'AWAITING_CONSENT';
      break;
    }

    case 'AWAITING_CONSENT': {
      if (interactiveId === 'consent_yes') {
        await promptName(waId);
        session.state = 'AWAITING_NAME';
      } else if (interactiveId === 'consent_no') {
        await sendText(waId, "No problem - message us again whenever you're ready to apply.");
        return deleteSession(waId);
      } else {
        return sendText(waId, 'Please tap "I Agree" or "Cancel" above.');
      }
      break;
    }

    case 'AWAITING_NAME': {
      if (!text) return sendText(waId, 'Please type your full name as text.');
      session.name = text;
      await promptPan(waId);
      session.state = 'AWAITING_PAN';
      break;
    }

    case 'AWAITING_PAN': {
      if (!text || !/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(text)) {
        return sendText(waId, "That doesn't look like a valid PAN. Format: ABCDE1234F. Please re-enter.");
      }
      session.pan = text.toUpperCase();
      await promptDob(waId);
      session.state = 'AWAITING_DOB';
      break;
    }

    case 'AWAITING_DOB': {
      if (!text || !/^\d{2}-\d{2}-\d{4}$/.test(text)) {
        return sendText(waId, 'Please enter your DOB in DD-MM-YYYY format.');
      }
      session.dob = text;
      await promptEmployment(waId);
      session.state = 'AWAITING_EMPLOYMENT';
      break;
    }

    case 'AWAITING_EMPLOYMENT': {
      if (!interactiveId) return sendText(waId, 'Please choose an option from the list above.');
      session.employment = { salaried: 'Salaried', self_employed: 'Self-employed' }[interactiveId];
      await promptIncome(waId);
      session.state = 'AWAITING_INCOME';
      break;
    }

    case 'AWAITING_INCOME': {
      if (!text || !/^\d+$/.test(text)) return sendText(waId, 'Please enter a numeric monthly income.');
      session.income = text;
      await promptPanDoc(waId);
      session.state = 'AWAITING_PAN_DOC';
      break;
    }

    case 'AWAITING_PAN_DOC': {
      if (!isMedia) return sendText(waId, 'Please upload a photo of your PAN card to continue.');
      session.pan_doc_media_id = message[message.type].id;
      await sendText(waId, 'PAN card received.');
      await promptAddressDoc(waId);
      session.state = 'AWAITING_ADDRESS_DOC';
      break;
    }

    case 'AWAITING_ADDRESS_DOC': {
      if (!isMedia) return sendText(waId, 'Please upload a photo of your address proof to continue.');
      session.address_doc_media_id = message[message.type].id;
      await sendText(waId, 'Address proof received.');
      await promptBureauConsent(waId);
      session.state = 'AWAITING_BUREAU_CONSENT';
      break;
    }

    case 'AWAITING_BUREAU_CONSENT': {
      if (interactiveId === 'bureau_yes') {
        await sendSummary(waId, session);
        session.state = 'COMPLETE';
      } else if (interactiveId === 'bureau_no') {
        await sendText(waId, 'Understood - your application was not submitted. Message us again to restart.');
        return deleteSession(waId);
      } else {
        return sendText(waId, 'Please tap "Yes, proceed" or "Cancel" above.');
      }
      break;
    }

    case 'COMPLETE': {
      return sendText(
        waId,
        `Your application ${session.ref_id} is currently *under review*. We'll notify you here as soon as there's an update.`
      );
    }

    default: {
      session.state = 'NEW';
      await saveSession(session);
      return handleInboundMessage(waId, message);
    }
  }

  return saveSession(session);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return new Response(challenge, { status: 200 });
  }
  return new Response(null, { status: 403 });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return new Response(null, { status: 200 }); // status updates – ignore

    const waId = message.from;
    console.log(`Inbound [${message.type}] from ${waId}`);
    await handleInboundMessage(waId, message);
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }
  return new Response(null, { status: 200 });
}
