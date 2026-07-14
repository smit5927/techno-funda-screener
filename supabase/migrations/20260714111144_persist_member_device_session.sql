alter table public.app_profiles
  add column if not exists active_device_id uuid;

create index if not exists app_profiles_active_device_id_idx
  on public.app_profiles (active_device_id)
  where active_device_id is not null;
