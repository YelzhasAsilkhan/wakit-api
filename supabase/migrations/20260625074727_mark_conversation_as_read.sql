set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.mark_conversation_as_read(p_conversation_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _organization_id uuid;
  _updated_count integer;
begin
  select organization_id into _organization_id
  from public.conversations
  where id = p_conversation_id;

  if _organization_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'conversation not found';
  end if;

  -- Caller must be at least a member of the conversation's organization.
  if _organization_id not in (select public.get_authorized_orgs('member')) then
    raise exception using
      errcode = '42501',
      message = 'insufficient permissions to mark this conversation as read';
  end if;

  with updated as (
    update public.messages
    set status = jsonb_build_object('read', now())
    where conversation_id = p_conversation_id
      and direction = 'incoming'
      and (status ->> 'read') is null
    returning 1
  )
  select count(*) into _updated_count from updated;

  return _updated_count;
end;
$function$
;
