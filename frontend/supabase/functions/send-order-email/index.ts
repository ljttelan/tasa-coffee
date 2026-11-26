import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type EmailEvent = 'confirmation' | 'cancelled' | 'status_update' | 'return_update'
type OrderRow = {
  id: string
  user_id: string
  courier_id: string | null
  customer_name: string
  status: string
  return_status: string
  total: number
}
type OrderItem = {
  product_name: string
  product_option: string
  quantity: number
  unit_price: number
}

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return value.replace(/[&<>"']/g, (character) => entities[character])
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405)

  try {
    const authorization = request.headers.get('Authorization')
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return respond({ error: 'Authentication is required.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL')
    if (!supabaseUrl || !anonKey || !serviceRoleKey || !resendApiKey || !fromEmail) {
      console.error('send-order-email is missing required Supabase or Resend configuration.')
      return respond({ error: 'Order email delivery is not configured.' }, 503)
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: authData, error: authError } = await authClient.auth.getUser(token)
    if (authError || !authData.user) return respond({ error: 'Authentication is invalid or expired.' }, 401)

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return respond({ error: 'A valid JSON request body is required.' }, 400)
    }
    if (!payload || typeof payload !== 'object') return respond({ error: 'Request data is invalid.' }, 400)

    const { order_id: orderId, event_type: eventType } = payload as Record<string, unknown>
    const allowedEvents: EmailEvent[] = ['confirmation', 'cancelled', 'status_update', 'return_update']
    if (
      typeof orderId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId) ||
      typeof eventType !== 'string' ||
      !allowedEvents.includes(eventType as EmailEvent)
    ) {
      return respond({ error: 'Order email request is invalid.' }, 400)
    }

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const [actorResult, orderResult] = await Promise.all([
      serviceClient.from('profiles').select('role').eq('id', authData.user.id).maybeSingle(),
      serviceClient
        .from('orders')
        .select('id,user_id,courier_id,customer_name,status,return_status,total')
        .eq('id', orderId)
        .maybeSingle(),
    ])
    if (actorResult.error || orderResult.error) {
      console.error('Could not verify order email access.')
      return respond({ error: 'Could not verify order email access.' }, 500)
    }

    const order = orderResult.data as OrderRow | null
    const role = actorResult.data?.role
    if (!order) return respond({ error: 'Order not found.' }, 404)

    const isOwner = order.user_id === authData.user.id
    const isStaff = role === 'admin' || role === 'staff'
    const isAssignedCourier = role === 'fulfillment' && order.courier_id === authData.user.id
    if (!isOwner && !isStaff && !isAssignedCourier) return respond({ error: 'Order not found.' }, 404)
    if (eventType === 'confirmation' && !isOwner) {
      return respond({ error: 'Only the customer can request an order confirmation.' }, 403)
    }
    if (eventType === 'cancelled' && !isOwner && !isStaff) {
      return respond({ error: 'Customer or staff access is required for cancellation emails.' }, 403)
    }
    if (eventType === 'cancelled' && order.status !== 'Cancelled') {
      return respond({ error: 'Only cancelled orders can send a cancellation email.' }, 409)
    }
    if (eventType === 'status_update' && !isStaff && !isAssignedCourier) {
      return respond({ error: 'Assigned fulfillment access is required for status emails.' }, 403)
    }
    if (eventType === 'return_update' && !isOwner && !isStaff) {
      return respond({ error: 'Staff access is required for return emails.' }, 403)
    }
    if (eventType === 'return_update' && order.return_status === 'None') {
      return respond({ error: 'This order has no return update to send.' }, 409)
    }

    const [recipientResult, itemsResult] = await Promise.all([
      serviceClient.from('profiles').select('email').eq('id', order.user_id).single(),
      serviceClient
        .from('order_items')
        .select('product_name,product_option,quantity,unit_price')
        .eq('order_id', order.id)
        .order('created_at'),
    ])
    if (recipientResult.error || itemsResult.error) {
      console.error('Could not load order email details.')
      return respond({ error: 'Could not load order email details.' }, 500)
    }

    const subjects: Record<EmailEvent, string> = {
      confirmation: 'Your Tasa Coffee order is confirmed',
      cancelled: 'Your Tasa Coffee order was cancelled',
      status_update: 'Your Tasa Coffee order has an update',
      return_update: 'Your Tasa Coffee return has an update',
    }
    const descriptions: Record<EmailEvent, string> = {
      confirmation: 'We have received your order.',
      cancelled: 'Your order has been cancelled. Any refund shown in your account is demo-only; no real payment was processed.',
      status_update: `Your order status is now ${order.status}.`,
      return_update: `Your return status is ${order.return_status}. Any refund shown in your account is demo-only; no real payment was processed.`,
    }
    const items = (itemsResult.data ?? []) as OrderItem[]
    const orderNumber = `TASA-${order.id.replace(/-/g, '').toUpperCase()}`
    const itemMarkup = items.map((item) =>
      `<li>${escapeHtml(String(item.quantity))} × ${escapeHtml(item.product_name)} (${escapeHtml(item.product_option)}) — ₱${Number(item.unit_price * item.quantity).toFixed(2)}</li>`,
    ).join('')
    const html = [
      `<h1>${escapeHtml(subjects[eventType as EmailEvent])}</h1>`,
      `<p>Hi ${escapeHtml(order.customer_name)},</p>`,
      `<p>${escapeHtml(descriptions[eventType as EmailEvent])}</p>`,
      `<p>Order <strong>${escapeHtml(orderNumber)}</strong> · ${escapeHtml(order.status)}</p>`,
      `<ul>${itemMarkup}</ul>`,
      `<p>Total: <strong>₱${Number(order.total).toFixed(2)}</strong></p>`,
      '<p>Use this order number on the Track Order page to see the latest delivery details.</p>',
    ].join('')

    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipientResult.data.email],
        subject: subjects[eventType as EmailEvent],
        html,
      }),
    })
    if (!resendResponse.ok) {
      console.error(`Resend rejected an order email with status ${resendResponse.status}.`)
      return respond({ error: 'The email provider could not deliver this message.' }, 502)
    }

    return respond({ sent: true })
  } catch (reason) {
    console.error('send-order-email failed:', reason)
    return respond({ error: 'Order email delivery failed.' }, 500)
  }
})
