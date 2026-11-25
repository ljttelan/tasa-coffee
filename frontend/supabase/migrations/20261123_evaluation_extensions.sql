begin;

alter table public.products
  drop constraint if exists products_category_check;

create table if not exists public.product_categories (
  name text primary key check (length(trim(name)) between 1 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  price_delta numeric(10, 2) not null default 0 check (price_delta >= 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (product_id, name)
);

create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 60),
  full_address text not null check (length(trim(full_address)) between 5 and 500),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists customer_addresses_one_default_idx
  on public.customer_addresses (user_id) where is_default;

create table if not exists public.coupons (
  code text primary key check (code = upper(code) and length(code) between 2 and 32),
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  discount_value numeric(10, 2) not null check (discount_value > 0),
  min_subtotal numeric(10, 2) not null default 0 check (min_subtotal >= 0),
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0 check (uses >= 0),
  valid_from timestamptz,
  valid_until timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (discount_type <> 'percent' or discount_value <= 100)
);

create table if not exists public.store_events (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null,
  user_id uuid references public.profiles (id) on delete set null,
  event_type text not null check (
    event_type in ('catalog_view', 'add_to_cart', 'checkout_started', 'order_placed', 'order_abandoned')
  ),
  product_id uuid references public.products (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists store_events_created_idx
  on public.store_events (created_at desc, event_type);

alter table public.orders
  add column if not exists coupon_code text,
  add column if not exists discount_amount numeric(10, 2) not null default 0 check (discount_amount >= 0),
  add column if not exists courier_id uuid references public.profiles (id) on delete set null,
  add column if not exists tracking_number text,
  add column if not exists refund_status text not null default 'Not requested'
    check (refund_status in ('Not requested', 'Mock refund processed', 'Not applicable'));

update public.orders
  set refund_status = case
    when payment_method = 'Cash on delivery' then 'Not applicable'
    else 'Mock refund processed'
  end
  where status in ('Cancelled', 'Returned') and refund_status = 'Not requested';

create or replace function public.cancel_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order
    from public.orders
    where id = p_order_id and user_id = auth.uid()
    for update;
  if not found or v_order.status not in ('Pending', 'Packing') then
    raise exception 'Only pending or packing orders can be cancelled.';
  end if;

  update public.products p
    set stock = p.stock + i.quantity, updated_at = now()
    from (
      select product_id, sum(quantity)::integer as quantity
      from public.order_items
      where order_id = p_order_id and product_id is not null
      group by product_id
    ) i
    where i.product_id = p.id;
  update public.orders
    set status = 'Cancelled',
        refund_status = case
          when v_order.payment_method = 'Cash on delivery' then 'Not applicable'
          else 'Mock refund processed'
        end,
        updated_at = now()
    where id = p_order_id;
end;
$$;

insert into public.product_categories (name)
select distinct category from public.products
on conflict (name) do nothing;

insert into public.product_categories (name)
values ('Beans'), ('Brewed'), ('Pastries'), ('Merch')
on conflict (name) do nothing;

insert into public.product_variants (product_id, name, price_delta, sort_order)
select p.id, v.name, v.price_delta, v.sort_order
from public.products p
cross join lateral (
  values
    ('Whole bean', 0::numeric, 1),
    ('Espresso grind', 0::numeric, 2),
    ('Filter grind', 0::numeric, 3)
) as v(name, price_delta, sort_order)
where p.category = 'Beans'
on conflict (product_id, name) do nothing;

insert into public.product_variants (product_id, name, price_delta, sort_order)
select p.id, v.name, v.price_delta, v.sort_order
from public.products p
cross join lateral (
  values
    ('Regular', 0::numeric, 1),
    ('Large (+₱30)', 30::numeric, 2)
) as v(name, price_delta, sort_order)
where p.category = 'Brewed'
on conflict (product_id, name) do nothing;

insert into public.product_variants (product_id, name, price_delta, sort_order)
select p.id, 'Standard', 0, 1
from public.products p
where p.category in ('Pastries', 'Merch')
on conflict (product_id, name) do nothing;

insert into public.coupons (code, discount_type, discount_value, min_subtotal)
values ('WELCOME10', 'percent', 10, 300), ('TASA50', 'fixed', 50, 500)
on conflict (code) do nothing;

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

grant select on public.product_categories, public.product_variants to anon, authenticated;
grant insert, update, delete on public.product_categories, public.product_variants to authenticated;
grant select, insert, update, delete on public.customer_addresses to authenticated;
grant select on public.store_events to authenticated;
grant insert on public.store_events to anon, authenticated;
grant select on public.coupons to authenticated;
grant insert, update, delete on public.coupons to authenticated;

alter table public.product_categories enable row level security;
alter table public.product_variants enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.store_events enable row level security;
alter table public.coupons enable row level security;

drop policy if exists "profiles are visible to their owner and staff" on public.profiles;
create policy "profiles are visible to their owner and staff"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (select public.get_my_role()) in ('admin', 'staff')
  );

drop policy if exists "active products are public" on public.products;
create policy "active products are public"
  on public.products for select to anon, authenticated
  using (
    active
    or (select public.get_my_role()) in ('admin', 'staff')
  );

drop policy if exists "customers and staff can read orders" on public.orders;
create policy "customers and assigned fulfillment can read orders"
  on public.orders for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.get_my_role()) in ('admin', 'staff')
    or (
      (select public.get_my_role()) = 'fulfillment'
      and courier_id = (select auth.uid())
    )
  );

