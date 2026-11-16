import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppEnv, Session } from "../types";

// One stylesheet, inlined: no build step and no second request. Text is set in
// a serif to read as a document; controls and metadata use the system sans.
const STYLE = `
:root{color-scheme:light dark;--paper:#fbfaf7;--ink:#1c1b19;--muted:#66625a;--rule:#d9d5ca;--tint:#f1eee6;--link:#1d4e89;--danger:#a3261b;--ok:#2a6a3a;
--serif:Charter,"Iowan Old Style","Palatino Linotype",Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#151513;--ink:#e8e5dc;--muted:#a29d90;--rule:#37352f;--tint:#1d1c19;--link:#8fb4e3;--danger:#f0877c;--ok:#7fc795}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:1.0625rem/1.6 var(--serif)}
a{color:var(--link);text-underline-offset:.15em}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible,label:focus-within{outline:3px solid var(--link);outline-offset:2px}
.wrap{max-width:46rem;margin:0 auto;padding:0 1.25rem}
.wide{max-width:70rem}
.skip{position:absolute;left:-999px;top:0;background:var(--ink);color:var(--paper);padding:.5rem 1rem}
.skip:focus{left:0;z-index:9}
header.site{border-bottom:1px solid var(--rule);font-family:var(--sans);font-size:.9375rem}
header.site .wrap{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1.5rem;padding-top:.9rem;padding-bottom:.9rem}
.brand{font:700 1.25rem var(--serif);letter-spacing:-.01em;color:var(--ink);text-decoration:none;margin-right:auto}
header.site nav{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;align-items:baseline}
header.site nav a{color:var(--ink)}
.who{color:var(--muted)}
main{padding:2.5rem 0 4rem}
h1{font-size:2rem;line-height:1.2;letter-spacing:-.015em;margin:0 0 1rem}
h2{font-size:1.25rem;line-height:1.3;margin:2.5rem 0 .75rem;padding-top:.5rem;border-top:1px solid var(--rule)}
h3{font-size:1.0625rem;margin:1.5rem 0 .25rem}
p,ul,ol,dl{margin:0 0 1rem}
.lede{font-size:1.25rem;line-height:1.5}
.muted{color:var(--muted)}
.sans{font-family:var(--sans)}
.small{font-size:.9rem}
code,.hash{font-family:var(--mono);font-size:.875em}
.hash{overflow-wrap:anywhere;word-break:break-all}
form.save{margin:1.5rem 0 .5rem;font-family:var(--sans)}
label{display:block;font-weight:600;margin-bottom:.35rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap}
input[type=url],input[type=text]{flex:1 1 16rem;min-width:0;font:inherit;padding:.6rem .7rem;border:1px solid var(--muted);border-radius:3px;background:var(--paper);color:var(--ink)}
button,.button{font:600 1rem var(--sans);padding:.6rem 1.1rem;border:1px solid var(--ink);background:var(--ink);color:var(--paper);border-radius:3px;cursor:pointer;text-decoration:none;display:inline-block}
button.quiet{background:transparent;color:var(--ink)}
.error{color:var(--danger);font-family:var(--sans);margin:.5rem 0 0}
.notice{border-left:3px solid var(--muted);padding:.1rem 0 .1rem 1rem;color:var(--muted)}
.grid{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:2rem 1.5rem;margin:1.5rem 0}
.grid a.thumb{display:block;border:1px solid var(--rule);background:var(--tint)}
.grid img{display:block;width:100%;height:auto;max-height:22rem;object-fit:cover;object-position:top}
.grid .meta{font:.875rem/1.4 var(--sans);margin-top:.4rem;color:var(--muted)}
.grid .meta a{color:var(--ink)}
.proof{width:100%;border-collapse:collapse;font-family:var(--sans);font-size:.9375rem}
.proof th,.proof td{text-align:left;vertical-align:top;padding:.55rem .75rem .55rem 0;border-top:1px solid var(--rule)}
.proof th{width:9.5rem;font-weight:600;color:var(--muted)}
.capture-img{display:block;max-width:100%;height:auto;border:1px solid var(--rule);margin:1.5rem 0}
.facts{font-family:var(--sans);font-size:.9375rem;color:var(--muted);margin:0 0 1rem}
.facts span+span::before{content:"\\00b7";margin:0 .5rem}
.status{font-weight:600}.status.ok{color:var(--ok)}.status.bad{color:var(--danger)}
ol.steps li{margin-bottom:.6rem}
ul.plain{list-style:none;padding:0}
ul.plain li{padding:.45rem 0;border-top:1px solid var(--rule);font-family:var(--sans)}
ul.plain li:last-child{border-bottom:1px solid var(--rule)}
.drop{border:2px dashed var(--muted);border-radius:4px;padding:2rem 1rem;text-align:center;font-family:var(--sans);cursor:pointer;margin:1rem 0}
.drop.over{border-color:var(--link);background:var(--tint)}
.drop input{position:absolute;opacity:0;width:1px;height:1px}
.result{font-family:var(--sans);margin-top:1.5rem}
.result:empty{display:none}
footer{border-top:1px solid var(--rule);font:.875rem var(--sans);color:var(--muted)}
footer .wrap{padding-top:1rem;padding-bottom:2rem}
@media (max-width:30rem){h1{font-size:1.65rem}.proof th{display:block;width:auto;padding-bottom:0;border-top:0}.proof td{display:block;padding-top:.1rem}.proof tr{display:block;border-top:1px solid var(--rule);padding:.4rem 0}}
`;

