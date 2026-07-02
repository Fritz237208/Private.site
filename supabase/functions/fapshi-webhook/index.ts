// supabase/functions/fapshi-webhook/index.ts
// Fapshi calls this URL when a payment status changes
// (SUCCESSFUL, FAILED, EXPIRED).
//
// Set this URL in your Fapshi dashboard under:
//   Settings → Webhooks → Webhook URL
// Also set a Webhook Secret there and add it to your
// Supabase secrets as FAPSHI_WEBHOOK_SECRET.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FAPSHI_WEBHOOK_SECRET = Deno.env.get('FAPSHI_WEBHOOK_SECRET')!;

// Use the SERVICE ROLE key here — this function runs as admin,
// no user JWT is involved since the caller is Fapshi's server.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

serve(async (req) => {
  /* ----------------------------------------------------------
     1. Verify the request is genuinely from Fapshi
        Fapshi sends the secret in the x-wh-secret header.
  ---------------------------------------------------------- */
  const incomingSecret = req.headers.get('x-wh-secret');
  if (!FAPSHI_WEBHOOK_SECRET || incomingSecret !== FAPSHI_WEBHOOK_SECRET) {
    console.warn('Webhook secret mismatch — rejected');
    return new Response('Unauthorized', { status: 401 });
  }

  /* ----------------------------------------------------------
     2. Parse the webhook payload
        Fapshi sends: { event, data: { transId, externalId, status, amount, ... } }
        status values: SUCCESSFUL | FAILED | EXPIRED
  ---------------------------------------------------------- */
  let payload: {
    event: string;
    data: {
      transId:    string;
      externalId: string; // this is your internal txnId (set in fapshi-initiate)
      status:     'SUCCESSFUL' | 'FAILED' | 'EXPIRED';
      amount:     number;
      medium?:    string; // 'mobile money' | 'orange money'
      phone?:     string;
    };
  };

  try {
    payload = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { transId, externalId, status, amount } = payload.data ?? {};

  if (!transId || !status) {
    return new Response('Missing transId or status', { status: 400 });
  }

  // Map Fapshi status → your DB status
  const dbStatus = status === 'SUCCESSFUL' ? 'successful'
    : status === 'FAILED'     ? 'failed'
    : 'failed'; // treat EXPIRED as failed too

  /* ----------------------------------------------------------
     3. Find the matching payment_transactions row.
        Primary lookup: fapshi_trans_id column.
        Fallback:       externalId (= your txnId, set in fapshi-initiate).
  ---------------------------------------------------------- */
  let txnId: string | null = null;

  // Try fapshi_trans_id first
  const { data: byFapshi } = await supabase
    .from('payment_transactions')
    .select('id, status, type, user_id, amount')
    .eq('fapshi_trans_id', transId)
    .maybeSingle();

  if (byFapshi) {
    txnId = byFapshi.id;
  } else if (externalId) {
    // Fallback: match by the externalId we passed when initiating
    const { data: byExternal } = await supabase
      .from('payment_transactions')
      .select('id, status, type, user_id, amount')
      .eq('id', externalId)
      .maybeSingle();
    if (byExternal) txnId = byExternal.id;
  }

  if (!txnId) {
    // Not found — log and return 200 so Fapshi doesn't keep retrying
    console.warn('Webhook: no matching transaction for transId', transId, 'externalId', externalId);
    return new Response('Transaction not found — acknowledged', { status: 200 });
  }

  const txn = byFapshi ?? null; // we'll re-fetch if we used the fallback path
  const currentStatus = txn?.status;

  // Idempotency: don't re-process if already settled
  if (currentStatus === 'successful' || currentStatus === 'failed') {
    console.log('Webhook: txn', txnId, 'already settled as', currentStatus, '— skipping');
    return new Response('Already processed', { status: 200 });
  }

  /* ----------------------------------------------------------
     4. Update the transaction status
  ---------------------------------------------------------- */
  const { error: updateErr } = await supabase
    .from('payment_transactions')
    .update({
      status:           dbStatus,
      fapshi_trans_id:  transId, // ensure it's stored even if fapshi-initiate missed it
      updated_at:       new Date().toISOString(),
    })
    .eq('id', txnId);

  if (updateErr) {
    console.error('Webhook: failed to update transaction', txnId, updateErr);
    // Return 500 so Fapshi retries the webhook
    return new Response('DB update failed', { status: 500 });
  }

  /* ----------------------------------------------------------
     5. If the payment was SUCCESSFUL and it's a subscription,
        update the user's access (set expires_at for university type,
        or leave as-is for concour since it's permanent access).
        This runs ONLY for subscription type — withdrawals are
        handled manually by your admin.
  ---------------------------------------------------------- */
  if (dbStatus === 'successful') {
    // Re-fetch the full row now that we know txnId
    const { data: fullTxn } = await supabase
      .from('payment_transactions')
      .select('type, user_id, school, department, level, semester, expires_at')
      .eq('id', txnId)
      .single();

    if (fullTxn?.type === 'subscription') {
      // For university subscriptions: set expires_at to 1 year from now
      // if it wasn't already set when the row was created.
      if (!fullTxn.expires_at && fullTxn.school) {
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);

        await supabase
          .from('payment_transactions')
          .update({ expires_at: expiresAt.toISOString() })
          .eq('id', txnId);
      }

      // Optionally: update a `subscriptions` or `profiles` table here
      // if you track active subscription status separately.
    }
  }

  /* ----------------------------------------------------------
     6. Acknowledge to Fapshi — always return 200 once processed
  ---------------------------------------------------------- */
  console.log(`Webhook: txn ${txnId} → ${dbStatus} (fapshi transId: ${transId})`);
  return new Response('OK', { status: 200 });
});
