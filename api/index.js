// The Vercel function: every request of the site is rewritten to it (vercel.json).
// `npm run build` bundles the app into dist/ first, because Vercel does not compile .tsx modules of a function.

export { handle as GET, handle as HEAD, handle as POST } from "../dist/main.js";
