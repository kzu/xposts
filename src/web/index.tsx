import { Hono } from "hono";
import type { Context } from "hono";

import { requireSession } from "../auth";
import { explorerUrl } from "../chain/explorer";
import { capturesByAuthor, getCapture, listCaptures, recentCaptures, requestCapture } from "../db";
import { ARTIFACTS, captureKey, captureUrl } from "../types";
import type { AppEnv, Capture } from "../types";
import { parsePostRef, postUrl } from "../x/ref";
import { Time, formatTime, notFoundPage, page, tsToIso } from "./layout";

export const web = new Hono<AppEnv>();

const POST_ID = /^\d{1,20}$/;
const TS = /^\d{14}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const capturePath = (c: { postId: string; ts: string }) => `/p/${c.postId}/${c.ts}`;

/** The post on x.com. Only well-formed handles are put in the URL. */
function originalUrl(capture: Capture): string {
  const handle = capture.authorHandle && HANDLE.test(capture.authorHandle) ? capture.authorHandle : undefined;
  return postUrl({ id: capture.postId, handle });
}

function excerpt(text: string | null, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function CaptureGrid(props: { captures: Capture[] }) {
  return (
    <ul class="grid">
      {props.captures.map((capture) => (
        <li>
          <a class="thumb" href={capturePath(capture)}>
            <img
              src={`${capturePath(capture)}/${ARTIFACTS.png}`}
              alt={excerpt(capture.text, 140) || "Saved post"}
              loading="lazy"
              width={capture.width ?? undefined}
              height={capture.height ?? undefined}
            />
          </a>
          <div class="meta">
            {capture.authorHandle ? <a href={`/u/${encodeURIComponent(capture.authorHandle)}`}>@{capture.authorHandle}</a> : "Unknown author"}
            {" · "}
            <a href={capturePath(capture)}>
              <Time iso={capture.capturedAt ?? tsToIso(capture.ts)} />
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

async function homePage(c: Context<AppEnv>, form: { value?: string; error?: string; status?: 400 } = {}) {
  const captures = await recentCaptures(c.env.DB, 24);
  const handle = c.env.X_BOT_HANDLE;
  return page(
    c,
    {
      title: "xposts",
      description: "A verifiable archive of X posts, anchored on Algorand.",
      wide: true,
      status: form.status,
    },
    <>
      <div class="wrap" style="padding:0;max-width:46rem">
        <h1>A verifiable archive of X posts.</h1>
        <p class="lede">
          Save a post as an image, with the data it was made from, and anchor its fingerprint on the Algorand
          blockchain, so anyone can later check that the archive held exactly these bytes at that time.
        </p>
        <p>
          On X, mention <a href={`https://x.com/${handle}`}>@{handle}</a> in a reply to a post and it is saved. Here,
          paste the link.
        </p>
        <SaveForm signedIn={!!c.get("session")} value={form.value} error={form.error} returnTo="/" />
      </div>
      <h2>Recently saved</h2>
      {captures.length === 0 ? <p class="muted">Nothing has been saved yet.</p> : <CaptureGrid captures={captures} />}
    </>,
  );
}

web.get("/", (c) => homePage(c));

web.post("/submit", requireSession, async (c) => {
  // The session cookie is SameSite=Lax, which already blocks cross-site POSTs; this refuses what slips past.
  const origin = c.req.header("Origin");
  if (origin !== new URL(c.env.PUBLIC_URL).origin) {
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
  const ref = parsePostRef(input);
  if (!ref) {
    return homePage(c, {
      value: input.slice(0, 300),
      error: "That is not a link to a post. Use an address like https://x.com/user/status/1234567890.",
      status: 400,
    });
  }

  const session = c.get("session")!;
  const { capture } = await requestCapture(c.env, { postId: ref.id, source: "web", requestedBy: session.sub });
  return c.redirect(capturePath(capture), 303);
});

web.get("/p/:postId", async (c) => {
  const postId = c.req.param("postId");
  if (!POST_ID.test(postId)) return notFoundPage(c);
  const captures = await listCaptures(c.env.DB, postId);
  if (captures.length === 0) return notFoundPage(c, "This post has not been saved.");
  if (captures.length === 1) return c.redirect(capturePath(captures[0]!));

  const authored = captures.find((capture) => capture.authorHandle);
  return page(
    c,
    { title: `Captures of post ${postId}` },
    <>
      <h1>Captures of this post</h1>
      <p class="muted">
        {authored?.authorHandle ? <>By @{authored.authorHandle}. </> : null}
        <a href={originalUrl(authored ?? captures[0]!)}>Original on x.com</a>
      </p>
      <ul class="plain">
        {captures.map((capture) => (
          <li>
            <a href={capturePath(capture)}>
              <Time iso={tsToIso(capture.ts)} />
            </a>
            {capture.status === "pending" ? <span class="muted"> · being saved</span> : null}
            {capture.status === "failed" ? <span class="muted"> · failed</span> : null}
            {capture.status === "done" && capture.anchorTxid ? <span class="muted"> · anchored</span> : null}
          </li>
        ))}
      </ul>
    </>,
  );
});

const POLL_SCRIPT = `(function(){var el=document.getElementById("pending");if(!el)return;var api=el.getAttribute("data-api");
function later(){setTimeout(tick,2000)}
function tick(){fetch(api,{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null}).then(function(c){if(c&&c.status!=="pending"){location.reload()}else{later()}}).catch(later)}
later()})();`;

async function artifactFiles(c: Context<AppEnv>, capture: Capture) {
  const names = [ARTIFACTS.png, ARTIFACTS.manifest, ARTIFACTS.xeetInput, ARTIFACTS.xApi, ARTIFACTS.xApiHeaders, ARTIFACTS.xPage];
  const heads = await Promise.all(names.map((name) => c.env.BUCKET.head(captureKey(capture, name))));
  // x-page.html and x-api.json are absent for some captures: list what is stored.
  return names.flatMap((name, i) => (heads[i] ? [{ name, bytes: heads[i].size }] : []));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Proof(props: { capture: Capture; files: { name: string; bytes: number }[] }) {
  const { capture, files } = props;
  const base = capturePath(capture);
  return (
    <>
      <h2 id="proof">Proof</h2>
      <table class="proof">
        <tbody>
          <tr>
            <th scope="row">Image SHA-256</th>
            <td class="hash">{capture.pngSha256}</td>
          </tr>
          <tr>
            <th scope="row">Manifest SHA-256</th>
            <td class="hash">{capture.manifestSha256}</td>
          </tr>
          <tr>
            <th scope="row">Algorand</th>
            <td>
              {capture.anchorTxid && capture.anchorNetwork ? (
                <>
                  <a class="hash" href={explorerUrl(capture.anchorNetwork, capture.anchorTxid)}>
                    {capture.anchorTxid}
                  </a>
                  <br />
                  {capture.anchorNetwork}, round {capture.anchorRound}
                </>
              ) : (
                <>Not anchored. The archive holds these files, but no timestamp on a blockchain backs them.</>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Check it without trusting this site</h3>
      <ol class="steps">
        <li>
          Download <a href={`${base}/${ARTIFACTS.png}`}>post.png</a> and <a href={`${base}/${ARTIFACTS.manifest}`}>manifest.json</a>.
        </li>
        <li>
          Compute their SHA-256 on your own machine (<code>sha256sum post.png</code>, <code>shasum -a 256 post.png</code>, or{" "}
          <code>certutil -hashfile post.png SHA256</code>), or drop the image on <a href="/verify">the verify page</a>, which
          does it in your browser. The values must equal the two above.
        </li>
        {capture.anchorTxid && capture.anchorNetwork ? (
          <li>
            Open <a href={explorerUrl(capture.anchorNetwork, capture.anchorTxid)}>the transaction</a> in any Algorand explorer.
            Its note carries the same two hashes. The block that holds it is dated by the network, not by this archive, so
            these bytes existed no later than that moment.
          </li>
        ) : (
          <li>This capture has no transaction, so there is no independent date for it.</li>
        )}
        <li>
          Optionally, render <a href={`${base}/${ARTIFACTS.xeetInput}`}>xeet-input.json</a> again with the renderer version
          named in the manifest: the image is reproduced from that input.
        </li>
      </ol>

      {files.length > 0 ? (
        <>
          <h3>Stored files</h3>
          <ul class="plain">
            {files.map((file) => (
              <li>
                <a href={`${base}/${file.name}`} download>
                  {file.name}
                </a>
                <span class="muted"> · {formatBytes(file.bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

web.get("/p/:postId/:ts", async (c) => {
  const { postId, ts } = c.req.param();
  if (!POST_ID.test(postId) || !TS.test(ts)) return notFoundPage(c);
  const capture = await getCapture(c.env.DB, { postId, ts });
  if (!capture) return notFoundPage(c, "There is no such capture.");

  if (capture.status === "pending") {
    return page(
      c,
      { title: "Saving post", refresh: 5 },
      <>
        <h1>Saving this post…</h1>
        <p id="pending" data-api={`/api/captures/${postId}/${ts}`} role="status">
          <span class="spinner">Fetching the post, rendering it and anchoring it. This page updates when it is done.</span>
        </p>
        <p class="muted small">
          Requested <Time iso={capture.createdAt} />. <a href={`/p/${postId}`}>All captures of this post</a>
        </p>
        <script dangerouslySetInnerHTML={{ __html: POLL_SCRIPT }} />
      </>,
    );
  }

  if (capture.status === "failed") {
    const signedIn = !!c.get("session");
    return page(
      c,
      { title: "Capture failed", status: 200 },
      <>
        <h1>This capture failed</h1>
        <p>The post could not be saved:</p>
        <p class="notice">{capture.error ?? "No reason was recorded."}</p>
        {signedIn ? (
          <form method="post" action="/submit" class="sans">
            <input type="hidden" name="url" value={capture.postId} />
            <button type="submit">Try again</button>
          </form>
        ) : (
          <p class="sans">
            <a class="button" href={`/auth/login?returnTo=${encodeURIComponent(`/p/${postId}/${ts}`)}`}>
              Sign in to try again
            </a>
          </p>
        )}
        <p class="muted small">
          <a href={`/p/${postId}`}>All captures of this post</a>
        </p>
      </>,
    );
  }

  const files = await artifactFiles(c, capture);
  const imageUrl = `${c.env.PUBLIC_URL}${capturePath(capture)}/${ARTIFACTS.png}`;
  const who = capture.authorHandle ? `@${capture.authorHandle}` : "A post";
  const summary = excerpt(capture.text, 200);
  const head = (
    <>
      <meta property="og:type" content="article" />
      <meta property="og:site_name" content="xposts" />
      <meta property="og:title" content={`${who} on X, saved ${formatTime(capture.capturedAt)}`} />
      <meta property="og:description" content={summary || "An archived post."} />
      <meta property="og:url" content={captureUrl(c.env, capture)} />
      <meta property="og:image" content={imageUrl} />
      {capture.width ? <meta property="og:image:width" content={String(capture.width)} /> : null}
      {capture.height ? <meta property="og:image:height" content={String(capture.height)} /> : null}
      <meta property="og:image:alt" content={summary || "The archived post"} />
      <meta name="twitter:card" content="summary_large_image" />
      <link rel="canonical" href={captureUrl(c.env, capture)} />
    </>
  );

  return page(
    c,
    { title: `${who}: ${excerpt(capture.text, 60) || capture.postId}`, description: summary, head },
    <>
      <h1>{capture.authorName ?? who}</h1>
      <p class="facts">
        {capture.authorHandle ? (
          <span>
            <a href={`/u/${encodeURIComponent(capture.authorHandle)}`}>@{capture.authorHandle}</a>
          </span>
        ) : null}
        <span>
          Posted <Time iso={capture.postedAt} />
        </span>
        <span>
          Captured <Time iso={capture.capturedAt} />
        </span>
        <span>
          <a href={originalUrl(capture)}>Original on x.com</a>
        </span>
      </p>
      <img
        class="capture-img"
        src={`${capturePath(capture)}/${ARTIFACTS.png}`}
        alt={capture.text ?? "The archived post"}
        width={capture.width ?? undefined}
        height={capture.height ?? undefined}
      />
      {capture.text ? <p style="white-space:pre-wrap">{capture.text}</p> : null}
      <p class="muted small">
        <a href={`/p/${postId}`}>Other captures of this post</a>
      </p>
      <Proof capture={capture} files={files} />
    </>,
  );
});

web.get("/u/:handle", async (c) => {
  const handle = c.req.param("handle").replace(/^@/, "");
  if (!HANDLE.test(handle)) return notFoundPage(c);
  const captures = await capturesByAuthor(c.env.DB, handle);
  if (captures.length === 0) return notFoundPage(c, `No posts by @${handle} have been saved.`);
  const name = captures[0]!.authorHandle ?? handle;
  return page(
    c,
    { title: `@${name}`, wide: true },
    <>
      <h1>@{name}</h1>
      <p class="muted">
        {captures.length} saved {captures.length === 1 ? "capture" : "captures"} · <a href={`https://x.com/${name}`}>Profile on x.com</a>
      </p>
      <CaptureGrid captures={captures} />
    </>,
  );
});

const VERIFY_SCRIPT = `(function(){
var drop=document.getElementById("drop"),file=document.getElementById("file"),form=document.getElementById("hash-form"),hash=document.getElementById("hash"),out=document.getElementById("result");
function el(tag,text,attrs){var e=document.createElement(tag);if(text!=null)e.textContent=text;for(var k in attrs||{})e.setAttribute(k,attrs[k]);return e}
function show(){out.replaceChildren.apply(out,arguments)}
async function lookup(h,label){
 show(el("p","Checking…"));
 var r;try{r=await fetch("/api/verify/"+h,{headers:{accept:"application/json"}})}catch(e){show(el("p","The archive could not be reached: "+e.message,{class:"error",role:"alert"}));return}
 if(r.status===404){show(el("h2","Not in this archive"),el("p","No capture has "+(label||"this hash")+" (SHA-256 "+h+"). The archive does not know this image. It may be altered, re-encoded, or never saved here."));return}
 if(!r.ok){show(el("p","The archive answered "+r.status+".",{class:"error",role:"alert"}));return}
 var d=await r.json(),c=d.capture,p=el("p");
 var which=c.pngSha256===h?"image":"manifest";
 p.append("This is the "+which+" of ",el("a",c.authorHandle?"@"+c.authorHandle+"'s post":"a saved post",{href:new URL(d.url).pathname}),", captured "+(c.capturedAt||c.ts)+".");
 var parts=[el("h2","Match"),p];
 if(d.anchor){var q=el("p");q.append("Anchored on Algorand "+d.anchor.network+", round "+d.anchor.round+": ",el("a",d.anchor.txId,{href:d.anchor.explorerUrl,class:"hash"}));parts.push(q)}
 else parts.push(el("p","This capture is not anchored on a blockchain."));
 show.apply(null,parts)}
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
      <p class="lede">Check whether this archive saved an image, and when it was anchored.</p>
      <p>
        The file is hashed in your browser with SHA-256. It never leaves your device: only the hash is sent. The same
        works for the manifest file of a capture.
      </p>
      <label class="drop" id="drop" for="file">
        Drop a PNG here, or choose one
        <input id="file" type="file" accept="image/png,application/json,.png,.json" />
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
    { title: "About", description: "How xposts saves X posts, and what a capture proves." },
    <>
      <h1>About</h1>
      <p class="lede">
        xposts keeps a copy of an X post as it looked when it was saved, and fixes the time of that copy on a public
        blockchain.
      </p>

      <h2>How it works</h2>
      <ol class="steps">
        <li>You paste a link here, or mention @{c.env.X_BOT_HANDLE} in a reply to the post on X.</li>
        <li>The archive fetches the post from the X API and the page from x.com.</li>
        <li>
          It draws the post as an image with <a href="https://github.com/kzu/xeet">xeet</a>, a renderer that reproduces how
          x.com shows a post.
        </li>
        <li>It stores the image, the raw responses and a manifest that lists the SHA-256 of every file.</li>
        <li>It writes the hashes of the image and the manifest into a transaction on the Algorand blockchain.</li>
      </ol>

      <h2>What is preserved</h2>
      <p>
        For every capture: the rendered image, the X API response byte for byte with its headers, the x.com page the
        renderer read when it was available, the exact renderer input, and the manifest. All are downloadable from the
        capture page.
      </p>

      <h2>What a capture proves, and what it does not</h2>
      <p>
        A capture proves that this archive held these exact bytes at the time of the Algorand transaction. Anyone can
        check that without trusting the archive: hash the files, then read the hashes in the transaction.
      </p>
      <p>
        It does <strong>not</strong> prove that X served this content. X does not sign its posts, so no one, this archive
        included, can prove that a post said what an image says. The stored X API response and its headers, and the
        creation time encoded in the post id, are evidence: they can be compared with what X shows, and they are hard to
        invent consistently. They are not proof. A capture taken after a post was edited or deleted shows the post as the
        archive saw it then.
      </p>

      <h2>Reproducible and open</h2>
      <p>
        Each capture includes <code>xeet-input.json</code>. Rendering it again with the renderer version named in the
        manifest gives the same image, so the picture is derived from stored data and not a screenshot. The code of this
        archive is open source at <a href={c.env.REPO_URL}>{c.env.REPO_URL}</a>.
      </p>
    </>,
  ),
);

/** The 404 page, for the root app to install with `app.notFound` (sub-apps do not pass theirs up). */
export const notFound = (c: Context<AppEnv>) => notFoundPage(c);
