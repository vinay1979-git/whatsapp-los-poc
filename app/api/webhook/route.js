/**
 * app/api/webhook/route.js
 *
 * WhatsApp Cloud API webhook — pre-approved personal loan journey.
 * GET  /api/webhook — Meta hub verification challenge
 * POST /api/webhook — inbound message events
 *
 * State machine: lib/loan-journey/stateMachine.js
 * Schema:        supabase/migrations/001_loan_journey.sql
 */

import { getActiveApplication, createApplication, updateApplication } from '../../../lib/loan-journey/db.js';
import { dispatch } from '../../../lib/loan-journey/stateMachine.js';
import { sendWelcome } from '../../../lib/loan-journey/messages.js';

export const dynamic = 'force-dynamic';

const { VERIFY_TOKEN } = process.env;

// ── GET: Meta hub verification ────────────────────────────────────────────────

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

// ── POST: inbound message events ──────────────────────────────────────────────

export async function POST(request) {
  try {
    const body    = await request.json();
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    // Status updates (delivered, read, etc.) have no `messages` array — ignore them.
    if (!message) return new Response(null, { status: 200 });

    await handleInboundMessage(message.from, message);
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
  return new Response(null, { status: 200 });
}

// ── Core handler ──────────────────────────────────────────────────────────────

async function handleInboundMessage(waId, message) {
  let app = await getActiveApplication(waId);
  const isNewSession = !app;

  if (isNewSession) app = await createApplication(waId);

  // Deduplicate: Meta occasionally delivers the same webhook event twice.
  if (message.id && app.last_wa_message_id === message.id) {
    console.log(`[webhook] Duplicate event ${message.id} — skipped`);
    return;
  }
  await updateApplication(app.id, { last_wa_message_id: message.id });

  // First inbound message on a brand-new session → send the welcome prompt.
  // Subsequent messages on an existing session → dispatch to the state machine.
  if (isNewSession) {
    await sendWelcome(waId);
    return;
  }

  await dispatch(app, message);
}
