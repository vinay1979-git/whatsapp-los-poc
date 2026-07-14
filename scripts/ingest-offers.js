#!/usr/bin/env node
/**
 * scripts/ingest-offers.js
 *
 * Upserts pre-approved loan offers from a CSV file into the
 * pre_approved_offers table in Supabase.
 *
 * Usage:
 *   node scripts/ingest-offers.js <path-to-csv> [--dry-run]
 *
 * Required env vars (set in .env or Vercel project settings):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Expected CSV format (header row required, order matters):
 *   mobile_number, pan_number, approval_amount,
 *   offer1_amount, offer1_tenure_months, offer1_roi_annual,
 *   offer2_amount, offer2_tenure_months, offer2_roi_annual,   ← optional
 *   offer3_amount, offer3_tenure_months, offer3_roi_annual    ← optional
 *
 * mobile_number accepts:
 *   - 10-digit Indian numbers (6-9XXXXXXXXX) → auto-prefixed with 91
 *   - E.164 with leading + (+91XXXXXXXXXX)  → + stripped
 *   - E.164 without + (91XXXXXXXXXX)        → used as-is
 *
 * On conflict (mobile_number, pan_number) the row is overwritten (upsert).
 * Run with --dry-run to validate and print rows without writing to the DB.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ──────────────────────────────────────────────────────────────────

const CSV_PATH = process.argv[2];
const DRY_RUN  = process.argv.includes('--dry-run');
const BATCH    = 100; // rows per Supabase upsert call

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// ─── Validation ──────────────────────────────────────────────────────────────

if (!CSV_PATH) {
  console.error('Usage: node scripts/ingest-offers.js <path-to-csv> [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error(`File not found: ${CSV_PATH}`);
  process.exit(1);
}
if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise to E.164 without the leading "+". */
function normalizeMobile(raw) {
  let m = raw.replace(/[\s\-()+]/g, '');
  // 10-digit Indian mobile (starts with 6-9)
  if (/^[6-9]\d{9}$/.test(m)) m = '91' + m;
  return m;
}

