alter table public.app_profiles
  add column login_mobile text generated always as (
    case
      when regexp_replace(coalesce(mobile_number, ''), '[^0-9]', '', 'g') ~ '^91[0-9]{10}$'
        then right(regexp_replace(coalesce(mobile_number, ''), '[^0-9]', '', 'g'), 10)
      else regexp_replace(coalesce(mobile_number, ''), '[^0-9]', '', 'g')
    end
  ) stored;

create unique index app_profiles_login_mobile_unique
  on public.app_profiles (login_mobile)
  where login_mobile <> '';

create table public.app_push_config (
  singleton boolean primary key default true check (singleton),
  vapid_subject text not null,
  vapid_public_key text not null,
  vapid_private_key text not null,
  updated_at timestamptz not null default now()
);

create table public.app_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid,
  endpoint text not null unique,
  p256dh_key text not null,
  auth_key text not null,
  expiration_time numeric,
  enabled boolean not null default true,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index app_push_subscriptions_user_enabled_idx
  on public.app_push_subscriptions (user_id, enabled, created_at desc);
create index app_push_subscriptions_device_idx
  on public.app_push_subscriptions (user_id, device_id)
  where enabled;

create table public.app_push_deliveries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid not null references public.app_push_subscriptions(id) on delete cascade,
  alert_id text not null,
  status text not null check (status in ('sent', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  last_error text,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (subscription_id, alert_id)
);

create index app_push_deliveries_user_alert_idx
  on public.app_push_deliveries (user_id, alert_id, status);

create trigger app_push_config_touch_updated_at before update on public.app_push_config
for each row execute function private.touch_updated_at();
create trigger app_push_subscriptions_touch_updated_at before update on public.app_push_subscriptions
for each row execute function private.touch_updated_at();
create trigger app_push_deliveries_touch_updated_at before update on public.app_push_deliveries
for each row execute function private.touch_updated_at();

alter table public.app_push_config enable row level security;
alter table public.app_push_subscriptions enable row level security;
alter table public.app_push_deliveries enable row level security;

revoke all on public.app_push_config from public, anon, authenticated;
revoke all on public.app_push_subscriptions from public, anon, authenticated;
revoke all on public.app_push_deliveries from public, anon, authenticated;
grant select on public.app_push_config to service_role;
grant select, insert, update, delete on public.app_push_subscriptions to service_role;
grant select, insert, update, delete on public.app_push_deliveries to service_role;
grant usage, select on sequence public.app_push_deliveries_id_seq to service_role;

comment on table public.app_push_config is 'Server-only VAPID configuration; never exposed to browser clients.';
comment on table public.app_push_subscriptions is 'Tenant-isolated browser push endpoints registered through the authenticated API.';
comment on table public.app_push_deliveries is 'Per-subscription alert delivery ledger for dedupe and controlled retries.';
