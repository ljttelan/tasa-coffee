begin;

create or replace function public.track_order(p_order_number text)
returns table (
  id uuid,
  created_at timestamptz,
  status text,
  tracking_number text,
  courier_name text,
  shipping_address text,
  payment_method text,
  subtotal numeric,
  delivery_fee numeric,
  total numeric,
  items jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_compact_number text;
  v_order_id uuid;
begin
  v_compact_number := upper(
    replace(
      regexp_replace(trim(coalesce(p_order_number, '')), '^TASA-', '', 'i'),
      '-',
      ''
    )
  );
  if v_compact_number !~ '^[0-9A-F]{32}$' then
    return;
  end if;

  v_order_id := (
    substr(v_compact_number, 1, 8) || '-' ||
    substr(v_compact_number, 9, 4) || '-' ||
    substr(v_compact_number, 13, 4) || '-' ||
    substr(v_compact_number, 17, 4) || '-' ||
    substr(v_compact_number, 21, 12)
  )::uuid;

  return query
    select
      o.id,
      o.created_at,
      o.status,
      o.tracking_number,
      p.name,
      o.shipping_address,
      o.payment_method,
      o.subtotal,
      o.delivery_fee,
      o.total,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'product_name', oi.product_name,
              'product_option', oi.product_option,
              'quantity', oi.quantity,
              'unit_price', oi.unit_price
            )
            order by oi.created_at, oi.id
          )
          from public.order_items oi
          where oi.order_id = o.id
        ),
        '[]'::jsonb
      )
    from public.orders o
    left join public.profiles p on p.id = o.courier_id
    where o.id = v_order_id;
end;
$$;

revoke all on function public.track_order(text) from public;
grant execute on function public.track_order(text) to anon, authenticated;

commit;
