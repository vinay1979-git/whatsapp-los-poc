# WhatsApp LOS POC

A minimal, fully self-serve loan-application journey over the WhatsApp Cloud API,
built on the test WhatsApp Business Account ("WhatAPP Onboarding" app) created
in the Meta App Dashboard.

## Journey

Customer messages the test number first (any text, e.g. "Hi") -> bot walks them
through: loan type -> consent -> name -> PAN -> DOB -> employment type ->
income -> PAN photo upload -> address proof upload -> bureau consent ->
application summary with a reference ID. From there, the bank/NBFC's LOS
backend can push status-update messages (see "Sending status updates" below).

Because the customer always messages first, this POC needs **no approved
message templates** - it all runs on free-form + interactive messages inside
the 24-hour customer service window. In production, if the *bank* wants to
initiate the conversation (e.g. "click here to apply"), that first message
must be an approved template - see "Going beyond this POC."

## 1. Install

```bash
cd whatsapp-los-poc
npm install
```

## 2. Configure

`.env` is already filled in with the test credentials from the Meta App
Dashboard (App: WhatAPP Onboarding, test number +1 555 147 3691):

- `PHONE_NUMBER_ID`, `WABA_ID`, `ACCESS_TOKEN` - from API Setup panel
- `VERIFY_TOKEN` - any string you pick; must match what you enter in Meta's webhook config screen

**The ACCESS_TOKEN is a short-lived test token (~24h).** When it expires,
generate a new one from App Dashboard > your app > WhatsApp > API Setup >
Access token > Generate new token, and paste it into `.env`.

## 3. Run the server

```bash
npm start
```

Runs on `http://localhost:3000`.

## 4. Expose it publicly (ngrok)

Meta needs a public HTTPS URL to send webhook events to.

```bash
ngrok http 3000
```

Copy the `https://...ngrok-free.app` URL it gives you.

## 5. Register the webhook in Meta

In App Dashboard > your app > WhatsApp > Configuration:

- Callback URL: `https://<your-ngrok-domain>/webhook`
- Verify token: same value as `VERIFY_TOKEN` in `.env`
- Subscribe to the `messages` webhook field

Click "Verify and save" - it will hit your `/webhook` GET endpoint, which
this server already handles.

## 6. Test it

From the phone number you added as a test recipient earlier, send any message
(e.g. "Hi") to the test number +1 555 147 3691. You should get the loan-type
list message back, and the conversation proceeds from there.

Watch your terminal - every inbound message is logged.

## Sending status updates later

Once an application is submitted, the actual LOS backend (not this POC) will
be the source of truth for status changes. To notify the customer, POST to
the same Graph API endpoint:

```
POST https://graph.facebook.com/v25.0/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {ACCESS_TOKEN}

{
  "messaging_product": "whatsapp",
  "to": "{customer_wa_id}",
  "type": "text",
  "text": { "body": "Your application LOS-12345678 has been approved! Next steps: ..." }
}
```

Outside the 24h window (i.e. more than a day since the customer's last
message), this must instead be a pre-approved **utility template message** -
plain text will be rejected by the API.

## Supabase schema

Run this once in the Supabase SQL editor to create the `applications` table used by the Vercel function:

```sql
create table applications (
  wa_id               text primary key,
  state               text not null default 'NEW',
  loan_type           text,
  name                text,
  pan                 text,
  dob                 text,
  employment          text,
  income              text,
  pan_doc_media_id    text,
  address_doc_media_id text,
  ref_id              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Optional: auto-update updated_at on every write
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger applications_updated_at
  before update on applications
  for each row execute procedure set_updated_at();
```

Set these environment variables in your Vercel project settings (and locally in `.env` for `server.js`):

| Variable                   | Where to find it                                  |
|----------------------------|---------------------------------------------------|
| `SUPABASE_URL`             | Supabase project Settings > API > Project URL     |
| `SUPABASE_SERVICE_ROLE_KEY`| Supabase project Settings > API > service_role key|

## Going beyond this POC

- **Persistence**: swap the in-memory `sessions` Map in `server.js` for a real
  store (Redis, or a table in your LOS DB) keyed by WhatsApp ID, so state
  survives server restarts and scales across instances.
- **Document handling**: this POC only logs the media ID from uploaded
  images. To actually retrieve the file, call
  `GET https://graph.facebook.com/v25.0/{media_id}` with your access token to
  get a temporary download URL, then fetch and store it in the LOS document
  store.
- **WhatsApp Flows**: for a slicker KYC data-entry screen (native multi-field
  form instead of one-question-at-a-time text prompts), build a Flow in
  WhatsApp Manager and reference its `flow_id` from an interactive Flow
  message. This requires the Flow to be built/published separately in the
  Meta console and is a good next iteration once the conversational version
  is validated with the bank/NBFC.
- **Business-initiated journeys**: if the bank wants to text the customer
  first (rather than waiting for them to message in), the opening message
  must be an approved **message template** with a quick-reply or CTA button.
  Templates are submitted via WhatsApp Manager > Message Templates and
  typically approve within minutes to a few hours.
- **Production number & Tech Provider status**: this POC runs on Meta's free
  test number, capped at 5 recipient numbers. Moving to a real customer-facing
  number, and onboarding multiple bank/NBFC clients, requires completing
  Meta's Tech Provider business verification + App Review (see the earlier
  discussion) or routing through a BSP.
