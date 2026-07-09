import type { Database, Template, TemplateData } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";

const API_VERSION = "v24.0";
const DEFAULT_ACCESS_TOKEN = Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN") ||
  "";

async function getBusinessCredentials(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<{ waba_id: string; access_token: string }> {
  const { data, error } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id, extra->>access_token")
    .eq("organization_id", organization_id)
    .eq("address", organization_address)
    .single();

  if (error || !data?.waba_id) {
    log.error("Could not fetch business credentials", error);
    throw new HTTPException(403, {
      message: "Could not fetch business credentials",
      cause: error,
    });
  }

  const access_token = data.access_token || DEFAULT_ACCESS_TOKEN;

  if (!access_token) {
    throw new HTTPException(403, {
      message: "No WhatsApp access token configured",
    });
  }

  return { waba_id: data.waba_id, access_token };
}

function languagesMatch(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}_`) || b.startsWith(`${a}_`);
}

export async function listTemplates(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<TemplateData[]> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not fetch templates",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function fetchTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<TemplateData> {
  const { access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not fetch template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function findTemplateByName(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  name: string,
  language: string,
): Promise<TemplateData | undefined> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const url = new URL(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
  );
  url.searchParams.set("name", name);

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!response.ok) {
    log.error("Could not fetch template by name", {
      name,
      language,
      cause: await response.json().catch(() => ({})),
    });
    return undefined;
  }

  const body = await response.json() as { data?: TemplateData[] };
  const templates = (body.data ?? []).filter((template) => template.name === name);

  if (!templates.length) {
    log.warn("Template not found in Meta", { name, language, waba_id });
    return undefined;
  }

  const match = templates.find((template) => template.language === language) ??
    templates.find((template) => languagesMatch(template.language, language));

  if (!match) {
    log.warn("Template language not found in Meta", {
      name,
      language,
      available: templates.map((template) => template.language),
    });
    return undefined;
  }

  return await fetchTemplate(
    client,
    organization_id,
    organization_address,
    match,
  );
}

/** Builds CRM preview text (header + body + footer) with parameters substituted. */
export function renderTemplatePreviewText(
  meta: TemplateData,
  send: Template,
): string {
  const textParams: string[] = [];

  for (const comp of send.components ?? []) {
    if (!("parameters" in comp) || !comp.parameters) continue;
    for (const param of comp.parameters) {
      if (param.type === "text" && "text" in param) {
        textParams.push(param.text);
      }
    }
  }

  let paramIndex = 0;
  const substitute = (text: string) =>
    text.replace(/\{\{\d+\}\}/g, () => textParams[paramIndex++] ?? "");

  const parts: string[] = [];

  for (const comp of meta.components ?? []) {
    const type = comp.type.toUpperCase();

    if (type === "HEADER" && "format" in comp && comp.format === "TEXT" &&
      "text" in comp && comp.text) {
      parts.push(substitute(comp.text));
    }
    if (type === "BODY" && "text" in comp && comp.text) {
      parts.push(substitute(comp.text));
    }
    if (type === "FOOTER" && "text" in comp && comp.text) {
      parts.push(comp.text);
    }
  }

  return parts.join("\n\n").trim();
}

export async function createTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  id: string;
  status: string;
  category: string;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const { name, category, language, components } = template;

  const filteredTemplate = {
    name,
    category,
    allow_category_change: true,
    language,
    components,
  };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not create template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function editTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const { category, components } = template;
  const filteredTemplate = { category, components };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not update template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function deleteTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates?name=${template.name}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not delete template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}
