// Receives CS2 Game State Integration POSTs straight from the players' games.
// GSI can't send an Authorization header, so this is deployed with --no-verify-jwt and checks the
// team token that GSI puts in the body (`auth.token` from the .cfg) instead.
import { createClient } from "jsr:@supabase/supabase-js@2";

const token = Deno.env.get("CS_GSI_TOKEN");
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "cs" } },
);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("CS Coach GSI endpoint", { status: 405 });
  }
  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!token || payload?.auth?.token !== token) {
    return new Response("unauthorized", { status: 401 });
  }
  const { data, error } = await db.rpc("ingest", { p: payload });
  if (error) {
    console.error(error);
    return new Response(error.message, { status: 500 });
  }
  return new Response(data ?? "ok");
});
