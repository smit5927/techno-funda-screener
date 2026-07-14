create index if not exists app_profiles_created_by_idx
  on public.app_profiles (created_by)
  where created_by is not null;
