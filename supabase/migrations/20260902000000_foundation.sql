-- Foundation schema for the online deployment (issue #3).
-- Every table carries user_id and is scoped by RLS to auth.uid(), even though the
-- deployment has exactly one account (ADR-0002). The anon key ships in the browser,
-- so RLS — not the key — is the access boundary.

create extension if not exists pgcrypto;

-- Établissements, keyed by their Google placeId.
create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  place_id text not null,
  name text not null default '',
  address text not null default '',
  lat double precision,
  lng double precision,
  types text[] not null default '{}',
  status text not null default 'to_visit'
    check (status in ('to_visit', 'scheduled', 'sold', 'refused', 'non_compliant')),
  sale_amount numeric(12, 2),
  created_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Établissement de-duplication, enforced by the database rather than the client.
  constraint places_user_place_unique unique (user_id, place_id)
);

-- Field-visit events recorded against an établissement.
create table if not exists public.visit_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  status text not null
    check (status in ('to_visit', 'sold', 'refused', 'non_compliant')),
  comment text not null default '',
  sale_amount numeric(12, 2),
  changed_at timestamptz not null default now()
);

create index if not exists visit_history_place_idx on public.visit_history (user_id, place_id, changed_at desc);

-- Read-only technical audit trail (the Backlog).
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  place_name text not null default '',
  address text not null default '',
  details text,
  at timestamptz not null default now()
);

create index if not exists activity_log_at_idx on public.activity_log (user_id, at desc);

-- One settings row per account.
create table if not exists public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  sale_price numeric(12, 2) not null default 50,
  monthly_quota_limit integer not null default 1000 check (monthly_quota_limit >= 0),
  updated_at timestamptz not null default now()
);

-- Google Maps Platform request counts, one row per account per calendar month.
create table if not exists public.quota (
  user_id uuid not null references auth.users (id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  places_count integer not null default 0 check (places_count >= 0),
  maps_count integer not null default 0 check (maps_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

alter table public.places enable row level security;
alter table public.visit_history enable row level security;
alter table public.activity_log enable row level security;
alter table public.settings enable row level security;
alter table public.quota enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['places', 'visit_history', 'activity_log', 'settings', 'quota'] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_owner', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      table_name || '_owner', table_name
    );
  end loop;
end;
$$;

-- Atomically check the current month's total against the monthly limit and, when the
-- request fits, count it. Two devices calling concurrently cannot both read a stale
-- count and jointly exceed the limit: the row is locked for the whole check-and-increment.
create or replace function public.increment_quota(p_api text default 'places', p_count integer default 1)
returns table (allowed boolean, total integer, monthly_limit integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_limit integer;
  v_total integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_api not in ('places', 'maps') then
    raise exception 'unknown api: %', p_api using errcode = '22023';
  end if;
  if p_count is null or p_count < 1 then
    raise exception 'count must be at least 1' using errcode = '22023';
  end if;

  select s.monthly_quota_limit into v_limit from public.settings s where s.user_id = v_user;
  v_limit := coalesce(v_limit, 1000);

  insert into public.quota (user_id, month) values (v_user, v_month)
    on conflict (user_id, month) do nothing;

  select q.places_count + q.maps_count into v_total
    from public.quota q
   where q.user_id = v_user and q.month = v_month
     for update;

  if v_total + p_count > v_limit then
    return query select false, v_total, v_limit;
    return;
  end if;

  update public.quota q
     set places_count = q.places_count + case when p_api = 'places' then p_count else 0 end,
         maps_count = q.maps_count + case when p_api = 'maps' then p_count else 0 end,
         updated_at = now()
   where q.user_id = v_user and q.month = v_month
  returning q.places_count + q.maps_count into v_total;

  return query select true, v_total, v_limit;
end;
$$;

revoke all on function public.increment_quota(text, integer) from public;
grant execute on function public.increment_quota(text, integer) to authenticated;