drop policy if exists "customers and staff can read order items" on public.order_items;
create policy "customers and assigned fulfillment can read order items"
  on public.order_items for select to authenticated
  using (
    exists (
      select 1
      from public.orders o
      where o.id = order_id
        and (
          o.user_id = (select auth.uid())
          or (select public.get_my_role()) in ('admin', 'staff')
          or (
            (select public.get_my_role()) = 'fulfillment'
            and o.courier_id = (select auth.uid())
          )
        )
    )
  );

drop policy if exists "active categories are public" on public.product_categories;
create policy "active categories are public"
  on public.product_categories for select to anon, authenticated
  using (active or (select public.get_my_role()) in ('admin', 'staff'));

drop policy if exists "admins manage categories" on public.product_categories;
create policy "admins manage categories"
  on public.product_categories for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "active variants are public" on public.product_variants;
create policy "active variants are public"
  on public.product_variants for select to anon, authenticated
  using (
    active
    and exists (
      select 1 from public.products p where p.id = product_id and p.active
    )
    or (select public.get_my_role()) in ('admin', 'staff')
  );

drop policy if exists "admins manage variants" on public.product_variants;
create policy "admins manage variants"
  on public.product_variants for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "customers manage their addresses" on public.customer_addresses;
create policy "customers manage their addresses"
  on public.customer_addresses for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "visitors can record store events" on public.store_events;
create policy "visitors can record store events"
  on public.store_events for insert to anon, authenticated
  with check (
    user_id is null or user_id = (select auth.uid())
  );

drop policy if exists "staff can read store events" on public.store_events;
create policy "staff can read store events"
  on public.store_events for select to authenticated
  using ((select public.get_my_role()) in ('admin', 'staff'));

drop policy if exists "admins manage coupons" on public.coupons;
create policy "admins manage coupons"
  on public.coupons for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "public can view product images" on storage.objects;
create policy "public can view product images"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-images');

drop policy if exists "admins upload product images" on storage.objects;
create policy "admins upload product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists "admins update product images" on storage.objects;
create policy "admins update product images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()))
  with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists "admins delete product images" on storage.objects;
create policy "admins delete product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()));