export interface PageOptions {
  title: string;
  description?: string;
  /** Extra <head> elements, such as Open Graph tags. */
  head?: Child;
  wide?: boolean;
  status?: ContentfulStatusCode;
}

export function Layout(props: PageOptions & { session: Session | null; path: string; repoUrl?: string; children?: Child }) {
  const { session } = props;
  const signIn = `/auth/login?returnTo=${encodeURIComponent(props.path)}`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title === "xposts" ? "xposts" : `${props.title} · xposts`}</title>
        {props.description ? <meta name="description" content={props.description} /> : null}
        {props.head}
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class="site">
          <div class={props.wide ? "wrap wide" : "wrap"}>
            <a class="brand" href="/">
              xposts
            </a>
            <nav aria-label="Site">
              <a href="/verify">Verify</a>
              <a href="/about">About</a>
              {session ? (
                <>
                  <span class="who">{session.name}</span>
                  <a href="/auth/logout">Sign out</a>
                </>
              ) : (
                <a href={signIn}>Sign in</a>
              )}
            </nav>
          </div>
        </header>
        <main id="main">
          <div class={props.wide ? "wrap wide" : "wrap"}>{props.children}</div>
        </main>
        <footer>
          <div class={props.wide ? "wrap wide" : "wrap"}>
            An archive of X posts.{" "}
            {props.repoUrl ? <a href={props.repoUrl}>Open source</a> : null}
          </div>
        </footer>
      </body>
    </html>
  );
}

/** Renders a page with the shared layout. */
export function page(c: Context<AppEnv>, options: PageOptions, children: Child) {
  const html = (
    <Layout {...options} session={c.get("session") ?? null} path={new URL(c.req.url).pathname + new URL(c.req.url).search} repoUrl={c.env.REPO_URL}>
      {children}
    </Layout>
  );
  return c.html(html, options.status ?? 200);
}

export function notFoundPage(c: Context<AppEnv>, message = "There is nothing at this address.", extra?: Child) {
  return page(
    c,
    { title: "Not found", status: 404 },
    <>
      <h1>Not found</h1>
      <p>{message}</p>
      {extra}
      <p>
        <a href="/">Go to the archive</a>
      </p>
    </>,
  );
}

/** "2026-11-16 04:27 UTC": unambiguous, and the same for every reader. */
export function formatTime(iso: string | null): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function Time(props: { iso: string | null }) {
  return props.iso ? <time datetime={props.iso}>{formatTime(props.iso)}</time> : <>unknown</>;
}
