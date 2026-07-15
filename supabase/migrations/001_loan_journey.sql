-- =============================================================================
-- Migration 001: pre-approved personal loan journey
--
-- Apply in Supabase SQL Editor, or via `supabase db push` if using the CLI.
--
-- PREREQUISITE: the set_updated_at() trigger function must already exist.
-- It was created by the original README bootstrap SQL. If you are running
-- against a fresh project, add this block first:
--
--   create or replace function set_updated_at()
--   returns trigger language plpgsql as $$
--   begin new.updated_at = now(); return new; end;
--   $$;
--
-- ⚠ DATA CHECK: Before running, confirm whether the `applications` table
-- contains any data worth keeping (test runs from the old generic journey).
-- Export it from Supabase Table Editor → Export CSV if so. This migration
-- drops the table unconditionally — the old generic journey is retired.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Retire the old generic-journey table
-- -----------------------------------------------------------------------------
drop table if exists applications cascade;


-- -----------------------------------------------------------------------------
-- 2. pre_approved_offers
--
-- Source of truth for which (mobile_number, pan_number) pairs are eligible
-- and what loan amounts/tenures/ROIs are available. Populated via the
-- scripts/ingest-offers.js CSV ingest tool.
--
-- mobile_number convention: E.164 without leading "+", e.g. 919876543210.
--   The ingest script normalises 10-digit Indian numbers on the way in.
--   The webhook uses message.from verbatim (Meta sends E.164 without "+").
--
-- ROI convention: reducing-balance annual percentage, e.g. 14.00 = 14 % p.a.
--   ⚠ Confirm with the credit team before go-live that the CSV column is
--   indeed a reducing-balance rate — if it is flat-rate the EMI formula
--   (P×r×(1+r)^n / ((1+r)^n−1)) will produce wrong EMIs (see brief §6.4).
-- -----------------------------------------------------------------------------
create table pre_approved_offers (
  id                    uuid          primary key default gen_random_uuid(),
  mobile_number         text          not null,
  pan_number            text          not null,

  approval_amount       numeric       not null,   -- headline amount shown in step 5 ("approved for ₹X")

  -- Offer 1 — always present; a row without at least one offer should not exist
  offer1_amount         numeric       not null,
  offer1_tenure_months  int           not null,
  offer1_roi_annual     numeric       not null,

  -- Offer 2 — nullable (not every customer gets 3 offers)
  offer2_amount         numeric,
  offer2_tenure_months  int,
  offer2_roi_annual     numeric,

  -- Offer 3 — nullable
  offer3_amount         numeric,
  offer3_tenure_months  int,
  offer3_roi_annual     numeric,

  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint pre_approved_offers_mobile_pan_uq
    unique (mobile_number, pan_number)
);

-- PAN is the customer-entered lookup key; index it for fast equality queries
create index pre_approved_offers_pan_idx
  on pre_approved_offers (pan_number);

create trigger pre_approved_offers_updated_at
  before update on pre_approved_offers
  for each row execute procedure set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. loan_applications
--
-- One row per application attempt. Cancel-and-restart creates a fresh row
-- (status = 'in_progress'); the previous row is retained with
-- status = 'cancelled' for audit. The active session for a given
-- mobile_number is the row with status = 'in_progress'.
-- -----------------------------------------------------------------------------
create table loan_applications (
  id                      uuid          primary key default gen_random_uuid(),
  mobile_number           text          not null,

  -- ── Conversation stage ────────────────────────────────────────────────────
  -- Values: interest | pan | approval | aadhaar | otp | offers |
  --         confirm | esign | bank | mandate | done | cancelled
  stage                   text          not null default 'interest',

  -- ── Collected data ────────────────────────────────────────────────────────
  -- TODO (before go-live): encrypt pan_number at the application layer.
  -- AES-SIV / deterministic encryption preserves equality-query capability.
  -- See brief §7.1.
  pan_number              text,

  selected_offer_index    int,          -- 1 | 2 | 3 — set when customer picks

  -- ⚠ ONLY the last 4 Aadhaar digits are ever written here.
  -- The full 12-digit number must never appear in this table, in logs, or
  -- in any other persistent store (see brief §7.1).
  aadhaar_last4           text,

  -- Encrypted at the application layer (AES-256-GCM) before INSERT.
  -- The raw account number must never be stored in plaintext.
  bank_account_number     text,
  bank_name               text,
  branch_or_ifsc          text,

  mandate_method          text,         -- 'NACH' | 'UPI_AUTOPAY'

  -- ── Compliance ────────────────────────────────────────────────────────────
  -- Timestamp of the customer's "Yes" to the privacy policy — required for
  -- audit. Also written to consent_log for the append-only audit trail.
  consent_given_at        timestamptz,
  otp_attempts            int           not null default 0,

  -- Values: in_progress | completed | cancelled | no_offer | declined
  status                  text          not null default 'in_progress',

  -- ── Idempotency ───────────────────────────────────────────────────────────
  -- Stores the last successfully processed Meta message ID. If an inbound
  -- event arrives with the same ID, it is a replay — skip processing and
  -- return 200 immediately without advancing the stage.
  last_wa_message_id      text,

  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now()
);

create index loan_applications_mobile_idx
  on loan_applications (mobile_number);

-- Partial index for fast active-session lookup (the common query path)
create index loan_applications_active_idx
  on loan_applications (mobile_number)
  where status = 'in_progress';

create index loan_applications_status_idx
  on loan_applications (status);

create trigger loan_applications_updated_at
  before update on loan_applications
  for each row execute procedure set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. consent_log
--
-- Append-only compliance table. Never UPDATE rows. One row per consent event:
--   privacy_policy   — customer tapped "Yes" to the opening privacy notice
--   esign_complete   — simulated eSign confirmed (real: provider webhook)
--   mandate_auth     — simulated mandate authorised (real: provider webhook)
-- -----------------------------------------------------------------------------
create table consent_log (
  id                    uuid          primary key default gen_random_uuid(),
  loan_application_id   uuid          not null references loan_applications (id),
  event_type            text          not null,
  mobile_number         text          not null,
  channel               text          not null default 'whatsapp',
  -- Provider message ID, raw timestamp, and any other provenance metadata
  metadata              jsonb,
  created_at            timestamptz   not null default now()
);

create index consent_log_application_idx
  on consent_log (loan_application_id);


-- -----------------------------------------------------------------------------
-- 5. Row Level Security
--
-- All three tables are locked to service-role-only access.
-- The webhook (lib/loan-journey/db.js) and dashboard data fetch both use
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS unconditionally.
-- The anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY) is public-facing and must
-- never be able to read PAN numbers, Aadhaar digits, or bank details.
-- Enabling RLS with zero policies achieves this: anon and authenticated roles
-- get no access; service role is unaffected.
-- -----------------------------------------------------------------------------
alter table pre_approved_offers  enable row level security;
alter table loan_applications    enable row level security;
alter table consent_log          enable row level security;
