create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null unique,
  role text not null default 'customer'
    check (role in ('customer', 'fulfillment', 'staff', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in ('Beans', 'Brewed', 'Pastries', 'Merch')),
  description text not null default '',
  price numeric(10, 2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_name_unique unique (name)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  customer_name text not null,
  phone text not null,
  billing_address text not null,
  shipping_address text not null,
  payment_method text not null
    check (payment_method in ('GCash (mock)', 'Card (mock)', 'Cash on delivery')),
  status text not null default 'Pending'
    check (status in ('Pending', 'Packing', 'Out for delivery', 'Delivered', 'Cancelled', 'Returned')),
  return_status text not null default 'None'
    check (return_status in ('None', 'Requested', 'Approved', 'Rejected')),
  courier_id uuid references public.profiles (id) on delete set null,
  tracking_number text,
  subtotal numeric(10, 2) not null check (subtotal >= 0),
  delivery_fee numeric(10, 2) not null check (delivery_fee >= 0),
  total numeric(10, 2) not null check (total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_user_created_idx on public.orders (user_id, created_at desc);
create index if not exists orders_status_created_idx on public.orders (status, created_at desc);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  product_name text not null,
  product_option text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  created_at timestamptz not null default now()
);

create index if not exists order_items_order_idx on public.order_items (order_id);

grant usage on schema public to anon, authenticated;
grant select on public.products to anon, authenticated;
grant select on public.profiles, public.orders, public.order_items to authenticated;
grant update (role) on public.profiles to authenticated;
grant insert, update, delete on public.products to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists products_touch_updated_at on public.products;
create trigger products_touch_updated_at
  before update on public.products
  for each row execute procedure public.touch_updated_at();

drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at
  before update on public.orders
  for each row execute procedure public.touch_updated_at();

create or replace function public.get_my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.profiles where id = (select auth.uid())
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.get_my_role() in ('admin', 'staff', 'fulfillment'), false)
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.get_my_role() = 'admin', false)
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, name, email, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), 'Coffee lover'),
    new.email,
    'customer'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "profiles are visible to their owner and staff" on public.profiles;
create policy "profiles are visible to their owner and staff"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_staff()));

drop policy if exists "admins can change other roles" on public.profiles;
create policy "admins can change other roles"
  on public.profiles for update to authenticated
  using ((select public.is_admin()) and id <> (select auth.uid()))
  with check ((select public.is_admin()) and id <> (select auth.uid()));

drop policy if exists "active products are public" on public.products;
create policy "active products are public"
  on public.products for select to anon, authenticated
  using (active or (select public.is_staff()));

drop policy if exists "admins manage products" on public.products;
create policy "admins manage products"
  on public.products for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "customers and staff can read orders" on public.orders;
create policy "customers and staff can read orders"
  on public.orders for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff()));

drop policy if exists "customers and staff can read order items" on public.order_items;
create policy "customers and staff can read order items"
  on public.order_items for select to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_id
        and (o.user_id = (select auth.uid()) or (select public.is_staff()))
    )
  );

