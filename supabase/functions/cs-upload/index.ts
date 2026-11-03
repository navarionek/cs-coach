// Lineup screenshots: the page compresses the image and POSTs the bytes here with the team key;
// files land in the public cs-lineups bucket under a random name, which only the key-gated
// playbook ever reveals. DELETE {paths} removes files of deleted lineups or dropped images.
// Deployed with --no-verify-jwt; the team key is the only gate.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "cs-lineups";
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
const PATH_RE = /^[0-9a-f-]{36}\.(webp|jpg|png)$/;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-team-key, content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const { data: ok } = await db.schema("cs").rpc("check_key", { k: req.headers.get("x-team-key") ?? "" });
  if (!ok) return json({ error: "Złe hasło drużyny" }, 401);

  if (req.method === "POST") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
    const ext = TYPES[type];
    if (!ext) return json({ error: "Obsługiwane są tylko obrazki (webp, jpg, png)" }, 415);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > MAX_BYTES) return json({ error: "Plik jest za duży (max 5 MB)" }, 413);
    const path = `${crypto.randomUUID()}.${ext}`;
    const { error } = await db.storage.from(BUCKET).upload(path, body, { contentType: type });
    if (error) return json({ error: error.message }, 500);
    return json({ path });
  }

  if (req.method === "DELETE") {
    const { paths } = await req.json().catch(() => ({ paths: [] }));
    const valid = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && PATH_RE.test(p));
    if (valid.length) {
      const { error } = await db.storage.from(BUCKET).remove(valid);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ removed: valid.length });
  }

  return json({ error: "Method not allowed" }, 405);
});
