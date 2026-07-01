import type { SupabaseClient } from "@supabase/supabase-js";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import type { Database, OutgoingMessage, Template } from "../_shared/supabase.ts";
import {
  findTemplateByName,
  renderTemplatePreviewText,
} from "./templates.ts";

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export type StartConversationPayload = {
  organization_id: string;
  organization_address?: string;
  contact_phone: string;
  contact_name?: string;
  /** Optional CRM preview override; otherwise resolved from Meta template body. */
  text?: string;
  template: Template;
};

export type StartConversationResult = {
  conversation_id: string;
  message_id: string;
  contact_address: string;
};

async function resolveWhatsAppAccount(
  client: SupabaseClient<Database>,
  organizationId: string,
  organizationAddress?: string,
) {
  let query = client
    .from("organizations_addresses")
    .select("address, extra")
    .eq("organization_id", organizationId)
    .eq("service", "whatsapp")
    .eq("status", "connected");

  if (organizationAddress) {
    query = query.eq("address", organizationAddress);
  }

  const { data: accounts } = await query.limit(1).throwOnError();

  if (!accounts.length) {
    throw new HTTPException(404, {
      message: "No connected WhatsApp account found for this organization",
    });
  }

  return accounts[0];
}

async function ensureContact(
  client: SupabaseClient<Database>,
  organizationId: string,
  contactPhone: string,
  contactName?: string,
) {
  const trimmedName = contactName?.trim();

  if (trimmedName) {
    await client.rpc("link_contact_to_address", {
      p_organization_id: organizationId,
      p_address: contactPhone,
      p_name: trimmedName,
    }).throwOnError();
    return;
  }

  const { data: existingAddress } = await client
    .from("contacts_addresses")
    .select("address")
    .eq("organization_id", organizationId)
    .eq("address", contactPhone)
    .maybeSingle();

  if (existingAddress) {
    return;
  }

  await client
    .from("contacts_addresses")
    .insert({
      organization_id: organizationId,
      address: contactPhone,
      service: "whatsapp",
      status: "active",
      extra: {},
    })
    .throwOnError();
}

async function resolveTemplatePreviewText(
  client: SupabaseClient<Database>,
  organizationId: string,
  organizationAddress: string,
  template: Template,
  override?: string,
): Promise<string> {
  if (override?.trim()) return override.trim();

  const meta = await findTemplateByName(
    client,
    organizationId,
    organizationAddress,
    template.name,
    template.language.code,
  );

  if (!meta) {
    log.warn("Template not found for preview", {
      name: template.name,
      language: template.language.code,
    });
    return `Шаблон: ${template.name}`;
  }

  const rendered = renderTemplatePreviewText(meta, template);
  if (rendered) return rendered;

  log.warn("Template found but preview text is empty", {
    name: template.name,
    language: template.language.code,
  });
  return `Шаблон: ${template.name}`;
}

export async function startConversation(
  client: SupabaseClient<Database>,
  payload: StartConversationPayload,
): Promise<StartConversationResult> {
  if (!payload.template?.name) {
    throw new HTTPException(400, { message: "template.name is required" });
  }

  if (!payload.template.language?.code) {
    throw new HTTPException(400, {
      message: "template.language.code is required",
    });
  }

  const contactPhone = normalizePhone(payload.contact_phone);

  if (!contactPhone) {
    throw new HTTPException(400, { message: "contact_phone is required" });
  }

  const account = await resolveWhatsAppAccount(
    client,
    payload.organization_id,
    payload.organization_address,
  );

  await ensureContact(
    client,
    payload.organization_id,
    contactPhone,
    payload.contact_name,
  );

  const template: Template = {
    name: payload.template.name.trim(),
    language: {
      code: payload.template.language.code.trim(),
      policy: payload.template.language.policy ?? "deterministic",
    },
    components: payload.template.components,
  };

  let previewText: string;
  try {
    previewText = await resolveTemplatePreviewText(
      client,
      payload.organization_id,
      account.address,
      template,
      payload.text,
    );
  } catch (error) {
    log.error("Could not resolve template preview text", error);
    previewText = `Шаблон: ${template.name}`;
  }

  const content: OutgoingMessage = {
    version: "1",
    type: "data",
    kind: "template",
    text: previewText,
    data: template,
  };

  const { data: message } = await client
    .from("messages")
    .insert({
      organization_id: payload.organization_id,
      organization_address: account.address,
      contact_address: contactPhone,
      service: "whatsapp",
      direction: "outgoing",
      content,
    })
    .select("id, conversation_id")
    .single()
    .throwOnError();

  return {
    conversation_id: message.conversation_id,
    message_id: message.id,
    contact_address: contactPhone,
  };
}
