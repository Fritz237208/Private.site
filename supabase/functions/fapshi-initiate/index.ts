// supabase/functions/fapshi-initiate/index.ts
// Receives { amount, txnId } from the frontend,
// calls Fapshi's initiate-pay endpoint, stores the
// returned transId on the payment_transactions row,
// and returns { transId, paymentUrl } to the client.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FAPSHI_API_USER = Deno.env.get('FAPSHI_API_USER')!;
const FAPSHI_API_KEY  = Deno.env.get('FAPSHI_API_KEY')!;
const FAPSHI_BASE_URL = Deno.env.get('FAPSHI_ENV') === 'live'
  ? 'https://live.fapshi.com'
  : 'https://sandbox.fapshi.com';

// The URL Fapshi redirects the user to after payment.
// Replace with your real success page once you have one.
const REDIRECT_URL = Deno.env.get('PAYMENT_REDIRECT_URL') ?? 'https://examwise.cm/payment/return';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    /* ----------------------------------------------------------
       1. Parse & validate the request body
    ---------------------------------------------------------- */
    const { amount, txnId } = await req.json();

    if (!amount || !txnId) {
      return new Response(
        JSON.stringify({ error: 'amount and txnId are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (typeof amount !== 'number' || amount < 100) {
      return new Response(
        JSON.stringify({ error: 'amount must be a number ≥ 100 FCFA' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    /* ----------------------------------------------------------
       2. Authenticate the calling user via the JWT in the
          Authorization header (set automatically by supabase.functions.invoke)
    ---------------------------------------------------------- */
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    // Verify the user is authenticated
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    /* ----------------------------------------------------------
       3. Verify the txnId belongs to this user and is still pending
          (prevents users from hijacking another user's transaction)
    ---------------------------------------------------------- */
    const { data: txn, error: txnError } = await supabase
      .from('payment_transactions')
      .select('id, amount, status, user_id')
      .eq('id', txnId)
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .single();

    if (txnError || !txn) {
      return new Response(
        JSON.stringify({ error: 'Transaction not found or already processed' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Double-check the amount matches what was stored (prevents tampering)
    if (txn.amount !== amount) {
      return new Response(
        JSON.stringify({ error: 'Amount mismatch' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    /* ----------------------------------------------------------
       4. Call Fapshi's initiate-pay endpoint
          Docs: https://docs.fapshi.com/en/api-reference/endpoint/initiate-pay.md
    ---------------------------------------------------------- */
    const fapshiRes = await fetch(`${FAPSHI_BASE_URL}/initiate-pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apiuser': FAPSHI_API_USER,
        'apikey':  FAPSHI_API_KEY,
      },
      body: JSON.stringify({
        amount,                    // amount in FCFA (integer)
        redirectUrl: REDIRECT_URL, // where to send user after payment
        userId: user.id,           // lets you query transactions by user later
        externalId: txnId,         // your internal txn ID — comes back in the webhook
        message: `ExamWise subscription payment`, // shown to user on MoMo prompt
      }),
    });

    const fapshiData = await fapshiRes.json();

    if (!fapshiRes.ok) {
      console.error('Fapshi error:', fapshiData);
      return new Response(
        JSON.stringify({ error: fapshiData.message ?? 'Fapshi request failed' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // fapshiData = { transId: "...", link: "https://..." }
    const { transId, link: paymentUrl } = fapshiData;

    /* ----------------------------------------------------------
       5. Store the Fapshi transId on the payment_transactions row
          so the webhook can later match the callback to this txn.
    ---------------------------------------------------------- */
    const { error: updateError } = await supabase
      .from('payment_transactions')
      .update({ fapshi_trans_id: transId })
      .eq('id', txnId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('Failed to store fapshi_trans_id:', updateError);
      // Non-fatal — the webhook uses externalId as fallback
    }

    /* ----------------------------------------------------------
       6. Return the payment link to the frontend
    ---------------------------------------------------------- */
    return new Response(
      JSON.stringify({ transId, paymentUrl }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Unhandled error in fapshi-initiate:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
