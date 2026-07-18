create or replace function public.admin_reset_user_portfolio(
  p_actor_user_id uuid,
  p_subject_user_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_generation uuid := gen_random_uuid();
  v_reset_at timestamptz := clock_timestamp();
  v_display_name text;
  v_username text;
  v_delivery_count integer := 0;
  v_state jsonb;
begin
  if p_confirmation is distinct from 'RESET SELECTED PORTFOLIO' then
    raise exception 'Selected portfolio reset confirmation is invalid' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.app_profiles
    where user_id = p_actor_user_id
      and role = 'admin'
      and status = 'active'
  ) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  select display_name, username
    into v_display_name, v_username
  from public.app_profiles
  where user_id = p_subject_user_id;

  if not found then
    raise exception 'Selected account was not found' using errcode = 'P0002';
  end if;

  v_state := jsonb_build_object(
    'systemResetAt', v_reset_at,
    'resetGeneration', v_generation,
    'trades', '[]'::jsonb,
    'waitingCandidates', '[]'::jsonb,
    'candidateDecisionLog', '[]'::jsonb,
    'alertHistory', '[]'::jsonb,
    'tradeEvents', '[]'::jsonb,
    'journal', jsonb_build_object(
      'systemResetAt', v_reset_at,
      'resetGeneration', v_generation,
      'legacyOwnerJournalMigratedAt', v_reset_at,
      'trades', '[]'::jsonb,
      'candidates', '[]'::jsonb,
      'candidateDecisionLog', '[]'::jsonb,
      'alertHistory', '[]'::jsonb,
      'signalState', '{}'::jsonb,
      'capitalTransactions', '[]'::jsonb
    )
  );

  insert into public.app_user_states (
    user_id,
    reset_generation,
    reset_at,
    strategy_version,
    scan_at,
    state,
    updated_at
  ) values (
    p_subject_user_id,
    v_generation,
    v_reset_at,
    'owner-account-reset',
    null,
    v_state,
    v_reset_at
  )
  on conflict (user_id) do update
  set
    reset_generation = excluded.reset_generation,
    reset_at = excluded.reset_at,
    strategy_version = excluded.strategy_version,
    scan_at = excluded.scan_at,
    state = excluded.state,
    updated_at = excluded.updated_at;

  update public.app_user_settings
  set capital_history = '[]'::jsonb
  where user_id = p_subject_user_id;

  select count(*) into v_delivery_count
  from public.app_push_deliveries
  where user_id = p_subject_user_id;

  delete from public.app_push_deliveries
  where user_id = p_subject_user_id;

  insert into public.app_audit_log (
    actor_user_id,
    subject_user_id,
    action,
    details
  ) values (
    p_actor_user_id,
    p_subject_user_id,
    'USER_PORTFOLIO_RESET',
    jsonb_build_object(
      'resetAt', v_reset_at,
      'resetGeneration', v_generation,
      'displayName', v_display_name,
      'username', v_username,
      'pushDeliveriesCleared', v_delivery_count,
      'preserved', jsonb_build_array(
        'account', 'current capital', 'risk and brokerage settings',
        'trade scope', 'custom list', 'Telegram', 'push subscriptions'
      )
    )
  );

  return jsonb_build_object(
    'ok', true,
    'subjectUserId', p_subject_user_id,
    'displayName', v_display_name,
    'username', v_username,
    'resetAt', v_reset_at,
    'resetGeneration', v_generation,
    'pushDeliveriesCleared', v_delivery_count
  );
end;
$$;

revoke all on function public.admin_reset_user_portfolio(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_reset_user_portfolio(uuid, uuid, text)
  to service_role;

comment on function public.admin_reset_user_portfolio(uuid, uuid, text) is
  'Service-role-only transactional reset for one owner-selected portfolio. Other tenant portfolios remain unchanged.';

drop function if exists public.admin_reset_all_portfolios(uuid, text);
