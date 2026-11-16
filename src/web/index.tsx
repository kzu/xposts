import { Hono } from "hono";
import type { Context } from "hono";

import { requireSession } from "../auth";
import { CaptureError, type Deps } from "../deps";
import { savePath, shortPath } from "../types";
import type { AppEnv, FileKind, Save, SaveRecord, SaveRef } from "../types";
import { parsePostRef, postUrl } from "../x/ref";
import { Time, formatTime, notFoundPage, page } from "./layout";

const POST_ID = /^\d{1,20}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** Paths of the site that are never an author's handle. */
const FIXED = new Set(["verify", "about", "submit", "s", "api", "auth"]);

const isHandle = (value: string) => HANDLE.test(value) && !FIXED.has(value.toLowerCase());

/** The post on x.com. Only well-formed handles are put in the URL. */
function originalUrl(save: Save): string {
  return postUrl({ id: save.postId, handle: HANDLE.test(save.handle) ? save.handle : save.username });
}

const absolute = (c: Context<AppEnv>, path: string) => `${c.env.PUBLIC_URL}${path}`;

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function SaveGrid(props: { saves: Save[] }) {
  return (
    <ul class="grid">
      {props.saves.map((save) => (
        <li>
          <a class="thumb" href={savePath(save)}>
            <img
              src={save.blob.url}
              alt={excerpt(save.excerpt, 140) || "Saved post"}
              loading="lazy"
              width={save.width}
              height={save.height}
            />
          </a>
          <div class="meta">
            <a href={`/${save.username}`}>@{save.handle}</a>
            {" · "}
            <a href={savePath(save)}>
              <Time iso={save.postedAt ?? save.capturedAt} />
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SaveForm(props: { signedIn: boolean; value?: string; error?: string; returnTo: string }) {
  if (!props.signedIn) {
    return (
      <p class="sans">
        <a class="button" href={`/auth/login?returnTo=${encodeURIComponent(props.returnTo)}`}>
          Sign in to save a post
        </a>
      </p>
    );
  }
  return (
    <form class="save" method="post" action="/submit">
      <label for="url">Link to a post on X</label>
      <div class="row">
        <input
          id="url"
          name="url"
          type="text"
          inputmode="url"
          autocomplete="off"
          required
          placeholder="https://x.com/user/status/…"
          value={props.value ?? ""}
          aria-describedby={props.error ? "url-error" : undefined}
          aria-invalid={props.error ? "true" : undefined}
        />
        <button type="submit">Save this post</button>
      </div>
      {props.error ? (
        <p id="url-error" class="error" role="alert">
          {props.error}
        </p>
      ) : null}
    </form>
  );
}

interface FormState {
  value?: string;
  error?: string;
  status?: 400 | 422 | 502;
}

/** Reads the whole text of a save from its record; null when the record is missing or unreadable. */
async function readRecord(deps: Deps, ref: SaveRef): Promise<SaveRecord | null> {
  try {
    const bytes = await deps.store.readFile(ref, "record");
    if (!bytes) return null;
    const record = JSON.parse(new TextDecoder().decode(bytes)) as SaveRecord;
    return record?.schema === "xposts/save/v1" && typeof record.post?.text === "string" ? record : null;
  } catch {
    return null;
  }
}

export function createWeb(deps: Deps): Hono<AppEnv> {
  const { store } = deps;
  const web = new Hono<AppEnv>();

  async function homePage(c: Context<AppEnv>, form: FormState = {}) {
    const saves = await store.recentSaves(24);
    return page(
      c,
      {
        title: "xposts",
        description: "An archive of X posts: each one kept as an image, dated by Azure Blob Storage.",
        wide: true,
        status: form.status,
      },
      <>
        <div class="wrap" style="padding:0;max-width:46rem">
          <h1>An archive of X posts.</h1>
          <p class="lede">
            Save a post as an image, with the data it was made from. The date of the save is the one Azure Blob Storage
            gave the file, which anyone can read.
          </p>
          <p>
            On X, mention <a href={`https://x.com/${c.env.X_BOT_HANDLE}`}>@{c.env.X_BOT_HANDLE}</a> in a reply to a post
            and it is saved. Here, paste the link.
          </p>
          <SaveForm signedIn={!!c.get("session")} value={form.value} error={form.error} returnTo="/" />
        </div>
        <h2>Recently saved</h2>
        {saves.length === 0 ? <p class="muted">Nothing has been saved yet.</p> : <SaveGrid saves={saves} />}
      </>,
    );
  }

  web.get("/", (c) => homePage(c));

  web.post("/submit", requireSession, async (c) => {
    // The session cookie is SameSite=Lax, which already blocks cross-site POSTs; this refuses what slips past.
    if (c.req.header("Origin") !== new URL(c.env.PUBLIC_URL).origin) {
      return page(
        c,
        { title: "Request refused", status: 403 },
        <>
          <h1>Request refused</h1>
          <p>This form must be sent from {c.env.PUBLIC_URL}.</p>
        </>,
      );
    }

    const body = await c.req.parseBody();
    const input = typeof body.url === "string" ? body.url : "";
    const post = parsePostRef(input);
    if (!post) {
      return homePage(c, {
        value: input.slice(0, 300),
        error: "That is not a link to a post. Use an address like https://x.com/user/status/1234567890.",
        status: 400,
      });
    }

    try {
      const { save } = await deps.save({ post, source: "web", requestedBy: c.get("session")!.sub });
      return c.redirect(savePath(save), 303);
    } catch (error) {
      if (!(error instanceof CaptureError)) throw error;
      return homePage(c, { value: input.slice(0, 300), error: error.message, status: error.retryable ? 502 : 422 });
    }
  });

  const VERIFY_SCRIPT = `(function(){
var drop=document.getElementById("drop"),file=document.getElementById("file"),form=document.getElementById("hash-form"),hash=document.getElementById("hash"),out=document.getElementById("result");
function el(tag,text,attrs){var e=document.createElement(tag);if(text!=null)e.textContent=text;for(var k in attrs||{})e.setAttribute(k,attrs[k]);return e}
function show(){out.replaceChildren.apply(out,arguments)}
async function lookup(h,label){
 show(el("p","Checking…"));
 var r;try{r=await fetch("/api/verify/"+h,{headers:{accept:"application/json"}})}catch(e){show(el("p","The archive could not be reached: "+e.message,{class:"error",role:"alert"}));return}
 if(r.status===404){show(el("h2","Not in this archive"),el("p","No save has "+(label||"this hash")+" (SHA-256 "+h+"). The archive does not hold this image. It may be altered, re-encoded, or never saved here."));return}
 if(!r.ok){show(el("p","The archive answered "+r.status+".",{class:"error",role:"alert"}));return}
 var d=await r.json(),s=d.save,p=el("p");
 p.append("This is the image of ",el("a","@"+s.handle+"'s post",{href:new URL(d.page).pathname}),".");
 var q=el("p");q.append("Azure Blob Storage created it on ",el("code",s.blob.createdOn),".");
 show(el("h2","Match"),p,q)}
async function hashFile(f){
 show(el("p","Computing SHA-256 in your browser…"));
 var d=await crypto.subtle.digest("SHA-256",await f.arrayBuffer());
 var h=Array.prototype.map.call(new Uint8Array(d),function(b){return b.toString(16).padStart(2,"0")}).join("");
 hash.value=h;lookup(h,f.name)}
file.addEventListener("change",function(){if(file.files[0])hashFile(file.files[0])});
["dragenter","dragover"].forEach(function(n){drop.addEventListener(n,function(e){e.preventDefault();drop.classList.add("over")})});
["dragleave","drop"].forEach(function(n){drop.addEventListener(n,function(e){e.preventDefault();drop.classList.remove("over")})});
drop.addEventListener("drop",function(e){var f=e.dataTransfer.files[0];if(f)hashFile(f)});
form.addEventListener("submit",function(e){e.preventDefault();var h=hash.value.trim().toLowerCase();
 if(!/^[0-9a-f]{64}$/.test(h)){show(el("p","A SHA-256 is 64 hexadecimal characters.",{class:"error",role:"alert"}));return}
 lookup(h)})
})();`;

  web.get("/verify", (c) =>
    page(
      c,
      { title: "Verify an image", description: "Check whether an image or hash is in the archive." },
      <>
        <h1>Verify an image</h1>
        <p class="lede">Check whether this archive saved an image, and when Azure Blob Storage created it.</p>
        <p>
          The file is hashed in your browser with SHA-256. It never leaves your device: only the hash is sent.
        </p>
        <label class="drop" id="drop" for="file">
          Drop a PNG here, or choose one
          <input id="file" type="file" accept="image/png,.png" />
        </label>
        <form id="hash-form" class="save">
          <label for="hash">Or paste a SHA-256</label>
          <div class="row">
            <input id="hash" type="text" autocomplete="off" spellcheck={false} placeholder="64 hexadecimal characters" />
            <button type="submit">Check</button>
          </div>
        </form>
        <div id="result" class="result" aria-live="polite"></div>
        <noscript>
          <p class="notice">Checking needs JavaScript, because the hash is computed on your device.</p>
        </noscript>
        <script dangerouslySetInnerHTML={{ __html: VERIFY_SCRIPT }} />
      </>,
    ),
  );

  web.get("/about", (c) =>
    page(
      c,
      { title: "About", description: "How xposts saves X posts, and what a save proves." },
      <>
        <h1>About</h1>
        <p class="lede">
          xposts keeps a copy of an X post as it looked when it was saved, and relies on Azure Blob Storage for the date
          of that copy.
        </p>

        <h2>How it works</h2>
        <ol class="steps">
          <li>You paste a link here, or mention @{c.env.X_BOT_HANDLE} in a reply to the post on X.</li>
          <li>The archive reads the post from the X API.</li>
          <li>
            It draws the post as an image with <a href="https://github.com/kzu/xeet">xeet</a>, a renderer that reproduces
            how x.com shows a post.
          </li>
          <li>It stores the image and the data it came from in Azure Blob Storage, in a container anyone can read.</li>
        </ol>

        <h2>What is preserved</h2>
        <p>
          For every save: the image, <code>record.json</code> (the whole text, and what X stated about the post), the X
          API response, and the renderer input. All are downloadable from the page of the save.
        </p>

        <h2>What a save proves, and what it does not</h2>
        <p>
          The date of a save comes from Azure Blob Storage. Azure sets the creation time, Last-Modified, ETag and
          Content-MD5 of a blob itself, and shows them to anyone who asks:{" "}
          <code>curl -I &lt;blob url&gt;</code>. The archive cannot choose them. The first save of a post is never
          overwritten.
        </p>
        <p>
          A save does <strong>not</strong> prove that X served this content. X does not sign posts, so nothing proves X
          said what an image says. A save taken after a post was edited or deleted shows the post as the archive read it
          then.
        </p>
        <p>
          The limit of the proof: it rests on Microsoft's clock, and on the archive not having deleted a blob and
          created it again. A rewritten blob shows a later Last-Modified, so check that it equals the creation time.
        </p>

        <h2>Reproducible and open</h2>
        <p>
          Rendering the renderer input again with <code>@xeet/core</code> gives the same image, so the picture is derived
          from stored data and not a screenshot. The code of this archive is open source at{" "}
          <a href={c.env.REPO_URL}>{c.env.REPO_URL}</a>.
        </p>
      </>,
    ),
  );

  // The short, hot-linkable address of the image.
  web.get("/s/:username/:status", async (c) => {
    const { username, status } = c.req.param();
    if (!isHandle(username) || !POST_ID.test(status)) return notFoundPage(c);
    const save = await store.getSave({ username: username.toLowerCase(), postId: status });
    if (!save) return notFoundPage(c, "This post has not been saved.");
    return c.redirect(save.blob.url, 308);
  });

  // An x.com link works by swapping the host.
  web.get("/:username/status/:status", (c) => {
    const { username, status } = c.req.param();
    if (!isHandle(username) || !POST_ID.test(status)) return notFoundPage(c);
    return c.redirect(`/${username.toLowerCase()}/${status}`, 301);
  });

  web.get("/:username/:status", async (c) => {
    const { username, status } = c.req.param();
    if (!isHandle(username) || !POST_ID.test(status)) return notFoundPage(c);
    if (username !== username.toLowerCase()) return c.redirect(`/${username.toLowerCase()}/${status}`, 301);

    const ref: SaveRef = { username, postId: status };
    const save = await store.getSave(ref);
    if (!save) {
      return notFoundPage(
        c,
        "This post has not been saved.",
        <SaveForm signedIn={!!c.get("session")} value={`https://x.com/${username}/status/${status}`} returnTo={savePath(ref)} />,
      );
    }

    const record = await readRecord(deps, save);
    const text = record?.post.text ?? save.excerpt;
    const shortUrl = absolute(c, shortPath(save));
    const who = `@${save.handle}`;
    const summary = excerpt(text, 200);
    const head = (
      <>
        <meta property="og:type" content="article" />
        <meta property="og:site_name" content="xposts" />
        <meta property="og:title" content={`${who} on X, saved ${formatTime(save.capturedAt)}`} />
        <meta property="og:description" content={summary || "An archived post."} />
        <meta property="og:url" content={absolute(c, savePath(save))} />
        <meta property="og:image" content={save.blob.url} />
        <meta property="og:image:width" content={String(save.width)} />
        <meta property="og:image:height" content={String(save.height)} />
        <meta property="og:image:alt" content={summary || "The archived post"} />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href={absolute(c, savePath(save))} />
      </>
    );
    const downloads: { kind: FileKind; label: string }[] = [
      { kind: "record", label: "record.json" },
      { kind: "xeetInput", label: "xeet-input.json" },
      ...(record?.files.xApi ? [{ kind: "xApi" as const, label: "x-api.json" }] : []),
    ];

    return page(
      c,
      { title: `${who}: ${excerpt(text, 60) || save.postId}`, description: summary, head },
      <>
        <h1>{save.authorName ?? who}</h1>
        <p class="facts">
          <span>
            <a href={`/${save.username}`}>{who}</a>
          </span>
          <span>
            Posted <Time iso={save.postedAt} />
          </span>
          <span>
            Saved <Time iso={save.capturedAt} />
          </span>
          <span>
            <a href={originalUrl(save)}>Original on x.com</a>
          </span>
        </p>
        <img class="capture-img" src={save.blob.url} alt={text} width={save.width} height={save.height} />
        <p style="white-space:pre-wrap">{text}</p>
        <p class="muted small">
          Short address of the image: <a href={shortUrl}>{shortUrl}</a>
        </p>
        {record && record.warnings.length > 0 ? (
          <p class="notice small">
            Notes from the save:
            <br />
            {record.warnings.map((warning) => (
              <>
                {warning}
                <br />
              </>
            ))}
          </p>
        ) : null}

        <h2 id="proof">Proof</h2>
        <p class="muted small">
          The first five rows are stated by Azure Blob Storage, not by this archive.
        </p>
        <table class="proof">
          <tbody>
            <tr>
              <th scope="row">Blob URL</th>
              <td class="hash">
                <a href={save.blob.url}>{save.blob.url}</a>
              </td>
            </tr>
            <tr>
              <th scope="row">Created</th>
              <td class="hash">{save.blob.createdOn}</td>
            </tr>
            <tr>
              <th scope="row">Last modified</th>
              <td class="hash">{save.blob.lastModified}</td>
            </tr>
            <tr>
              <th scope="row">ETag</th>
              <td class="hash">{save.blob.etag}</td>
            </tr>
            <tr>
              <th scope="row">Content-MD5</th>
              <td class="hash">{save.blob.contentMd5 ?? "not stated"}</td>
            </tr>
            <tr>
              <th scope="row">Image SHA-256</th>
              <td class="hash">{save.pngSha256}</td>
            </tr>
            <tr>
              <th scope="row">Record SHA-256</th>
              <td class="hash">{save.recordSha256}</td>
            </tr>
          </tbody>
        </table>

        <h3>Check it without trusting this site</h3>
        <ol class="steps">
          <li>
            Run <code>curl -I {save.blob.url}</code>. Azure answers with <code>x-ms-creation-time</code>,{" "}
            <code>Last-Modified</code>, <code>ETag</code>, <code>Content-MD5</code> and the <code>x-ms-meta-*</code> values.
            They must equal the table, and Last-Modified must equal the creation time: a blob that was rewritten shows a
            later one.
          </li>
          <li>
            Download the image and compute its SHA-256 on your own machine (<code>sha256sum</code>,{" "}
            <code>shasum -a 256</code>, or <code>certutil -hashfile file SHA256</code>), or drop it on{" "}
            <a href="/verify">the verify page</a>, which does it in your browser. It must equal the image hash above.
          </li>
          <li>
            Optionally, render <code>xeet-input.json</code> again with <code>@xeet/core</code>, at the renderer version in
            the record: the image is reproduced from that input.
          </li>
        </ol>

        <h3>Downloads</h3>
        <ul class="plain">
          {downloads.map((file) => (
            <li>
              <a href={store.fileUrl(save, file.kind)}>{file.label}</a>
            </li>
          ))}
        </ul>
      </>,
    );
  });

  web.get("/:username", async (c) => {
    const username = c.req.param("username");
    if (!isHandle(username)) return notFoundPage(c);
    const saves = await store.listSaves(username.toLowerCase());
    const handle = saves[0]?.handle ?? username;
    return page(
      c,
      { title: `@${handle}`, wide: true },
      <>
        <h1>@{handle}</h1>
        <p class="muted">
          {saves.length} saved {saves.length === 1 ? "post" : "posts"} · <a href={`https://x.com/${handle}`}>Profile on x.com</a>
        </p>
        {saves.length === 0 ? (
          <>
            <p>No posts by @{handle} have been saved yet.</p>
            <SaveForm signedIn={!!c.get("session")} returnTo={`/${username.toLowerCase()}`} />
          </>
        ) : (
          <SaveGrid saves={saves} />
        )}
      </>,
    );
  });

  return web;
}

/** The 404 page, for the root app to install with `app.notFound` (sub-apps do not pass theirs up). */
export const notFound = (c: Context<AppEnv>) => notFoundPage(c);
