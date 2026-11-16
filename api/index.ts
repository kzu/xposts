// The Vercel function: every request of the site is rewritten to it (vercel.json).

import { handle } from "../src/main.js";

export { handle as GET, handle as HEAD, handle as POST };
