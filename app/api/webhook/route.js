/**
 * app/api/webhook/route.js
 *
 * WhatsApp Cloud API webhook — pre-approved personal loan journey.
 * GET  /api/webhook — Meta hub verification challenge
 * POST /api/webhook — inbound message events
 *
 * State machine wired in §8 step 3 (see docs/loan-journey-implementation-brief.md).
 * Supabase tables: loan_applications, pre_approved_offers, consent_log
 * (see supabase/migrations/001_loan_journey.sql)
 */

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const {
  GRAPH_API_VERSION = 'v25.0',
  PHONE_NUMBER_ID,
  ACCESS_TOKEN,
  VERIFY_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

// Lazily initialised — module is imported at build time without env vars.
let _supabase;
function db() {
  if (!_supabase) _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return _supabase;
}

function graphUrl() {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

// ---------------------------------------------------------------------------
// Outbound message helpers
// ---------------------------------------------------------------------------

async function sendRequest(payload) {
  try {
    await axios.post(graphUrl(), payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('WhatsApp API error:', err.response?.data || err.message);
  }
}

/**
 * Plain text message.
 * Also the fallback for any step when the client can't render interactive messages.
 */
export function sendText(to, body) {
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

/**
 * Interactive button message (up to 3 buttons).
 * buttons: [{ id, title }]
 *
 * §4.3 requirement: bodyText must already include a numbered plain-text
 * fallback ("Reply 1 for Yes, 2 for No") so customers on clients that
 * can't render buttons can still respond.
 */
export function sendButtons(to, bodyText, buttons) {
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

/**
 * Interactive list message.
 * rows: [{ id, title, description? }]
 *
 * Same §4.3 requirement applies — include numbered fallback in bodyText.
 */
export function sendList(to, bodyText, buttonLabel, rows) {
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
// State machine (TODO: §8 step 3)
// ---------------------------------------------------------------------------

// Placeholder — replaced when the loan journey state machine is wired up.
async function handleInboundMessage(waId, message) {
  console.log(`Inbound [${message.type}] from ${waId} — state machine pending (§8 step 3)`);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode      = searchParams.get('hub.mode');
  const token     = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return new Response(challenge, { status: 200 });
  }
  return new Response(null, { status: 403 });
}

export async function POST(request) {
  try {
    const body    = await request.json();
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return new Response(null, { status: 200 }); // status updates — ignore

    const waId = message.from;
    await handleInboundMessage(waId, message);
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }
  return new Response(null, { status: 200 });
}
