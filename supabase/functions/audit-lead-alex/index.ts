// audit-lead-alex — enregistre un lead du quiz de qualification (page /audit),
// crée/retrouve une fiche CRM, puis notifie le bot Telegram "MonBotJarvis".
//
// Flux : page /audit  ──POST JSON──▶  cette fonction
//   1. valide + insère la ligne dans public.audit_leads (clé service_role)
//   2. best effort : upsert d'une fiche public.customers (dédup email + activité,
//      comme formation-lead) et écriture de audit_leads.customer_id
//   3. best effort : message Telegram
//   Les étapes 2 et 3 n'échouent jamais le flux : le lead audit_leads reste créé.
//
// Secrets attendus (Supabase → Edge Functions → Secrets) :
//   SUPABASE_URL                (injecté automatiquement)
//   SUPABASE_SERVICE_ROLE_KEY   (injecté automatiquement)
//   TELEGRAM_BOT_TOKEN          (à ajouter — token du bot MonBotJarvis)
//   TELEGRAM_CHAT_ID            (optionnel — défaut : 8783852186)

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// Formation Vente — même id que ACTIVITY_IDS.FORMATION côté Pilotage360.
const FORMATION_ACTIVITY_ID = "7cbbe7b5-d2e9-43fe-9a27-5394f6fc8ef6";
const DEFAULT_CHAT_ID = "8783852186";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// score de catégorie : entier 0..12 ; total : entier 0..36
function clampScore(value: unknown, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, Math.round(n)));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));

    const prenom = String(body.prenom ?? "").trim().slice(0, 100);
    const email = String(body.email ?? "").trim().toLowerCase();
    const profil = String(body.profil ?? "").trim().slice(0, 120);
    const scoreOrganisation = clampScore(body.score_organisation, 12);
    const scoreVente = clampScore(body.score_vente, 12);
    const scoreIa = clampScore(body.score_ia, 12);
    const scoreTotal = clampScore(body.score_total, 36);

    const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if (
      !emailOk || !profil ||
      scoreOrganisation === null || scoreVente === null ||
      scoreIa === null || scoreTotal === null
    ) {
      return json({ error: "invalid_input" }, 400);
    }

    const reponses = Array.isArray(body.reponses) ? body.reponses.slice(0, 50) : [];

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: lead, error } = await db
      .from("audit_leads")
      .insert({
        prenom: prenom || null,
        email,
        score_organisation: scoreOrganisation,
        score_vente: scoreVente,
        score_ia: scoreIa,
        score_total: scoreTotal,
        profil,
        reponses,
        activity_id: FORMATION_ACTIVITY_ID,
      })
      .select("id")
      .single();

    if (error || !lead) {
      console.error("audit_leads insert failed:", error?.message);
      return json({ error: "insert_failed" }, 500);
    }

    // ─── Fiche CRM (best effort — ne bloque jamais le flux principal) ───────
    try {
      const noteLine =
        `Quiz audit /audit — Profil : ${profil} — ${scoreTotal}/36 ` +
        `(orga ${scoreOrganisation} / vente ${scoreVente} / IA ${scoreIa})`;

      // Dédup par email + activité, comme la fonction formation-lead.
      const { data: existing } = await db
        .from("customers")
        .select("id, notes")
        .eq("activity_id", FORMATION_ACTIVITY_ID)
        .ilike("email", email)
        .maybeSingle();

      let customerId: string | null = null;

      if (existing) {
        customerId = existing.id;
        await db
          .from("customers")
          .update({
            notes: `${existing.notes ?? ""}\n${noteLine}`.trim(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", customerId);
      } else {
        const { data: created, error: crmErr } = await db
          .from("customers")
          .insert({
            activity_id: FORMATION_ACTIVITY_ID,
            source: "quiz_audit",
            full_name: prenom || email,
            email,
            type: "individual",
            stage: "prospect",
            tags: ["quiz-audit", "lead"],
            notes: noteLine,
          })
          .select("id")
          .single();
        if (crmErr || !created) {
          throw new Error(crmErr?.message ?? "customer_insert_failed");
        }
        customerId = created.id;
      }

      if (customerId) {
        await db
          .from("audit_leads")
          .update({ customer_id: customerId })
          .eq("id", lead.id);
      }
      console.log("CRM upsert ok:", lead.id, "→ customer", customerId);
    } catch (e) {
      console.error(
        "CRM upsert failed (non bloquant):",
        e instanceof Error ? e.message : e,
      );
    }

    // ─── Notification Telegram (best effort) ───────────────────────────────
    try {
      const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
      const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? DEFAULT_CHAT_ID;
      if (token) {
        const text = [
          "🎯 *Nouveau lead — Quiz Audit*",
          "",
          `👤 ${prenom || "—"}`,
          `✉️ ${email}`,
          `📊 Profil : *${profil}*`,
          "",
          `• Organisation : ${scoreOrganisation}/12`,
          `• Système de vente : ${scoreVente}/12`,
          `• IA & Automatisation : ${scoreIa}/12`,
          `• Total : ${scoreTotal}/36`,
        ].join("\n");

        const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        });
        if (tg.ok) {
          console.log("telegram sendMessage ok:", lead.id);
        } else {
          console.error("telegram sendMessage failed:", tg.status, await tg.text());
        }
      } else {
        console.warn("TELEGRAM_BOT_TOKEN absent — notification Telegram ignorée");
      }
    } catch (e) {
      console.error("telegram error:", e);
    }

    return json({ ok: true, id: lead.id });
  } catch (e) {
    console.error("audit-lead-alex error:", e);
    return json({ error: "server_error" }, 500);
  }
});
