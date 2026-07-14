create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.app_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  auth_email text not null,
  display_name text not null,
  contact_email text not null,
  mobile_number text,
  role text not null default 'member' check (role in ('admin', 'member')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  active_session_id uuid,
  mfa_required boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz,
  constraint app_profiles_username_format check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$')
);

create unique index app_profiles_username_unique on public.app_profiles (lower(username));
create unique index app_profiles_auth_email_unique on public.app_profiles (lower(auth_email));

create table public.app_user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  total_capital numeric(16,2) not null default 1000000 check (total_capital >= 10000),
  scope_list_id text not null default 'all-market' check (scope_list_id in ('all-market', 'default', 'custom')),
  quality_mode text not null default 'BEST_ONLY' check (quality_mode in ('BEST_ONLY', 'STRONG_OR_BETTER', 'ALL_ENTRIES')),
  max_open_positions integer not null default 15 check (max_open_positions between 1 and 100),
  risk_per_trade_pct numeric(6,3) not null default 1 check (risk_per_trade_pct > 0 and risk_per_trade_pct <= 10),
  max_portfolio_risk_pct numeric(6,3) not null default 6 check (max_portfolio_risk_pct > 0 and max_portfolio_risk_pct <= 50),
  max_position_pct numeric(6,3) not null default 10 check (max_position_pct > 0 and max_position_pct <= 100),
  max_sector_exposure_pct numeric(6,3) not null default 25 check (max_sector_exposure_pct > 0 and max_sector_exposure_pct <= 100),
  pyramiding_enabled boolean not null default true,
  capital_history jsonb not null default '[]'::jsonb check (jsonb_typeof(capital_history) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_watchlists (
  user_id uuid primary key references auth.users(id) on delete cascade,
  symbols jsonb not null default '[]'::jsonb check (jsonb_typeof(symbols) = 'array'),
  updated_at timestamptz not null default now()
);

create table public.app_user_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  strategy_version text not null default 'uninitialized',
  scan_at timestamptz,
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);

create table public.app_telegram_configs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bot_token text,
  chat_id text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.app_market_state (
  singleton boolean primary key default true check (singleton),
  strategy_version text not null,
  scan_at timestamptz,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);

create table public.app_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  subject_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index app_audit_log_actor_created_idx on public.app_audit_log (actor_user_id, created_at desc);
create index app_audit_log_subject_created_idx on public.app_audit_log (subject_user_id, created_at desc);

create table public.app_secrets (
  name text primary key,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.app_secrets (name, sha256)
values
  ('owner_bootstrap', 'eb08915b85eb8a3bc9fd0d14d25179b2dd2100ed2079fa97003e565529cf4991'),
  ('workflow_ingest', '64512ba21c94e94af57779c1f011ecf3a7e9365e2f7db066dd8ceae92eb8c85f')
on conflict (name) do update set sha256 = excluded.sha256, updated_at = now();

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger app_profiles_touch_updated_at before update on public.app_profiles
for each row execute function private.touch_updated_at();
create trigger app_user_settings_touch_updated_at before update on public.app_user_settings
for each row execute function private.touch_updated_at();
create trigger app_watchlists_touch_updated_at before update on public.app_watchlists
for each row execute function private.touch_updated_at();
create trigger app_user_states_touch_updated_at before update on public.app_user_states
for each row execute function private.touch_updated_at();
create trigger app_telegram_configs_touch_updated_at before update on public.app_telegram_configs
for each row execute function private.touch_updated_at();
create trigger app_market_state_touch_updated_at before update on public.app_market_state
for each row execute function private.touch_updated_at();
create trigger app_secrets_touch_updated_at before update on public.app_secrets
for each row execute function private.touch_updated_at();

create or replace function private.app_session_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_profiles p
    where p.user_id = (select auth.uid())
      and p.status = 'active'
      and p.active_session_id::text = (select auth.jwt() ->> 'session_id')
  );
$$;

revoke all on function private.app_session_is_active() from public, anon;
grant execute on function private.app_session_is_active() to authenticated;

alter table public.app_profiles enable row level security;
alter table public.app_user_settings enable row level security;
alter table public.app_watchlists enable row level security;
alter table public.app_user_states enable row level security;
alter table public.app_telegram_configs enable row level security;
alter table public.app_market_state enable row level security;
alter table public.app_audit_log enable row level security;
alter table public.app_secrets enable row level security;

create policy app_profiles_read_own on public.app_profiles
for select to authenticated
using (user_id = (select auth.uid()) and (select private.app_session_is_active()));

create policy app_settings_read_own on public.app_user_settings
for select to authenticated
using (user_id = (select auth.uid()) and (select private.app_session_is_active()));

create policy app_watchlists_read_own on public.app_watchlists
for select to authenticated
using (user_id = (select auth.uid()) and (select private.app_session_is_active()));

create policy app_states_read_own on public.app_user_states
for select to authenticated
using (user_id = (select auth.uid()) and (select private.app_session_is_active()));

create policy app_audit_read_own on public.app_audit_log
for select to authenticated
using (
  (actor_user_id = (select auth.uid()) or subject_user_id = (select auth.uid()))
  and (select private.app_session_is_active())
);

revoke all on all tables in schema public from anon, authenticated;
grant select on public.app_profiles, public.app_user_settings, public.app_watchlists,
  public.app_user_states, public.app_audit_log to authenticated;

comment on table public.app_profiles is 'Techno Funda mobile identities and single-device session gate.';
comment on table public.app_user_states is 'Tenant-isolated portfolio journal generated by the shared strategy engine.';
comment on table public.app_market_state is 'Latest shared completed-candle market scan; served only through the authenticated API.';
