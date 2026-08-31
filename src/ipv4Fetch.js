// Node's global `fetch` (undici) hangs connecting to hosts that publish AAAA
// (IPv6) records when the machine's IPv6 route is a black hole -- it races
// IPv4/IPv6 and never falls back in time, timing out even though the same
// host answers instantly over IPv4 (openrouter.ai is the case that surfaced
// this; api.groq.com/api.deepgram.com have no AAAA records so they never hit
// it). Node's older `https` module doesn't have this problem since it can be
// told to use IPv4 only, so this rebuilds just enough of the fetch surface
// (used by the `openai` SDK's `fetch` client option) on top of it.
import https from "node:https";
import { Readable } from "node:stream";

function headersToPlainObject(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

export function ipv4Fetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(typeof url === "string" ? url : url.url);
    const req = https.request(
      target,
      {
        method: init.method || "GET",
        family: 4,
        headers: headersToPlainObject(init.headers),
      },
      (res) => {
        const body = Readable.toWeb(res);
        resolve(
          new Response(body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: Object.entries(res.headers).filter(([, v]) => v !== undefined),
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.signal) {
      init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
    }
    if (!init.body) {
      req.end();
    } else if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
      req.end(init.body);
    } else {
      Readable.fromWeb(init.body).pipe(req);
    }
  });
}