/** Validate E.164-without-+ after normalisation. */
function isValidMobile(m) {
  return /^\d{10,15}$/.test(m);
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function parseNum(s) {
  if (s === undefined || s === null || s.trim() === '') return null;
  const n = Number(s.trim());
  return isNaN(n) ? null : n;
}

function parseInt2(s) {
  if (s === undefined || s === null || s.trim() === '') return null;
  const n = parseInt(s.trim(), 10);
  return isNaN(n) ? null : n;
}

/**
 * Parse a single data row (array of trimmed strings) into a DB row object.
 * Returns { row, errors } — errors is empty on success.
 */
function parseRow(fields, lineNo) {
  const errors = [];

  const mobile = normalizeMobile(fields[0] ?? '');
  if (!isValidMobile(mobile)) {
    errors.push(`invalid mobile_number "${fields[0]}"`);
  }

  const pan = (fields[1] ?? '').trim().toUpperCase();
  if (!PAN_RE.test(pan)) {
    errors.push(`invalid PAN "${fields[1]}" (expected AAAAA9999A format)`);
  }

  const approvalAmount = parseNum(fields[2]);
  if (approvalAmount === null) errors.push('approval_amount is missing or non-numeric');

  const o1Amount  = parseNum(fields[3]);
  const o1Tenure  = parseInt2(fields[4]);
  const o1Roi     = parseNum(fields[5]);
  if (o1Amount === null || o1Tenure === null || o1Roi === null) {
    errors.push('offer1 fields (amount, tenure_months, roi_annual) are required');
  }

  // Offers 2 and 3 are optional; validate only when partially present
  const o2Amount  = parseNum(fields[6]);
  const o2Tenure  = parseInt2(fields[7]);
  const o2Roi     = parseNum(fields[8]);
  const o2present = [o2Amount, o2Tenure, o2Roi].filter(v => v !== null).length;
  if (o2present > 0 && o2present < 3) {
    errors.push('offer2 is partially filled — provide all three fields (amount, tenure_months, roi_annual) or leave all blank');
  }

  const o3Amount  = parseNum(fields[9]);
  const o3Tenure  = parseInt2(fields[10]);
  const o3Roi     = parseNum(fields[11]);
  const o3present = [o3Amount, o3Tenure, o3Roi].filter(v => v !== null).length;
  if (o3present > 0 && o3present < 3) {
    errors.push('offer3 is partially filled — provide all three fields or leave all blank');
  }

  if (errors.length) return { row: null, errors };

  return {
    errors: [],
    row: {
      mobile_number:        mobile,
      pan_number:           pan,
      approval_amount:      approvalAmount,
      offer1_amount:        o1Amount,
      offer1_tenure_months: o1Tenure,
      offer1_roi_annual:    o1Roi,
      offer2_amount:        o2Amount,
      offer2_tenure_months: o2Tenure,
      offer2_roi_annual:    o2Roi,
      offer3_amount:        o3Amount,
      offer3_tenure_months: o3Tenure,
      offer3_roi_annual:    o3Roi,
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📂 Reading: ${CSV_PATH}${DRY_RUN ? '  (dry run — no DB writes)' : ''}\n`);

  const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const rl = readline.createInterface({
    input: fs.createReadStream(CSV_PATH),
    crlfDelay: Infinity,
  });

  const rows = [];
  const rowErrors = [];
  let lineNo = 0;
  let headerSkipped = false;

  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue; // skip blank lines

    // Skip header row (first non-blank line, detected by leading letter in first field)
    if (!headerSkipped) {
      headerSkipped = true;
      if (/^[a-z_]/i.test(trimmed.split(',')[0])) {
        continue; // it's a header
      }
    }

    const fields = trimmed.split(',');
    const { row, errors } = parseRow(fields, lineNo);

    if (errors.length) {
      rowErrors.push({ lineNo, errors, raw: trimmed });
    } else {
      rows.push(row);
    }
  }

  // ── Report validation results ─────────────────────────────────────────────
  console.log(`Parsed ${lineNo} line(s): ${rows.length} valid, ${rowErrors.length} error(s)\n`);

  if (rowErrors.length) {
    console.error('─── Validation errors ────────────────────────────────────');
    for (const { lineNo: n, errors, raw } of rowErrors) {
      console.error(`  Line ${n}: ${raw.substring(0, 80)}`);
      for (const e of errors) console.error(`    • ${e}`);
    }
    console.error('──────────────────────────────────────────────────────────\n');
  }

  if (rows.length === 0) {
    console.log('Nothing to write.');
    process.exit(rowErrors.length ? 1 : 0);
  }

  if (DRY_RUN) {
    console.log('─── Rows that would be upserted ──────────────────────────');
    for (const r of rows) {
      const offers = [1, 2, 3].filter(i => r[`offer${i}_amount`] !== null).length;
      console.log(`  ${r.mobile_number}  ${r.pan_number}  ₹${r.approval_amount}  (${offers} offer${offers !== 1 ? 's' : ''})`);
    }
    console.log('──────────────────────────────────────────────────────────\n');
    console.log('Dry run complete. Re-run without --dry-run to write to DB.');
    process.exit(0);
  }

  // ── Upsert in batches ─────────────────────────────────────────────────────
  let inserted = 0;
  let failed   = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('pre_approved_offers')
      .upsert(batch, { onConflict: 'mobile_number,pan_number' });

    if (error) {
      console.error(`Batch ${Math.floor(i / BATCH) + 1} failed: ${error.message}`);
      failed += batch.length;
    } else {
      inserted += batch.length;
      process.stdout.write(`\rUpserted ${inserted} / ${rows.length}...`);
    }
  }

  console.log(`\n\n✅ Done. ${inserted} upserted, ${failed} failed, ${rowErrors.length} skipped (validation).`);
  process.exit(failed || rowErrors.length ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
