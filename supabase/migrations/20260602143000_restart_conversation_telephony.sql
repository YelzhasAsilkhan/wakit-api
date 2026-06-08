alter type public.service add value if not exists 'telephony';

drop index if exists public.organizations_addresses_phone_number_idx;

create index organizations_addresses_phone_number_idx
on public.organizations_addresses
using btree ((extra->>'phone_number'))
where service in ('whatsapp', 'telephony');

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.restart_conversation(p_conversation_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  _conv public.conversations%rowtype;
  _new_id uuid;
  _extra jsonb;
begin
  select * into _conv
  from public.conversations
  where id = p_conversation_id
    and status = 'active';

  if not found then
    raise exception 'Active conversation not found: %', p_conversation_id;
  end if;

  update public.conversations
  set
    status = 'closed',
    extra = coalesce(extra, '{}'::jsonb)
      - 'paused'
      - 'memory'
      || jsonb_build_object('closed_reason', 'restart', 'closed_at', now())
  where id = p_conversation_id;

  _extra := coalesce(_conv.extra, '{}'::jsonb)
    - 'paused'
    - 'memory'
    - 'archived';

  insert into public.conversations (
    organization_id,
    service,
    organization_address,
    contact_address,
    group_address,
    name,
    status,
    extra
  )
  values (
    _conv.organization_id,
    _conv.service,
    _conv.organization_address,
    _conv.contact_address,
    _conv.group_address,
    _conv.name,
    'active',
    _extra
  )
  returning id into _new_id;

  return _new_id;
end;
$function$;
