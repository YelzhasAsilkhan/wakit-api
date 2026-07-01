set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.init_data(p_organization_id uuid, p_limit integer DEFAULT 200, p_per_conversation integer DEFAULT 100, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  _messages json;
  _conversations json;
  _conversation_ids uuid[];
begin
  -- Windowed messages: up to p_per_conversation per conversation, total p_limit
  with windowed as (
    select m.*,
      row_number() over (
        partition by m.conversation_id
        order by m.timestamp desc
      ) as rn
    from public.messages m
    where m.organization_id = p_organization_id
      and (p_since is null or m.timestamp > p_since)
      and (p_until is null or m.timestamp < p_until)
  ),
  limited as (
    select * from windowed
    where rn <= p_per_conversation
    order by timestamp desc
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(l.*)), '[]'::json),
    array_agg(distinct l.conversation_id)
  into _messages, _conversation_ids
  from limited l;

  -- Fetch conversations for the messages returned, enriched with the saved
  -- contact name so the UI can display and search conversations by it.
  -- The saved name lives on public.contacts, reached from the conversation via
  -- contact_address -> contacts_addresses -> contacts.
  select coalesce(json_agg(row_to_json(enriched.*)), '[]'::json)
  into _conversations
  from (
    select c.*, ct.name as contact_name
    from public.conversations c
    left join public.contacts_addresses ca
      on ca.organization_id = c.organization_id
      and ca.address = c.contact_address
    left join public.contacts ct
      on ct.id = ca.contact_id
    where c.id = any(_conversation_ids)
  ) enriched;

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$function$
;
