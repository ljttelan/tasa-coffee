begin;

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

revoke all on function public.get_product_popularity() from public;
grant execute on function public.get_product_popularity() to anon, authenticated;

commit;