create or replace function public.update_my_profile(p_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or nullif(trim(p_name), '') is null or length(p_name) > 120 then
    raise exception 'Profile name is invalid.';
  end if;
  update public.profiles set name = trim(p_name) where id = auth.uid();
end;
$$;

create or replace function public.set_default_address(p_address_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.customer_addresses
    where id = p_address_id and user_id = auth.uid()
  ) then
    raise exception 'Address not found.';
  end if;
  update public.customer_addresses
    set is_default = false
    where user_id = auth.uid() and is_default;
  update public.customer_addresses
    set is_default = true
    where id = p_address_id and user_id = auth.uid();
end;
$$;

create or replace function public.quote_coupon(p_code text, p_subtotal numeric)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coupon public.coupons%rowtype;
begin
  if p_subtotal is null or p_subtotal < 0 then
    raise exception 'Subtotal is invalid.';
  end if;
  select * into v_coupon
    from public.coupons
    where code = upper(trim(p_code))
      and active
      and (valid_from is null or valid_from <= now())
      and (valid_until is null or valid_until >= now())
      and (max_uses is null or uses < max_uses);
  if not found or p_subtotal < v_coupon.min_subtotal then
    raise exception 'Coupon is invalid, expired, exhausted, or the minimum subtotal was not reached.';
  end if;
  if v_coupon.discount_type = 'percent' then
    return least(p_subtotal, round(p_subtotal * v_coupon.discount_value / 100, 2));
  end if;
  return least(p_subtotal, v_coupon.discount_value);
end;
$$;

drop function if exists public.place_order(text, text, text, text, text, jsonb);
create or replace function public.place_order(
  p_customer_name text,
  p_phone text,
  p_billing_address text,
  p_shipping_address text,
  p_payment_method text,
  p_items jsonb,
  p_coupon_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_coupon public.coupons%rowtype;
  v_product_id uuid;
  v_option text;
  v_quantity integer;
  v_unit_price numeric(10, 2);
  v_subtotal numeric(10, 2) := 0;
  v_delivery_fee numeric(10, 2);
  v_discount numeric(10, 2) := 0;
  v_order_id uuid;
begin
  if v_user_id is null then
    raise exception 'Sign in before placing an order.';
  end if;
  if nullif(trim(p_customer_name), '') is null
     or length(p_customer_name) > 120
     or nullif(trim(p_phone), '') is null
     or length(p_phone) > 50
     or nullif(trim(p_billing_address), '') is null
     or length(p_billing_address) > 500
     or nullif(trim(p_shipping_address), '') is null
     or length(p_shipping_address) > 500
     or p_payment_method is null
     or p_payment_method not in ('GCash (mock)', 'Card (mock)', 'Cash on delivery') then
    raise exception 'Checkout details are invalid.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'The cart is empty or contains too many items.';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_option := v_item ->> 'option';
    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception 'Cart quantity is invalid.';
    end if;

    select * into v_product
      from public.products
      where id = v_product_id and active
      for update;
    if not found or v_product.stock < v_quantity then
      raise exception 'A product is unavailable or has insufficient stock.';
    end if;

    select * into v_variant
      from public.product_variants
      where product_id = v_product_id and name = v_option and active;
    if not found then
      raise exception 'A product option is no longer available.';
    end if;

    v_unit_price := v_product.price + v_variant.price_delta;
    v_subtotal := v_subtotal + (v_unit_price * v_quantity);
  end loop;

  if nullif(trim(p_coupon_code), '') is not null then
    select * into v_coupon
      from public.coupons
      where code = upper(trim(p_coupon_code))
      for update;
    if not found or not v_coupon.active
       or (v_coupon.valid_from is not null and v_coupon.valid_from > now())
       or (v_coupon.valid_until is not null and v_coupon.valid_until < now())
       or (v_coupon.max_uses is not null and v_coupon.uses >= v_coupon.max_uses)
       or v_subtotal < v_coupon.min_subtotal then
      raise exception 'Coupon is invalid, expired, exhausted, or the minimum subtotal was not reached.';
    end if;
    if v_coupon.discount_type = 'percent' then
      v_discount := least(v_subtotal, round(v_subtotal * v_coupon.discount_value / 100, 2));
    else
      v_discount := least(v_subtotal, v_coupon.discount_value);
    end if;
  end if;

  v_delivery_fee := case when v_subtotal >= 1000 then 0 else 60 end;
  insert into public.orders (
    user_id, customer_name, phone, billing_address, shipping_address,
    payment_method, subtotal, delivery_fee, total, coupon_code, discount_amount
  ) values (
    v_user_id, trim(p_customer_name), trim(p_phone), trim(p_billing_address),
    trim(p_shipping_address), p_payment_method, v_subtotal, v_delivery_fee,
    v_subtotal - v_discount + v_delivery_fee, nullif(upper(trim(p_coupon_code)), ''), v_discount
  ) returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_option := v_item ->> 'option';
    v_quantity := (v_item ->> 'quantity')::integer;
    select * into v_product from public.products where id = v_product_id;
    select * into v_variant
      from public.product_variants
      where product_id = v_product_id and name = v_option and active;
    v_unit_price := v_product.price + v_variant.price_delta;
    insert into public.order_items (
      order_id, product_id, product_name, product_option, quantity, unit_price
    ) values (
      v_order_id, v_product.id, v_product.name, v_option, v_quantity, v_unit_price
    );
    update public.products
      set stock = stock - v_quantity, updated_at = now()
      where id = v_product.id and stock >= v_quantity;
    if not found then
      raise exception 'Stock changed during checkout. Please try again.';
    end if;
  end loop;

  if v_coupon.code is not null then
    update public.coupons set uses = uses + 1 where code = v_coupon.code;
  end if;
  return v_order_id;
end;
$$;

create or replace function public.assign_courier(p_order_id uuid, p_courier_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.get_my_role(), '') not in ('admin', 'staff') then
    raise exception 'Administrator or staff access is required.';
  end if;
  if p_courier_id is not null and not exists (
    select 1 from public.profiles where id = p_courier_id and role = 'fulfillment'
  ) then
    raise exception 'Select a fulfillment account.';
  end if;
  update public.orders set courier_id = p_courier_id, updated_at = now()
    where id = p_order_id and status in ('Pending', 'Packing', 'Out for delivery');
  if not found then
    raise exception 'That order cannot be assigned.';
  end if;
end;
$$;

create or replace function public.set_tracking_number(p_order_id uuid, p_tracking_number text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(public.get_my_role(), '');
  v_courier_id uuid;
begin
  select courier_id into v_courier_id from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_role not in ('admin', 'staff')
     and (v_role <> 'fulfillment' or v_courier_id is distinct from auth.uid()) then
    raise exception 'Order fulfillment access is required.';
  end if;
  if p_tracking_number is not null and length(trim(p_tracking_number)) > 80 then
    raise exception 'Tracking number is too long.';
  end if;
  update public.orders
    set tracking_number = nullif(trim(p_tracking_number), ''), updated_at = now()
    where id = p_order_id;
end;
$$;

create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_role text := coalesce(public.get_my_role(), '');
begin
  if v_role not in ('admin', 'staff', 'fulfillment') then
    raise exception 'Staff access is required.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if p_status = v_order.status then
    return;
  end if;
  if v_role = 'fulfillment'
     and (v_order.courier_id is distinct from auth.uid()
       or p_status not in ('Out for delivery', 'Delivered')) then
    raise exception 'Only the assigned courier can update delivery status.';
  end if;
  if (v_order.status = 'Pending' and p_status not in ('Packing', 'Cancelled'))
     or (v_order.status = 'Packing' and p_status not in ('Out for delivery', 'Cancelled'))
     or (v_order.status = 'Out for delivery' and p_status not in ('Delivered', 'Cancelled'))
     or v_order.status in ('Delivered', 'Cancelled', 'Returned')
     or p_status = 'Returned'
     or p_status not in ('Pending', 'Packing', 'Out for delivery', 'Delivered', 'Cancelled') then
    raise exception 'That order status transition is not allowed.';
  end if;

  if p_status = 'Cancelled' then
    update public.products p
      set stock = p.stock + i.quantity, updated_at = now()
      from (
        select product_id, sum(quantity)::integer as quantity
        from public.order_items
        where order_id = p_order_id and product_id is not null
        group by product_id
      ) i
      where i.product_id = p.id;
    update public.orders
      set refund_status = case
        when payment_method = 'Cash on delivery' then 'Not applicable'
        else 'Mock refund processed'
      end
      where id = p_order_id;
  end if;
  update public.orders set status = p_status, updated_at = now() where id = p_order_id;
end;
$$;

create or replace function public.review_return(p_order_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if not public.is_admin() or p_decision is null or p_decision not in ('Approved', 'Rejected') then
    raise exception 'Administrator access is required.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status <> 'Delivered' or v_order.return_status <> 'Requested' then
    raise exception 'That return request is no longer awaiting review.';
  end if;

  if p_decision = 'Approved' then
    update public.products p
      set stock = p.stock + i.quantity, updated_at = now()
      from (
        select product_id, sum(quantity)::integer as quantity
        from public.order_items
        where order_id = p_order_id and product_id is not null
        group by product_id
      ) i
      where i.product_id = p.id;
    update public.orders
      set status = 'Returned',
          return_status = 'Approved',
          refund_status = case
            when payment_method = 'Cash on delivery' then 'Not applicable'
            else 'Mock refund processed'
          end,
          updated_at = now()
      where id = p_order_id;
  else
    update public.orders
      set return_status = 'Rejected', updated_at = now()
      where id = p_order_id;
  end if;
end;
$$;

revoke all on function public.update_my_profile(text) from public;
revoke all on function public.set_default_address(uuid) from public;
revoke all on function public.quote_coupon(text, numeric) from public;
revoke all on function public.assign_courier(uuid, uuid) from public;
revoke all on function public.set_tracking_number(uuid, text) from public;
revoke all on function public.place_order(text, text, text, text, text, jsonb, text) from public;
revoke all on function public.set_order_status(uuid, text) from public;
revoke all on function public.review_return(uuid, text) from public;

grant execute on function public.update_my_profile(text) to authenticated;
grant execute on function public.set_default_address(uuid) to authenticated;
grant execute on function public.quote_coupon(text, numeric) to anon, authenticated;
grant execute on function public.assign_courier(uuid, uuid) to authenticated;
grant execute on function public.set_tracking_number(uuid, text) to authenticated;
grant execute on function public.place_order(text, text, text, text, text, jsonb, text) to authenticated;
grant execute on function public.set_order_status(uuid, text) to authenticated;
grant execute on function public.review_return(uuid, text) to authenticated;

commit;
