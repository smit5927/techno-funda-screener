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
      and (
        p.role = 'admin'
        or p.active_session_id::text = (select auth.jwt() ->> 'session_id')
      )
  );
$$;

revoke all on function private.app_session_is_active() from public, anon;
grant execute on function private.app_session_is_active() to authenticated;
