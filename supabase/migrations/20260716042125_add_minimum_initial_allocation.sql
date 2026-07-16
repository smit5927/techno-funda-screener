alter table public.app_user_settings
  add column if not exists minimum_initial_allocation numeric(16,2) not null default 10000
  check (minimum_initial_allocation >= 1000 and minimum_initial_allocation <= 100000000);

comment on column public.app_user_settings.minimum_initial_allocation is
  'Minimum rupee value for each automated initial buy or pyramid add-on order.';
