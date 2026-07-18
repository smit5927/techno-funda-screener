alter table public.app_user_states
  add column if not exists reset_generation uuid not null default gen_random_uuid(),
  add column if not exists reset_at timestamptz;

create index if not exists app_user_states_reset_generation_idx
  on public.app_user_states (reset_generation);

create or replace function public.admin_reset_all_portfolios(
  p_actor_user_id uuid,
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
  v_user_count integer := 0;
  v_delivery_count integer := 0;
begin
  if p_confirmation is distinct from 'RESET ALL PORTFOLIOS' then
    raise exception 'Master reset confirmation is invalid' using errcode = '22023';
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

  select count(*) into v_user_count from public.app_user_states;
  select count(*) into v_delivery_count from public.app_push_deliveries;

  update public.app_user_states
  set
    reset_generation = v_generation,
    reset_at = v_reset_at,
    strategy_version = 'owner-master-reset',
    scan_at = null,
    state = jsonb_build_object(
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

  update public.app_user_settings
  set capital_history = '[]'::jsonb;

  delete from public.app_push_deliveries;

  insert into public.app_audit_log (
    actor_user_id,
    subject_user_id,
    action,
    details
  ) values (
    p_actor_user_id,
    null,
    'MASTER_PORTFOLIO_RESET',
    jsonb_build_object(
      'resetAt', v_reset_at,
      'resetGeneration', v_generation,
      'accountsReset', v_user_count,
      'pushDeliveriesCleared', v_delivery_count,
      'preserved', jsonb_build_array(
        'accounts', 'current capital', 'risk and brokerage settings',
        'trade scope', 'custom lists', 'Telegram', 'push subscriptions'
      )
    )
  );

  return jsonb_build_object(
    'ok', true,
    'resetAt', v_reset_at,
    'resetGeneration', v_generation,
    'accountsReset', v_user_count,
    'pushDeliveriesCleared', v_delivery_count
  );
end;
$$;

revoke all on function public.admin_reset_all_portfolios(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_reset_all_portfolios(uuid, text)
  to service_role;

comment on function public.admin_reset_all_portfolios(uuid, text) is
  'Service-role-only transactional reset of all tenant portfolio journals. Accounts and saved operating settings are preserved.';
