import { createClient } from '@supabase/supabase-js';

let _db;
function db() {
  if (!_db) _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _db;
}

export async function getActiveApplication(mobile) {
  const { data, error } = await db()
    .from('loan_applications')
    .select('*')
    .eq('mobile_number', mobile)
    .eq('status', 'in_progress')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createApplication(mobile) {
  const { data, error } = await db()
    .from('loan_applications')
    .insert({ mobile_number: mobile, stage: 'interest', status: 'in_progress' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateApplication(id, fields) {
  const { error } = await db()
    .from('loan_applications')
    .update(fields)
    .eq('id', id);
  if (error) throw error;
}

export async function lookupOffer(mobile, pan) {
  const { data, error } = await db()
    .from('pre_approved_offers')
    .select('*')
    .eq('mobile_number', mobile)
    .eq('pan_number', pan.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function logConsent(appId, eventType, mobile, metadata = null) {
  const { error } = await db()
    .from('consent_log')
    .insert({
      loan_application_id: appId,
      event_type: eventType,
      mobile_number: mobile,
      channel: 'whatsapp',
      metadata,
    });
  if (error) throw error;
}
