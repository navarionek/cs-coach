// AI voice for live calls: ElevenLabs text-to-speech behind the team key. Every clip is stored in
// the cs-lineups bucket under a hash of voice + text, so a phrase is paid for once and then served
// from storage ("Runda 7.", "Full buy.", a tactic + role call…).
// Deployed with --no-verify-jwt; the API key lives in the ELEVENLABS_API_KEY secret.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "cs-lineups";
const MAX_CHARS = 600;
// ElevenLabs' multilingual premade voices; they speak Polish with language_code "pl".
const VOICES: Record<string, string> = {
  brian: "nPczCjzI2devNBz1zQrb",
  adam: "pNInz6obpgDQGcFmaJgB",
  george: "JBFqnCBsd6RMkjVDRZzb",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-team-key, content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { data: ok } = await db.schema("cs").rpc("check_key", { k: req.headers.get("x-team-key") ?? "" });
  if (!ok) return json({ error: "Złe hasło drużyny" }, 401);

  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim().slice(0, MAX_CHARS);
  const voice = VOICES[body.voice] ? body.voice : "brian";
  if (!text) return json({ error: "Pusty tekst" }, 400);

  const path = `tts/${voice}/${await sha256(`${voice}|${text}`)}.mp3`;
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  const cached = await fetch(url, { method: "HEAD" });
  if (cached.ok) return json({ url, cached: true });

  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  if (!apiKey) return json({ error: "Brak klucza ElevenLabs" }, 500);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES[voice]}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
      language_code: "pl",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: 1.05 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("elevenlabs", res.status, detail);
    return json({ error: `ElevenLabs ${res.status}` }, 502);
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  const { error } = await db.storage.from(BUCKET).upload(path, audio, { contentType: "audio/mpeg", upsert: true });
  if (error) return json({ error: error.message }, 500);
  return json({ url, cached: false });
});
