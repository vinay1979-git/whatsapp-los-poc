import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '../../lib/supabase/server';
import SignOutButton from './SignOutButton';

const STAGE_LABELS = {
  NEW: 'New',
  AWAITING_LOAN_TYPE: 'Choosing loan type',
  AWAITING_CONSENT: 'Awaiting consent',
  AWAITING_NAME: 'Name',
  AWAITING_PAN: 'PAN',
  AWAITING_DOB: 'DOB',
  AWAITING_EMPLOYMENT: 'Employment',
  AWAITING_INCOME: 'Income',
  AWAITING_PAN_DOC: 'PAN doc',
  AWAITING_ADDRESS_DOC: 'Address doc',
  AWAITING_BUREAU_CONSENT: 'Bureau consent',
  COMPLETE: 'Complete',
};

function stageBadge(state) {
  const isComplete = state === 'COMPLETE';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: '999px',
      fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.02em',
      background: isComplete ? '#dcfce7' : '#fef9c3',
      color: isComplete ? '#15803d' : '#854d0e',
    }}>
      {STAGE_LABELS[state] ?? state}
    </span>
  );
}

function dash(value) {
  return value || <span style={{ color: '#94a3b8' }}>—</span>;
}

export default async function DashboardPage() {
  // Verify auth session (anon client reads the cookie set by middleware).
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect('/login');

  // Fetch applications with the service-role key — bypasses RLS.
  const db = createServiceClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: applications, error } = await db
    .from('applications')
    .select('wa_id, state, loan_type, name, ref_id, updated_at')
    .order('updated_at', { ascending: false });

  return (
    <main style={{ padding: '2rem', maxWidth: '1140px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 700 }}>Loan Applications</h1>
          <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: '#64748b' }}>
            {applications?.length ?? 0} total · sorted by last updated
          </p>
        </div>
        <SignOutButton />
      </div>

      {error && (
        <p style={{ color: '#dc2626', background: '#fef2f2', padding: '10px 14px', borderRadius: '6px', fontSize: '0.875rem' }}>
          Error loading applications: {error.message}
        </p>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse', background: 'white',
          borderRadius: '10px', overflow: 'hidden', boxShadow: '0 1px 6px rgba(0,0,0,0.08)',
          fontSize: '0.875rem',
        }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
              {['Phone', 'Stage', 'Loan Type', 'Name', 'Ref ID', 'Last Updated (IST)'].map((h) => (
                <th key={h} style={{
                  padding: '10px 16px', textAlign: 'left', fontWeight: 600,
                  fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase',
                  letterSpacing: '0.06em', whiteSpace: 'nowrap',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!applications?.length && (
              <tr>
                <td colSpan={6} style={{ padding: '2.5rem', textAlign: 'center', color: '#94a3b8' }}>
                  No applications yet.
                </td>
              </tr>
            )}
            {applications?.map((app, i) => (
              <tr key={app.wa_id} style={{ borderTop: i > 0 ? '1px solid #f1f5f9' : undefined }}>
                <td style={{ padding: '11px 16px', fontFamily: 'monospace', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                  {app.wa_id}
                </td>
                <td style={{ padding: '11px 16px' }}>{stageBadge(app.state)}</td>
                <td style={{ padding: '11px 16px' }}>{dash(app.loan_type)}</td>
                <td style={{ padding: '11px 16px' }}>{dash(app.name)}</td>
                <td style={{ padding: '11px 16px', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                  {dash(app.ref_id)}
                </td>
                <td style={{ padding: '11px 16px', color: '#475569', whiteSpace: 'nowrap' }}>
                  {new Date(app.updated_at).toLocaleString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
