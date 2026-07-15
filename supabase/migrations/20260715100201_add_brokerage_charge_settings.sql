alter table public.app_user_settings
  add column if not exists charges_enabled boolean not null default false,
  add column if not exists brokerage_mode text not null default 'FLAT_PER_ORDER',
  add column if not exists brokerage_flat_per_order numeric(12,2) not null default 20,
  add column if not exists brokerage_percent numeric(8,4) not null default 0.1,
  add column if not exists dp_charge_per_sell numeric(12,2) not null default 15.34;

alter table public.app_user_settings
  add constraint app_user_settings_brokerage_mode_check
    check (brokerage_mode in ('FLAT_PER_ORDER', 'PERCENT_TURNOVER')),
  add constraint app_user_settings_brokerage_flat_check
    check (brokerage_flat_per_order >= 0 and brokerage_flat_per_order <= 10000),
  add constraint app_user_settings_brokerage_percent_check
    check (brokerage_percent >= 0 and brokerage_percent <= 5),
  add constraint app_user_settings_dp_charge_check
    check (dp_charge_per_sell >= 0 and dp_charge_per_sell <= 10000);

comment on column public.app_user_settings.charges_enabled is
  'When true, portfolio P&L includes brokerage, statutory charges and estimated delivery exit costs.';
