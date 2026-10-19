// Sincroniza HU (de un sprint, de una lista de IDs o bajo una Feature/Epic) y sus HA desde Azure DevOps al tablero.
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
    const modo: "mias" | "todas" | "id" = body?.modo === "todas" ? "todas" : body?.modo === "id" ? "id" : "mias";
    const idsEntrada = [...new Set(String(Array.isArray(body?.ids) ? body.ids.join(",") : (body?.ids ?? body?.id ?? ""))
      .split(/[^0-9]+/).filter(Boolean).map(Number))].slice(0, 300);
    const hermanas = body?.hermanas === true;
    const sprintPedido: string | null = typeof body?.sprint === "string" && body.sprint ? body.sprint : null;
    if (modo === "id" && !idsEntrada.length) return json({ error: "Escribe uno o varios IDs de HU, Feature o Epic." }, 400);

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

    // Lista de sprints del equipo (para el selector)
    if (body?.accion === "sprints") {
      const r = await az(`${org}/${proj}/${team}/_apis/work/teamsettings/iterations?api-version=7.1`);
      const its = (r.value ?? []).map((i: any) => ({ name: i.name, path: i.path, timeFrame: i.attributes?.timeFrame, start: i.attributes?.startDate }));
      const idx = its.findIndex((i: any) => i.timeFrame === "current");
      const desde = Math.max(0, (idx >= 0 ? idx : its.length) - 6);
      return json({ sprints: its.slice(desde, (idx >= 0 ? idx : its.length) + 2).reverse() });
    }

    const sprintDe = (w?: WI) => String(w?.fields["System.IterationPath"] ?? "").split("\\").pop() || null;

    // Detalle de work items (lotes de 200)
    async function lote(ids: number[]): Promise<WI[]> {
      const out: WI[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const r = await az(`${org}/_apis/wit/workitemsbatch?api-version=7.1`, {
          method: "POST",
          body: JSON.stringify({
            ids: ids.slice(i, i + 200),
            fields: ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Parent", "System.IterationPath"],
          }),
        });
        out.push(...(r.value ?? []));
      }
      return out;
    }
    // Detalle con relaciones (la API no admite lista de campos junto con $expand)
    async function loteRel(ids: number[]): Promise<any[]> {
      const out: any[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const r = await az(`${org}/_apis/wit/workitemsbatch?api-version=7.1`, {
          method: "POST",
          body: JSON.stringify({ ids: ids.slice(i, i + 200), $expand: "Relations" }),
        });
        out.push(...(r.value ?? []));
      }
      return out;
    }
    const RELS = new Set([
      "System.LinkTypes.Hierarchy-Forward", "System.LinkTypes.Related",
      "System.LinkTypes.Dependency-Forward", "System.LinkTypes.Dependency-Reverse",
    ]);
    const relacionados = (w: any) =>
      (w?.relations ?? []).filter((r: any) => RELS.has(r.rel) && /\/workItems\/\d+$/i.test(r.url))
        .map((r: any) => ({ rel: r.rel as string, id: Number(String(r.url).split("/").pop()) }));
    const tiposHU = new Set((cfg.tipos_hu as string[]).map((t) => t.toLowerCase()));
    const esHU = (w?: WI) => !!w && tiposHU.has(String(w.fields["System.WorkItemType"]).toLowerCase());
    const esContenedor = (w?: WI) => !!w && /feature|epic|[ée]pica|iniciativa|caracter/i.test(String(w.fields["System.WorkItemType"]));
    const diag: Record<string, unknown> = {};
    const descendientes = async (id: number, recursivo: boolean) => {
      const r = await wiql(
        `SELECT [System.Id] FROM WorkItemLinks
         WHERE ([Source].[System.Id] = ${id}) AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')
         MODE (${recursivo ? "Recursive" : "MayContain"})`,
      );
      return (r.workItemRelations ?? []).filter((x: any) => x.source).map((x: any) => x.target.id as number);
    };

    // 2) Determinar las HU a traer
    const set = new Set<number>();
    if (modo === "id") {
      const items = await lote(idsEntrada);
      const vistos = new Set(items.map((w) => w.id));
      diag.no_encontrados = idsEntrada.filter((id) => !vistos.has(id));
      diag.base = items.length === 1 ? `${items[0].fields["System.WorkItemType"]} ${items[0].id}: ${items[0].fields["System.Title"]}` : `${items.length} IDs`;
      if (!items.length) return json({ error: "No encontré esos work items o tu token no tiene acceso a ellos." }, 404);
      for (const w of items) {
        if (esContenedor(w)) {
          const desc = await lote(await descendientes(w.id, true));
          for (const x of desc) if (esHU(x)) set.add(x.id);
          continue;
        }
        set.add(w.id);
        const padre = Number(w.fields["System.Parent"] || 0);
        if (hermanas && padre) {
          const sib = await lote(await descendientes(padre, false));
          for (const x of sib) if (x.fields["System.WorkItemType"] === w.fields["System.WorkItemType"]) set.add(x.id);
        }
      }
    } else {
      let it: any;
      if (sprintPedido) it = { name: sprintPedido.split("\\").pop(), path: sprintPedido };
      else {
        const iters = await az(`${org}/${proj}/${team}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`);
        it = iters?.value?.[0];
        if (!it) return json({ error: "El equipo no tiene un sprint actual configurado." }, 404);
      }
      diag.sprint = it.name; diag.ruta = it.path;
      const filtro = modo === "mias" ? " AND [System.AssignedTo] = @Me" : "";
      const r0 = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] UNDER '${q(it.path)}'${filtro}`);
      const base = await lote((r0.workItems ?? []).map((w: any) => w.id));
      diag.items = base.length;
      diag.tipos = [...new Set(base.map((w) => w.fields["System.WorkItemType"]))];
      // Padres de los items que no son HU
      const padresIds = [...new Set(base.filter((w) => !esHU(w) && w.fields["System.Parent"]).map((w) => Number(w.fields["System.Parent"])))];
      const padres = new Map((padresIds.length ? await lote(padresIds) : []).map((p) => [p.id, p]));
      let sueltos = 0;
      const huerfanos: WI[] = [];
      for (const w of base) {
        if (esHU(w) || esContenedor(w)) { if (esHU(w)) set.add(w.id); continue; }
        const p = padres.get(Number(w.fields["System.Parent"] || 0));
        if (p && !esContenedor(p)) set.add(p.id);       // su HU padre
        else huerfanos.push(w);
      }
      // Sin padre (p. ej. Habilitador): buscar su HU entre los relacionados; si no hay, tarjeta propia
      if (huerfanos.length) {
        const conRel = await loteRel(huerfanos.map((w) => w.id));
        const cand = [...new Set(conRel.flatMap((w) => relacionados(w).map((r: any) => r.id)))];
        const candDet = new Map((cand.length ? await lote(cand) : []).map((c) => [c.id, c]));
        for (const w of conRel) {
          const hus = relacionados(w).map((r: any) => candDet.get(r.id))
            .filter((c: any) => c && !esContenedor(c) && (esHU(c) || c.fields["System.WorkItemType"] !== w.fields["System.WorkItemType"]));
          if (hus.length) hus.forEach((h: any) => set.add(h.id));
          else { set.add(w.id); sueltos++; }
        }
      }
      diag.sueltos = sueltos;
    }
    const huIds = [...set];
    if (!huIds.length) return json({ ...diag, modo, hu_total: 0, aviso: modo === "id" ? "No encontré HU bajo ese work item." : "No encontré HU para traer en el sprint actual." });

    // 3) HA de esas HU: hijas, relacionadas y dependencias (p. ej. Habilitadores), en cualquier estado
    const huDet = await loteRel(huIds);
    const relPorHU = new Map(huDet.map((w: any) => [w.id as number, relacionados(w)]));
    const candidatos = [...new Set([...relPorHU.values()].flat().map((r: any) => r.id as number))].filter((id) => !set.has(id));
    const candDet = new Map((candidatos.length ? await lote(candidatos) : []).map((w) => [w.id, w]));
    const hijos = new Map<number, number[]>();
    for (const [id, rels] of relPorHU) {
      const ok = rels.filter((r: any) => {
        const c = candDet.get(r.id);
        if (!c || esContenedor(c)) return false;
        return r.rel === "System.LinkTypes.Hierarchy-Forward" || !esHU(c);
      }).map((r: any) => r.id as number);
      hijos.set(id, [...new Set(ok)]);
    }
    const det = new Map<number, WI>([...huDet.map((w: any) => [w.id, w] as [number, WI]), ...candDet]);
    const asignado = (w?: WI) => w?.fields["System.AssignedTo"]?.displayName ?? null;

    // 5) Volcar al tablero (con la sesión del usuario: aplica RLS)
    const ahora = new Date().toISOString();
    const { data: existentes, error: e1 } = await sb.from("hu").select("id,codigo,orden");
    if (e1) throw e1;
    const porCodigo = new Map((existentes ?? []).map((h: any) => [h.codigo, h]));
    let orden = (existentes ?? []).reduce((m: number, h: any) => Math.max(m, h.orden ?? 0), -1) + 1;
    const res = { ...diag, modo, hu_total: huIds.length, hu_nuevas: 0, hu_actualizadas: 0, ha_nuevas: 0, ha_actualizadas: 0 };

    for (const id of huIds) {
      const w = det.get(id); if (!w) continue;
      const codigo = String(id);
      const campos = {
        titulo: w.fields["System.Title"],
        tipo: w.fields["System.WorkItemType"],
        sprint: sprintDe(w),
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