create or replace function public.place_order(
  p_customer_name text,
  p_phone text,
  p_billing_address text,
  p_shipping_address text,
  p_payment_method text,
  p_items jsonb
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
  v_product_id uuid;
  v_option text;
  v_quantity integer;
  v_unit_price numeric(10, 2);
  v_subtotal numeric(10, 2) := 0;
  v_delivery_fee numeric(10, 2);
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

    if v_option is null
       or (v_product.category = 'Beans' and v_option not in ('Whole bean', 'Espresso grind', 'Filter grind'))
       or (v_product.category = 'Brewed' and v_option not in ('Regular', 'Large (+₱30)'))
       or (v_product.category in ('Pastries', 'Merch') and v_option <> 'Standard') then
      raise exception 'A product option is invalid.';
    end if;

    v_unit_price := v_product.price + case when v_option = 'Large (+₱30)' then 30 else 0 end;
    v_subtotal := v_subtotal + (v_unit_price * v_quantity);
  end loop;

  v_delivery_fee := case when v_subtotal >= 1000 then 0 else 60 end;
  insert into public.orders (
    user_id, customer_name, phone, billing_address, shipping_address,
    payment_method, subtotal, delivery_fee, total
  ) values (
    v_user_id, trim(p_customer_name), trim(p_phone), trim(p_billing_address),
    trim(p_shipping_address), p_payment_method, v_subtotal, v_delivery_fee,
    v_subtotal + v_delivery_fee
  ) returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_option := v_item ->> 'option';
    v_quantity := (v_item ->> 'quantity')::integer;
    select * into v_product from public.products where id = v_product_id;
    v_unit_price := v_product.price + case when v_option = 'Large (+₱30)' then 30 else 0 end;
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

  return v_order_id;
end;
$$;

create or replace function public.cancel_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.orders
    where id = p_order_id and user_id = auth.uid()
    for update;
  if not found or v_status not in ('Pending', 'Packing') then
    raise exception 'Only pending or packing orders can be cancelled.';
  end if;

  update public.products p
    set stock = p.stock + i.quantity, updated_at = now()
    from public.order_items i
    where i.order_id = p_order_id and i.product_id = p.id;
  update public.orders set status = 'Cancelled', updated_at = now() where id = p_order_id;
end;
$$;

create or replace function public.request_return(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.orders
    set return_status = 'Requested', updated_at = now()
    where id = p_order_id and user_id = auth.uid()
      and status = 'Delivered' and return_status = 'None';
  if not found then
    raise exception 'Only delivered orders without an existing return request can be returned.';
  end if;
end;
$$;

create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_status text;
  v_role text := public.get_my_role();
begin
  if v_role not in ('admin', 'staff', 'fulfillment') then
    raise exception 'Staff access is required.';
  end if;

  select status into v_current_status
    from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if p_status = v_current_status then
    return;
  end if;
  if (v_current_status = 'Pending' and p_status not in ('Packing', 'Cancelled'))
     or (v_current_status = 'Packing' and p_status not in ('Out for delivery', 'Cancelled'))
     or (v_current_status = 'Out for delivery' and p_status not in ('Delivered', 'Cancelled'))
     or v_current_status in ('Delivered', 'Cancelled', 'Returned')
     or p_status = 'Returned'
     or (v_role = 'fulfillment' and p_status = 'Cancelled') then
    raise exception 'That order status transition is not allowed.';
  end if;

  if p_status = 'Cancelled' then
    update public.products p
      set stock = p.stock + i.quantity, updated_at = now()
      from public.order_items i
      where i.order_id = p_order_id and i.product_id = p.id;
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
      from public.order_items i
      where i.order_id = p_order_id and i.product_id = p.id;
    update public.orders
      set status = 'Returned', return_status = 'Approved', updated_at = now()
      where id = p_order_id;
  else
    update public.orders
      set return_status = 'Rejected', updated_at = now()
      where id = p_order_id;
  end if;
end;
$$;

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

create or replace function public.get_product_popularity()
returns table (product_id uuid, popularity bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.product_id, count(*)::bigint
  from public.store_events e
  join public.products p on p.id = e.product_id and p.active
  where e.event_type = 'add_to_cart'
    and e.created_at >= now() - interval '30 days'
  group by e.product_id
$$;

revoke all on function public.get_my_role() from public;
revoke all on function public.is_staff() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.touch_updated_at() from public;
revoke all on function public.place_order(text, text, text, text, text, jsonb) from public;
revoke all on function public.cancel_order(uuid) from public;
revoke all on function public.request_return(uuid) from public;
revoke all on function public.set_order_status(uuid, text) from public;
revoke all on function public.review_return(uuid, text) from public;
revoke all on function public.track_order(text) from public;
revoke all on function public.get_product_popularity() from public;

grant execute on function public.get_my_role() to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.place_order(text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.cancel_order(uuid) to authenticated;
grant execute on function public.request_return(uuid) to authenticated;
grant execute on function public.set_order_status(uuid, text) to authenticated;
grant execute on function public.review_return(uuid, text) to authenticated;
grant execute on function public.track_order(text) to anon, authenticated;
grant execute on function public.get_product_popularity() to anon, authenticated;

insert into public.products (name, category, description, price, stock) values
  ('Benguet Arabica Beans', 'Beans', 'Bright, nutty, medium roast.', 450.00, 30),
  ('Barako Dark Roast', 'Beans', 'Bold Batangas-style liberica.', 380.00, 40),
  ('Sagada Light Roast', 'Beans', 'Floral and citrusy.', 420.00, 25),
  ('Iced Spanish Latte', 'Brewed', 'Espresso, milk, and sweet cream.', 140.00, 99),
  ('Calamansi Cold Brew', 'Brewed', 'Cold brew with calamansi.', 130.00, 99),
  ('Ube Latte', 'Brewed', 'Ube and espresso.', 150.00, 99),
  ('Ensaymada', 'Pastries', 'Buttery, topped with cheese.', 85.00, 20),
  ('Tasa Tumbler', 'Merch', 'Insulated 450 ml tumbler.', 650.00, 12)
on conflict (name) do nothing;
