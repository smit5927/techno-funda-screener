create unique index if not exists app_profiles_single_admin_unique
on public.app_profiles ((role))
where role = 'admin';
