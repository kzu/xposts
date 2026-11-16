// Runs the archive locally: `npm run dev` (settings from .env.local).

import { serve } from "@hono/node-server";

import { handle, publicUrl } from "./src/main";

const port = Number(new URL(publicUrl).port || 3000);
serve({ fetch: handle, port }, () => console.log(`xposts on ${publicUrl}`));
