// Sincroniza las HU del sprint actual (y sus HA hijas) desde Azure DevOps al tablero.
// - El PAT vive en el secreto AZDO_PAT (Supabase > Edge Functions > Secrets). Nunca en el repo.
// - La organización, proyecto y equipo se leen de public.azure_config del usuario que llama.
// - Solo lectura en Azure DevOps. En el tablero crea/actualiza HU y HA sin tocar estado, meta ni notas.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class AzError extends Error {
  constructor(msg: string, public status = 502) { super(msg); }
}

type WI = { id: number; fields: Record<string, any> };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "Sesión no válida" }, 401);

    const { data: cfg } = await sb.from("azure_config").select("*").maybeSingle();
    if (!cfg) return json({ error: "Tu cuenta no tiene Azure DevOps configurado." }, 403);

    const pat = Deno.env.get("AZDO_PAT");
    if (!pat) return json({ error: "Falta el secreto AZDO_PAT en Supabase." }, 500);

    const body = await req.json().catch(() => ({}));
    const modo: "mias" | "todas" = body?.modo === "todas" ? "todas" : "mias";

    const org = String(cfg.org_url).replace(/\/+$/, "");
    const proj = encodeURIComponent(cfg.project);
    const team = encodeURIComponent(cfg.team);
    const headers = {
      Authorization: "Basic " + btoa(":" + pat),
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const az = async (url: string, init: RequestInit = {}) => {
      const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, redirect: "manual" });
      const ct = r.headers.get("content-type") ?? "";
      if (r.status === 401 || r.status === 203 || (r.status >= 300 && r.status < 400) || (r.ok && !ct.includes("json"))) {
        throw new AzError("Azure DevOps rechazó el token: puede estar vencido, revocado o sin permiso de Work Items (Read).", 401);
      }
      if (r.status === 403) {
        const t = await r.text();
        throw new AzError("Azure DevOps bloqueó el acceso (403). Puede ser una política de la organización (IP o acceso condicional). " + t.slice(0, 200), 403);
      }
      if (!r.ok) {
        const t = await r.text();
        throw new AzError(`Azure DevOps respondió ${r.status}: ${t.slice(0, 300)}`, 502);
      }
      return r.json();
    };
    const wiql = (query: string) =>
      az(`${org}/${proj}/${team}/_apis/wit/wiql?api-version=7.1`, { method: "POST", body: JSON.stringify({ query }) });
    const q = (s: string) => s.replace(/'/g, "''");

    // 1) Sprint actual del equipo
    const iters = await az(`${org}/${proj}/${team}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`);
    const it = iters?.value?.[0];
    if (!it) return json({ error: "El equipo no tiene un sprint actual configurado." }, 404);
    const sprint: string = it.name;
    const path: string = it.path;

    // 2) HU del sprint con sus hijas
    const tipos = (cfg.tipos_hu as string[]).map((t) => `'${q(t)}'`).join(",");
    const links = await wiql(
      `SELECT [System.Id] FROM WorkItemLinks
       WHERE ([Source].[System.WorkItemType] IN (${tipos}) AND [Source].[System.IterationPath] = '${q(path)}')
         AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')
       MODE (MayContain)`,
    );
    const hijos = new Map<number, number[]>();
    for (const rel of links.workItemRelations ?? []) {
      if (!rel.source) { if (!hijos.has(rel.target.id)) hijos.set(rel.target.id, []); }
      else hijos.set(rel.source.id, [...(hijos.get(rel.source.id) ?? []), rel.target.id]);
    }

    if (hijos.size === 0) {
      // Ayuda de diagnóstico: qué tipos hay en el sprint
      const todos = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${q(path)}'`);
      const ids = (todos.workItems ?? []).slice(0, 200).map((w: any) => w.id);
      const tiposVistos = ids.length ? [...new Set((await lote(ids)).map((w) => w.fields["System.WorkItemType"]))] : [];
      return json({ sprint, hu_total: 0, aviso: "No encontré HU en el sprint con los tipos configurados.", tipos_en_sprint: tiposVistos });
    }

    // 3) Mis work items del sprint (para el modo "mías")
    const mias = new Set<number>();
    if (modo === "mias") {
      const r = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${q(path)}' AND [System.AssignedTo] = @Me`);
      for (const w of r.workItems ?? []) mias.add(w.id);
    }
    const huIds = [...hijos.keys()].filter((id) => modo === "todas" || mias.has(id) || (hijos.get(id) ?? []).some((c) => mias.has(c)));

    // 4) Detalle de HU y HA
    async function lote(ids: number[]): Promise<WI[]> {
      const out: WI[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const r = await az(`${org}/_apis/wit/workitemsbatch?api-version=7.1`, {
          method: "POST",
          body: JSON.stringify({
            ids: ids.slice(i, i + 200),
            fields: ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo"],
          }),
        });
        out.push(...(r.value ?? []));
      }
      return out;
    }
    const todosIds = [...new Set(huIds.flatMap((id) => [id, ...(hijos.get(id) ?? [])]))];
    const det = new Map((await lote(todosIds)).map((w) => [w.id, w]));
    const asignado = (w?: WI) => w?.fields["System.AssignedTo"]?.displayName ?? null;

    // 5) Volcar al tablero (con la sesión del usuario: aplica RLS)
    const ahora = new Date().toISOString();
    const { data: existentes, error: e1 } = await sb.from("hu").select("id,codigo,orden");
    if (e1) throw e1;
    const porCodigo = new Map((existentes ?? []).map((h: any) => [h.codigo, h]));
    let orden = (existentes ?? []).reduce((m: number, h: any) => Math.max(m, h.orden ?? 0), -1) + 1;
    const res = { sprint, modo, hu_total: huIds.length, hu_nuevas: 0, hu_actualizadas: 0, ha_nuevas: 0, ha_actualizadas: 0 };

    for (const id of huIds) {
      const w = det.get(id); if (!w) continue;
      const codigo = String(id);
      const campos = {
        titulo: w.fields["System.Title"],
        sprint,
        azure_estado: w.fields["System.State"],
        azure_url: `${org}/${proj}/_workitems/edit/${id}`,
        sincronizado_at: ahora,
      };
      let hu = porCodigo.get(codigo);
      if (hu) {
        const { error } = await sb.from("hu").update(campos).eq("id", hu.id);
        if (error) throw error;
        res.hu_actualizadas++;
      } else {
        const { data, error } = await sb.from("hu").insert({ codigo, orden: orden++, ...campos }).select("id,codigo,orden").single();
        if (error) throw error;
        hu = data; porCodigo.set(codigo, hu); res.hu_nuevas++;
      }

      const hijas = (hijos.get(id) ?? []).map((c) => det.get(c)).filter(Boolean) as WI[];
      if (!hijas.length) continue;
      const { data: haEx, error: e2 } = await sb.from("ha").select("id,codigo").eq("hu_id", hu.id);
      if (e2) throw e2;
      const haPorCodigo = new Map((haEx ?? []).map((a: any) => [a.codigo, a.id]));
      const nuevas = [];
      for (const c of hijas) {
        const datos = { titulo: c.fields["System.Title"], azure_estado: c.fields["System.State"], asignado: asignado(c) };
        const haId = haPorCodigo.get(String(c.id));
        if (haId) {
          const { error } = await sb.from("ha").update(datos).eq("id", haId);
          if (error) throw error;
          res.ha_actualizadas++;
        } else nuevas.push({ hu_id: hu.id, codigo: String(c.id), ...datos });
      }
      if (nuevas.length) {
        const { error } = await sb.from("ha").insert(nuevas);
        if (error) throw error;
        res.ha_nuevas += nuevas.length;
      }
    }

    return json(res);
  } catch (e) {
    const status = e instanceof AzError ? e.status : 500;
    return json({ error: (e as Error)?.message ?? String(e) }, status);
  }
});
